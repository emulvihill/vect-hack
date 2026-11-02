// The sustained gate for the Angband Module (vect-hack-3vk.4): hands the game
// to Angband's own borg and watches the 3D client hold up under fast autonomous
// play for ten minutes. A human playtest is the other half of that gate; this
// half is the part a machine can be honest about.
//
// What it measures and why each number is here:
//   frame rate p50/p05    — the median frame and the bad tail. A mean hides a
//                           stall; p05 is what a player would call a hitch.
//   map batches/sec       — engine traffic. Zero for long enough is a hang,
//                           which is the failure this gate exists to catch.
//   full sweeps/sec       — batches covering the whole level (main-wasm.c's
//                           dirty_fallback path). Cheap once in a while, the
//                           dominant cost if it becomes the normal case.
//   terrain rebuilds/sec  — static geometry rebuilt from scratch. Hero light is
//                           baked into it, so this tracks hero moves, and it is
//                           the cost that scales with level size rather than
//                           with what actually changed (the design's Risks).
//   max grid batch words  — the largest single record batch, in Int32 words:
//                           what the worker->main transfer has to carry.
//   hero moves            — liveness. A borg that stopped playing still renders.
//
// The key protocol is deliberately not instrumented here. Under ?borg the
// BorgPlayer decorator answers the engine itself and never calls the view's
// nextKey (src/modules/angband/ui/BorgPlayer.ts), so a counter on the view
// would read zero however broken the protocol was. An unanswered key request
// has an observable form in this run anyway: the engine stops asking for
// anything, map traffic goes flat, and the stall check below fires.
// scripts/dev/fp-controls-check.mjs is where the key encoding itself is
// checked, against a session a human is driving.
//
// Everything read off the page is public API: DungeonRenderer's diagnostics
// accessors, the CellGrid on renderer.map, and the view's own handle/onNotice
// (patched to observe, always forwarding). Nothing reaches a private field —
// an assertion that cannot fail is worse than no assertion (docs/DECISIONS.md,
// vect-hack-azf).
//
// Needs a dev server (npm run dev -- --port 5199) and a GPU:
//   npm run check:angband-borg
//   BORG_GATE_MS=120000 npm run check:angband-borg     # a shorter pre-gate
//   BORG_PACE_MS=250 ... check:angband-borg             # paced run (?borg=250)
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { STORAGE_DECLINED_WARNING } from "./gate-console.mjs";

const URL_BASE = process.env.NH_URL ?? "http://localhost:5199/";
/**
 * The one console warning a healthy run makes. Everything else — every other
 * warning, every error, every pageerror — still fails this gate, which is the
 * point: an allowlist that swallowed "warnings in general" would cost more than
 * it saves. The why lives at the constant's definition in gate-console.mjs,
 * with the reason it must not be deleted; the short version is that the browser
 * declining the storage grant is src/ui/saveRisk.ts doing its job, not a defect.
 *
 * This gate had no list at all until vect-hack-zt7, so it failed on that warning
 * from the day the save-risk work shipped — asserting something false while
 * every measured number (60fps, no stall, 34849 hero moves) was healthy.
 */
const EXPECTED_CONSOLE = [STORAGE_DECLINED_WARNING];
const OUT_DIR = ".preview";
const GATE_MS = Number(process.env.BORG_GATE_MS ?? 600000);
/** Optional ?borg=<ms> pace; the gate itself runs unthrottled. */
const PACE_MS = process.env.BORG_PACE_MS ?? "";
const SAMPLE_MS = 1000;
const BOOT_MS = 30000;
/** The borg births a character itself; give it room before demanding traffic. */
const START_MS = 60000;
/** No map traffic for this long is a hang, not a quiet stretch — unless the
 *  game ended, which END_TELLS below is how this gate knows. */
const STALL_MS = 30000;
/**
 * The engine's own tells that the game is over. A borg whose character dies is
 * Angband working correctly, not the client hanging, and this gate exists to
 * measure the client — so the end has to be recognised explicitly rather than
 * inferred from the silence that follows it (vect-hack-zt7).
 *
 *  - "You die." is msgt(MSG_DEATH) in take_hit (player-util.c:251), emitted in
 *    the same breath as `p->is_dead = true`. It is the authoritative death
 *    message and the borg's own "Die? " hook reads the same moment.
 *  - the score line is enter_score (score.c:283-303), which death_knowledge
 *    reaches for EVERY end, a win included. In this build it is always the
 *    borg branch: angband-wasm.mk compiles -DALLOW_BORG and nothing anywhere
 *    defines SCORE_BORGS.
 *  - the win has its own message first (player-quest.c:250).
 *
 * Three tells and not one because they arrive by different paths, and because
 * a build-flag change that silenced one must not quietly turn "the game ended"
 * back into "the client hung". Anchored, so a message that merely quotes one
 * is not an end.
 */
const END_TELLS = [/^You die\.$/, /^Score not registered for /, /^You have won the game!$/];
/**
 * How long the borg must have played before an ended game may still pass.
 * Derived from this gate's own constants, and fixed before the death times
 * were measured (pre-registered, vect-hack-zt7):
 * START_MS (60s) is unmeasured warm-up during which a stall is not even
 * counted, and 60s beyond it is 60 one-second samples — enough for the p05
 * this gate reports to be a percentile rather than a synonym for the single
 * worst sample.
 *
 * Without this floor the gate could not fail: every red run would be excused
 * by "the borg died", and an assertion that cannot fail is worse than no
 * assertion (docs/DECISIONS.md, vect-hack-azf).
 */
const MIN_PLAY_MS = 120000;
const MIN_FPS = 30;
const CHROMIUM_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"];
/** src/modules/angband/mapRecords.ts GRID_STRIDE. */
const GRID_STRIDE = 15;

/**
 * Observe the view from the moment main.ts publishes it. The assignment is
 * intercepted rather than polled for: AngbandSession is constructed in the same
 * turn, so a wrapper installed even a tick later misses the level event and the
 * first parked key request.
 */
const OBSERVE = (tellSources) => {
  const END = tellSources.map((src) => new RegExp(src));
  let view = null;
  const c = {
    events: 0, batches: 0, sweeps: 0, records: 0, maxRecords: 0,
    messages: 0, effects: 0, levels: 0, moves: 0,
    lastBatchAt: 0, area: 0, hero: null,
    notice: null, lastMessage: null, endedAt: null, endTell: null,
  };
  window.__borg = c;
  Object.defineProperty(window, "__angbandView", {
    configurable: true,
    get: () => view,
    set: (v) => {
      view = v;
      const handle = v.handle.bind(v);
      v.handle = (ev) => {
        c.events++;
        const result = handle(ev);
        if (ev.name === "map") {
          const records = ev.records.length / 15;
          c.batches++;
          c.records += records;
          c.maxRecords = Math.max(c.maxRecords, records);
          if (c.area && records >= c.area) c.sweeps++;
          c.lastBatchAt = performance.now();
          const hero = v.renderer?.map?.hero ?? null;
          if (hero && (!c.hero || hero.x !== c.hero.x || hero.y !== c.hero.y)) c.moves++;
          if (hero) c.hero = { x: hero.x, y: hero.y };
        }
        if (ev.name === "level") { c.levels++; c.area = ev.width * ev.height; }
        if (ev.name === "message") {
          c.messages++;
          c.lastMessage = ev.text;
          // Caught here rather than by sampling lastMessage once a second: the
          // borg makes tens of messages a second, so "You die." is long gone
          // from lastMessage before the next sample could read it.
          if (c.endedAt === null && END.some((re) => re.test(ev.text))) {
            c.endedAt = performance.now();
            c.endTell = ev.text;
          }
        }
        if (ev.name === "effect") c.effects++;
        return result;
      };
      const notice = v.onNotice.bind(v);
      v.onNotice = (text) => { c.notice = text; return notice(text); };
    },
  });
};

const SAMPLE = () => {
  const r = window.__angbandView?.renderer ?? null;
  return {
    ...window.__borg,
    frames: r?.frames ?? 0,
    rebuilds: r?.terrainRebuilds ?? 0,
    backend: r?.backend ?? null,
    now: performance.now(),
  };
};

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

await fetch(URL_BASE).catch(() => {
  console.error(`FAIL: no dev server at ${URL_BASE} — run: npm run dev -- --port 5199`);
  process.exit(1);
});
await mkdir(OUT_DIR, { recursive: true });

const errors = [];
const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
let report;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    if (EXPECTED_CONSOLE.some((re) => re.test(m.text()))) return;
    errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(OBSERVE, END_TELLS.map((re) => re.source));
  await page.goto(`${URL_BASE}?game=angband&borg${PACE_MS && `=${PACE_MS}`}`, { waitUntil: "domcontentloaded" });

  const backend = await page.waitForFunction(
    () => window.__angbandView?.renderer?.backend ?? null, null, { timeout: BOOT_MS },
  ).then((h) => h.jsonValue());
  console.log(`[borg gate] backend=${backend}, sampling for ${(GATE_MS / 1000).toFixed(0)}s`);

  const started = Date.now();
  let prev = await page.evaluate(SAMPLE);
  // Page time at the first sample, so a played window can be measured against
  // the same clock the end tell is stamped with.
  const startedPageNow = prev.now;
  const fps = [], batchRate = [], sweepRate = [], rebuildRate = [];
  let stalledFor = 0, worstStall = 0;
  let ended = null;

  while (Date.now() - started < GATE_MS) {
    await page.waitForTimeout(SAMPLE_MS);
    const now = await page.evaluate(SAMPLE);
    const dt = (now.now - prev.now) / 1000;
    if (dt > 0) {
      fps.push((now.frames - prev.frames) / dt);
      batchRate.push((now.batches - prev.batches) / dt);
      sweepRate.push((now.sweeps - prev.sweeps) / dt);
      rebuildRate.push((now.rebuilds - prev.rebuilds) / dt);
    }
    // Only count a stall once the borg has had time to birth its character:
    // before that the engine is legitimately quiet, waiting on birth prompts.
    // The counter resets rather than merely going unrecorded at the boundary,
    // or birth-time quiet leaks across it and reports a stall on a healthy run.
    const running = Date.now() - started > START_MS;
    stalledFor = running && now.batches === prev.batches ? stalledFor + SAMPLE_MS : 0;
    if (running) worstStall = Math.max(worstStall, stalledFor);
    prev = now;

    const secs = Math.round((Date.now() - started) / 1000);
    if (secs % 30 === 0) {
      console.log(`  ${secs}s: ${fps.at(-1).toFixed(0)} fps, ${now.batches} batches, `
        + `${now.sweeps} sweeps, ${now.moves} moves, ${now.rebuilds} rebuilds`
        + (now.notice ? `, notice: ${now.notice.slice(0, 60)}` : ""));
    }
    // A recognised end stops the sampling: there is no client left to measure,
    // and every second past it would only be silence dressed up as a stall.
    if (now.endedAt !== null) {
      ended = { tell: now.endTell, playedMs: now.endedAt - startedPageNow };
      console.log(`  the borg's game ended after ${(ended.playedMs / 1000).toFixed(0)}s: ${ended.tell}`);
      break;
    }
    if (now.notice || errors.some((e) => e.startsWith("pageerror"))) break;
  }

  const final = await page.evaluate(SAMPLE);
  await page.screenshot({ path: `${OUT_DIR}/angband-borg-gate.png` });
  report = {
    backend, seconds: (Date.now() - started) / 1000,
    fps: { p50: percentile(fps, 0.5), p05: percentile(fps, 0.05), mean: fps.reduce((a, b) => a + b, 0) / (fps.length || 1) },
    batchesPerSec: percentile(batchRate, 0.5),
    sweepsPerSec: percentile(sweepRate, 0.5),
    rebuildsPerSec: percentile(rebuildRate, 0.5),
    maxBatchWords: final.maxRecords * GRID_STRIDE,
    levels: final.levels, moves: final.moves, batches: final.batches,
    sweeps: final.sweeps, effects: final.effects,
    worstStallMs: worstStall, notice: final.notice, lastMessage: final.lastMessage,
    ended: ended && { tell: ended.tell, playedSeconds: ended.playedMs / 1000 },
    errors,
  };
} finally {
  await browser.close();
}

const problems = [];
const ended = report.ended;
// A game that ended and then exited is Angband finishing, not the client
// stopping — so THIS assertion is scoped to a run with no recognised end.
if (report.notice && !ended) problems.push(`the engine stopped: ${report.notice}`);
if (report.errors.some((e) => e.startsWith("pageerror"))) {
  problems.push(`page error: ${report.errors.find((e) => e.startsWith("pageerror"))}`);
}
// The stall check is deliberately NOT scoped that way. The counters above are
// updated BEFORE the loop breaks on `endedAt`, so post-death quiet can add at
// most one SAMPLE_MS — reaching STALL_MS that way would need a >=29s freeze
// already under way when the character died, which is a real stall by then.
// So an `!ended` guard would forgive nothing worth forgiving, and one thing
// that must never be forgiven: a real >=30s freeze during LIVE play, in a run
// whose borg happened to die later, past the floor. That is the assertion this
// gate exists for, and it is unconditional.
if (report.worstStallMs >= STALL_MS) problems.push(`map traffic stalled for ${report.worstStallMs / 1000}s`);
// ... and an end that arrived too soon measured nothing, so it fails on its own
// terms rather than being excused.
if (ended && ended.playedSeconds * 1000 < MIN_PLAY_MS) {
  problems.push(`the borg's game ended after ${ended.playedSeconds.toFixed(0)}s (${ended.tell}), `
    + `below the ${MIN_PLAY_MS / 1000}s of play this gate needs to have measured anything`);
}
if (report.fps.mean < MIN_FPS) problems.push(`${report.fps.mean.toFixed(1)} fps average, below ${MIN_FPS}`);
if (!report.moves) problems.push(`the borg never moved the hero`);
if (report.errors.length) problems.push(`console: ${report.errors.slice(0, 3).join(" | ")}`);

console.log(`\n[borg gate] backend=${report.backend} over ${report.seconds.toFixed(0)}s`
  + (ended ? ` (the game ended after ${ended.playedSeconds.toFixed(0)}s: ${ended.tell})` : ""));
console.log(`  fps p50=${report.fps.p50.toFixed(1)} p05=${report.fps.p05.toFixed(1)} mean=${report.fps.mean.toFixed(1)}`);
console.log(`  map ${report.batchesPerSec.toFixed(1)}/s, full sweeps ${report.sweepsPerSec.toFixed(1)}/s, `
  + `terrain rebuilds ${report.rebuildsPerSec.toFixed(1)}/s`);
console.log(`  max grid batch ${report.maxBatchWords} words; ${report.levels} levels, `
  + `${report.moves} hero moves, ${report.effects} effects`);
console.log(`  worst stall ${(report.worstStallMs / 1000).toFixed(0)}s; last message: ${report.lastMessage ?? "none"}`);
console.log(`  screenshot ${OUT_DIR}/angband-borg-gate.png`);

await writeFile(`${OUT_DIR}/angband-borg-gate.json`, JSON.stringify(report, null, 2));
if (problems.length) problems.forEach((p) => console.log(`  FAIL: ${p}`));
else console.log("  OK");
process.exit(problems.length ? 1 : 0);

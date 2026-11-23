// The sustained gate for the Angband Module (vect-hack-3vk.4): hands the game
// to Angband's own borg and watches the 3D client hold up under fast autonomous
// play for ten minutes. A human playtest is the other half of that gate; this
// half is the part a machine can be honest about.
//
// Pass mark for vect-hack-t4ja, written down before any run against it: five
// consecutive runs of this gate each end with a verdict that rests on at least
// 120 s of measured play; none fails for "the game ended". Guard, reported
// either way: how many games each run needed.
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
//                           with what actually changed.
//   max grid batch words  — the largest single record batch, in Int32 words:
//                           what the worker->main transfer has to carry.
//   hero moves            — liveness. A borg that stopped playing still renders.
//
// The play is measured over as many games as it takes (vect-hack-t4ja). When
// the borg's character dies, the next game starts on a fresh page, until
// BORG_GATE_MS of play has been measured or MAX_GAMES have been started; the
// verdict rests on every game's samples, and the run prints how many games it
// needed. angband-borg-gate-utils.mjs holds that accounting and its floor.
//
// The key protocol is deliberately not instrumented here. Under ?borg the
// BorgPlayer decorator answers the engine itself and never calls the view's
// nextKey (src/modules/angband/ui/BorgPlayer.ts), so a counter on the view
// would read zero however broken the protocol was. An unanswered key request
// has an observable form in this run anyway: the engine stops asking for
// anything, map traffic goes flat, and the stall check below fires.
// scripts/browser-check/fp-controls-check.mjs is where the key encoding itself
// is checked, against a session a human is driving.
//
// Everything read off the page is public API: DungeonRenderer's diagnostics
// accessors, the CellGrid on renderer.map, and the view's own handle/onNotice
// (patched to observe, always forwarding). Nothing reaches a private field —
// an assertion that cannot fail is worse than no assertion (vect-hack-azf).
//
// Needs a dev server (npm run dev -- --port 5199) and a GPU:
//   npm run check:angband-borg
//   BORG_GATE_MS=120000 npm run check:angband-borg     # a shorter pre-gate
//   BORG_PACE_MS=250 ... check:angband-borg             # paced run (?borg=250)
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { STORAGE_DECLINED_WARNING } from "./gate-console.mjs";
import { MAX_GAMES, playGames, playProblems } from "./angband-borg-gate-utils.mjs";

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
/** Play to measure, summed over the run's games. */
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
const fps = [], batchRate = [], sweepRate = [], rebuildRate = [];
let worstStall = 0;
/** The counters of every finished game, summed; maxRecords is the largest. */
const totals = { levels: 0, moves: 0, batches: 0, sweeps: 0, effects: 0, maxRecords: 0 };
let backend = null, notice = null, lastMessage = null, gamesStarted = 0;
const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });

/**
 * One game, from boot until it ends or has played `budgetMs`. A new page is a
 * new browser context, so its IndexedDB is empty and the borg births a fresh
 * character: the same start every game of a run gets, the first included.
 */
async function playGame(budgetMs) {
  const game = ++gamesStarted;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    page.on("console", (m) => {
      if (m.type() !== "error" && m.type() !== "warning") return;
      if (EXPECTED_CONSOLE.some((re) => re.test(m.text()))) return;
      errors.push(`${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await page.addInitScript(OBSERVE, END_TELLS.map((re) => re.source));
    await page.goto(`${URL_BASE}?game=angband&borg${PACE_MS && `=${PACE_MS}`}`, { waitUntil: "domcontentloaded" });

    backend = await page.waitForFunction(
      () => window.__angbandView?.renderer?.backend ?? null, null, { timeout: BOOT_MS },
    ).then((h) => h.jsonValue());
    console.log(`[borg gate] game ${game}: backend=${backend}, up to ${(budgetMs / 1000).toFixed(0)}s of play left to measure`);

    const started = Date.now();
    let prev = await page.evaluate(SAMPLE);
    // Page time at the first sample, so a played window can be measured against
    // the same clock the end tell is stamped with.
    const startedPageNow = prev.now;
    let stalledFor = 0;
    let ended = null;

    while (prev.now - startedPageNow < budgetMs) {
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
        console.log(`  game ${game}, ${secs}s: ${fps.at(-1).toFixed(0)} fps, ${now.batches} batches, `
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
    for (const k of ["levels", "moves", "batches", "sweeps", "effects"]) totals[k] += final[k];
    totals.maxRecords = Math.max(totals.maxRecords, final.maxRecords);
    // A game that ended and then exited is Angband finishing, not the client
    // stopping, so only a notice with no recognised end is kept for the verdict.
    if (!ended) notice = final.notice;
    lastMessage = final.lastMessage;
    return { playedMs: ended ? ended.playedMs : prev.now - startedPageNow, ended: ended && { tell: ended.tell } };
  } finally {
    await page.close();
  }
}

const runStarted = Date.now();
let run;
try {
  console.log(`[borg gate] measuring ${(GATE_MS / 1000).toFixed(0)}s of play over at most ${MAX_GAMES} games`);
  run = await playGames(playGame, GATE_MS);
} finally {
  await browser.close();
}
const report = {
  backend, seconds: (Date.now() - runStarted) / 1000, playedSeconds: run.playedMs / 1000,
  games: run.games.map((g) => ({ playedSeconds: g.playedMs / 1000, ended: g.ended?.tell ?? null })),
  fps: { p50: percentile(fps, 0.5), p05: percentile(fps, 0.05), mean: fps.reduce((a, b) => a + b, 0) / (fps.length || 1) },
  batchesPerSec: percentile(batchRate, 0.5),
  sweepsPerSec: percentile(sweepRate, 0.5),
  rebuildsPerSec: percentile(rebuildRate, 0.5),
  maxBatchWords: totals.maxRecords * GRID_STRIDE,
  levels: totals.levels, moves: totals.moves, batches: totals.batches,
  sweeps: totals.sweeps, effects: totals.effects,
  worstStallMs: worstStall, notice, lastMessage,
  errors,
};

const problems = [];
// Only a game with no recognised end can leave a notice here (playGame).
if (report.notice) problems.push(`the engine stopped: ${report.notice}`);
if (report.errors.some((e) => e.startsWith("pageerror"))) {
  problems.push(`page error: ${report.errors.find((e) => e.startsWith("pageerror"))}`);
}
// The stall check is deliberately NOT scoped to games that did not end. The
// counters above are updated BEFORE the loop breaks on `endedAt`, so post-death
// quiet can add at most one SAMPLE_MS — reaching STALL_MS that way would need a
// >=29s freeze already under way when the character died, which is a real
// stall by then. So an `!ended` guard would forgive nothing worth forgiving,
// and one thing that must never be forgiven: a real >=30s freeze during LIVE
// play, in a game whose borg happened to die later. That is the assertion this
// gate exists for, and it is unconditional.
if (report.worstStallMs >= STALL_MS) problems.push(`map traffic stalled for ${report.worstStallMs / 1000}s`);
// An ended game is never a problem on its own; too little play over the whole
// run is, because then nothing was measured.
problems.push(...playProblems(run));
if (report.fps.mean < MIN_FPS) problems.push(`${report.fps.mean.toFixed(1)} fps average, below ${MIN_FPS}`);
if (!report.moves) problems.push(`the borg never moved the hero`);
if (report.errors.length) problems.push(`console: ${report.errors.slice(0, 3).join(" | ")}`);

const games = report.games.length;
console.log(`\n[borg gate] backend=${report.backend}: ${report.playedSeconds.toFixed(0)}s of play measured `
  + `over ${games} game${games === 1 ? "" : "s"} in ${report.seconds.toFixed(0)}s`);
report.games.forEach((g, i) => console.log(`  game ${i + 1}: ${g.playedSeconds.toFixed(0)}s`
  + (g.ended ? `, ended: ${g.ended}` : "")));
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

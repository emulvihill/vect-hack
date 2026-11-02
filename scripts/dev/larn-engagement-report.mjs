// The engagement metric: what a batch of Larn games did when a monster reached
// the hero (spec: docs/specs/2026-08-21-larn-engagement-design.md,
// "A committed metric").
//
// The Phase 1b A/B report's melee figures were derived by hand and no script
// reproduced them. A gate whose metric cannot be re-run is not a gate, and this
// phase gates on exactly those numbers, so the inference lives here once.
//
// **Melee is inferred by replay, because the trajectory does not record it.**
// LarnRecorder writes every event the engine showed and every key the bot
// answered, and nothing else (src/modules/larn/bot/recorder.ts): the bot's own
// `intent` never reaches the file. So the events are replayed through a fresh
// LarnBotModel — the same public projection the bot played on — and a command
// key is a melee attempt when it is a movement key whose target cell held a
// being in the frame before it. That is walking into a monster, which is how
// Larn attacks.
//
// **Blows taken come from Larn's own text**, not from an HP delta: HP moves for
// poison, for regeneration and for traps, and counting those as blows would
// make "was the hero attacked" unfalsifiable. `The <monster> hit you` and its
// variants are printed by monster.c (1279, 1547-1643); `hitplayer` is the only
// thing that prints them.
//
// **A capped run is data here, unlike in the A/B.** abReport drops a
// harness-cut run from the score statistic because Larn prints no score line.
// Melee per 100 commands is recorded live and survives a cap — and a treatment
// that stopped fighting and ran out its budget is precisely what this metric
// exists to catch, so dropping capped runs would blind it.
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";
import { LarnBotModel } from "../../src/modules/larn/bot/model.ts";

/** The linear-interpolated R-7 quantile, the same definition
 *  scripts/dev/baseline-report.mjs states and uses. Copied rather than shared
 *  because that script does its work at import time; src/bot/abReport.ts
 *  deliberately uses the plain median instead, over per-seed deltas, and the
 *  two must not be confused. */
function quantile(values, p) {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const h = (v.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return v[lo] + (h - lo) * (v[hi] - v[lo]);
}
const median = (values) => quantile(values, 0.5);

const USAGE = `usage: larn-engagement-report.mjs --batch <dir> [--batch <dir> ...] [--json]

Reports, per batch: melee attempts, melee per 100 commands, runs that never
swung, runs that were attacked, blows taken, and capped runs.`;

const { values: opts } = parseArgs({
  options: { batch: { type: "string", multiple: true }, json: { type: "boolean", default: false } },
});
if (!opts.batch?.length) { console.error(USAGE); process.exit(2); }

/** Larn's own "a monster hit the hero" text (monster.c hitplayer). The `hits`
 *  spelling is real and appears once, at monster.c:1627. */
const BLOW = /\bThe [^\n]*? (?:hit|hits) you\b/g;
/** Characters carried between writes so a blow split across two of them still
 *  matches. Larn writes the whole phrase from one lprintf, so this only has to
 *  cover a torn write, not a long line. */
const BLOW_TAIL = 200;

/** Movement bytes, walk and run, in DIRS compass order — the table
 *  movementKey() writes from (src/modules/larn/keys.ts:74). */
const MOVES = new Map();
["k", "u", "l", "n", "j", "b", "h", "y"].forEach((ch, compass) => {
  const dirs = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  MOVES.set(ch.charCodeAt(0), dirs[compass]);
  MOVES.set(ch.toUpperCase().charCodeAt(0), dirs[compass]); // shifted = run
});

/** The typed arrays TrajectoryLog flattened on the way to disk. A `map` batch
 *  and a `status` record are plain arrays in the file, and the classifier
 *  decodes neither — hand them over as they came and the replay sees an empty
 *  dungeon (src/modules/larn/bot/digest.ts's header states this at length). */
function rehydrate(ev) {
  if (ev.name === "map") return { ...ev, records: Int32Array.from(ev.records) };
  if (ev.name === "status") {
    return { ...ev, record: Int32Array.from(ev.record), names: Uint8Array.from(ev.names) };
  }
  return ev;
}

/** One run's engagement numbers, from its trajectory alone.
 *
 *  Streamed a line at a time, never read whole. A capped run is 24000 commands
 *  and its trajectory decompresses past node's 512 MB string ceiling, so
 *  gunzipSync().toString() throws ERR_STRING_TOO_LONG on exactly the runs this
 *  metric most needs to read. */
async function replay(path) {
  const model = new LarnBotModel();
  let melee = 0;
  let commands = 0;
  let blows = 0;
  // Counted as the text streams by rather than accumulated: the messages of a
  // capped run are themselves large, and the regex is line-anchored to one
  // engine write, which is how the engine emits them.
  let blowTail = "";
  const rl = createInterface({
    input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity,
  });
  for await (const raw of rl) {
    if (!raw) continue;
    const line = JSON.parse(raw);
    if (line.name === "getKey") {
      const key = line.reply;
      if (line.ev?.cmd) {
        commands++;
        const step = key === null ? undefined : MOVES.get(key.code);
        const hero = model.map.hero;
        if (step && hero) {
          const c = model.map.at(hero.x + step[0], hero.y + step[1]);
          if (c.category === "being" && !c.hero) melee++;
        }
      }
      model.keyAnswered(Boolean(line.ev?.cmd));
      continue;
    }
    if (line.name === "text") {
      // The engine writes a message in pieces, so the match window is the tail
      // of the previous write plus this one. What was already counted is then
      // CUT from the tail — carrying it forward would count the same blow once
      // per following write, which is the difference between 1 and 3 on the
      // reflect fixture. Only the trailing text no match has consumed is kept,
      // and BLOW's match is far shorter than that.
      const window = blowTail + line.ev.text;
      let end = 0;
      for (const m of window.matchAll(BLOW)) { blows++; end = m.index + m[0].length; }
      blowTail = window.slice(Math.max(end, window.length - BLOW_TAIL));
    }
    model.observe(rehydrate(line.ev));
  }
  return { melee, commands, blows };
}

async function readBatch(dir) {
  const runs = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory()) continue;
    const runDir = join(dir, e.name);
    const summaryPath = join(runDir, "summary.json");
    const gzPath = join(runDir, "trajectory.jsonl.gz");
    if (!existsSync(summaryPath) || !existsSync(gzPath)) continue;
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    runs.push({ id: summary.id, seed: summary.seed, outcome: summary.outcome, ...await replay(gzPath) });
  }
  return runs;
}

/** The five numbers the phase gates on, plus the two denominators that make
 *  them readable. `per100` is the normalised figure: a run that will not fight
 *  ends sooner, so the raw count alone confounds willingness with time alive
 *  (2026-08-21-larn-1b-ab.md). */
function summarize(runs) {
  const per100 = runs.map((r) => (r.commands > 0 ? r.melee * 100 / r.commands : 0));
  return {
    runs: runs.length,
    meleeMedian: median(runs.map((r) => r.melee)),
    per100Median: median(per100),
    per100P75: quantile(per100, 0.75),
    neverSwung: runs.filter((r) => r.melee === 0).length,
    attacked: runs.filter((r) => r.blows > 0).length,
    blowsMedian: median(runs.filter((r) => r.blows > 0).map((r) => r.blows)),
    capped: runs.filter((r) => r.outcome === "capped").length,
    /** Of the runs a monster actually reached, how many never swung back. The
     *  1b report's decisive figure: it survives the objection that a bot which
     *  goes fewer places simply meets fewer monsters. */
    attackedNeverSwung: runs.filter((r) => r.blows > 0 && r.melee === 0).length,
  };
}

const report = [];
for (const dir of opts.batch) {
  const runs = await readBatch(dir);
  // The per-run rows ride along in --json: the spec asks for the distribution
  // and the rows, and a gate that reports only an aggregate cannot be argued
  // with when it disagrees with a hand count.
  report.push({ batch: dir, ...summarize(runs), rows: runs });
}

if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const r of report) {
    console.log(`\n${r.batch}  (${r.runs} runs)`);
    console.log(`  melee attempts        median ${r.meleeMedian}`);
    console.log(`  melee per 100 cmds    median ${r.per100Median.toFixed(2)}  p75 ${r.per100P75.toFixed(2)}`);
    console.log(`  never swung           ${r.neverSwung} of ${r.runs}`);
    console.log(`  attacked by a monster ${r.attacked} of ${r.runs}`);
    console.log(`  of those, never swung ${r.attackedNeverSwung}`);
    console.log(`  blows taken           median ${r.blowsMedian} (over the attacked runs)`);
    console.log(`  capped                ${r.capped}`);
  }
  console.log();
}

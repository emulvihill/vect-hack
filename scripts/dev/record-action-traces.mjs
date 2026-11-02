// Record the bot's exact keystrokes over a fixed seed set, as evidence that a
// refactor changed nothing. Run BEFORE the change to write the fixture, and
// again after only if the fixture is deliberately being re-baselined.
//
//   node scripts/dev/record-action-traces.mjs            # rewrite the fixture
//   node scripts/dev/record-action-traces.mjs --check    # compare, exit 1 on drift
//
// Uses the gym itself, so it exercises the same child the baseline batch will.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const FIXTURE = "scripts/test/fixtures/larn-action-traces.json";
// The seeds are arbitrary; their one job is to produce runs long enough for a
// changed decision to show up in. Larn's seed bot takes any descent it is
// offered, including the town's volcanic shaft, which drops a level-1
// character to depth 11 and kills it in a handful of commands — a trace that
// short would let this gate pass forever while proving nothing. These five
// were picked from a sweep of 1..30 for length and for reaching different
// depths (1, 2 and 3); seed 3 dies on its own around command 285, so the
// death and epitaph path is covered too.
const SEEDS = [3, 5, 6, 21, 25];
const MAX_COMMANDS = 400;
const check = process.argv.includes("--check");

/** Every key the bot answered, in order: the byte and whether it was a command
 *  boundary. Display events are deliberately excluded — a new event type is
 *  not a behavior change, a different keystroke is. */
function traceFor(seed) {
  const out = mkdtempSync(join(tmpdir(), "vect-trace-"));
  execFileSync(process.execPath, [
    "scripts/dev/bot-gym.mjs", "--game", "larn", "--games", "1", "--parallel", "1",
    "--max-commands", String(MAX_COMMANDS), "--timeout", "300", "--seed", String(seed), "--out", out,
  ], { stdio: ["ignore", "ignore", "inherit"] });
  const dir = readdirSync(out).find((n) => n.startsWith("larn-"));
  const lines = gunzipSync(readFileSync(join(out, dir, "trajectory.jsonl.gz"))).toString("utf8").trim().split("\n");
  const trace = [];
  for (const l of lines) {
    const r = JSON.parse(l);
    if (r.name !== "getKey" || r.reply === null) continue;
    trace.push(`${r.reply.code} ${r.ev.cmd ? "cmd" : "prompt"}`);
  }
  rmSync(out, { recursive: true, force: true });
  return trace;
}

const traces = {};
for (const seed of SEEDS) {
  traces[seed] = traceFor(seed);
  console.error(`seed ${seed}: ${traces[seed].length} keys`);
}
const built = { seeds: SEEDS, maxCommands: MAX_COMMANDS, traces };

if (!check) {
  writeFileSync(FIXTURE, JSON.stringify(built, null, 2) + "\n");
  console.log(`wrote ${FIXTURE}`);
} else {
  const want = JSON.parse(readFileSync(FIXTURE, "utf8"));
  let drift = 0;
  for (const seed of want.seeds) {
    const a = want.traces[seed], b = built.traces[seed];
    if (!b || a.length !== b.length || a.some((v, i) => v !== b[i])) {
      const at = b ? a.findIndex((v, i) => v !== b[i]) : 0;
      console.error(`DRIFT seed ${seed}: ${a.length} keys recorded, ${b?.length} now; first difference at ${at}: ${a[at]} -> ${b?.[at]}`);
      drift++;
    }
  }
  if (drift) process.exit(1);
  console.log(`OK: ${want.seeds.length} traces unchanged`);
}

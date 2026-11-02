// The reproducibility gate: two gym batches over the same seed list must
// produce the same GAMES. Not the same rows — ids carry a timestamp and a pid,
// and timestamps are wall-clock. The comparison is src/bot/canonical.ts.
//
// Command-capped on purpose: a timeout is a wall-clock outcome, so letting
// games run to death would make this gate flap on a loaded machine.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalLine } from "../../src/bot/canonical.ts";

const fail = (msg) => { console.error("FAIL: " + msg); process.exit(1); };
const GAMES = 3;
const MAX = 60;
const SEED = "20260818";

function batch() {
  const out = mkdtempSync(join(tmpdir(), "vect-repro-"));
  execFileSync(process.execPath, [
    "scripts/dev/bot-gym.mjs", "--game", "larn", "--games", String(GAMES), "--parallel", "2",
    "--max-commands", String(MAX), "--timeout", "240", "--seed", SEED, "--out", out,
  ], { stdio: "inherit" });
  const lines = readdirSync(out)
    .filter((n) => n.startsWith("larn-"))
    .map((d) => JSON.parse(readFileSync(join(out, d, "summary.json"), "utf8")))
    .map(canonicalLine)
    .sort();
  rmSync(out, { recursive: true, force: true });
  return lines;
}

const a = batch();
const b = batch();

if (a.length !== GAMES) fail(`first batch produced ${a.length} summaries, want ${GAMES}`);
if (new Set(a.map((l) => l.split(" ")[0])).size !== GAMES) fail(`seeds repeated within a batch: ${a.join(" | ")}`);
// Distinct seeds must not play the same game. Without this, a regression that
// ignored the seed entirely would still pass: every line would carry its own
// seed value and agree across batches, which is precisely the false OK this
// gate exists to refuse. Strip the seed field and require some variety.
const withoutSeed = a.map((l) => l.slice(l.indexOf(" ") + 1));
if (new Set(withoutSeed).size === 1) fail(`distinct seeds played identical games: ${withoutSeed[0]}`);
for (let i = 0; i < a.length; i++) {
  if (a[i] !== b[i]) fail(`same seed, different game:\n  A ${a[i]}\n  B ${b[i]}`);
}
console.log(`OK: ${GAMES} seeded games reproduced exactly\n  ` + a.join("\n  "));

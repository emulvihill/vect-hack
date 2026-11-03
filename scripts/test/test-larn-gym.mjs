// Engine test for the headless gym: run the orchestrator for one short Larn
// game into a scratch directory and check every artifact it promises — the
// bot got real events (a level beyond the town), answered real prompts, and
// the trajectory replays line for line.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const fail = (msg) => { console.error("FAIL: " + msg); process.exit(1); };
const out = mkdtempSync(join(tmpdir(), "vect-gym-"));
const MAX = 80;

execFileSync(process.execPath, [
  "scripts/dev/bot-gym.mjs", "--game", "larn", "--games", "1", "--parallel", "1",
  "--max-commands", String(MAX), "--timeout", "240", "--out", out,
], { stdio: "inherit" });

const csv = readFileSync(join(out, "scoreboard.csv"), "utf8").trim().split("\n");
if (csv.length !== 2) fail(`scoreboard has ${csv.length} lines, want header + 1`);
if (csv[0] !== "game,id,startedAt,endedAt,outcome,seed,depth,xlevel,hp,hpmax,commands,score,events,cause")
  fail(`unexpected header: ${csv[0]}`);

const runDir = readdirSync(out).find((n) => n.startsWith("larn-"));
if (!runDir) fail("no run directory");
const s = JSON.parse(readFileSync(join(out, runDir, "summary.json"), "utf8"));
if (!["capped", "died"].includes(s.outcome)) fail(`outcome ${s.outcome}: ${s.error} ${s.stderr.join(" | ")}`);
if (s.game !== "larn") fail(`game ${s.game}`);
// No --tuning was named, so this run is the bot as shipped and must say so: a
// sweep arm is only attributable afterwards if every summary names its own.
if (JSON.stringify(s.tuning) !== "{}") fail(`unflagged run recorded tuning ${JSON.stringify(s.tuning)}, want {}`);
if (s.depth < 1) fail(`depth ${s.depth}: the bot never left the town — messages: ${s.lastMessages.join(" / ")}`);
if (s.outcome === "capped" && s.commands < MAX) fail(`capped at ${s.commands} commands, want ${MAX}`);
// Scaled to the commands actually played: a legitimate fast death is short, but
// one Larn command always produces well over three events.
if (s.events < 3 * s.commands || s.events < 50) fail(`only ${s.events} events for ${s.commands} commands`);
if (!csv[1].startsWith(`larn,${runDir},`)) fail(`scoreboard row is not for ${runDir}: ${csv[1]}`);

const gzPath = join(out, runDir, "trajectory.jsonl.gz");
if (!existsSync(gzPath)) fail("no trajectory.jsonl.gz");
if (existsSync(join(out, runDir, "trajectory.jsonl"))) fail("raw trajectory.jsonl was not removed after gzip");
const lines = gunzipSync(readFileSync(gzPath)).toString("utf8").trim().split("\n");
if (lines.length !== s.events) fail(`trajectory has ${lines.length} lines, summary counted ${s.events}`);
if (JSON.parse(lines[0]).i !== 0) fail("first trajectory line is not i=0");
if (!lines.some((l) => l.includes('"name":"map"'))) fail("no map batch in the trajectory");
const cmds = lines.filter((l) => l.includes('"name":"getKey"') && l.includes('"cmd":true')).length;
if (cmds !== s.commands) fail(`trajectory has ${cmds} command keys, summary counted ${s.commands}`);

rmSync(out, { recursive: true, force: true });

// A knob the bot does not have is refused, never played as the defaults under
// the name of the arm that asked for it: the child exits before its game, and
// the batch reports the game fatal and fails.
const bad = mkdtempSync(join(tmpdir(), "vect-gym-"));
const refused = spawnSync(process.execPath, [
  "scripts/dev/bot-gym.mjs", "--game", "larn", "--games", "1", "--parallel", "1",
  "--max-commands", String(MAX), "--timeout", "60", "--out", bad, "--tuning", '{"restLimt":300}',
], { encoding: "utf8" });
if (refused.status === 0) fail("a batch with an unknown tuning knob exited 0");
if (!refused.stderr.includes('unknown tuning knob "restLimt"')) fail(`no refusal named the knob: ${refused.stderr}`);
const badDir = readdirSync(bad).find((n) => n.startsWith("larn-"));
const badSummary = badDir && JSON.parse(readFileSync(join(bad, badDir, "summary.json"), "utf8"));
if (badSummary?.outcome !== "fatal" || badSummary.commands !== 0) {
  fail(`unknown knob: want a fatal game with no commands, got ${JSON.stringify(badSummary?.outcome)} after ${badSummary?.commands}`);
}
rmSync(bad, { recursive: true, force: true });

console.log(`OK: the gym played one Larn game to ${s.outcome} at depth ${s.depth} in ${s.commands} commands (${s.events} events)`);

// Engine test for the headless gym: run the orchestrator for one short Larn
// game into a scratch directory and check every artifact it promises — the
// bot got real events (a level beyond the town), answered real prompts, and
// the trajectory replays line for line.
import { execFileSync } from "node:child_process";
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
// No --kb was named, so this run is the untaught seed bot and must say so. A
// knowledge base sitting in the working tree reaching an unflagged run would
// quietly move the frozen keystroke trace and the control arm of every A/B.
if (s.kb !== "") fail(`unflagged run recorded kb ${JSON.stringify(s.kb)}, want ""`);
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
console.log(`OK: the gym played one Larn game to ${s.outcome} at depth ${s.depth} in ${s.commands} commands (${s.events} events)`);

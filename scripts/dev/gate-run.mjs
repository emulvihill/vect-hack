// One command for the five gates that are not in `npm test`, with the dev
// server four of them need started and stopped around them (vect-hack-zt7,
// vect-hack-hnw, vect-hack-qv1).
//
// Why this exists: check:browser, check:controls, check:touch and
// check:angband-borg each need a real GPU and a server on 5199, so none of them
// runs in `npm test` and nothing ran them on a schedule. check:controls spent
// an unknown period asserting a first-person notice that had said something
// else since the gaze work landed — the gate was red and nobody could tell. A
// gate outside the test suite decays silently; the only thing that stops that
// is running it without anyone having to remember. check:payload is the fifth
// such gate, and it sat outside this runner for the opposite reason: it needs
// neither the GPU nor the server, so it did not fit the apparatus built for the
// ones that do. It decayed just the same (vect-hack-qv1).
//
// What a run does, in order:
//   1. The standalone gates — today just payload, which runs its own
//      `vite build` and `vite preview`. They go FIRST because they are the only
//      ones that can be driven before the preflight decides whether anything
//      else can be, so a machine with no reachable GPU still gets a real
//      answer instead of "could not run" for the whole run.
//   2. Preflight, and only if a hosted gate was asked for. A GPU those gates
//      can reach, and a Chromium that can launch. Failing this is "could not
//      run", NOT "the gates failed" — see below.
//   3. The server, likewise only for hosted gates. Reuses one already answering
//      on 5199; otherwise starts `npm run dev -- --port 5199 --strictPort` in
//      its own process group and kills that group on every exit path, including
//      SIGINT. --strictPort is required: a server that quietly took 5174 would
//      turn every gate into a "no dev server" failure, or worse, test whatever
//      is on 5199 instead.
//   4. The hosted gates, in sequence, output streamed so a human sees live
//      progress and captured so a nightly run leaves something to read.
//   5. The artifact, under ~/.local/state/vect-hack/gates/<stamp>/ — outside
//      the repo on purpose (§4 of the brief, and docs/DECISIONS.md 2026-08-26):
//      the deploy preflight requires a clean tree, so a nightly run that wrote
//      anything tracked would block deploys until someone committed a date.
//
// The three verdicts are deliberately three and not two:
//   exit 0  green            every gate passed
//   exit 1  red              a gate failed — this is the alarm
//   exit 2  usage            the command line was wrong; nothing ran
//   exit 3  could not run    no GPU, no browser, or no server: the run says
//                            nothing about the code. A nightly false alarm is
//                            how a real one gets ignored, so this is never
//                            reported as red.
//
// A run can now hold both at once, and the order between them is settled in
// verdictOf: a gate that RAN and failed outranks a preflight nothing could
// have satisfied. Otherwise a logged-out nightly would file a real payload
// regression under "told you nothing".
//
// Only a human passes --stamp, and only before a release. The nightly timer
// does not: see the header of scripts/dev/vect-hack-gates.service and §4 above.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT, EXIT_FOR_VERDICT, USAGE, appendProblem, buildSummary, durationText, notifiableFailures,
  parseGateArgs, pruneList, renderNodeProblem, splitGates, stampVerified, summaryLines, verdictOf,
} from "./gate-run-utils.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));
const URL_BASE = process.env.NH_URL ?? "http://localhost:5199/";
/** An NH_URL the caller chose is theirs to run; we never start or stop it. */
const MANAGED = !process.env.NH_URL;
const STATE_DIR = join(homedir(), ".local", "state", "vect-hack", "gates");
/** Run directories to keep. Each is a few hundred kB of logs and two JSONs. */
const KEEP_RUNS = 20;
/** Vite on a warm cache answers in about a second; this is the outer bound. */
const SERVER_MS = 60000;
const SERVER_POLL_MS = 250;
/** Long enough for playwright to take its browser down cleanly. */
const KILL_GRACE_MS = 5000;
/** Same launch flags the gates use, so the preflight probes what they will get. */
const CHROMIUM_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"];

let opts;
try {
  opts = parseGateArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(EXIT.usage);
}
if (opts.help) { console.log(USAGE); process.exit(EXIT.green); }

const startedAtMs = Date.now();
const startedAt = new Date(startedAtMs).toISOString();
// Lexically sortable, which is the only reason pruneList() needs no stat().
const stamp = startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const runDir = join(STATE_DIR, stamp);
await mkdir(runDir, { recursive: true });

// ---------------------------------------------------------------- teardown --
// Every exit path goes through finish(). The server is spawned detached so it
// owns a process group: `npm run dev` is a wrapper around vite, and signalling
// the npm process alone leaves vite holding 5199 — which makes the NEXT run
// fail for the wrong reason, the exact confusion this bead is about.

let server = null;         // the child, when we started one
let gateChild = null;      // the gate currently running
let finishing = false;
/**
 * Something the harness itself could not do. Never changes the gates' verdict.
 *
 * Declared HERE, with the other module-level slots, and not beside its first
 * assignment further down: writeSummary() reads it, and the two could-not-run
 * paths call writeSummary() before any later declaration would have executed.
 * A `let` further down puts this name in the temporal dead zone for exactly
 * those two paths — which are the ones that must never crash, because they are
 * how a logged-out nightly reports "could not run" instead of a false red.
 */
let harnessProblem = null;

/**
 * Record one thing the harness could not do, and return just that message so a
 * console line stays about the thing that has only now gone wrong. The slot
 * accumulates (appendProblem), so a run that fails its stamp AND its prune
 * carries both into summary.json rather than only the later one.
 */
function noteHarnessProblem(message) {
  harnessProblem = appendProblem(harnessProblem, message);
  return message;
}

function killGroup(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
}

/**
 * SIGTERM, then SIGKILL if it is still there after the grace period. A child
 * that ignores SIGTERM must not outlive the runner: playwright is given time to
 * take its browser down cleanly, and then it is not asked twice.
 */
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise((resolve) => child.once("exit", resolve));
  killGroup(child, "SIGTERM");
  const killer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
  await ended;
  clearTimeout(killer);
}

async function stopServer() {
  const dying = server;
  server = null;
  await stopChild(dying);
}

async function finish(code) {
  if (finishing) return;
  finishing = true;
  // The gate child first, and awaited: it is the thing holding the browser and
  // the port's only client, and stopServer() below takes up to KILL_GRACE_MS.
  await stopChild(gateChild);
  await stopServer();
  process.exit(code);
}

// The last resort: an uncaught throw or a process.exit() from anywhere else
// still runs 'exit' handlers, and this one is synchronous, so nothing can leave
// vite OR a gate child behind. Signalling a group that is already gone is a
// no-op, which is why both are unconditional.
process.on("exit", () => {
  for (const child of [gateChild, server]) if (child) killGroup(child, "SIGKILL");
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    console.log(`\n${sig} — stopping the run and the server it started`);
    void finish(130);
  });
}

// --------------------------------------------------------------- could-run --

/**
 * Can this machine run the HOSTED gates at all? Two questions, both about the
 * machine and neither about the code:
 *
 *  - is there a GPU render node this user may open? logind hands the seat's
 *    active session an ACL on /dev/dri/renderD*, and takes it away at logout.
 *    At 03:30 on a logged-out build host, Chromium falls back to software and every
 *    arm goes red for a reason nobody should be woken for.
 *  - does Chromium launch, and does it then see WebGPU and WebGL2? The gates
 *    drive eight arms that need both, and the touch gate needs a GPU as much as
 *    the desktop ones do — a phone viewport is still a real renderer. The page
 *    is served by route interception rather than by the dev server, so this
 *    needs nothing running: it is a real http://localhost origin, which is what
 *    makes it a secure context and makes navigator.gpu visible at all.
 *
 * Note what is NOT checked: DISPLAY / WAYLAND_DISPLAY. Every gate launches
 * headless Chromium, which needs no display server — a run with both variables
 * unset is a normal green run, and the full run in this bead's report was done
 * that way to prove it. The seat ACL above is the part that really does depend
 * on someone being logged in.
 *
 * It is not called at all when no hosted gate is in the run (vect-hack-qv1):
 * `--only payload` on a logged-out machine is a run this preflight has nothing
 * to say about, and asking it would turn a gate that works there into exit 3.
 * The narrowing that comes with that: payload does drive its own Chromium, so a
 * missing playwright is reported by payload-check.mjs as a red gate rather than
 * as "could not run". The third verdict stays a statement about the GPU.
 */
async function preflight() {
  let entries;
  try {
    entries = await readdir("/dev/dri");
  } catch (err) {
    return `no /dev/dri at all (${err.code}): this machine has no GPU for the gates to use`;
  }
  const usable = (name) => {
    try { accessSync(`/dev/dri/${name}`, constants.R_OK | constants.W_OK); return true; }
    catch { return false; }
  };
  const nodeProblem = renderNodeProblem(entries, usable);
  if (nodeProblem) return nodeProblem;

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    return `playwright is not installed (${err.message.split("\n")[0]}): run npm install`;
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  } catch (err) {
    return `Chromium would not launch (${err.message.split("\n")[0]}): run npx playwright install chromium`;
  }
  try {
    const page = await browser.newPage();
    await page.route("**/gate-preflight", (route) => route.fulfill({
      contentType: "text/html", body: "<title>gate preflight</title>",
    }));
    await page.goto("http://localhost/gate-preflight");
    const probe = await page.evaluate(async () => ({
      webgpu: !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)),
      webgl2: !!document.createElement("canvas").getContext("webgl2"),
    }));
    if (!probe.webgpu || !probe.webgl2) {
      const missing = [!probe.webgpu && "a WebGPU adapter", !probe.webgl2 && "WebGL2"].filter(Boolean);
      return `Chromium launched but this browser has no ${missing.join(" and no ")}:`
        + ` the gates drive both backends, so there is nothing here for them to measure`;
    }
  } catch (err) {
    return `the GPU probe threw (${err.message.split("\n")[0]})`;
  } finally {
    await browser.close();
  }
  return null;
}

// ------------------------------------------------------------------ server --

async function answers(url, ms = 1000) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(ms) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reuse or start. Reuse matters as much as start does: a human debugging with
 * their own `npm run dev` open must not have it killed underneath them, which
 * is why nothing here kills a server it did not spawn.
 */
async function ensureServer(logPath) {
  if (await answers(URL_BASE)) return { mode: "reused", note: `already answering at ${URL_BASE}` };
  if (!MANAGED) {
    return { mode: "absent", note: `NH_URL is set to ${URL_BASE} and nothing answers there.`
      + ` The runner only manages its own server; start that one or unset NH_URL.` };
  }
  const log = createWriteStream(logPath);
  server = spawn("npm", ["run", "dev", "--", "--port", "5199", "--strictPort"], {
    cwd: repoRoot, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  let died = null;
  server.on("exit", (code, signal) => { died = signal ?? code; });
  server.on("error", (err) => { died = String(err); });

  const deadline = Date.now() + SERVER_MS;
  while (Date.now() < deadline) {
    if (died !== null) {
      return { mode: "absent", note: `the dev server exited (${died}) before answering; see ${logPath}` };
    }
    if (await answers(URL_BASE, SERVER_POLL_MS)) {
      return { mode: "started", note: `npm run dev -- --port 5199 --strictPort (pid ${server.pid})` };
    }
    await new Promise((r) => setTimeout(r, SERVER_POLL_MS));
  }
  return { mode: "absent", note: `the dev server did not answer at ${URL_BASE} within ${SERVER_MS / 1000}s; see ${logPath}` };
}

// ------------------------------------------------------------------- gates --

function runGate(gate) {
  const logPath = join(runDir, `${gate.name}.log`);
  const log = createWriteStream(logPath);
  const startedMs = Date.now();
  console.log(`\n=== ${gate.name} — npm run ${gate.npm} ===`);
  return new Promise((resolve) => {
    // Detached for the same reason the server is: playwright owns a browser
    // process, and a Ctrl-C must reach the whole tree rather than orphan it.
    //
    // NH_URL goes only to the gates that have a server to be pointed at.
    // Handing it to a standalone gate would tell it something untrue: payload
    // builds and serves its own, and this run may have started no server at all.
    const child = spawn(process.execPath, [join(here, gate.script)], {
      cwd: repoRoot, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: gate.standalone ? process.env : { ...process.env, NH_URL: URL_BASE },
    });
    gateChild = child;
    const tee = (stream, out) => stream.on("data", (d) => { out.write(d); log.write(d); });
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    let settled = false;
    // A child that never starts (ENOENT) emits 'error' and may never emit
    // 'exit'; bot-gym.mjs settles on either for the same reason.
    const done = (exitCode, signal, err) => {
      if (settled) return;
      settled = true;
      log.end();
      // Once finish() has begun, this gate's result is meaningless and the main
      // flow must not advance a single step: resolving here would let the loop
      // spawn the NEXT gate while the server is still being torn down, and that
      // child would be orphaned. Leaving the promise unsettled parks the flow
      // until finish() exits the process. gateChild deliberately stays set, so
      // the 'exit' handler can still SIGKILL its group.
      if (finishing) return;
      gateChild = null;
      if (err) console.error(`  FAIL: ${gate.name} would not start: ${err}`);
      resolve({
        name: gate.name, ok: !err && exitCode === 0 && !signal,
        exitCode: err ? null : exitCode, signal: signal ?? null,
        durationMs: Date.now() - startedMs, error: err ? String(err) : null,
      });
    };
    child.on("error", (err) => done(null, null, err));
    child.on("exit", (code, signal) => done(code, signal, null));
  });
}

// --------------------------------------------------------------- reporting --

function notify(urgency, title, body) {
  const r = spawnSync("notify-send", ["-a", "vect-hack", "-u", urgency, title, body], { timeout: 5000 });
  if (r.error || r.status !== 0) {
    // A desktop with no session bus is not a reason to change the run's
    // verdict; it is a reason to say the alarm did not get out.
    console.log(`  (could not notify: ${r.error?.message ?? `notify-send exited ${r.status}`})`);
    return false;
  }
  return true;
}

function git(args) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function writeSummary(extra) {
  const endedAtMs = Date.now();
  const summary = buildSummary({
    startedAt, endedAt: new Date(endedAtMs).toISOString(), durationMs: endedAtMs - startedAtMs,
    host: hostname(), gitSha: git(["rev-parse", "HEAD"]), gitDirty: !!git(["status", "--porcelain"]),
    url: URL_BASE, borgGateMs: Number(process.env.BORG_GATE_MS ?? 600000),
    harnessProblem,
    ...extra,
  });
  await writeFile(join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

/**
 * Housekeeping, and it may neither throw nor go unrecorded. Called before
 * writeSummary() on every path so a failure reaches summary.json rather than
 * only the journal — otherwise a state directory quietly growing for ever is
 * visible nowhere durable.
 */
async function pruneQuietly() {
  try {
    await prune();
  } catch (err) {
    console.error(`WARNING: ${noteHarnessProblem(
      `old runs could not be pruned under ${STATE_DIR}: ${err.message}`)}`);
  }
}

/** Keep the last KEEP_RUNS run directories; a nightly timer runs forever. */
async function prune() {
  const dirs = (await readdir(STATE_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name);
  for (const old of pruneList(dirs, KEEP_RUNS)) {
    await rm(join(STATE_DIR, old), { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------- main --

console.log(`vect-hack gates — ${opts.gates.map((g) => g.name).join(", ")}`);
console.log(`  artifact ${runDir}`);

const { standalone, hosted } = splitGates(opts.gates);
const results = [];

/** Drive one gate and keep the JSON report it wrote for itself, if any. */
async function drive(gate) {
  results.push(await runGate(gate));
  if (gate.report) {
    await copyFile(join(repoRoot, gate.report), join(runDir, gate.report.split("/").pop()))
      .catch((err) => console.log(`  (no ${gate.report} to keep: ${err.code})`));
  }
}

// The standalone gates first, before anything has been asked of the machine.
// This is the ordering vect-hack-qv1 turns on: payload needs no render node and
// no server, so on a logged-out machine it is the one gate that still says
// something, and it can only say it if it runs before the preflight below.
for (const gate of standalone) {
  // Belt and braces with runGate's own guard: this one catches a signal that
  // arrives in the gap between two gates, where there is no child to park on.
  if (finishing) break;
  await drive(gate);
}

// The GPU half. Its two preconditions are asked about only when a gate in this
// run actually needs them — `--only payload` starts no server and probes no
// render node — and either failing means those gates could not run, not that
// they failed. Whatever the standalone gates already found still stands and is
// still reported; verdictOf ranks the two.
let cannotRun = null;
let serverState = { mode: "not started", note: "no gate in this run needs one" };
if (hosted.length && !finishing) {
  cannotRun = await preflight();
  if (cannotRun) {
    // No server was started and none will be; summary.json says so in the slot
    // a reader looks in, rather than leaving the "nobody needed one" note there.
    serverState = { mode: "not started", note: cannotRun };
  } else {
    serverState = await ensureServer(join(runDir, "server.log"));
    if (serverState.mode === "absent") cannotRun = serverState.note;
  }
  if (cannotRun) {
    console.error(`\nCOULD NOT RUN: ${cannotRun}`);
    console.error(`This says nothing about the code — ${hosted.map((g) => g.name).join(", ")}`
      + ` ${hosted.length === 1 ? "was" : "were"} not driven.`);
  } else {
    console.log(`  server ${serverState.mode} — ${serverState.note}`);
    for (const gate of hosted) {
      if (finishing) break;
      await drive(gate);
    }
  }
}

const verdict = verdictOf(results, cannotRun);
console.log(`\n=== ${verdict.toUpperCase()} in ${durationText(Date.now() - startedAtMs)} ===`);
if (results.length) console.log(summaryLines(results).join("\n"));

// The stamp is last: it may only record a run that has already finished green.
// Stamping a failed run is precisely the failure this bead exists to prevent,
// so a red run refuses out loud rather than quietly skipping it. A run that
// could not be completed is refused the same way and for the same reason.
let stamped = false;
if (opts.stamp) {
  const checklist = join(repoRoot, "docs", "RELEASE-CHECKLIST.md");
  const tmp = `${checklist}.gate-run.tmp`;
  if (verdict !== "green") {
    const failed = results.filter((r) => !r.ok).map((r) => r.name).join(", ");
    console.error(`\n--stamp REFUSED: ${failed ? `${failed} failed` : `the run could not be completed`}`
      + `${cannotRun ? ` (${cannotRun})` : ""},`
      + ` and "Last verified green" may only record a green run.`);
  } else {
    // Written beside the file and renamed over it. rename(2) is atomic within a
    // filesystem, so a crash mid-write leaves a stray .tmp rather than a
    // truncated RELEASE-CHECKLIST.md — this is a TRACKED file, and half of one
    // is worse than none.
    //
    // stampVerified throws when the line is gone — or, since vect-hack-r1s,
    // when the sentence beside the date does not name a gate this run drove —
    // and that throw is caught here rather than left to become an unhandled
    // rejection: a nightly whose only symptom is exit 1 is indistinguishable
    // from a failing gate.
    try {
      const text = await readFile(checklist, "utf8");
      await writeFile(tmp, stampVerified(text, new Date().toISOString().slice(0, 10), opts.gates));
      await rename(tmp, checklist);
      stamped = true;
      console.log(`\nstamped docs/RELEASE-CHECKLIST.md — commit it with the release`);
    } catch (err) {
      noteHarnessProblem(`the stamp failed: ${err.message}`);
      console.error(`\n--stamp FAILED: ${err.message}`);
      console.error(`docs/RELEASE-CHECKLIST.md is unchanged, and the gates' own verdict stands.`);
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
}

// Neither of these may take the run down. The gates have already produced a
// verdict; losing the artifact is a separate failure and is reported as one.
// Prune first, so that a prune failure is still something summary.json can carry.
await pruneQuietly();
let summary = null;
try {
  summary = await writeSummary({ results, server: serverState, stamped, cannotRun });
  console.log(`\nartifact ${runDir}/summary.json`);
} catch (err) {
  console.error(`\nHARNESS PROBLEM: ${noteHarnessProblem(
    `the run artifact could not be written: ${err.message}`)}`);
  console.error(`The gates' verdict above still stands; only the record of it was lost.`);
}

// Only browser and controls are pushed at a human; the payload, borg and touch
// gates' failures are read in the summary above, in summary.json and in their
// own logs, all of which they still get. NOTIFYING_GATES in gate-run-utils.mjs
// says why for each. So the body is built from the notifiable failures alone —
// a run where payload, controls, touch and borg all failed must name only
// controls.
const pushed = notifiableFailures(results);
if (pushed.length) {
  notify("critical", `VectHack gates: ${pushed.map((r) => r.name).join(", ")} failed`,
    `${summaryLines(pushed).join("\n").trim()}\n${runDir}`
    + (harnessProblem ? `\n(also: ${harnessProblem})` : ""));
} else if (verdict === "could-not-run") {
  // The machine, not the code. Normal urgency, because it is not an alarm — and
  // it is sent even when a standalone gate did run and pass, since the run
  // still failed to answer the question it was started to answer.
  notify("normal", "VectHack gates: could not run", `${cannotRun}\n${runDir}`);
} else if (!summary) {
  // Nothing else was going to say anything, and the run's own record is gone.
  // Distinct from both "a gate failed" and "could not run": the gates ran.
  notify("normal", "VectHack gates: the run could not be recorded",
    `${verdict.toUpperCase()} — ${harnessProblem}\n${runDir}`);
}
// Nothing on green on purpose: a nightly success notification is noise, and
// noise is what trains the eye to dismiss the failure one.

// The gates' own verdict, never the summary's: the summary may not exist.
await finish(EXIT_FOR_VERDICT[verdict]);

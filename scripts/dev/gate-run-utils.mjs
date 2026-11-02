/**
 * The pure half of scripts/dev/gate-run.mjs — argument parsing, the run
 * summary, the freshness-stamp rewriter, the artifact prune list and the
 * render-node check. Split out for the same reason moria-gate-utils.mjs is:
 * a gate script does its work at import time, so nothing inside one can be
 * unit tested. scripts/test/gate-run.test.ts is what tests this file.
 */
import { parseArgs } from "node:util";

/**
 * The five gates, in the order a run drives them. The invariant is borg LAST,
 * not cheapest first — browser is 62s, controls 22s and touch 9s, so the first
 * three have never been in cost order and the old "cheapest first" was already
 * loose before touch was inserted between them. What the order has to buy is
 * that the ten-minute borg gate is spent only after everything else has had its
 * say, so a red run usually goes red before it starts. `report` is the
 * JSON the gate writes into .preview/ on its own; the runner copies it into
 * the run directory, because .preview/ is overwritten by the next run and the
 * artifact is meant to outlive it. A gate that writes only screenshots keeps
 * `null`: browser-check.mjs leaves several in .preview/ too and none of them is
 * copied, so touch's one phone shot follows that precedent rather than turning
 * `report` into "any file the gate happened to write".
 *
 * touch sits third rather than last because it is fast and deterministic, and
 * the borg gate is neither: a human watching a run gets touch's answer inside
 * the first two minutes instead of behind ten minutes of unattended play
 * (vect-hack-hnw).
 *
 * `standalone` is the one thing that makes payload a different animal, and it
 * is a property of the GATE rather than a second runner (vect-hack-qv1).
 * payload-check.mjs runs its own `vite build` and `vite preview` and takes the
 * tty view, so it needs neither the runner's dev server on 5199 nor a render
 * node — the two preconditions the whole preflight-and-server apparatus exists
 * to establish. Marking it here rather than adding a second gate category
 * follows vect-hack-hnw's shape: a gate is a row in this table, and the runner
 * reads the row.
 *
 * Which is why payload runs FIRST rather than in cost order. It is the only
 * gate that can be driven before the preflight has decided whether the rest can
 * be driven at all, so a machine with no reachable GPU — a logged-out nightly,
 * exactly the case the third verdict exists for — still gets one real answer
 * instead of "could not run" for everything. It also finishes its `vite build`
 * before the dev server starts, which keeps the two off each other.
 */
export const GATES = [
  { name: "payload", script: "payload-check.mjs", npm: "check:payload", report: ".preview/payload.json", standalone: true },
  { name: "browser", script: "browser-check.mjs", npm: "check:browser", report: ".preview/browser-check.json", standalone: false },
  { name: "controls", script: "fp-controls-check.mjs", npm: "check:controls", report: null, standalone: false },
  { name: "touch", script: "touch-check.mjs", npm: "check:touch", report: null, standalone: false },
  { name: "borg", script: "angband-borg-check.mjs", npm: "check:angband-borg", report: ".preview/angband-borg-gate.json", standalone: false },
];

/**
 * A run's gates split into the two kinds, each keeping GATES order. `hosted`
 * is what the preflight and the dev server are for; `standalone` needs neither
 * and so is not held up by either. Either half may be empty — `--only payload`
 * drives no hosted gate and must therefore start no server, and `--only
 * browser` must not drag a 40s production build in behind it.
 */
export function splitGates(gates) {
  return {
    standalone: gates.filter((g) => g.standalone),
    hosted: gates.filter((g) => !g.standalone),
  };
}

/**
 * Exit codes. `cannotRun` is the whole point of having more than two: a nightly
 * run that never reached a GPU has told you nothing about the code, and
 * reporting that as a failure is how a real failure gets ignored.
 */
export const EXIT = { green: 0, red: 1, usage: 2, cannotRun: 3 };

/** verdictOf's three answers, as the process's three answers. */
export const EXIT_FOR_VERDICT = {
  green: EXIT.green, red: EXIT.red, "could-not-run": EXIT.cannotRun,
};

export const USAGE = `usage: gate-run.mjs [--only <gate>[,<gate>]] [--stamp]

  --only    run a subset; gates: ${GATES.map((g) => g.name).join(", ")}
            (payload needs no GPU and no server, so --only payload runs on a
            machine where the other four cannot)
  --stamp   on an all-green full run, rewrite the "Last verified green" date in
            docs/RELEASE-CHECKLIST.md. Never passed by the nightly timer, and
            refused unless that sentence names every gate this run drove.

env: NH_URL     an existing server to test against; the runner then starts and
                stops nothing (default http://localhost:5199/, managed here)
     BORG_GATE_MS  passed through to the borg gate (120000 is the short pre-gate)`;

/**
 * Parse and validate, or throw a message that is fit to print on its own. Both
 * refusals below happen here rather than 25 minutes later: `--stamp` with a
 * partial run would write "verified green" over a line that claims all ten
 * arms, and a misspelled gate name would otherwise silently run fewer gates
 * than asked for — the same class of quiet under-run this bead exists to stop.
 */
export function parseGateArgs(argv, env = process.env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        only: { type: "string" },
        stamp: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    throw new Error(`${err.message}\n\n${USAGE}`, { cause: err });
  }
  if (values.help) return { gates: [], stamp: false, help: true };

  const asked = values.only === undefined
    ? GATES.map((g) => g.name)
    : values.only.split(",").map((s) => s.trim()).filter(Boolean);
  if (!asked.length) throw new Error(`--only named no gate\n\n${USAGE}`);
  const unknown = asked.filter((n) => !GATES.some((g) => g.name === n));
  if (unknown.length) {
    throw new Error(`unknown gate: ${unknown.join(", ")}\n\n${USAGE}`);
  }
  // Always in GATES order, however --only listed them: the run order is a
  // property of the gates (cheapest first), not of the command line.
  const gates = GATES.filter((g) => asked.includes(g.name));
  if (values.stamp && gates.length !== GATES.length) {
    throw new Error(`--stamp refuses a partial run: the checklist line it writes claims every gate,`
      + ` and this run would only drive ${gates.map((g) => g.name).join(", ")}.\n\n${USAGE}`);
  }
  // The stamp records "this tree was verified green", and the summary beside it
  // names this checkout's sha. With NH_URL set the gates drove somebody else's
  // server, whose code this process cannot see — stamping that is the same kind
  // of lie as stamping a red run, so it is refused rather than guessed at.
  if (values.stamp && env.NH_URL) {
    throw new Error(`--stamp refuses a run against NH_URL (${env.NH_URL}): the gates would test that`
      + ` server while the stamp claims this checkout was verified. Drop --stamp, or unset NH_URL`
      + ` and let the runner start its own server.\n\n${USAGE}`);
  }
  return { gates, stamp: values.stamp, help: false };
}

/**
 * Add one harness problem to whatever has already been recorded.
 *
 * Appends rather than overwrites, because a single run really can hit more than
 * one: a `--stamp` that threw AND a prune that failed. The slot they share used
 * to keep only the last, so the first survived nowhere but the console — and
 * the console is not a channel for a run nobody watched.
 *
 * It stays a single string rather than becoming an array on purpose.
 * `harnessProblem` is `string | null` in summary.json, and that file is a record
 * format now; both consumers — a human reading the artifact, and the
 * notification body that appends "(also: …)" — want one readable sentence
 * rather than something to iterate. Joining with "; " keeps the shape.
 */
export function appendProblem(existing, message) {
  return existing ? `${existing}; ${message}` : message;
}

/**
 * The gates whose failure is pushed at a human by notify-send.
 *
 * This is a deliberate two-gate list, not the set of gates that happened to
 * exist first (Eric, 2026-08-26). browser and controls are the two that mean
 * the desktop client's core rendering or control path broke, and that is the
 * whole of what this channel carries.
 *
 * The borg gate is deliberately not one of them. It watches a ten-minute
 * unattended play session whose outcome is partly luck — the borg's character
 * may simply die — so its failures are meant to be read deliberately rather
 * than pushed at someone.
 *
 * The touch gate is deliberately not one of them either, and the reason is
 * different enough to be worth writing down, because the obvious objection is
 * right about the mechanism: touch-check.mjs is deterministic, which is exactly
 * what usually makes a gate a good notification candidate. The touch scheme is
 * a spike behind `?touch` with two open beads still to land against it
 * (vect-hack-21k, vect-hack-lxd), so it is churning code — and a gate on
 * churning code goes red for expected reasons, which is how a notification
 * channel gets trained out of a person. Widening the channel is a decision to
 * take once the touch scheme has settled, not one to inherit from this bead.
 *
 * The payload gate is deliberately not one either, and neither of those two
 * reasons is why (vect-hack-qv1). It is deterministic AND it watches settled
 * code, so the excuses that keep borg and touch out do not apply. It is out on
 * CONSEQUENCE: browser and controls mean the desktop client will not render or
 * will not steer, and a payload leak means the download got bigger — a real
 * regression, and nobody is unable to play. It fails the run, sets the exit
 * code, and is read in the morning. A third name goes in this set when someone
 * has been bitten by not having it, not because the gate is good.
 *
 * This is one reporting channel and nothing else. A non-notifying gate's
 * failure still appears in the printed summary, still lands in summary.json,
 * still keeps its full log, and still decides the run's exit code. There is no
 * advisory gate here and no severity concept — just this list.
 */
const NOTIFYING_GATES = new Set(["browser", "controls"]);

/**
 * The failures a notification may name. A run in which only the payload, borg
 * or touch gates failed notifies nobody; a run in which controls, touch and
 * borg all failed notifies about controls and mentions neither of the others.
 */
export function notifiableFailures(results) {
  return results.filter((r) => !r.ok && NOTIFYING_GATES.has(r.name));
}

/**
 * The freshness stamp. It replaces the date and nothing else: the prose after
 * it ("ten arms — all four Modules on ...") is a human's claim about what the
 * gates cover, and a runner that rewrote it would be inventing coverage.
 *
 * It throws when the line is absent rather than returning the text unchanged.
 * A rewriter that silently matches nothing is the classic failure here — the
 * stamp would go on reporting success while the file it was meant to edit had
 * moved on years ago.
 *
 * And since vect-hack-r1s it VERIFIES that prose instead of trusting it. The
 * line pairs a date the runner writes, which cannot rot, with a gate list a
 * human maintains, which rotted inside twenty-four hours: `check:touch` landed
 * on a parallel branch and the sentence went on naming three gates while a run
 * drove four, and the stamp re-dated the stale claim without a word. So the
 * fourth refusal, beside the three in parseGateArgs and the red-run one in
 * gate-run.mjs: every gate the run actually drove must be NAMED in the
 * sentence, by its npm script name, or the stamp refuses and says which is
 * missing. Same mechanism as the other three — refuse rather than guess.
 *
 * WHAT THIS DOES NOT CATCH, and it is deliberate: a stale COUNT. "85 checks"
 * becoming 90, or "ten arms" becoming twelve, leaves every gate mentioned and
 * the sentence still wrong. Closing that needs option B in vect-hack-r1s —
 * every gate emitting a structured coverage report the stamp composes from —
 * and the cost there is not the composer but agreeing a schema four
 * differently-shaped gates can fill honestly. Judged not worth its price; read
 * that bead before deciding otherwise.
 *
 * The mention test is the npm name (`check:browser`, `check:angband-borg`)
 * rather than the gate's short name, because that is exact: `borg` alone would
 * match the word in any passing remark, and the checklist already writes gates
 * this way.
 */
const STAMP_RE = /^(Last verified green: \*\*)(\d{4}-\d{2}-\d{2})(\*\*)/m;

export function stampVerified(text, date, gates) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`the stamp date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  }
  const at = text.match(STAMP_RE);
  if (!at) {
    throw new Error(`no "Last verified green: **<date>**" line to stamp — the runner will not invent one.`
      + ` Restore that line in docs/RELEASE-CHECKLIST.md or drop --stamp.`);
  }
  // The sentence is the whole paragraph that line starts — it wraps over
  // several lines — and it ends at the blank line. Scoped rather than
  // file-wide on purpose: every gate is named further down in the command
  // block, so searching the file would make this check unable to fail.
  const end = text.indexOf("\n\n", at.index);
  const sentence = end === -1 ? text.slice(at.index) : text.slice(at.index, end);
  const missing = gates.filter((g) => !sentence.includes(g.npm));
  if (missing.length) {
    throw new Error(`this run drove ${missing.map((g) => g.name).join(", ")}, and the`
      + ` "Last verified green" sentence does not mention ${missing.map((g) => `\`${g.npm}\``).join(", ")}.`
      + ` A date the runner writes beside a gate list nobody updates is how that line went stale`
      + ` (vect-hack-r1s). Say what this run covered in docs/RELEASE-CHECKLIST.md, then stamp it.`);
  }
  return text.replace(STAMP_RE, `$1${date}$3`);
}

/**
 * The run's one verdict, in precedence order.
 *
 * A gate that RAN and failed outranks "could not run", and that order is the
 * whole reason this takes two arguments. Since vect-hack-qv1 a run can be both:
 * `payload` needs no GPU and drives on a machine the four browser gates never
 * reach, so a logged-out nightly can hold a real payload regression AND a
 * preflight failure at once. Reporting that as "told you nothing" would file
 * the finding under the excuse.
 *
 * Otherwise unchanged: could-not-run when the machine stopped the run, green
 * only when every gate that ran passed and something did run.
 *
 * @param {{ ok: boolean }[]} results
 * @param {string | null} [cannotRun]
 */
export function verdictOf(results, cannotRun = null) {
  if (results.some((r) => !r.ok)) return "red";
  if (cannotRun) return "could-not-run";
  return results.length ? "green" : "red";
}

/**
 * The artifact a nightly run leaves behind. The verdict is verdictOf's, so the
 * file can never contradict the exit code: `cannotRun` outranks a clean gate
 * list — the whole point of the third verdict is that a reader of these files
 * can tell "the gates failed" from "the gates never got to run" — and a gate
 * that actually failed outranks `cannotRun` in turn.
 */
export function buildSummary(run) {
  const results = run.results;
  return {
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    verdict: verdictOf(results, run.cannotRun),
    cannotRun: run.cannotRun ?? null,
    // Something the harness itself could not do: the stamp, the prune, or the
    // artifact write itself. It never changes the verdict — the gates' own
    // result stands — but a nightly that quietly lost half its record should
    // say so in the half it kept. All three really can land here: the prune
    // runs BEFORE this is built (gate-run.mjs's pruneQuietly), and a failed
    // artifact write is reported to the console because by then there is
    // nowhere durable left to put it.
    harnessProblem: run.harnessProblem ?? null,
    host: run.host,
    git: { sha: run.gitSha, dirty: run.gitDirty },
    url: run.url,
    server: run.server,
    borgGateMs: run.borgGateMs,
    stamped: run.stamped ?? false,
    gates: results.map((r) => ({
      name: r.name, ok: r.ok, exitCode: r.exitCode, signal: r.signal ?? null,
      durationMs: r.durationMs, log: `${r.name}.log`,
    })),
  };
}

export function durationText(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** One line per gate, for the human watching and for the notification body. */
export function summaryLines(results) {
  return results.map((r) => `  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(9)} `
    + `${durationText(r.durationMs).padStart(6)}  exit ${r.signal ?? r.exitCode}`);
}

/**
 * Which run directories to delete, keeping the newest `keep`. The names are
 * timestamps, so lexical order is chronological — that is the only reason this
 * needs no stat() and works on a directory listing alone.
 */
export function pruneList(dirs, keep) {
  const sorted = [...dirs].sort();
  return sorted.slice(0, Math.max(0, sorted.length - keep));
}

/**
 * Whether this machine can hand Chromium a GPU at all, decided from a listing
 * of /dev/dri and a predicate that says whether one node is usable.
 *
 * This is the logged-out case, and it is why the runner has a "could not run"
 * verdict. logind hands the seat's active session an ACL on the render node
 * (a `user:<login>:rw-` entry); log out and that entry goes away, so at 03:30 on
 * a machine nobody is logged into, Chromium falls back to software rendering
 * and every arm goes red for a reason that has nothing to do with the code.
 */
export function renderNodeProblem(entries, usable) {
  const nodes = entries.filter((n) => n.startsWith("renderD"));
  if (!nodes.length) {
    return "no /dev/dri/renderD* render node: this machine has no GPU for the gates to use";
  }
  if (!nodes.some(usable)) {
    return `no render node in /dev/dri is readable by this user (${nodes.join(", ")}):`
      + ` logind grants that access to the seat's active session, so a logged-out machine cannot run these gates`;
  }
  return null;
}

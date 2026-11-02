// The reflect host: a batch of played games in, one transcript per game and a
// rewritten knowledge base out (spec:
// docs/specs/2026-08-19-bot-phase1b-larn-reflect-design.md, "The
// spine"). Everything upstream of here is pure — src/bot/ and the Larn digest
// builder may not touch a filesystem, because the browser bot shares them — so
// this script is where all the I/O of the loop lives: it reads the batch,
// hands values to the pure code, and writes what comes back.
//
// Three things it is responsible for beyond wiring.
//
// **The transcript.** An LLM is stochastic, so a fact whose only record is the
// fact itself is an artifact nobody can rebuild or review. Every call writes
// <run>/reflection.json with the model that served it, the exact prompt, the
// raw reply, the parse (deltas or the reason there are none) and the sha256 of
// the trajectory those deltas cite. That hash is the audit link from a claim's
// evidence to the bytes it was drawn from.
//
// **The probe gates the batch, except for one named kind.** A claim that
// survives the same digest with its death taken away came from the model's
// priors, not from the dungeon (reflect.ts, stripDeathEvidence/partitionLeaks).
// Every run is reflected first and a sample is probed afterwards, so a fatal
// leak fails the whole batch before a single byte of facts.json is rewritten —
// a laundered prior that landed and was cleaned up later would already have
// been read by whatever ran in between. `avoid-terrain` leaks no longer fail
// it: they are admitted, printed, and carried into the run's own transcript
// (PRIOR_ADMISSIBLE_KINDS, vect-hack-b5f.23). A pass that admits one says so on
// stdout, because a hole nobody is told about is indistinguishable from a gate
// that stopped working.
//
// **Only parsed deltas reach the applier.** applyDeltas trusts its caller to
// have normalized the claims; parseDeltaDocument is the only thing that does.
// Nothing here may hand it a delta it built itself.
//
// **The transcript is also the resume record.** A pass over 200 games is five
// hours of model calls, and before vect-hack-b5f.13 one dropped socket at run
// 67 threw away 66 finished reflections: every run was re-asked from the
// start, so there was no way to continue. reflection.json already holds the
// exact prompt and the sha256 of the trajectory the reply was drawn from,
// which is exactly what says whether a recorded reply still answers the
// question being asked — so it is reused when both match and the run is
// re-asked when either does not. The recorded *raw* is reused, never the
// recorded parse: parseDeltaDocument is the only thing allowed to normalize a
// delta, and a stored parse from an older parser would smuggle one past it.
// Reuse is also the more reproducible half of the choice, not the less. On the
// local Brain temperature 0 and a fixed seed make a re-ask nominally
// identical, but server-side batching can still move a token; on the cloud
// Brain there is no sampling control to pin at all, so a re-ask is a re-roll.
// Either way the transcript is what makes a pass repeatable, and `--no-reuse`
// forces fresh calls when a re-run is what was wanted.
//
// The model is deliberately not part of that test. A pass resumed under a
// different `--model` is a batch with two models in it, and every transcript
// names the one that actually answered it — so that is a visible fact about
// the batch rather than a silent one, and `--no-reuse` is how to refuse it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readTrajectoryLines } from "./trajectory-read.mjs";
import { localBrain, replayBrain } from "../../src/bot/brain.ts";
import { claudeBrain, DEFAULT_EFFORT, DEFAULT_MODEL, EFFORT_LEVELS } from "./brain-claude.mjs";
import { runGrounds } from "../../src/bot/digest.ts";
import { applyDeltas, parseDeltaDocument, serializeFacts } from "../../src/bot/factDelta.ts";
import { buildReflectPrompt, partitionLeaks, stripDeathEvidence } from "../../src/bot/reflect.ts";
import { buildLarnDigest } from "../../src/modules/larn/bot/digest.ts";
import { retryingFetch } from "./brain-fetch.mjs";
import { larnKb } from "./bot-kb.mjs";

/** The local Brain's default. Not `DEFAULT_MODEL`'s neighbour by accident: a
 *  model id is meaningless across brains, so each brain names its own and
 *  `--model` overrides whichever one is in play. */
const LOCAL_MODEL = "qwen38-q5";

const USAGE = `usage: bot-reflect.mjs --batch <dir> [--kb data/kb] [--brain local|claude|replay]
       [--replay <dir>] [--url http://127.0.0.1:8090/v1] [--model <id>]
       [--effort ${DEFAULT_EFFORT}] [--probe-sample 5] [--archive <dir>] [--no-reuse] [--dry-run] [--ship]

--brain claude shells out to the \`claude -p\` CLI and uses its login; nothing
else is needed to authorize a pass. --model defaults per brain: local
${LOCAL_MODEL}, claude ${DEFAULT_MODEL}. --url and --effort each apply to one
brain: --url to local, --effort to claude.`;

const { values: opts } = parseArgs({
  options: {
    batch: { type: "string" },
    kb: { type: "string", default: "data/kb" },
    brain: { type: "string", default: "local" },
    replay: { type: "string" },
    url: { type: "string", default: "http://127.0.0.1:8090/v1" },
    model: { type: "string" },
    effort: { type: "string", default: DEFAULT_EFFORT },
    "probe-sample": { type: "string", default: "5" },
    archive: { type: "string" },
    "no-reuse": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    // Promote the applied fact set into the repo's own data/kb. Without it a
    // pass whose --kb IS data/kb refuses to write (vect-hack-h9x.16).
    ship: { type: "boolean", default: false },
  },
});

/** Is this path the repo's own shipped knowledge base? Resolved, not compared
 *  as text: `data/kb`, `./data/kb`, an absolute path to it and a path reached
 *  through a symlink are all the same directory, and a guard that only knew
 *  the string would be a guard against typing it one particular way. */
function isShippedKb(dir) {
  const shipped = fileURLToPath(new URL("../../data/kb", import.meta.url));
  try { return realpathSync(resolve(dir)) === realpathSync(shipped); } catch { return false; }
}

const die = (msg) => { console.error(msg); process.exit(2); };
if (!opts.batch) die(USAGE);
if (!["local", "claude", "replay"].includes(opts.brain)) die(`--brain must be local, claude or replay, got ${opts.brain}\n${USAGE}`);
if (opts.brain === "replay" && !opts.replay) die(`--brain replay needs --replay <dir>\n${USAGE}`);
if (!EFFORT_LEVELS.includes(opts.effort)) die(`--effort must be one of ${EFFORT_LEVELS.join(", ")}, got ${opts.effort}`);
const probeSample = Number(opts["probe-sample"]);
if (!Number.isInteger(probeSample) || probeSample < 1) die(`--probe-sample must be a positive integer, got ${opts["probe-sample"]}`);
// The three files larnKb reads. Checking them here rather than at the write is
// what stops a whole batch of model calls from being spent against a KB path
// that was never going to load.
for (const rel of ["meta/facts.json", "larn/facts.json", "larn/policy.json"]) {
  if (!existsSync(join(opts.kb, rel))) die(`--kb ${opts.kb} is not a knowledge base: ${rel} is missing`);
}
// The shipped KB is not a scratch directory (vect-hack-h9x.16). Two throwaway
// probe passes over 5 games each once left 12 facts in data/kb/larn/facts.json:
// a knowledge state nobody decided to ship, sitting in the file a browser ?bot
// game loads, the unit suite asserts against, and every `--kb data/kb`
// evaluation arm means. It was caught only because the NEXT pass printed a
// fact count where it should have printed 0. It also breaks the r3/r4c
// convention that a NO-SHIP fact set leaves data/kb empty — the one thing that
// makes "empty" mean anything.
//
// So writing it is a deliberate act with its own flag. Any other --kb is an
// experiment directory by construction and is written freely. Refused HERE and
// not at the write, for the same reason as the check above: a pass over 200
// games is five hours of model calls, and discovering at the end that none of
// them may be written is the expensive way to learn it.
if (isShippedKb(opts.kb) && !opts.ship && !opts["dry-run"]) {
  die(`refusing to write the shipped KB at ${opts.kb} without --ship.\n`
    + "  Use --kb <a scratch directory> for an experiment, --dry-run to apply and write nothing,\n"
    + "  or --ship to promote this pass's facts into the repo's knowledge state.");
}

/** The game ended and taught something. timeout and fatal are harness
 *  artifacts — the orchestrator's clock or a crash — and a model asked to draw
 *  a lesson from one would be reflecting on our bug, not on the dungeon. */
const REFLECTABLE = new Set(["died", "won", "capped"]);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Every run directory in the batch, in run-id order: the batch is a set of
 *  games, and which one the filesystem happened to hand back first must not
 *  change the order deltas are applied in. */
function readBatch(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "summary.json")))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ dir: join(dir, name), summary: readJson(join(dir, name, "summary.json")) }));
}

/** Recorded replies keyed by the run id (and `<id>#probe` for probe calls), so
 *  a fixture can never be served for the wrong run. */
function readReplay(dir) {
  const out = {};
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".txt")) out[name.slice(0, -".txt".length)] = readFileSync(join(dir, name), "utf8");
  }
  return out;
}

const runs = readBatch(opts.batch);
if (runs.length === 0) die(`--batch ${opts.batch} holds no run directories`);

const brain = opts.brain === "replay"
  ? replayBrain(readReplay(opts.replay))
  : opts.brain === "claude"
    ? claudeBrain({ model: opts.model ?? DEFAULT_MODEL, effort: opts.effort })
    : localBrain({ url: opts.url, model: opts.model ?? LOCAL_MODEL, fetchFn: retryingFetch() });

// The prompt lists everything the bot knows — both tiers, the way the ladder
// reads them — but only the engine tier is ever rewritten: a meta fact applied
// through claimId("larn", ...) would be copied into the Larn file and the two
// tiers would stop being distinguishable.
const engineFactsPath = join(opts.kb, "larn/facts.json");
const engineFacts = readJson(engineFactsPath).facts;
const knownFacts = [...readJson(join(opts.kb, "meta/facts.json")).facts, ...engineFacts];
console.log(`kb ${opts.kb}: ${knownFacts.length} known facts, tables hash ${larnKb(opts.kb).hash}`);

// Evidence must name the trajectory of the run the delta was reflected from,
// and a window inside that run's event count. The model is told the rule
// (reflect.ts) but cannot be trusted to keep it, and an unfalsifiable citation
// is worse than no citation. The scope is one run rather than the whole batch
// on purpose: a delta drawn from run A that cites run C names a range that is
// real, in this batch and in bounds, and is still a misattribution — and a
// provenance record that names the wrong game certifies a fact nothing
// supports.
const citableIn = (summary) => (e) =>
  e.trajectory === summary.id && e.from >= 0 && e.from < e.to && e.to <= summary.events;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** One run's transcript, rewritten in place when the probe adds to it. */
function writeReflection(run) {
  writeFileSync(join(run.dir, "reflection.json"), JSON.stringify(run.reflection, null, 2) + "\n");
}

/** The transcript a previous pass left beside this run, or null. A file that
 *  will not parse is treated as absent rather than as an error: the way a
 *  transcript goes bad is a process killed mid-write, which is the very case
 *  resuming exists for, and refusing to continue would be the old failure
 *  under a new name. */
function readReflection(dir) {
  if (opts["no-reuse"]) return null;
  const path = join(dir, "reflection.json");
  if (!existsSync(path)) return null;
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

/** Whether a recorded call still answers the question about to be asked.
 *  Field by field rather than through JSON.stringify: a match must be about
 *  the two strings the model was shown, not about the key order a serializer
 *  happened to use. */
const sameRequest = (recorded, request) =>
  recorded?.system === request.system && recorded?.user === request.user;

/** A recorded reply, or a fresh one from the Brain. `raw` is what gets reused;
 *  the caller re-parses it, because the stored parse may be an older parser's.
 *  Returns the served model too, so a resumed transcript still names the model
 *  that actually answered rather than the one this pass asked for. */
async function ask(key, request, recorded) {
  if (recorded && typeof recorded.raw === "string" && sameRequest(recorded.request, request)) {
    return { raw: recorded.raw, model: recorded.model ?? "unrecorded", reused: true };
  }
  return { ...await brain.reflect(key, request), reused: false };
}

// --- Reflect every run, then probe a sample of them. -------------------------
// In that order, and not interleaved: the probe's verdict is about the batch,
// so a batch that is going to fail must fail before anything is written to the
// knowledge base, whichever run leaked.

const reflected = [];
let reusedCalls = 0;
for (const run of runs) {
  const { summary } = run;
  if (!REFLECTABLE.has(summary.outcome)) {
    console.log(`${summary.id}  skipped (${summary.outcome})`);
    continue;
  }
  const gz = readFileSync(join(run.dir, "trajectory.jsonl.gz"));
  // Streamed, not decoded whole: a capped run runs past node's string ceiling
  // and used to end the pass at whichever run first hit the cap — see
  // scripts/dev/trajectory-read.mjs. The bytes above are still read whole,
  // because the hash below is a claim about the file, not about its text.
  const digest = buildLarnDigest(await readTrajectoryLines(join(run.dir, "trajectory.jsonl.gz")), summary);
  const request = buildReflectPrompt(digest, knownFacts, summary.id, summary.events);
  const trajectorySha256 = sha256(gz);
  // The hash is checked here and not inside `ask`, because it is a claim about
  // the run rather than about the call: a transcript drawn from different
  // bytes cannot be reused, and neither can the probe recorded beside it.
  const recorded = readReflection(run.dir);
  const usable = recorded?.trajectorySha256 === trajectorySha256 ? recorded : null;
  const { raw, model, reused } = await ask(summary.id, request, usable);
  const parse = parseDeltaDocument(raw);

  run.digest = digest;
  run.reflection = { model, request, raw, parse, trajectorySha256 };
  // Carried across so a pass killed during the probe phase does not have to
  // re-probe what it already probed. Only when the reflection itself was
  // reused: a probe's verdict is a comparison against this run's deltas, and
  // one recorded against a reply that has just been re-asked is about a
  // different pair of answers.
  if (reused && usable.probe) run.reflection.probe = usable.probe;
  writeReflection(run);
  reflected.push(run);
  if (reused) reusedCalls++;
  console.log(`${summary.id}  ${parse.deltas.length} deltas${parse.error ? `  parse: ${parse.error}` : ""}${reused ? "  (reused)" : ""}`);
}

if (reflected.length === 0) {
  console.error(`no reflectable runs in ${opts.batch}: every game was a harness artifact`);
  process.exit(1);
}

// Every k-th run, so the sample is spread across the batch rather than taken
// off the front — a batch whose first games all died in the town would
// otherwise be probed entirely on its shortest runs.
const stride = Math.max(1, Math.floor(reflected.length / probeSample));
const leaks = [];
const admittedLeaks = [];
for (let i = 0; i < reflected.length; i += stride) {
  const run = reflected[i];
  const { summary } = run;
  const request = buildReflectPrompt(stripDeathEvidence(run.digest), knownFacts, summary.id, summary.events);
  const { raw, model, reused } = await ask(`${summary.id}#probe`, request, run.reflection.probe ?? null);
  const parse = parseDeltaDocument(raw);
  // Recomputed even on a reuse: `leaked` is a verdict, and the applier's rule
  // that only freshly parsed deltas count applies to both sides of it.
  const { admitted, fatal } = partitionLeaks(run.reflection.parse.deltas, parse.deltas);
  const leaked = [...admitted, ...fatal].sort();

  // Both lists are stored, not just the verdict: an admitted leak is the one
  // record that a terrain fact may be the model's prior rather than the bot's
  // experience, and the transcript is the only place that record can live.
  run.reflection.probe = { model, request, raw, parse, leaked, admitted, fatal };
  writeReflection(run);
  if (reused) reusedCalls++;
  if (fatal.length > 0) leaks.push({ id: summary.id, leaked: fatal });
  if (admitted.length > 0) admittedLeaks.push({ id: summary.id, leaked: admitted });
  const mark = [
    fatal.length ? `  LEAK: ${fatal.join(", ")}` : "",
    admitted.length ? `  ADMITTED PRIOR: ${admitted.join(", ")}` : "",
  ].join("");
  console.log(`${summary.id}#probe  ${parse.deltas.length} deltas${mark}${reused ? "  (reused)" : ""}`);
}
if (reusedCalls > 0) console.log(`reused ${reusedCalls} recorded reply/replies; pass --no-reuse to re-ask the model`);

if (opts.archive) {
  mkdirSync(opts.archive, { recursive: true });
  for (const run of reflected) {
    writeFileSync(join(opts.archive, `${run.summary.id}.json`), JSON.stringify(run.reflection, null, 2) + "\n");
  }
  console.log(`archived ${reflected.length} transcripts to ${opts.archive}`);
}

if (admittedLeaks.length > 0) {
  console.log(`ablation probe: ${admittedLeaks.length} of ${Math.ceil(reflected.length / stride)} probed run(s) restated a terrain claim with the evidence removed — ADMITTED, not refused (vect-hack-b5f.23)`);
  for (const l of admittedLeaks) console.log(`  ${l.id}: ${l.leaked.join(", ")}`);
  console.log(`  Terrain facts in this pass may rest on the model's knowledge of roguelikes rather than on this bot's play. Any report drawn from them has to say so.`);
}
if (leaks.length > 0) {
  console.error(`ablation probe: ${leaks.length} run(s) restated a claim with the evidence removed — facts.json NOT written`);
  for (const l of leaks) console.error(`  ${l.id}: ${l.leaked.join(", ")}`);
  process.exit(1);
}
if (reflected.every((r) => r.reflection.parse.deltas.length === 0 && r.reflection.parse.error !== null)) {
  console.error(`every reflection in ${opts.batch} failed to parse — facts.json NOT written`);
  process.exit(1);
}

// --- Apply. ------------------------------------------------------------------
// One applier call per run, in run order, so two hosts over the same batch
// build the same file: the citation scope travels with the deltas, which is
// what a batch-wide call cannot express. One clock for the whole pass, so the
// stamps do not depend on how long the applier took. Only deltas that came
// back out of parseDeltaDocument: applyDeltas trusts its caller for claim
// normalization.
const now = new Date().toISOString();
let facts = engineFacts;
let accepted = 0;
const rejections = [];
for (const run of reflected) {
  const result = applyDeltas(facts, run.reflection.parse.deltas, {
    engine: "larn", now, evidenceExists: citableIn(run.summary),
    // The digest's own subjects, not the model's word for them: a threat
    // delta may only be about the being this run's screen showed killing the
    // hero (vect-hack-b5f.4), and an avoid-terrain delta only about an exit
    // this run's hero chose to step onto (vect-hack-b5f.6). The prompt was
    // built from the same derivation, so nothing offered there is refused
    // here.
    grounds: runGrounds(run.digest),
  });
  facts = result.facts;
  accepted += result.accepted;
  for (const r of result.rejections) rejections.push({ ...r, run: run.summary.id });
}
console.log(`${accepted} deltas accepted, ${rejections.length} rejected`);
for (const r of rejections) {
  console.log(`  rejected ${r.run} ${r.delta.op} ${JSON.stringify(r.delta.claim)}: ${r.reason}`);
}

if (opts["dry-run"]) {
  console.log(`--dry-run: ${facts.length} facts would be written to ${engineFactsPath}`);
  process.exit(0);
}
const hashBefore = larnKb(opts.kb).hash;
writeFileSync(engineFactsPath, serializeFacts(facts));
console.log(`${engineFactsPath}: ${facts.length} facts, tables hash ${hashBefore} -> ${larnKb(opts.kb).hash}`);

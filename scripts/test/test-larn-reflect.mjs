// The reflect loop end to end, with no GPU, no network and no model: a fixture
// batch of three real Larn games goes through scripts/dev/bot-reflect.mjs
// against the replay Brain, and a knowledge base comes out.
//
// The batch is genuine — three games played by `npm run bot:headless --game
// larn --seed 424242` and committed as trajectory + summary only. The replies
// are not: they are hand-authored to drive each path exactly once, because a
// recording of a real model would pin whatever that model happened to say.
//   run 1 (capped, depth 1)  prose with no JSON array: the parse-error path
//   run 2 (died, depth 11)   a terrain assert about the V shaft this run rode
//                            down, and a threat assert about a being that
//                            merely stood beside the hero
//   run 3 (died, depth 11)   a confirm that merges into run 2's fact, and a
//                            terrain assert about an exit it never took
//
// Which run plays which role is not arbitrary: runs 2 and 3 both left the town
// by the volcanic shaft and run 1 left by the dungeon entrance, so runs 2 and 3
// are the only pair that can ground one terrain fact between them. Before the
// terrain gate (vect-hack-b5f.6) run 1 carried the assert and nothing minded
// that its hero never saw a V.
//
// The properties this gate exists for, in the order it checks them:
//
//   1. **The loop closes.** Three transcripts, and one fact carrying evidence
//      from two different runs — support 2 with no refutation is confidence
//      0.75 by confidenceOf, never a number the model chose.
//   2. **Reflecting twice changes nothing.** The second run happens at a
//      different wall-clock time over an already-applied batch, which is the
//      case a naive applier restamps; facts.json must be byte-identical. This
//      is the anti-thrash gate the whole phase rests on — a KB that churns
//      cannot be reviewed or bisected.
//   3. **The probe gates the batch.** The `leaky/` fixture set holds the SAME
//      three run replies as `replay/` and differs only in one probe reply,
//      which restates a threat claim after the death was stripped out. That
//      isolation is the point: same reflections, different probe, and the run
//      must exit 1 with facts.json untouched. A `leaky/` set missing the run
//      replies would fail before it ever reached the probe and prove nothing.
//   4. **A being that merely stood nearby cannot become a threat.** Run 1's
//      second delta asserts a threat about an `H` that traded hits with the
//      hero and did not kill them — the run was capped. That is the shape of
//      the bug in vect-hack-b5f.4: nothing in the digest tied the death
//      message to a glyph, so adjacency read as causation and 5 of the first
//      38 earned threat facts blamed a bystander. The applier must reject it
//      with a reason and still write the terrain fact from the same reply.
//   4b. **Terrain the run never chose cannot become a fact.** Run 3's second
//      delta asserts `stairs:E` — a real exit of this dungeon, taken by run 1,
//      and never by run 3. The applier must reject it while accepting the
//      confirm beside it in the same reply: `stairs:E` and `stairs:V` are one
//      character apart and only one of them is what this hero did.
//   5. **Evidence is scoped to the run it was reflected from.** The
//      `cross-cite/` set differs from `replay/` in one field: run 3's confirm
//      cites a real, in-bounds range of run 1's trajectory instead of its own.
//      A batch-wide evidence check accepts that — the range exists — and the
//      fact ends up certifying a game it was never drawn from. It must be a
//      rejection with a reason instead.
//   6. **A killed pass resumes.** reflection.json is the resume record
//      (vect-hack-b5f.13), so a second pass over an already-reflected batch
//      must ask nothing at all — and must ask again the moment the prompt or
//      the trajectory it was drawn from changes. An empty replay directory is
//      what makes that visible: the replay Brain throws on any call it has no
//      recording for, so a pass that survives one is a pass that made no call.
//   7. **A dropped socket does not end the pass.** The transport retries a
//      connection failure and only a connection failure, driven here against a
//      real server that hangs up mid-reply.
//   8. **The cloud Brain asks `claude -p` one question, from nowhere, and
//      refuses to manufacture a reflection.** Three properties, none of which
//      a test that only reads the reply can see. The command line must carry
//      the prompts where the CLI expects them. The working directory must be
//      an empty one, because `claude` reads CLAUDE.md and AGENTS.md from wherever
//      it runs and this repo's instructions are not evidence about a Larn game.
//      And every non-answer — a refusal, a truncation, a denied tool call, a
//      second turn — must throw: recorded instead, each becomes a run that
//      "learned nothing", which is exactly what a run with nothing to teach
//      also looks like.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localBrain } from "../../src/bot/brain.ts";
import { retryingFetch } from "../dev/brain-fetch.mjs";
import { claudeBrain } from "../dev/brain-claude.mjs";

const fail = (msg) => { console.error("FAIL: " + msg); process.exit(1); };
const repo = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const FIXTURES = repo("scripts/test/fixtures/reflect");
/** A fixture set of recorded replies. */
const SET = (name) => join(FIXTURES, name);
const HOST = repo("scripts/dev/bot-reflect.mjs");

const work = mkdtempSync(join(tmpdir(), "vect-reflect-"));

/** A copy of the fixture batch, one per fixture set. reflection.json is a
 *  resume record now, so a set reflected into a directory another set already
 *  wrote would be handed that set's replies instead of its own — every
 *  property below except resume itself is about a specific reply reaching the
 *  applier. */
function newBatch(name) {
  const dir = join(work, name);
  cpSync(join(FIXTURES, "batch"), dir, { recursive: true });
  return dir;
}
const batch = newBatch("batch");

/** A fresh KB: empty tiers, the repo's own tuning. The tuning is not part of
 *  what reflection writes, so taking it from data/kb keeps this test measuring
 *  the fact path alone. */
function newKb(name) {
  const dir = join(work, name);
  mkdirSync(join(dir, "meta"), { recursive: true });
  mkdirSync(join(dir, "larn"), { recursive: true });
  writeFileSync(join(dir, "meta/facts.json"), '{\n  "facts": []\n}\n');
  writeFileSync(join(dir, "larn/facts.json"), '{\n  "facts": []\n}\n');
  cpSync(repo("data/kb/larn/policy.json"), join(dir, "larn/policy.json"));
  return dir;
}

const kb = newKb("kb");
const factsPath = join(kb, "larn/facts.json");
const runIds = ["0001", "0002", "0003"].map((n) => `larn-20260820T185838Z-93207-${n}`);

/** The host over a batch directory with `replay` as its recorded replies. */
function reflect(replay, { into = kb, batch: dir = batch, extra = [] } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [
      HOST, "--brain", "replay", "--replay", replay,
      "--batch", dir, "--kb", into, "--probe-sample", "3", ...extra,
      // Captured, not inherited: the leak run is *supposed* to print its
      // complaint, and a passing gate that prints one reads as a failure.
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout };
  } catch (err) {
    // A non-zero exit is a verdict here, not a crash: the leak path is
    // supposed to end this way, and a signal or a missing binary is not.
    if (err.status === undefined || err.status === null) fail(`bot-reflect.mjs did not run: ${err}`);
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

// --- 1. The loop closes. -----------------------------------------------------
const first = reflect(SET("replay"));
if (first.status !== 0) fail(`the replay batch exited ${first.status}:\n${first.stdout}${first.stderr ?? ""}`);

for (const id of runIds) {
  const path = join(batch, id, "reflection.json");
  if (!existsSync(path)) fail(`${id}: no reflection.json`);
}
const prose = JSON.parse(readFileSync(join(batch, runIds[0], "reflection.json"), "utf8"));
if (prose.parse.error === null) fail(`${runIds[0]}: prose with no JSON array parsed without an error`);
if (prose.parse.deltas.length !== 0) fail(`${runIds[0]}: ${prose.parse.deltas.length} deltas out of unparseable prose`);
if (!/^[0-9a-f]{64}$/.test(prose.trajectorySha256)) fail(`${runIds[0]}: trajectorySha256 is ${prose.trajectorySha256}`);
if (prose.probe === undefined) fail(`${runIds[0]}: --probe-sample 3 over three runs left one unprobed`);

const facts = JSON.parse(readFileSync(factsPath, "utf8")).facts;
const shaft = facts.find((f) => f.id === "larn/avoid-terrain/stairs:V");
if (!shaft) fail(`no stairs:V fact in ${facts.map((f) => f.id).join(", ") || "an empty facts.json"}`);
if (shaft.support.length !== 2) fail(`stairs:V has ${shaft.support.length} support entries, want 2 (one per run)`);
if (shaft.confidence !== 0.75) fail(`stairs:V has confidence ${shaft.confidence}, want 0.75`);
const cited = shaft.support.map((e) => e.trajectory).sort();
if (cited[0] !== runIds[1] || cited[1] !== runIds[2]) fail(`stairs:V cites ${cited.join(", ")}, want runs 2 and 3`);

// --- 1b. An exit this run never took does not become a fact. -----------------
// Run 3 asserted stairs:E beside the confirm the fact above rests on, so this
// is one delta declined out of a reply that was otherwise taken — and the two
// claims differ by one character (vect-hack-b5f.6).
if (facts.some((f) => f.id === "larn/avoid-terrain/stairs:E")) {
  fail(`a run that left by the shaft earned a fact about the entrance: ${facts.map((f) => f.id).join(", ")}`);
}
const ungrounded = first.stdout.split("\n").find((l) => l.startsWith("  rejected ") && l.includes('"ch":"E"'));
if (!ungrounded) fail(`run 3's stairs:E delta was neither applied nor rejected:\n${first.stdout}`);
if (!ungrounded.includes("not terrain this run chose")) {
  fail(`the rejection does not say why an exit this run never took is not evidence:\n${ungrounded}`);
}

// --- 1c. A bystander does not become a threat. -------------------------------
// Run 2's own reply asserts both, and the terrain fact above already proves the
// reply was read: so this is the applier declining one delta out of a reply it
// otherwise accepted, not a reply that failed to parse.
if (facts.some((f) => f.id.startsWith("larn/threat/"))) {
  fail(`a threat fact was earned from a run nothing killed the hero in: ${facts.map((f) => f.id).join(", ")}`);
}
const bystander = first.stdout.split("\n").find((l) => l.startsWith("  rejected ") && l.includes('"threat"'));
if (!bystander) fail(`run 2's threat delta was neither applied nor rejected:\n${first.stdout}`);
if (!bystander.includes("names no killer")) {
  fail(`the rejection does not say why a bystander is not evidence:\n${bystander}`);
}

// --- 2. Reflecting the same batch again changes nothing. ---------------------
// `--no-reuse`, so this is still what it was written to be: the same replies
// asked again and applied again over an already-applied batch. Without it the
// second pass would resume off the first one's transcripts, and the anti-thrash
// property would be measured on a path that never reached the Brain. Reuse is
// section 6's subject, not this one's.
const once = readFileSync(factsPath);
const again = reflect(SET("replay"), { extra: ["--no-reuse"] });
if (again.status !== 0) fail(`the second replay batch exited ${again.status}:\n${again.stdout}${again.stderr ?? ""}`);
const twice = readFileSync(factsPath);
if (!once.equals(twice)) {
  fail(`reflecting the same batch twice rewrote facts.json:\n--- once\n${once}\n--- twice\n${twice}`);
}

// --- 3. A planted leak fails the batch and writes nothing. -------------------
const leaky = reflect(SET("leaky"), { batch: newBatch("batch-leaky") });
if (leaky.status !== 1) fail(`the planted leak exited ${leaky.status}, want 1:\n${leaky.stdout}${leaky.stderr ?? ""}`);
if (!leaky.stderr.includes("larn/threat/H|1|1")) fail(`the leak report does not name the leaked subject:\n${leaky.stderr}`);
const afterLeak = readFileSync(factsPath);
if (!twice.equals(afterLeak)) fail(`the leaking batch rewrote facts.json:\n--- before\n${twice}\n--- after\n${afterLeak}`);

// --- 5. A delta citing another run's trajectory is rejected. -----------------
// Into a KB of its own, because this is a claim about what one batch wrote and
// the KB above already holds the honest batch's answer.
const crossKb = newKb("kb-cross-cite");
const crossed = reflect(SET("cross-cite"), { into: crossKb, batch: newBatch("batch-cross-cite") });
if (crossed.status !== 0) fail(`the cross-citing batch exited ${crossed.status}:\n${crossed.stdout}${crossed.stderr ?? ""}`);
// By reason, not by position: run 2's bystander threat is rejected first in
// every set, and a positional pick would read that one and pass on the wrong
// evidence.
const rejected = crossed.stdout.split("\n").find((l) => l.startsWith("  rejected ") && l.includes("may cite"));
if (!rejected) fail(`run 3 cited run 2's trajectory and nothing was rejected:\n${crossed.stdout}`);
if (!rejected.includes(runIds[2]) || !rejected.includes(runIds[1])) {
  fail(`the rejection names neither the run that made the claim nor the trajectory it cited:\n${rejected}`);
}
const crossFacts = JSON.parse(readFileSync(join(crossKb, "larn/facts.json"), "utf8")).facts;
const crossShaft = crossFacts.find((f) => f.id === "larn/avoid-terrain/stairs:V");
if (!crossShaft) fail(`no stairs:V fact after the cross-citing batch — run 2's own assert should still stand`);
if (crossShaft.support.length !== 1) {
  fail(`stairs:V has ${crossShaft.support.length} support entries after a cross-citation, want 1 (run 2's own)`);
}
if (crossShaft.support[0].trajectory !== runIds[1]) {
  fail(`stairs:V rests on ${crossShaft.support[0].trajectory}, want ${runIds[1]}`);
}

// --- 6. A killed pass resumes off its own transcripts. -----------------------
// The whole section runs against an EMPTY replay directory, which is what makes
// reuse observable at all: replayBrain throws on any key it has no recording
// for, so a pass that survives one made no call, and a pass that dies made one.
// Without that, "reused" and "asked again and got the same answer" are the same
// observation, and every assertion below would hold either way.
const noReplies = join(work, "no-replies");
mkdirSync(noReplies, { recursive: true });
const lines = (out) => out.split("\n");
const said = (out, prefix) => lines(out).find((l) => l.startsWith(prefix));

const resumed = reflect(noReplies);
if (resumed.status !== 0) {
  fail(`a pass over an already-reflected batch asked the model:\n${resumed.stdout}${resumed.stderr ?? ""}`);
}
for (const id of runIds) {
  const reflection = said(resumed.stdout, `${id}  `);
  if (!reflection?.includes("(reused)")) fail(`${id}: reflection not reported as reused:\n${resumed.stdout}`);
  const probe = said(resumed.stdout, `${id}#probe`);
  if (!probe?.includes("(reused)")) fail(`${id}: probe not reported as reused:\n${resumed.stdout}`);
}
const afterResume = readFileSync(factsPath);
if (!twice.equals(afterResume)) {
  fail(`a resumed pass rewrote facts.json:\n--- before\n${twice}\n--- after\n${afterResume}`);
}

// 6b. A recorded reply that answers a different prompt is not an answer.
// The prompt carries the knowledge base the bot held, so this is the real case:
// a KB that grew between passes makes every recorded reply stale.
const stalePath = join(batch, runIds[1], "reflection.json");
const intact = readFileSync(stalePath);
const restale = (mutate) => {
  const t = JSON.parse(intact);
  mutate(t);
  writeFileSync(stalePath, JSON.stringify(t, null, 2) + "\n");
};

restale((t) => { t.request.user += "\n- larn/threat/Z|9|9  a fact this reply never saw\n"; });
const reasked = reflect(noReplies);
if (reasked.status === 0) fail(`a reply recorded against a different prompt was reused:\n${reasked.stdout}`);
if (!(reasked.stderr ?? "").includes(`no recorded response for ${runIds[1]}`)) {
  fail(`the stale-prompt run was not the one re-asked:\n${reasked.stderr ?? ""}`);
}

// 6c. A reply drawn from different bytes is not an answer either. The hash is
// the audit link from a claim to its evidence, so a transcript that no longer
// matches the trajectory beside it certifies nothing, whatever it says.
restale((t) => { t.trajectorySha256 = "0".repeat(64); });
const rehashed = reflect(noReplies);
if (rehashed.status === 0) fail(`a reply whose trajectory hash no longer matches was reused:\n${rehashed.stdout}`);
if (!(rehashed.stderr ?? "").includes(`no recorded response for ${runIds[1]}`)) {
  fail(`the stale-trajectory run was not the one re-asked:\n${rehashed.stderr ?? ""}`);
}
writeFileSync(stalePath, intact);

// 6d. --no-reuse means what it says: every run goes back to the model, and the
// first one to do so here has nothing to go back to.
const forced = reflect(noReplies, { extra: ["--no-reuse"] });
if (forced.status === 0) fail(`--no-reuse served a recorded reply:\n${forced.stdout}`);
if (!(forced.stderr ?? "").includes(`no recorded response for ${runIds[0]}`)) {
  fail(`--no-reuse did not re-ask from the first run:\n${forced.stderr ?? ""}`);
}

// --- 7. A dropped socket does not end the pass. ------------------------------
// vect-hack-b5f.13: llama-swap evicted the model at run 67 of 200 and node saw
// the connection go away mid-generation. A real server here rather than a
// stubbed fetch, because the fault is a socket destroyed while a response body
// was in flight — the exact thing a stub cannot be wrong about.
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const REPLY = JSON.stringify({ model: "qwen38-q5", choices: [{ message: { content: "[]" } }] });

/** Hangs up on its first `drops` requests after starting to answer, then
 *  answers properly. `seen` is how many requests actually reached it. */
function flaky(drops) {
  let seen = 0;
  const server = createServer((req, res) => {
    seen++;
    if (seen <= drops) {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"model":"qwen38-q5","choices":[{"mes');
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(REPLY);
  });
  return { server, seen: () => seen };
}

/** The transport under test with no real waiting: the delays are the retry
 *  budget, and a test that spent 52 seconds proving four of them would be one
 *  nobody runs. */
const transport = (delays) => retryingFetch({ delays, log: () => {} });

const rode = flaky(2);
const ridePort = await listen(rode.server);
const rideBrain = localBrain({
  url: `http://127.0.0.1:${ridePort}/v1`, model: "qwen38-q5", fetchFn: transport([5, 5, 5]),
});
let rideReply = null;
try {
  rideReply = await rideBrain.reflect("run", { system: "s", user: "u" });
} catch (err) {
  fail(`a dropped socket ended the call instead of being retried: ${err?.code ?? err?.message ?? err}`);
}
if (rideReply.raw !== "[]") fail(`the retried call returned ${JSON.stringify(rideReply.raw)}, want "[]"`);
if (rode.seen() !== 3) fail(`two dropped sockets took ${rode.seen()} requests to ride out, want 3`);
rode.server.close();

// 7b. Bounded. A server that is really gone must still end the pass, or a
// killed model turns a five-hour job into an endless one.
const gone = flaky(Infinity);
const gonePort = await listen(gone.server);
const goneBrain = localBrain({
  url: `http://127.0.0.1:${gonePort}/v1`, model: "qwen38-q5", fetchFn: transport([5, 5]),
});
let threw = null;
try {
  await goneBrain.reflect("run", { system: "s", user: "u" });
} catch (err) {
  threw = err;
}
if (!threw) fail(`a server that never answered was retried into a success`);
if (gone.seen() !== 3) fail(`a two-retry budget made ${gone.seen()} attempts, want 3`);
gone.server.close();

// 7c. Only the socket. A status the server actually sent is an answer, and
// retrying it would turn one refusal into four and hide the reason behind the
// last of them.
let refusals = 0;
const refuser = createServer((_req, res) => {
  refusals++;
  res.writeHead(500, { "content-type": "text/plain" });
  res.end("no model loaded");
});
const refuserPort = await listen(refuser);
const refuserBrain = localBrain({
  url: `http://127.0.0.1:${refuserPort}/v1`, model: "qwen38-q5", fetchFn: transport([5, 5]),
});
let refused = null;
try {
  await refuserBrain.reflect("run", { system: "s", user: "u" });
} catch (err) {
  refused = err;
}
if (!refused?.message.includes("no model loaded")) {
  fail(`a 500 did not reach the Brain intact: ${refused?.message}`);
}
if (refusals !== 1) fail(`a 500 the server chose to send was retried ${refusals} times`);
refuser.close();

// --- 8. The cloud Brain. -----------------------------------------------------
// A stub executable rather than a stubbed spawn: the properties under test are
// the command line, the working directory it runs in and the envelope it gets
// back, and a faked child_process could only ever agree with whatever this
// file thinks spawning does. Nothing here reaches a network or a credential —
// `bin` is a node script in the work directory.

const STUB = join(work, "claude-stub.mjs");
const RECORD = join(work, "claude-stub-record.json");
writeFileSync(STUB, `#!/usr/bin/env node
// Records how it was called, then prints whatever STUB_REPLY says.
import { existsSync, writeFileSync } from "node:fs";
let stdin = "";
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  writeFileSync(process.env.STUB_RECORD, JSON.stringify({
    argv: process.argv.slice(2),
    stdin,
    cwd: process.cwd(),
    // Read from the cwd, the way the real CLI discovers project context.
    sawProjectDocs: existsSync("CLAUDE.md") || existsSync("AGENTS.md"),
  }));
  process.stdout.write(process.env.STUB_REPLY);
  process.exit(Number(process.env.STUB_EXIT));
});
`);
chmodSync(STUB, 0o755);
process.env.STUB_RECORD = RECORD;

/** The envelope shape `claude -p --output-format json` returns, with only the
 *  fields the adapter reads. Overridden field by field per case, so a case is
 *  legible as its one difference from a successful call. */
const envelope = (over = {}) => ({
  type: "result", subtype: "success", is_error: false, stop_reason: "end_turn",
  num_turns: 1, permission_denials: [], api_error_status: null, result: "[]",
  modelUsage: { "some-alias": { canonicalModel: "claude-opus-5-served-by-the-stub" } },
  ...over,
});

/** Arms the stub and hands back the Brain that will run it. */
function stubbedBrain(over = {}, { exit = 0, ...opts } = {}) {
  process.env.STUB_REPLY = typeof over === "string" ? over : JSON.stringify(envelope(over));
  process.env.STUB_EXIT = String(exit);
  return claudeBrain({ bin: STUB, ...opts });
}

/** The `--flag value` pair the adapter passed, or undefined. */
const flag = (argv, name) => (argv.indexOf(name) < 0 ? undefined : argv[argv.indexOf(name) + 1]);

const cloudReply = await stubbedBrain({}, { effort: "medium" }).reflect("run", { system: "s", user: "u" });
const called = JSON.parse(readFileSync(RECORD, "utf8"));
// 8a. The prompts must arrive where the CLI takes them: the system prompt as
// a replacement rather than an append, and the user prompt on stdin, which is
// the only place a digest of any size can go.
if (flag(called.argv, "--system-prompt") !== "s") fail(`the system prompt reached the CLI as ${JSON.stringify(flag(called.argv, "--system-prompt"))}`);
if (called.stdin !== "u") fail(`the user prompt reached the CLI as ${JSON.stringify(called.stdin)}`);
if (!called.argv.includes("-p")) fail(`the CLI was run without -p, so it would not have printed and exited`);
if (flag(called.argv, "--output-format") !== "json") fail(`the CLI was not asked for a JSON envelope`);
if (flag(called.argv, "--effort") !== "medium") fail(`--effort medium reached the CLI as ${JSON.stringify(flag(called.argv, "--effort"))}`);
if (flag(called.argv, "--model") !== "claude-opus-5") fail(`the default model reached the CLI as ${JSON.stringify(flag(called.argv, "--model"))}`);
// 8b. And it must run from nowhere. `claude` reads CLAUDE.md and AGENTS.md out
// of its working directory, so a call made from the repo would put this
// project's instructions in front of the model deciding what the bot learned —
// an input to the knowledge base that no fact's provenance records.
if (called.sawProjectDocs) fail(`the CLI ran somewhere it could read this repo's CLAUDE.md/AGENTS.md`);
// 8c. The served id, not the requested one — the whole reason a transcript can
// be believed about which model wrote a fact.
if (cloudReply.model !== "claude-opus-5-served-by-the-stub") fail(`the transcript would name ${cloudReply.model}, not the model that served the call`);
if (cloudReply.raw !== "[]") fail(`the reply came back as ${JSON.stringify(cloudReply.raw)}, want "[]"`);

/** Every way a call can come back as something other than an answer. Each must
 *  throw: recorded instead, all five are a run that "learned nothing", which is
 *  what a quiet game looks like too. The `result` text is prose in each,
 *  because dropping a check must fail on the reply being recorded — not on the
 *  empty-string guard catching it by accident. */
const NON_ANSWERS = [
  ["a refusal", { stop_reason: "refusal", result: "I can't help with that." }, "declined"],
  ["a truncation", { stop_reason: "max_tokens", result: '[{"op":"assert"' }, "truncated"],
  ["a denied tool call", { permission_denials: [{ tool_name: "Read" }], result: "[]" }, "tool call"],
  ["a second turn", { num_turns: 3, result: "[]" }, "3 turns"],
  ["a failed run", { is_error: true, subtype: "error_during_execution", result: "boom" }, "failed"],
];
for (const [what, over, wanted] of NON_ANSWERS) {
  let err = null;
  try {
    await stubbedBrain(over).reflect("run", { system: "s", user: "u" });
  } catch (e) { err = e; }
  if (!err?.message.includes(wanted)) fail(`${what} was recorded as a reflection instead of throwing ${JSON.stringify(wanted)}: ${err?.message}`);
}

// 8d. A CLI that dies before printing an envelope must say so with what it did
// print. A crash parsed as "no deltas" is the same silent failure again.
let crashErr = null;
try {
  await stubbedBrain("not json at all", { exit: 1 }).reflect("run", { system: "s", user: "u" });
} catch (e) { crashErr = e; }
if (!crashErr?.message.includes("without a JSON envelope")) fail(`a crashed CLI did not surface as an error: ${crashErr?.message}`);

rmSync(work, { recursive: true, force: true });
console.log(`OK: three runs reflected, stairs:V earned confidence 0.75 from two trajectories, a bystander earned no threat, an exit no run took earned no fact, a second pass changed no byte, a planted prior failed the batch, a citation of another run's trajectory was rejected, a resumed pass asked nothing and a stale one asked again, a dropped socket was ridden out while a 500 was not, and the cloud Brain ran claude -p from an empty directory with the prompts where the CLI takes them, named the model that served it, and threw on a refusal, a truncation, a denied tool call, a second turn, a failed run and a crash`);

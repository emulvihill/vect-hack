// The cloud Brain: the same one-method interface as `localBrain`, served by
// Claude through the `claude -p` CLI.
//
// **Why the CLI and not the API.** The credential. `claude` holds the OAuth
// login this machine already has, the same way task-llama's `claude-cli`
// provider does (task-scheduler/config/providers.yaml); an SDK client would
// need a separate API key to be issued, stored and rotated for a job that is
// already authorized as this user. The subprocess is the cheaper half of that
// trade: a reflection is one prompt in and one document out, with no streaming
// to consume and no session to keep, so the process boundary costs a fork and
// buys the whole credential problem going away.
//
// **Why it is not a second `--url` either.** `localBrain` speaks the OpenAI
// chat-completions shape over HTTP and sends `temperature: 0` and `seed: 7`.
// Neither the CLI nor Claude's API has anywhere to put those, and nothing in
// task-llama fronts Claude on an OpenAI-compatible port to point at — its
// Claude routing is a Python library, not a service.
//
// **Why here and not in src/bot/.** That directory is shared with the browser
// bot and may not spawn a process or touch a filesystem. `Brain` stays the
// seam; only the hosts that have a shell construct one.
//
// **The empty working directory is load-bearing.** `claude` discovers
// CLAUDE.md and AGENTS.md from the directory it runs in, so a call made from
// the repo would put this project's own instructions in front of the model
// that is deciding what the bot has learned. That is an uncontrolled input to
// the knowledge base, and an invisible one: nothing downstream of a fact
// records which repo text was in scope when it was proposed. Every call gets a
// fresh empty directory instead, and `--system-prompt` replaces the harness
// prompt rather than appending to it.
//
// **What reproducibility survives.** Nothing here can promise that one prompt
// gives one reply — Claude offers no sampling controls to pin. What the loop
// actually rests on is unaffected: bot-reflect.mjs reuses a recorded reply
// when the prompt is byte-identical and the trajectory sha256 still matches,
// and that is a property of the transcript, not of the sampler. A pass is
// still resumable, and a committed fact still names the bytes it was drawn
// from. `--no-reuse` is still how to ask for a genuinely fresh pass, and on
// this Brain it is a re-roll rather than a re-run.
//
// **Anything but a plain answer is an error.** A refusal, a truncation, a
// denied tool call, a second turn: each throws rather than being recorded.
// Recorded, every one of them reaches parseDeltaDocument and comes out as a
// run that learned nothing — which is exactly what a run with nothing to teach
// also looks like. Throwing ends the pass instead, and the transcripts already
// written are what a resumed pass keeps.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_EFFORT = "high";
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** Flags that hold the session down to one question and one answer. Tools are
 *  denied both ways round because the two lists are not the same mechanism: an
 *  empty allow-list is the policy, and the deny-list is what keeps the tool
 *  definitions out of the prefix. Sessions are not persisted because a pass is
 *  hundreds of calls and none of them is ever resumed by the CLI — the
 *  transcript beside the run is the resume record. */
const FIXED_ARGS = [
  "-p",
  "--output-format", "json",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--allowed-tools", "",
  "--disallowed-tools", "Bash Read Write Edit Glob Grep WebFetch WebSearch Task NotebookEdit TodoWrite",
];

/** Runs `bin` with `args` in `cwd`, `input` on stdin, and resolves the whole
 *  of stdout. Rejects when the process cannot be started; a non-zero exit
 *  resolves, because the CLI reports a refusal that way too and the caller
 *  reads the reason out of the JSON. */
function run(bin, args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
}

/** Every model the CLI billed this call to, by its canonical id. A fallback or
 *  a mid-call switch shows up here as two, and the transcript should say so
 *  rather than name whichever one this pass asked for. */
function servedModel(envelope, requested) {
  const used = Object.values(envelope.modelUsage ?? {})
    .map((u) => u.canonicalModel)
    .filter((id) => typeof id === "string");
  return used.length > 0 ? [...new Set(used)].sort().join("+") : requested;
}

/** `bin` is for tests: a stub on the path of a fake CLI is what lets the
 *  command line and the envelope handling be driven without a credential. */
export function claudeBrain({ model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, bin = "claude" } = {}) {
  return {
    async reflect(_key, req) {
      const cwd = mkdtempSync(`${tmpdir()}/vect-reflect-cli-`);
      let result;
      try {
        result = await run(bin, [
          ...FIXED_ARGS,
          "--model", model,
          "--effort", effort,
          "--system-prompt", req.system,
        ], cwd, req.user);
      } finally {
        // The recursive delete answers only to the mkdtemp line above. A
        // sabotage pass once redirected `cwd` to the repo root and this
        // cleanup erased the whole checkout; a cwd outside our own prefix is
        // someone else's directory, and leaking a temp dir is the cheap fault.
        if (cwd.startsWith(`${tmpdir()}/vect-reflect-cli-`)) {
          rmSync(cwd, { recursive: true, force: true });
        }
      }

      let envelope;
      try {
        envelope = JSON.parse(result.stdout);
      } catch {
        throw new Error(`brain: ${bin} exited ${result.code} without a JSON envelope: ${result.stderr.trim() || result.stdout.slice(0, 400)}`);
      }
      if (envelope.is_error || envelope.subtype !== "success") {
        throw new Error(`brain: ${bin} failed (${envelope.subtype ?? "no subtype"}${envelope.api_error_status ? `, api ${envelope.api_error_status}` : ""}): ${String(envelope.result ?? "").slice(0, 400)}`);
      }
      if (envelope.stop_reason === "refusal") {
        throw new Error(`brain: ${servedModel(envelope, model)} declined the reflection: ${String(envelope.result ?? "").slice(0, 400)}`);
      }
      if (envelope.stop_reason === "max_tokens") {
        throw new Error(`brain: ${servedModel(envelope, model)} hit the output ceiling — the reply is truncated`);
      }
      // A denied tool call means the model tried to go and look at something
      // rather than answer from the digest. Whatever it then wrote was written
      // by a model that wanted a fact it did not have.
      if (envelope.permission_denials?.length > 0) {
        throw new Error(`brain: the reflection attempted ${envelope.permission_denials.length} tool call(s); a digest is all it may see`);
      }
      // One question, one answer. A second turn is the same finding as a
      // denied tool: this was not a model reading a digest and replying.
      if (envelope.num_turns !== 1) {
        throw new Error(`brain: the reflection took ${envelope.num_turns} turns, want 1`);
      }
      const raw = envelope.result;
      if (typeof raw !== "string" || raw === "") {
        throw new Error(`brain: ${bin} returned no result text`);
      }
      // The served id, not the requested one — same rule the local adapter
      // follows, and the reason a transcript can be trusted about its model.
      return { raw, model: servedModel(envelope, model) };
    },
  };
}

// The Brain adapters: one interface, a local OpenAI-compatible server and a
// replay adapter over recorded responses (spec: 2026-08-19-bot-phase1b-larn-
// reflect-design.md, "The Brain").
//
// No test here talks to a model. `localBrain` is driven through an injected
// fetch, so the request shape — the endpoint, the fixed sampling, the two
// messages — is pinned without a GPU or a network.
import { describe, expect, it } from "vitest";
import { localBrain, replayBrain, type BrainRequest } from "../../src/bot/brain.ts";

const REQ: BrainRequest = { system: "you are the reflection step", user: "digest goes here" };

interface Call { url: string; init: RequestInit }

/** A fetch that records what it was handed and answers with `body`. */
function stubFetch(calls: Call[], status: number, body: unknown): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const completion = (content: string, model = "qwen38-q5") => ({
  model,
  choices: [{ message: { role: "assistant", content } }],
});

describe("replayBrain", () => {
  it("serves the recorded raw response for a key", async () => {
    const brain = replayBrain({ "run-1": "[]", "run-2": "[{\"op\":\"retire\"}]" });
    expect(await brain.reflect("run-2", REQ)).toEqual({ raw: "[{\"op\":\"retire\"}]", model: "replay" });
  });

  it("throws for a key it has no recording for", async () => {
    const brain = replayBrain({ "run-1": "[]" });
    await expect(brain.reflect("run-9", REQ)).rejects.toThrow("replay: no recorded response for run-9");
  });
});

describe("localBrain", () => {
  it("posts one chat completion with fixed sampling and both messages", async () => {
    const calls: Call[] = [];
    const brain = localBrain({
      url: "http://127.0.0.1:8090/v1",
      model: "qwen38-q5",
      fetchFn: stubFetch(calls, 200, completion("[]")),
    });
    const out = await brain.reflect("run-1", REQ);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:8090/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    const body = JSON.parse(String(call.init.body)) as {
      model: string; temperature: number; seed: number;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("qwen38-q5");
    expect(body.temperature).toBe(0);
    expect(body.seed).toBe(7);
    expect(body.messages).toEqual([
      { role: "system", content: REQ.system },
      { role: "user", content: REQ.user },
    ]);
    expect(out.raw).toBe("[]");
  });

  it("returns the content of the first choice and the model that served it", async () => {
    const calls: Call[] = [];
    const brain = localBrain({
      url: "http://host/v1",
      model: "configured",
      fetchFn: stubFetch(calls, 200, completion("[{\"op\":\"assert\"}]", "served-by")),
    });
    expect(await brain.reflect("run-1", REQ)).toEqual({ raw: "[{\"op\":\"assert\"}]", model: "served-by" });
  });

  it("throws with the status and the body when the server refuses", async () => {
    const brain = localBrain({
      url: "http://host/v1",
      model: "m",
      fetchFn: stubFetch([], 503, "no slot available"),
    });
    await expect(brain.reflect("run-1", REQ)).rejects.toThrow(/503.*no slot available/s);
  });

  it("throws when the reply carries no message content", async () => {
    const brain = localBrain({
      url: "http://host/v1",
      model: "m",
      fetchFn: stubFetch([], 200, { model: "m", choices: [] }),
    });
    await expect(brain.reflect("run-1", REQ)).rejects.toThrow(/no message content/);
  });
});

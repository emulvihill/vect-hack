import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Describes, answerDescribeRequest, type DescribeReply, type DescribeRequest,
} from "../../src/backplane/describe";

afterEach(() => vi.useRealTimers());

describe("the worker half of a describe", () => {
  const posted: DescribeReply[] = [];
  const post = (msg: DescribeReply) => { posted.push(msg); };
  const req = (id: number, x = 4, y = 5): DescribeRequest => ({ type: "describe", id, x, y });

  it("answers with the describer's phrase for the asked cell", () => {
    answerDescribeRequest(req(3, 4, 5), (x, y) => `cell ${x},${y}`, post);
    expect(posted.at(-1)).toEqual({ type: "describeReply", id: 3, text: "cell 4,5" });
  });

  it("turns a throwing describer into a null reply, not a throw", () => {
    // A throw here would be swallowed by the worker's message handler and the
    // page would wait out its whole timeout for a failure already known.
    expect(() => answerDescribeRequest(req(4), () => { throw new Error("no engine"); }, post))
      .not.toThrow();
    expect(posted.at(-1)).toEqual({ type: "describeReply", id: 4, text: null });
  });

  it("answers a hover that beats the engine, rather than dropping it", () => {
    answerDescribeRequest(req(5), undefined, post);
    expect(posted.at(-1)).toEqual({ type: "describeReply", id: 5, text: null });
  });
});

describe("the main-thread half of a describe", () => {
  const sent: DescribeRequest[] = [];
  const describes = new Describes();
  const ask = (x: number, y: number) => describes.request((msg) => { sent.push(msg); }, x, y);

  it("carries the asked cell and resolves the phrase its reply names", async () => {
    const wait = ask(7, 8);
    expect(sent.at(-1)).toMatchObject({ type: "describe", x: 7, y: 8 });
    describes.settle({ type: "describeReply", id: sent.at(-1)!.id, text: "jackal" });
    await expect(wait).resolves.toBe("jackal");
  });

  it("gives ids out one per request, so two hovers cannot cross", () => {
    ask(1, 1); ask(2, 2);
    expect(sent.at(-1)!.id).not.toBe(sent.at(-2)!.id);
  });

  it("supersedes an older request rather than letting a slow reply win", async () => {
    const older = ask(1, 1);
    const newer = ask(2, 2);
    // The caller only ever wants the answer to the latest position, so the
    // older promise settles null and its late reply is dropped.
    await expect(older).resolves.toBeNull();
    describes.settle({ type: "describeReply", id: sent.at(-2)!.id, text: "stale wall" });
    describes.settle({ type: "describeReply", id: sent.at(-1)!.id, text: "orange potion" });
    await expect(newer).resolves.toBe("orange potion");
  });

  it("drops a reply to an id it is not waiting for", () => {
    expect(() => describes.settle({ type: "describeReply", id: 9999, text: "x" }))
      .not.toThrow();
  });

  it("resolves null rather than hanging when the worker never answers", async () => {
    vi.useFakeTimers();
    const wait = new Describes().request(() => {}, 0, 0);
    vi.advanceTimersByTime(5_000);
    await expect(wait).resolves.toBeNull();
  });

  it("resolves null when the request cannot even be sent", async () => {
    await expect(new Describes().request(() => { throw new Error("worker is gone"); }, 0, 0))
      .resolves.toBeNull();
  });
});

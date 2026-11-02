// The other half of vect-hack-a8r: a dispose() nothing calls is a leak with a
// comment on it. Each Module's session must hand its view the teardown, and
// must do it AFTER the worker is gone — while a graceful release is still in
// flight the engine can ask one more question, and a view disposed early
// would answer it "no key" instead of letting the player finish.
//
// One file for all four, deliberately: this is four copies of one policy, and
// the way it goes wrong is one Module quietly not having it.
//
// LATENT, and worth saying out loud: no production code calls
// session.terminate() in the browser today (vect-hack-67py). These tests pin
// the wiring so that whoever wires terminate() to pagehide gets teardown for
// free rather than discovering the leak again.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetHackSession } from "../../src/modules/nethack/session";
import { AngbandSession } from "../../src/modules/angband/session";
import { LarnSession } from "../../src/modules/larn/session";
import { MoriaSession } from "../../src/modules/moria/session";

/** What happened, in the order it happened. */
let log: string[] = [];

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  posted: unknown[] = [];
  postMessage(message: unknown) { this.posted.push(message); }
  terminate() { log.push("worker.terminate"); }
}

let workers: FakeWorker[] = [];

const arm = () => {
  log = [];
  workers = [];
  vi.useFakeTimers();
  vi.stubGlobal("Worker", class extends FakeWorker {
    constructor() { super(); workers.push(this); }
  });
};

const dispose = () => log.push("view.dispose");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("session teardown disposes the view", () => {
  it("NetHack: straight through, no release handshake", () => {
    arm();
    new NetHackSession({ handle: () => null, dispose }).terminate();
    expect(log).toEqual(["worker.terminate", "view.dispose"]);
  });

  it("Angband: after the release acknowledgement, not before it", () => {
    arm();
    const session = new AngbandSession({
      onNotice: () => {}, handle: () => {}, nextKey: () => null, dispose,
    });
    session.terminate();
    // The release is in flight: the view is still live, because the engine
    // may still ask for a key while it saves.
    expect(log).toEqual([]);
    workers[0]?.onmessage?.({ data: { type: "released" } });
    expect(log).toEqual(["worker.terminate", "view.dispose"]);
  });

  it("Angband: and also on the broken-worker timeout, which is the path a hung engine takes", () => {
    arm();
    new AngbandSession({
      onNotice: () => {}, handle: () => {}, nextKey: () => null, dispose,
    }).terminate();
    vi.advanceTimersByTime(250);
    expect(log).toEqual(["worker.terminate", "view.dispose"]);
  });

  it("Larn: after the release acknowledgement, not before it", () => {
    arm();
    const session = new LarnSession({
      onNotice: () => {}, handle: () => {}, nextKey: () => null, dispose,
    });
    session.terminate();
    expect(log).toEqual([]);
    workers[0]?.onmessage?.({ data: { type: "released" } });
    expect(log).toEqual(["worker.terminate", "view.dispose"]);
  });

  it("Moria: after the release acknowledgement, not before it", () => {
    arm();
    const session = new MoriaSession({
      onNotice: () => {}, handle: () => {}, nextKey: () => null, dispose,
    });
    session.terminate();
    expect(log).toEqual([]);
    workers[0]?.onmessage?.({ data: { type: "released" } });
    expect(log).toEqual(["worker.terminate", "view.dispose"]);
  });

  it("a handler with no dispose is not an error — the bot decorators and the headless hosts have none", () => {
    arm();
    expect(() => new NetHackSession({ handle: () => null }).terminate()).not.toThrow();
    expect(log).toEqual(["worker.terminate"]);
  });
});

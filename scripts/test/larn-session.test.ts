// The Larn Module's half of the EngineSession contract: the fallback table
// (cancel-shaped, per the backplane design) and the delegate. Reached through
// makeDelegate()/larnFallback because LarnSession's constructor spawns a real
// Worker, which node has no business doing here — the mechanism half lives in
// scripts/test/backplane-session.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LarnSession, larnFallback, makeDelegate } from "../../src/modules/larn/session";
import type { LarnEvent, LarnMainToWorker, LarnWorkerToMain } from "../../src/modules/larn/protocol";
import { KC_ESCAPE } from "../../src/modules/larn/protocol";

describe("Larn fallback table (cancel-shaped, per the backplane design)", () => {
  it("ESC for a stranded blocking key wait", () => {
    expect(larnFallback({ type: "getKey", id: 7, wait: true, cmd: false }))
      .toEqual({ type: "key", id: 7, code: KC_ESCAPE, mods: 0 });
  });

  // wait=false is not a prompt to cancel, it is a poll: the cancel shape is
  // "no key" (code 0). ESC would press a phantom Escape into a drain loop.
  it("no key, never ESC, for a stranded non-blocking poll", () => {
    expect(larnFallback({ type: "getKey", id: 8, wait: false, cmd: false }))
      .toEqual({ type: "key", id: 8, code: 0, mods: 0 });
  });

  // getKey is the protocol's one reply-owing message — the worker parks a
  // resolver for it and the engine stays Asyncify-suspended until a reply
  // arrives, so its fallback is a message and never null. Everything else is
  // one-way. This Record must name every LarnWorkerToMain type, so a new
  // message breaks the typecheck until its cancel shape is decided here.
  const EXPECTED: Record<LarnWorkerToMain["type"], LarnMainToWorker | null> = {
    getKey: { type: "key", id: 7, code: KC_ESCAPE, mods: 0 }, // wait=true; the poll is above
    ready: null, event: null, quit: null, released: null,
    saveBlob: null,
    // Same reasoning as saveBlob: a describe reply is one-way, and a hover
    // superseded or timed out settles itself (src/backplane/describe.ts).
    describeReply: null,
    // Lifecycle: EngineSession routes these itself, so dispatch — and hence
    // the fallback — never sees them.
    notice: null, fatal: null, sessionOnly: null,
  };
  it("answers every message in the union", () => {
    for (const [type, want] of Object.entries(EXPECTED))
      expect(larnFallback({ type, id: 7, wait: true, cmd: false } as unknown as LarnWorkerToMain), type)
        .toEqual(want);
  });
});

describe("Larn delegate", () => {
  const harness = () => {
    const notices: string[] = [];
    const events: LarnEvent[] = [];
    const delegate = makeDelegate({
      onNotice: (text) => notices.push(text),
      handle: (ev) => events.push(ev),
      nextKey: () => ({ code: 0x6a, mods: 0 }),
    });
    return { notices, events, delegate };
  };

  it("tells the player a persistent saved exit kept the game", async () => {
    const { notices, delegate } = harness();
    expect(await delegate.dispatch({
      type: "quit", saved: true, persistent: true, reason: null,
    })).toBeNull();
    expect(notices).toEqual(["Larn exited — your game is saved. Reload to continue."]);
  });

  it("does not promise a save after an unsaved exit (the phase-1 constant)", async () => {
    const { notices, delegate } = harness();
    expect(await delegate.dispatch({
      type: "quit", saved: false, persistent: true, reason: null,
    })).toBeNull();
    expect(notices).toEqual(["Larn exited — reload to restart."]);
  });

  it("says nothing in the message strip about session-only storage", async () => {
    const calls: string[] = [];
    const delegate = makeDelegate({
      onNotice: (text) => calls.push(text), handle: () => {}, nextKey: () => null,
      onReady: () => calls.push("ready"),
    });
    expect(await delegate.dispatch({ type: "ready" })).toBeNull();
    // Only "ready" — see the Angband delegate's twin of this test
    // (scripts/test/backplane-session.test.ts) for why the strip line went.
    expect(calls).toEqual(["ready"]);
  });

  it("words an engine death around the engine's own diagnostic", () => {
    const { delegate } = harness();
    expect(delegate.fatalNotice("wasm trap"))
      .toBe("The Larn engine died — wasm trap. Reload the page to restart.");
  });

  it("answers the key wait with the view's key", async () => {
    const calls: Array<[boolean, boolean]> = [];
    const delegate = makeDelegate({
      onNotice: () => {}, handle: () => {},
      nextKey: (wait, cmd) => { calls.push([wait, cmd]); return { code: 0x6a, mods: 0 }; },
    });
    expect(await delegate.dispatch({ type: "getKey", id: 4, wait: true, cmd: false }))
      .toEqual({ type: "key", id: 4, code: 0x6a, mods: 0 });
    expect(calls).toEqual([[true, false]]);
  });

  it("answers a keyless view with code 0 — the reply is still owed", async () => {
    const delegate = makeDelegate({
      onNotice: () => {}, handle: () => {}, nextKey: () => null,
    });
    expect(await delegate.dispatch({ type: "getKey", id: 5, wait: false, cmd: false }))
      .toEqual({ type: "key", id: 5, code: 0, mods: 0 });
  });

  it("hands display events to the view and posts nothing back", async () => {
    const { events, delegate } = harness();
    expect(await delegate.dispatch({
      type: "event", ev: { name: "text", x: 0, y: 0, rgb: 0xcccccc, text: "Welcome" },
    })).toBeNull();
    expect(await delegate.dispatch({ type: "event", ev: { name: "wipe", x: 3, y: 2, n: 10 } }))
      .toBeNull();
    expect(events).toEqual([
      { name: "text", x: 0, y: 0, rgb: 0xcccccc, text: "Welcome" },
      { name: "wipe", x: 3, y: 2, n: 10 },
    ]);
  });

  it("notifies release through onReleased", async () => {
    let released = 0;
    const delegate = makeDelegate(
      { onNotice: () => {}, handle: () => {}, nextKey: () => null },
      () => released++,
    );
    expect(await delegate.dispatch({ type: "released" })).toBeNull();
    expect(released).toBe(1);
  });
});

describe("LarnSession storage lifecycle", () => {
  class FakeWorker {
    onmessage: ((event: { data: LarnWorkerToMain }) => void) | null = null;
    posted: LarnMainToWorker[] = [];
    terminated = false;
    postMessage(message: LarnMainToWorker) { this.posted.push(message); }
    terminate() { this.terminated = true; }
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("leaves enough time for the worker's two bounded IDBFS flushes", () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    vi.stubGlobal("Worker", class extends FakeWorker {
      constructor() { super(); workers.push(this); }
    });
    const session = new LarnSession({
      onNotice: () => {}, handle: () => {}, nextKey: () => null,
    });

    session.terminate();
    vi.advanceTimersByTime(20_000);

    expect(workers[0]?.posted).toEqual([{ type: "release" }]);
    expect(workers[0]?.terminated).toBe(false);
    workers[0]?.onmessage?.({ data: { type: "released" } });
    expect(workers[0]?.terminated).toBe(true);
  });

  it("still terminates a broken worker after the durability bound", () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    vi.stubGlobal("Worker", class extends FakeWorker {
      constructor() { super(); workers.push(this); }
    });
    const session = new LarnSession({
      onNotice: () => {}, handle: () => {}, nextKey: () => null,
    });

    session.terminate();
    vi.advanceTimersByTime(21_000);

    expect(workers[0]?.terminated).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { KC_ESCAPE, type MoriaEvent, type MoriaMainToWorker, type MoriaWorkerToMain } from "../../src/modules/moria/protocol";
import { MoriaSession, makeDelegate, moriaFallback } from "../../src/modules/moria/session";

describe("Moria session delegate", () => {
  it("has an exhaustive cancel-shaped fallback table", () => {
    expect(moriaFallback({
      type: "getKey", id: 1, wait: true, context: "literal", mode: "original", delayMicroseconds: 0,
    })).toEqual({ type: "key", id: 1, result: { status: "key", key: KC_ESCAPE } });
    expect(moriaFallback({
      type: "getKey", id: 2, wait: false, context: "poll", mode: "original", delayMicroseconds: 10_000,
    })).toEqual({ type: "key", id: 2, result: { status: "none" } });
    const oneWay: Record<Exclude<MoriaWorkerToMain["type"], "getKey">, null> = {
      ready: null, event: null, quit: null, released: null, saveBlob: null,
      // Same reasoning as saveBlob: a describe reply is one-way, and a hover
      // superseded or timed out settles itself (src/backplane/describe.ts).
      describeReply: null,
      notice: null, fatal: null, sessionOnly: null,
    };
    for (const type of Object.keys(oneWay))
      expect(moriaFallback({ type } as MoriaWorkerToMain), type).toBeNull();
  });

  it("dispatches frames and keys, and reports truthful ready/quit storage state", async () => {
    const events: MoriaEvent[] = [], notices: string[] = [], calls: unknown[] = [];
    const delegate = makeDelegate({
      onReady: () => calls.push("ready"), onNotice: (s) => notices.push(s),
      handle: (ev) => events.push(ev),
      nextKey: (wait, context, mode) => { calls.push([wait, context, mode]); return 0; },
    });
    expect(await delegate.dispatch({ type: "ready" })).toBeNull();
    const ev = { name: "bell" } as const;
    expect(await delegate.dispatch({ type: "event", ev })).toBeNull();
    expect(await delegate.dispatch({
      type: "getKey", id: 4, wait: true, context: "outer-command", mode: "roguelike", delayMicroseconds: 0,
    })).toEqual({ type: "key", id: 4, result: { status: "key", key: 0 } });
    expect(await delegate.dispatch({
      type: "quit", saved: false, persistent: false, reason: "another tab",
    })).toBeNull();
    expect(calls).toEqual(["ready", [true, "outer-command", "roguelike"]]);
    expect(events).toEqual([ev]);
    // The quit line and nothing else: ready carries no storage line any more,
    // because a warning the strip scrolls away is not a warning
    // (vect-hack-dem).
    expect(notices).toEqual(["Moria exited — reload to restart."]);
  });

  it("promises continuation only for an explicit save that reached persistent storage", async () => {
    const notices: string[] = [];
    const delegate = makeDelegate({
      onNotice: (text) => notices.push(text), handle: () => {}, nextKey: () => null,
    });
    await delegate.dispatch({ type: "quit", saved: true, persistent: true, reason: null });
    expect(notices).toEqual(["Moria exited — your game is saved. Reload to continue."]);
  });

  it("surfaces a strict final-sync failure without claiming the game is saved", async () => {
    const notices: string[] = [];
    const delegate = makeDelegate({
      onNotice: (text) => notices.push(text), handle: () => {}, nextKey: () => null,
    });
    await delegate.dispatch({
      type: "quit", saved: false, persistent: true,
      reason: "could not persist the Moria volume: Error: transaction failed",
    });
    expect(notices).toEqual([
      "Moria exited — reload to restart. Saving failed — could not persist the Moria volume: Error: transaction failed.",
    ]);
  });

  it("answers an empty poll as no-key and words fatal errors", async () => {
    const delegate = makeDelegate({ onNotice: () => {}, handle: () => {}, nextKey: () => null });
    expect(await delegate.dispatch({
      type: "getKey", id: 5, wait: false, context: "poll", mode: "original", delayMicroseconds: 0,
    })).toEqual({ type: "key", id: 5, result: { status: "none" } });
    expect(delegate.fatalNotice("trap")).toBe("The Moria engine died — trap. Reload the page to restart.");
    expect(delegate.fallback({
      type: "getKey", id: 6, wait: true, context: "literal", mode: "original", delayMicroseconds: 0,
    })).toEqual({ type: "key", id: 6, result: { status: "key", key: KC_ESCAPE } });
  });
});

describe("MoriaSession release", () => {
  class FakeWorker {
    onmessage: ((event: { data: MoriaWorkerToMain }) => void) | null = null;
    posted: MoriaMainToWorker[] = []; terminated = false;
    postMessage(message: MoriaMainToWorker) { this.posted.push(message); }
    terminate() { this.terminated = true; }
  }
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("is idempotent, acknowledges release, and bounds a broken worker", () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    vi.stubGlobal("Worker", class extends FakeWorker { constructor() { super(); workers.push(this); } });
    const session = new MoriaSession({ onNotice: () => {}, handle: () => {}, nextKey: () => null });
    session.terminate(); session.terminate();
    expect(workers[0]!.posted).toEqual([{ type: "release" }]);
    workers[0]!.onmessage?.({ data: { type: "released" } });
    expect(workers[0]!.terminated).toBe(true);

    const second = new MoriaSession({ onNotice: () => {}, handle: () => {}, nextKey: () => null });
    second.terminate();
    // Finalization can spend 10s draining an older auto-persist reconcile and
    // then 10s in the strict sync. The main thread must not kill the Worker
    // during either bounded persistence operation.
    vi.advanceTimersByTime(20_000);
    expect(workers[1]!.terminated).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(workers[1]!.terminated).toBe(true);
  });

  it("exports through the Backplane round trip", async () => {
    const workers: FakeWorker[] = [];
    vi.stubGlobal("Worker", class extends FakeWorker { constructor() { super(); workers.push(this); } });
    const session = new MoriaSession({ onNotice: () => {}, handle: () => {}, nextKey: () => null });

    const exported = session.exportSave();
    expect(workers[0]!.posted).toEqual([{ type: "exportSave", id: 1 }]);
    workers[0]!.onmessage?.({ data: {
      type: "saveBlob", id: 1, ok: true,
      bytes: new Uint8Array([4, 5]), filename: "moria.vhsave",
    } });

    await expect(exported).resolves.toEqual({
      bytes: new Uint8Array([4, 5]), filename: "moria.vhsave",
    });
  });
});

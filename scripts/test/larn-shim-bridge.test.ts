// The two semantics the shared VectLarn bridge exists to preserve
// (vect-hack-dwb). Both were mitigations added by hand to six literal copies
// of the shim object, and both are exactly the kind of thing a "just share the
// code" refactor quietly loses:
//
//  1. The GYM hooks read as ABSENT when a host does not want them. main-wasm.c
//     asks `typeof v.gymSeed === "function"` and treats a miss as "off", so a
//     default here would silently seed every browser game.
//  2. The DISPLAY callbacks fail LOUDLY. When statusBatch landed, four gates
//     threw within minutes and were fixed within minutes. A no-op default
//     would have turned that into a Module that draws nothing and says
//     nothing.
//
// The C side is not in this test: it is a unit test of the bridge's contract,
// and the engine tests (npm run test:larn) are what prove the six hosts still
// drive a real Larn.
import { describe, expect, it } from "vitest";
import { createLarnShim, installLarnShim } from "../../src/modules/larn/shimBridge";
import type { LarnEvent } from "../../src/modules/larn/protocol";

/** What main-wasm.c's wasm_gym_seed()/wasm_gym_fast() actually do. Copied
 *  here rather than imported because it is C, and this is the join. */
const gymHook = (shim: Record<string, unknown>, name: string): number => {
  const fn = shim[name];
  return typeof fn === "function" ? ((fn as () => number)() | 0) : 0;
};

describe("the shared Larn shim bridge", () => {
  it("reads an absent gym hook as off, and installs no property to read", () => {
    const quiet = createLarnShim({ name: "test host", onEvent: () => {} });
    // Not "returns 0" — NOT THERE. `typeof` is the whole mechanism: a bridge
    // that supplied `gymSeed: () => 0` would pass a value check and still
    // break the browser, because __wrap_newgame would then take the hook.
    expect("gymSeed" in quiet).toBe(false);
    expect("gymFast" in quiet).toBe(false);
    expect(gymHook(quiet, "gymSeed")).toBe(0);
    expect(gymHook(quiet, "gymFast")).toBe(0);
  });

  it("hands through a gym hook the host does supply", () => {
    const seeded = createLarnShim({ name: "test host", onEvent: () => {}, gymSeed: () => 4242 });
    expect(gymHook(seeded, "gymSeed")).toBe(4242);
    expect(gymHook(seeded, "gymFast")).toBe(0); // still absent, still off
  });

  it("throws on a display callback no host answered, naming the callback and the host", () => {
    const deaf = createLarnShim({ name: "scripts/test/example-host.mjs" });
    // The message has to carry both halves: which callback the shim called
    // (so the fix is one line) and which host installed the bridge (so the
    // 2am stack trace names the file to open).
    expect(() => (deaf.mapBatch as (v: Int32Array) => void)(new Int32Array([1, 2])))
      .toThrow(/mapBatch/);
    expect(() => (deaf.mapBatch as (v: Int32Array) => void)(new Int32Array([1, 2])))
      .toThrow(/scripts\/test\/example-host\.mjs/);
    expect(() => (deaf.statusBatch as (v: Int32Array, n: Uint8Array) => void)(
      new Int32Array([1]), new Uint8Array([0]))).toThrow(/statusBatch/);
    expect(() => (deaf.text as (x: number, y: number, r: number, s: string) => void)(0, 0, 0, "x"))
      .toThrow(/text/);
  });

  it("copies both batches out of the heap view before the host sees them", () => {
    const seen: LarnEvent[] = [];
    const shim = createLarnShim({ name: "test host", onEvent: (ev) => seen.push(ev) });
    // A live HEAP subarray is reused by the engine the moment the call
    // returns, so the bridge owns the copy — no host may be trusted with it.
    const heap = new Int32Array([7, 8, 9]);
    (shim.mapBatch as (v: Int32Array) => void)(heap);
    heap[0] = 0;
    expect(seen).toHaveLength(1);
    const ev = seen[0] as LarnEvent;
    expect(ev.name).toBe("map");
    expect(ev.name === "map" && Array.from(ev.records)).toEqual([7, 8, 9]);
  });

  it("owns the key register: gatherKey stores what the host answered", async () => {
    const shim = createLarnShim({
      name: "test host",
      onEvent: () => {},
      gatherKey: (wait, cmd) => (wait && cmd ? { code: 105, mods: 2 } : null),
    });
    const gather = shim.gatherKey as (w: number, c: number) => Promise<number>;
    expect(await gather(1, 1)).toBe(1);
    expect((shim.keyCode as () => number)()).toBe(105);
    expect((shim.keyMods as () => number)()).toBe(2);
    // A refused wait is code 0, the only reply the shim reads as "no key".
    expect(await gather(0, 0)).toBe(0);
    expect((shim.keyCode as () => number)()).toBe(0);
    expect((shim.keyMods as () => number)()).toBe(0);
  });

  it("installs itself where every EM_JS block looks for it", () => {
    const shim = installLarnShim({ name: "test host", onEvent: () => {} });
    expect((globalThis as Record<string, unknown>).VectLarn).toBe(shim);
    delete (globalThis as Record<string, unknown>).VectLarn;
  });
});

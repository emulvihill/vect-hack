// src/modules/angband/worker.ts itself, imported and booted. The engine
// drivers install their own VectAngband, so the worker's own callbacks — the
// key register, the checkpoint gate, the quit report, the ?borg pace held
// until the volume is up — had no test but the browser gates.
//
// Loaded the way scripts/test/nethack/nethack-worker.test.ts loads NetHack's:
// worker globals stubbed, BASE_URL pointed at a temp directory whose
// modules/angband/angband.js hands the emscripten options to the test, which
// then plays the runtime. The volume, the checkpoint cadence and the borg.txt
// patch are swapped at their factories: their own tests cover what they do,
// and this one covers how the worker wires them.
import { describe, expect, it, vi } from "vitest";
import type { AngbandMainToWorker, AngbandWorkerToMain } from "../../../src/modules/angband/protocol";
import { deferred, standInCore, stubWorkerScope, turn } from "../worker-harness";

const seam = vi.hoisted(() => ({
  mount: (_m: unknown): unknown => undefined,
  checkpoint: { command: (): void => {}, due: (): boolean => false, landed: (): void => {} },
  applyBorgDelay: (_fs: unknown, _ms: number): void => {},
}));
vi.mock("../../../src/modules/angband/persist", () => ({
  mountAngbandStorage: (m: unknown) => seam.mount(m),
}));
vi.mock("../../../src/modules/angband/angbandCheckpoint", () => ({
  createAngbandCheckpoint: () => ({
    command: () => seam.checkpoint.command(),
    due: () => seam.checkpoint.due(),
    landed: () => seam.checkpoint.landed(),
  }),
}));
vi.mock("../../../src/modules/angband/borgConfig", () => ({
  applyBorgDelay: (fs: unknown, ms: number) => seam.applyBorgDelay(fs, ms),
}));

const core = standInCore("angband", "__vhFakeAngbandCore");

/** Load worker.ts fresh. `ready` gates persist.ready, so a test can act
 *  between the runtime coming up and the volume settling. */
async function boot(opts: { persistent?: boolean } = {}) {
  vi.resetModules();
  const { posted, messages, listeners } = stubWorkerScope<AngbandWorkerToMain>(core.dir());
  const volume = deferred<boolean>();
  const persist = {
    ready: volume.promise,
    persistent: opts.persistent ?? true,
    reason: opts.persistent === false ? { code: "no-idb", detail: "IndexedDB is off" } : null,
    flush: vi.fn(async () => {}),
    release: vi.fn(),
    exportSave: vi.fn(() => ({ bytes: new Uint8Array([9]), filename: "angband.vhsave" })),
  };
  seam.mount = vi.fn(() => persist);
  const checkpoint = { command: vi.fn(), due: vi.fn(() => false), landed: vi.fn() };
  seam.checkpoint = checkpoint;
  const applyBorgDelay = vi.fn();
  seam.applyBorgDelay = applyBorgDelay;

  const FS = { tag: "engine FS" };
  const ccall = vi.fn((): unknown => "");
  let options: Record<string, any> = {};
  const factory = deferred();
  vi.stubGlobal("__vhFakeAngbandCore", async (o: Record<string, any>) => {
    options = o;
    for (const fn of o.preRun) fn(o);
    Object.assign(o, { FS, ccall });
    o.onRuntimeInitialized();
    factory.resolve();
  });
  vi.stubGlobal("VectAngband", undefined);

  await import("../../../src/modules/angband/worker");
  await factory.promise;
  await turn(); // `engine = options` lands after the factory resolves

  const g = globalThis as Record<string, any>;
  const v = g.VectAngband as Record<string, any>;
  return {
    posted, listeners, persist, checkpoint, applyBorgDelay, FS, ccall, options, v,
    messages: () => messages,
    send: (data: AngbandMainToWorker) => (g.onmessage as (e: { data: unknown }) => void)({ data }),
    /** Let the volume settle, and with it `ready`. */
    settle: async () => { volume.resolve(persist.persistent); await turn(); },
  };
}

describe("Angband worker boot", () => {
  it("says ready only once the volume has settled, and resolves the data package beside the core", async () => {
    const w = await boot();
    expect(w.messages().filter((m) => m.type === "ready")).toEqual([]);
    await w.settle();
    expect(w.messages().filter((m) => m.type === "ready")).toEqual([{ type: "ready" }]);
    expect(w.options.locateFile("angband.data")).toBe(`file://${core.dir()}/modules/angband/angband.data`);
  });

  it("holds a ?borg pace that arrives before the volume, and applies it to the engine's FS at ready", async () => {
    const w = await boot();
    w.send({ type: "borgDelay", ms: 40 });
    expect(w.v.borgDelayMs).toBe(40); // C reads it straight away
    expect(w.applyBorgDelay).not.toHaveBeenCalled(); // borg.txt is not populated yet
    await w.settle();
    expect(w.applyBorgDelay).toHaveBeenCalledExactlyOnceWith(w.FS, 40);
    const order = w.messages().map((m) => m.type);
    expect(order.at(-1)).toBe("ready"); // the patch is in before the view is told
  });

  it("applies a ?borg pace that arrives after ready at once, and only once", async () => {
    const w = await boot();
    await w.settle();
    w.send({ type: "borgDelay", ms: 5 });
    expect(w.applyBorgDelay).toHaveBeenCalledExactlyOnceWith(w.FS, 5);
  });

  it("turns a stray rejection or error into a fatal", async () => {
    const w = await boot();
    w.listeners.get("unhandledrejection")!({ reason: "boom" });
    w.listeners.get("error")!({ message: "kaput" });
    expect(w.messages().slice(-2)).toEqual([
      { type: "fatal", message: "unhandled rejection: boom" },
      { type: "fatal", message: "worker error: kaput" },
    ]);
  });
});

describe("Angband worker display callbacks", () => {
  it("decodes a UTF-32 text run before the heap view can go stale", async () => {
    const w = await boot();
    const run = new Uint32Array([0x41, 0x1f409, 0x7a]);
    w.v.text(3, 4, 3, 1, 0xff00ff, run);
    run.fill(0);
    expect(w.messages().at(-1)).toEqual({
      type: "event", ev: { name: "text", x: 3, y: 4, attr: 1, rgb: 0xff00ff, text: "A\u{1f409}z" },
    });
  });

  it("copies a map batch out of the heap and transfers the copy", async () => {
    const w = await boot();
    const heap = new Int32Array([1, 2, 3]);
    w.v.mapBatch(heap);
    heap[0] = 99;
    const { m, transfer } = w.posted.at(-1)!;
    const records = (m as { ev: { records: Int32Array } }).ev.records;
    expect(Array.from(records)).toEqual([1, 2, 3]);
    expect(transfer).toEqual([records.buffer]);
    expect(records.buffer).not.toBe(heap.buffer);
  });

  it("converts an effect's codepoint and its beam flag, and the overlay flag", async () => {
    const w = await boot();
    w.v.effect(5, 6, 0x2a, 4, 0x123456, 1);
    expect(w.messages().at(-1)).toEqual({
      type: "event", ev: { name: "effect", x: 5, y: 6, ch: "*", color: 4, rgb: 0x123456, beam: true },
    });
    w.v.overlay(0);
    expect(w.messages().at(-1)).toEqual({ type: "event", ev: { name: "overlay", active: false } });
  });
});

describe("Angband worker key wait", () => {
  it("parks on a key, then serves its code and mods synchronously from the register", async () => {
    const w = await boot();
    const got = w.v.gatherKey(1, 1) as Promise<number>;
    const ask = w.messages().at(-1) as Extract<AngbandWorkerToMain, { type: "getKey" }>;
    expect(ask).toMatchObject({ type: "getKey", wait: true, cmd: true });
    w.send({ type: "key", id: ask.id + 1, code: 1, mods: 1 }); // not the one asked for: dropped
    w.send({ type: "key", id: ask.id, code: 0x6a, mods: 4 });
    expect(await got).toBe(1);
    expect([w.v.keyCode(), w.v.keyMods()]).toEqual([0x6a, 4]);
  });

  it("answers no-key as 0, and counts only command-level waits toward a checkpoint", async () => {
    const w = await boot();
    const menu = w.v.gatherKey(0, 0) as Promise<number>;
    expect(w.messages().at(-1)).toMatchObject({ wait: false, cmd: false });
    expect(w.checkpoint.command).not.toHaveBeenCalled(); // a menu key is not a turn
    w.send({ type: "key", id: (w.messages().at(-1) as { id: number }).id, code: 0, mods: 0 });
    expect(await menu).toBe(0);

    void w.v.gatherKey(1, 1);
    expect(w.checkpoint.command).toHaveBeenCalledOnce();
  });
});

describe("Angband worker checkpoints and quit", () => {
  it("asks for a checkpoint only on a persistent volume, and only when one is due", async () => {
    const w = await boot();
    expect(w.v.checkpointDue()).toBe(0);
    w.checkpoint.due.mockReturnValue(true);
    expect(w.v.checkpointDue()).toBe(1);

    const lost = await boot({ persistent: false });
    lost.checkpoint.due.mockReturnValue(true);
    expect(lost.v.checkpointDue()).toBe(0); // a full save for nothing
  });

  it("does nothing for a failed checkpoint, and stamps and flushes a landed one", async () => {
    const w = await boot();
    w.v.checkpointLanded(0);
    expect(w.checkpoint.landed).not.toHaveBeenCalled(); // still due: the next command retries
    expect(w.persist.flush).not.toHaveBeenCalled();
    w.v.checkpointLanded(1);
    expect(w.checkpoint.landed).toHaveBeenCalledOnce();
    expect(w.persist.flush).toHaveBeenCalledOnce();
  });

  it("reports a quit as saved only when a checkpoint reached the volume, and waits for it", async () => {
    const w = await boot();
    const mirror = deferred();
    w.persist.flush.mockReturnValueOnce(mirror.promise);
    w.v.checkpointLanded(1);
    w.v.quit("", 1); // NULL: a clean exit
    await turn();
    expect(w.messages().filter((m) => m.type === "quit")).toEqual([]); // still mirroring
    mirror.resolve();
    await vi.waitFor(() => expect(w.messages().at(-1)).toEqual({
      type: "quit", saved: true, persistent: true, reason: null,
    }));
  });

  it("reports an unsaved quit with the volume's reason when nothing was checkpointed", async () => {
    const w = await boot({ persistent: false });
    w.v.quit("user choice", 0);
    await vi.waitFor(() => expect(w.messages().at(-1)).toEqual({
      type: "quit", saved: false, persistent: false, reason: "IndexedDB is off",
    }));
  });

  it("counts a checkpoint whose mirror failed as unsaved", async () => {
    const w = await boot();
    w.persist.flush.mockRejectedValueOnce(new Error("IDBFS failed"));
    w.v.checkpointLanded(1);
    w.v.quit("", 1);
    await vi.waitFor(() => expect(w.messages().at(-1)).toMatchObject({ type: "quit", saved: false }));
  });

  it("reports a quit with a reason of its own as fatal", async () => {
    const w = await boot();
    w.v.quit("Cannot open 'lib/gamedata'", 0);
    await vi.waitFor(() => expect(w.messages().at(-1)).toEqual({
      type: "fatal", message: "Cannot open 'lib/gamedata'",
    }));
  });
});

describe("Angband worker messages from the page", () => {
  it("names a grid through the engine once it is up, an empty answer as nothing", async () => {
    const w = await boot();
    w.ccall.mockReturnValueOnce("a Grip, Farmer Maggot's Dog").mockReturnValueOnce("");
    w.send({ type: "describe", id: 1, x: 2, y: 3 });
    w.send({ type: "describe", id: 2, x: 2, y: 3 });
    expect(w.ccall).toHaveBeenCalledWith("vect_angband_describe", "string", ["number", "number"], [2, 3]);
    expect(w.messages().slice(-2)).toEqual([
      { type: "describeReply", id: 1, text: "a Grip, Farmer Maggot's Dog" },
      { type: "describeReply", id: 2, text: null },
    ]);
  });

  it("releases the volume and says so", async () => {
    const w = await boot();
    w.send({ type: "release" });
    expect(w.persist.release).toHaveBeenCalledOnce();
    expect(w.messages().at(-1)).toEqual({ type: "released" });
  });

  it("answers an export from the volume handle", async () => {
    const w = await boot();
    w.send({ type: "exportSave", id: 4 });
    expect(w.messages().at(-1)).toEqual({
      type: "saveBlob", id: 4, ok: true, bytes: new Uint8Array([9]), filename: "angband.vhsave",
    });
  });
});

// src/modules/larn/worker.ts itself, imported and booted. The shared shim
// (larn-shim-bridge.test.ts) and the persistence lifecycle
// (larn-worker-persistence.test.ts) are tested on their own; what only the
// browser gates exercised was this host: what it posts, what it transfers,
// how a key reply reaches the parked wait, and that the quit it reports is not
// chased by the teardown's own "engine died".
//
// Loaded the way scripts/test/nethack/nethack-worker.test.ts loads NetHack's:
// worker globals stubbed, BASE_URL pointed at a temp directory whose
// modules/larn/larn.js hands the emscripten options to the test. The volume
// mount is swapped at its factory; the lifecycle is the real one.
import { describe, expect, it, vi } from "vitest";
import type { LarnMainToWorker, LarnWorkerToMain } from "../../../src/modules/larn/protocol";
import { deferred, missingCoreDir, standInCore, stubWorkerScope, turn } from "../worker-harness";

const seam = vi.hoisted(() => ({ mount: (_m: unknown): unknown => undefined }));
vi.mock("../../../src/modules/larn/persist", () => ({
  mountLarnStorage: (m: unknown) => seam.mount(m),
}));

const core = standInCore("larn", "__vhFakeLarnCore");

async function boot(opts: { factoryError?: Error; missingCore?: boolean } = {}) {
  vi.resetModules();
  const { posted, messages, listeners } = stubWorkerScope<LarnWorkerToMain>(
    opts.missingCore ? missingCoreDir(core.dir()) : core.dir());
  const volume = deferred<boolean>();
  const persist = {
    ready: volume.promise,
    persistent: true,
    reason: null,
    flush: vi.fn(async () => {}),
    release: vi.fn(),
    exportSave: vi.fn(() => ({ bytes: new Uint8Array([7]), filename: "larn.vhsave" })),
  };
  seam.mount = vi.fn(() => persist);

  const ccall = vi.fn((): unknown => "");
  let options: Record<string, any> = {};
  const factory = deferred();
  vi.stubGlobal("__vhFakeLarnCore", async (o: Record<string, any>) => {
    options = o;
    if (opts.factoryError) { factory.resolve(); throw opts.factoryError; }
    for (const fn of o.preRun) fn(o);
    Object.assign(o, { ccall });
    o.onRuntimeInitialized();
    factory.resolve();
  });
  vi.stubGlobal("VectLarn", undefined);

  await import("../../../src/modules/larn/worker");
  if (opts.missingCore) await vi.waitFor(() => expect(messages).not.toEqual([]));
  else await factory.promise;
  await turn();

  const g = globalThis as Record<string, any>;
  return {
    posted, listeners, persist, ccall, options,
    v: g.VectLarn as Record<string, any>,
    messages: () => messages,
    send: (data: LarnMainToWorker) => (g.onmessage as (e: { data: unknown }) => void)({ data }),
    settle: async () => { volume.resolve(true); await turn(); },
  };
}

describe("Larn worker boot", () => {
  it("installs the shim before the core runs, and says ready only once the volume settled", async () => {
    const w = await boot();
    expect(typeof w.v.gatherKey).toBe("function");
    expect(w.messages().filter((m) => m.type === "ready")).toEqual([]);
    await w.settle();
    expect(w.messages().filter((m) => m.type === "ready")).toEqual([{ type: "ready" }]);
    expect(w.options.locateFile("larn.data")).toBe(`file://${core.dir()}/modules/larn/larn.data`);
  });

  it("reports a core that never arrived by its URL, not as a fatal (vect-hack-o3rc)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = await boot({ missingCore: true });
    await turn();
    // A fatal would earn the reset advice, which points at a save the engine
    // never read. The browser's reason goes to the console, not the player.
    expect(w.messages()).toEqual([{
      type: "engineLoadFailed",
      url: `file://${missingCoreDir(core.dir())}/modules/larn/larn.js`,
    }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("larn.js"), expect.anything());
    warn.mockRestore();
  });

  it("reports a core that would not start as fatal", async () => {
    const w = await boot({ factoryError: new Error("no wasm") });
    await turn();
    expect(w.messages()).toContainEqual({ type: "fatal", message: "Error: no wasm" });
  });
});

describe("Larn worker as a shim host", () => {
  it("posts display events, transferring the two batches the bridge copied for it", async () => {
    const w = await boot();
    w.v.text(1, 2, 0xffffff, "Welcome");
    expect(w.posted.at(-1)).toEqual({
      m: { type: "event", ev: { name: "text", x: 1, y: 2, rgb: 0xffffff, text: "Welcome" } }, transfer: [],
    });

    w.v.mapBatch(new Int32Array([1, 2]));
    const map = w.posted.at(-1)!;
    const records = (map.m as { ev: { records: Int32Array } }).ev.records;
    expect(Array.from(records)).toEqual([1, 2]);
    expect(map.transfer).toEqual([records.buffer]);

    w.v.statusBatch(new Int32Array([3]), new Uint8Array([65, 0]));
    const status = w.posted.at(-1)!;
    const ev = (status.m as { ev: { record: Int32Array; names: Uint8Array } }).ev;
    expect(status.transfer).toEqual([ev.record.buffer, ev.names.buffer]);
  });

  it("passes a refused .larnopts option on as a notice", async () => {
    const w = await boot();
    w.v.notice("savefile: ignored");
    expect(w.messages().at(-1)).toEqual({ type: "notice", text: "savefile: ignored" });
  });

  it("parks on a key and hands the shim its code; a code-0 reply is no key", async () => {
    const w = await boot();
    const got = w.v.gatherKey(1, 1) as Promise<number>;
    const ask = w.messages().at(-1) as Extract<LarnWorkerToMain, { type: "getKey" }>;
    expect(ask).toMatchObject({ type: "getKey", wait: true, cmd: true });
    w.send({ type: "key", id: ask.id, code: 0x68, mods: 2 });
    expect(await got).toBe(1);
    expect([w.v.keyCode(), w.v.keyMods()]).toEqual([0x68, 2]);

    const none = w.v.gatherKey(0, 0) as Promise<number>;
    const poll = w.messages().at(-1) as Extract<LarnWorkerToMain, { type: "getKey" }>;
    expect(poll).toMatchObject({ wait: false, cmd: false });
    w.send({ type: "key", id: poll.id, code: 0, mods: 0 });
    expect(await none).toBe(0);
    expect(w.v.keyCode()).toBe(0);
  });

  it("flushes the volume when a save lands", async () => {
    const w = await boot();
    w.v.saveLanded();
    await turn();
    expect(w.persist.flush).toHaveBeenCalledOnce();
  });
});

describe("Larn worker quit", () => {
  it("reports the quit after the final flush, and no fatal from the teardown after it", async () => {
    const w = await boot();
    w.v.saveLanded();
    w.v.quit(1);
    // exit(2) tears the runtime down behind the quit: that noise is not a death.
    w.listeners.get("error")!({ message: "ExitStatus" });
    w.listeners.get("unhandledrejection")!({ reason: "unwind" });
    await vi.waitFor(() => expect(w.messages().at(-1)).toEqual({
      type: "quit", saved: true, persistent: true, reason: null,
    }));
    expect(w.messages().filter((m) => m.type === "fatal")).toEqual([]);
  });

  it("still reports a stray error as fatal while the game is running", async () => {
    const w = await boot();
    w.listeners.get("error")!({ message: "kaput" });
    w.listeners.get("unhandledrejection")!({ reason: "boom" });
    expect(w.messages().slice(-2)).toEqual([
      { type: "fatal", message: "worker error: kaput" },
      { type: "fatal", message: "unhandled rejection: boom" },
    ]);
  });

  it("delivers no key once the engine is closing", async () => {
    const w = await boot();
    const got = w.v.gatherKey(1, 1) as Promise<number>;
    const ask = w.messages().at(-1) as Extract<LarnWorkerToMain, { type: "getKey" }>;
    w.v.quit(0);
    w.send({ type: "key", id: ask.id, code: 0x68, mods: 0 });
    const r = await Promise.race([got, turn().then(() => "parked")]);
    expect(r).toBe("parked");
  });
});

describe("Larn worker messages from the page", () => {
  it("names a grid through the engine once it is up, an empty answer as nothing", async () => {
    const w = await boot();
    w.ccall.mockReturnValueOnce("a giant ant").mockReturnValueOnce("");
    w.send({ type: "describe", id: 1, x: 5, y: 6 });
    w.send({ type: "describe", id: 2, x: 5, y: 6 });
    expect(w.ccall).toHaveBeenCalledWith("vect_larn_describe", "string", ["number", "number"], [5, 6]);
    expect(w.messages().slice(-2)).toEqual([
      { type: "describeReply", id: 1, text: "a giant ant" },
      { type: "describeReply", id: 2, text: null },
    ]);
  });

  it("releases the volume after its last flush, then says so", async () => {
    const w = await boot();
    w.send({ type: "release" });
    await vi.waitFor(() => expect(w.messages().at(-1)).toEqual({ type: "released" }));
    expect(w.persist.flush).toHaveBeenCalledOnce();
    expect(w.persist.release).toHaveBeenCalledOnce();
  });

  it("answers an export from the volume handle", async () => {
    const w = await boot();
    w.send({ type: "exportSave", id: 3 });
    expect(w.messages().at(-1)).toEqual({
      type: "saveBlob", id: 3, ok: true, bytes: new Uint8Array([7]), filename: "larn.vhsave",
    });
  });
});

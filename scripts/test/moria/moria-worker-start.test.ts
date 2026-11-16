// startMoriaWorker, the glue in src/modules/moria/worker.ts that
// moria-worker-bridge.test.ts leaves out: it tests the bridge, the message
// router, runMoriaEngine and the terminal reporter one by one, and this is
// where they are put together — the describer published at engineReady, the
// quit that needs beforeExit's persistence state, and the scope's listeners.
//
// The scope is a parameter, so no worker globals need stubbing; only the core
// import does, through BASE_URL, the same way nethack-worker.test.ts does it.
// The volume is swapped at its factory; the lifecycle is the real one.
import { describe, expect, it, vi } from "vitest";
import type { MoriaMainToWorker, MoriaWorkerToMain } from "../../../src/modules/moria/protocol";
import { deferred, standInCore, turn } from "../worker-harness";

const seam = vi.hoisted(() => ({ mount: (_m: unknown): unknown => undefined }));
vi.mock("../../../src/modules/moria/persist", () => ({
  mountMoriaStorage: (m: unknown) => seam.mount(m),
}));

const { startMoriaWorker } = await import("../../../src/modules/moria/worker");

const core = standInCore("moria", "__vhFakeMoriaCore");

async function start() {
  const posted: MoriaWorkerToMain[] = [];
  const listeners = new Map<string, (e: unknown) => void>();
  const persist = {
    ready: Promise.resolve(true), persistent: true, reason: null,
    checkpointRecoveryPath: "",
    flush: vi.fn(async () => {}), release: vi.fn(), exportSave: vi.fn(),
    publishCheckpoint: vi.fn(), clearRecovery: vi.fn(), recordTerminal: vi.fn(),
  };
  seam.mount = vi.fn(() => persist);

  const run = deferred<unknown>();
  const module: Record<string, unknown> = {
    ccall: vi.fn((name: string): unknown => name === "moria_start" ? run.promise : ""),
  };
  let options: Record<string, any> = {};
  const factory = deferred();
  vi.stubGlobal("__vhFakeMoriaCore", async (o: Record<string, any>) => {
    options = o;
    for (const fn of o.preRun ?? []) fn(module);
    factory.resolve();
    return module;
  });
  vi.stubEnv("BASE_URL", core.dir() + "/");
  const scope = {
    location: { origin: "file://" },
    postMessage: (m: MoriaWorkerToMain) => void posted.push(m),
    addEventListener: (t: string, fn: (e: unknown) => void) => void listeners.set(t, fn),
    onmessage: null as null | ((e: { data: MoriaMainToWorker }) => void),
  };
  startMoriaWorker(scope as unknown as DedicatedWorkerGlobalScope);
  const send = (data: MoriaMainToWorker) => scope.onmessage!({ data });
  return {
    posted, listeners, persist, module, run, send,
    options: () => options,
    booted: async () => { await factory.promise; await vi.waitFor(() => expect(posted).toContainEqual({ type: "ready" })); },
  };
}

describe("startMoriaWorker", () => {
  it("names nothing before the engine is up, then asks the engine", async () => {
    const w = await start();
    w.send({ type: "describe", id: 1, x: 1, y: 2 }); // still loading the core
    expect(w.posted.at(-1)).toEqual({ type: "describeReply", id: 1, text: null });
    await w.booted();
    const ccall = w.module.ccall as ReturnType<typeof vi.fn>;
    ccall.mockImplementation((name: string) =>
      name === "moria_start" ? w.run.promise : name === "moria_describe" ? "a Grip, Farmer Maggot's Dog" : "");
    w.send({ type: "describe", id: 2, x: 1, y: 2 });
    expect(ccall).toHaveBeenCalledWith("moria_describe", "string", ["number", "number"], [1, 2]);
    expect(w.posted.at(-1)).toEqual({ type: "describeReply", id: 2, text: "a Grip, Farmer Maggot's Dog" });
    expect(w.options().locateFile("moria.wasm")).toBe(`file://${core.dir()}/modules/moria/moria.wasm`);
  });

  it("reports the quit with the persistence state its beforeExit finalized", async () => {
    const w = await start();
    await w.booted();
    await w.options().beforeExit(0, 1); // a native save: recovery cleared, volume flushed
    expect(w.persist.clearRecovery).toHaveBeenCalledOnce();
    w.module.moriaPreExit = true;
    w.run.resolve(undefined);
    await vi.waitFor(() => expect(w.posted.at(-1)).toEqual({
      type: "quit", saved: true, persistent: true, reason: null,
    }));
  });

  it("calls an exit that skipped beforeExit fatal rather than inventing a quit", async () => {
    const w = await start();
    await w.booted();
    w.module.moriaPreExit = true;
    w.run.resolve(undefined);
    await vi.waitFor(() => expect(w.posted.at(-1)).toEqual({
      type: "fatal", message: "Moria exited without finalized persistence state",
    }));
  });

  it("reports the first fault from the scope and nothing after it", async () => {
    const w = await start();
    await w.booted();
    w.listeners.get("error")!({ error: new Error("unreachable"), message: "ignored" });
    w.listeners.get("unhandledrejection")!({ reason: "teardown noise" });
    w.run.reject(new Error("late"));
    await turn();
    expect(w.posted.filter((m) => m.type === "fatal")).toEqual([
      { type: "fatal", message: "Error: unreachable" },
    ]);
  });

  it("reports a moria_start rejection as fatal", async () => {
    const w = await start();
    await w.booted();
    w.run.reject(new Error("RuntimeError: unreachable"));
    await vi.waitFor(() => expect(w.posted.at(-1)).toEqual({
      type: "fatal", message: "Error: RuntimeError: unreachable",
    }));
  });
});

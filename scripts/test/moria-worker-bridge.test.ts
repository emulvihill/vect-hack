import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  MoriaWorkerBridge,
  type MoriaNativeKeyRequest,
  type MoriaWorkerPost,
} from "../../src/modules/moria/workerBridge";
import {
  createMoriaTerminalReporter,
  handleMoriaWorkerMessage,
  runMoriaEngine,
  type MoriaRuntimeModule,
} from "../../src/modules/moria/worker";
import {
  MORIA_FRAME_BYTES,
  type MoriaMainToWorker,
  type MoriaWorkerToMain,
} from "../../src/modules/moria/protocol";
import type { MoriaSemanticReporter } from "../../src/modules/moria/semanticReporter";
import type { MoriaExitOutcome } from "../../src/modules/moria/persistenceLifecycle";

type Posted = { message: MoriaWorkerToMain; transfer: Transferable[] };
const realArtifactIt = process.env.MORIA_REAL_ARTIFACT === "1" ? it : it.skip;

function semanticCallbacks(): MoriaSemanticReporter {
  return {
    semanticMap: vi.fn(),
    semanticState: vi.fn(),
    semanticMessage: vi.fn(),
  };
}

function harness(options: {
  delay?: (milliseconds: number) => Promise<void>;
  release?: () => void | Promise<void>;
  beforeExit?: (status: number, outcome: MoriaExitOutcome) => void | Promise<void>;
} = {}) {
  const posted: Posted[] = [];
  const post: MoriaWorkerPost = (message, transfer = []) => {
    posted.push({ message, transfer });
  };
  const bridge = new MoriaWorkerBridge(post, options);
  return { bridge, posted, post };
}

const blocking = (over: Partial<MoriaNativeKeyRequest> = {}): MoriaNativeKeyRequest => ({
  blocking: true,
  context: "literal",
  roguelike: false,
  delayMicroseconds: 0,
  ...over,
});

const poll = (delayMicroseconds: number): MoriaNativeKeyRequest => ({
  blocking: false,
  context: "poll",
  roguelike: false,
  delayMicroseconds,
});

const inputPosts = (posted: Posted[]) => posted
  .map(({ message }) => message)
  .filter((message): message is Extract<MoriaWorkerToMain, { type: "getKey" }> =>
    message.type === "getKey");

describe("MoriaWorkerBridge terminal callbacks", () => {
  it("copies and transfers each exact 1,920-byte frame before native memory changes", () => {
    const { bridge, posted } = harness();
    const native = new Uint8Array(MORIA_FRAME_BYTES).fill(0x20);
    native[0] = 0x40;

    bridge.terminalFlush(native, 7, 11);
    native[0] = 0x58;

    expect(posted).toHaveLength(1);
    const { message, transfer } = posted[0]!;
    expect(message).toMatchObject({
      type: "event",
      ev: { name: "frame", x: 11, y: 7 },
    });
    if (message.type !== "event" || message.ev.name !== "frame") throw new Error("not a frame");
    expect(message.ev.cells).not.toBe(native);
    expect(message.ev.cells.byteLength).toBe(MORIA_FRAME_BYTES);
    expect(message.ev.cells[0]).toBe(0x40);
    expect(transfer).toEqual([message.ev.cells.buffer]);
  });

  it("rejects a malformed native frame instead of transferring partial terminal state", () => {
    const { bridge, posted } = harness();
    expect(() => bridge.terminalFlush(new Uint8Array(MORIA_FRAME_BYTES - 1), 0, 0))
      .toThrow(/exactly 1,920 bytes/);
    expect(posted).toHaveLength(0);
  });

  it("forwards the native bell as a one-way event", () => {
    const { bridge, posted } = harness();
    bridge.terminalBell();
    expect(posted.map(({ message }) => message)).toEqual([
      { type: "event", ev: { name: "bell" } },
    ]);
  });
});

describe("MoriaWorkerBridge input", () => {
  it("routes save export and refuses keys after persistence finalization starts", async () => {
    const { bridge, posted, post } = harness();
    const lifecycle = {
      closing: false,
      deliverKey(deliver: () => void) {
        if (this.closing) return false;
        deliver();
        return true;
      },
    };
    const pending = bridge.getKeyInput(blocking());

    expect(handleMoriaWorkerMessage(
      { type: "key", id: 1, result: { status: "key", key: 65 } },
      bridge, lifecycle, () => undefined, post,
    )).toBe(true);
    await expect(pending).resolves.toEqual({ status: "key", key: 65 });

    expect(handleMoriaWorkerMessage(
      { type: "exportSave", id: 4 }, bridge, lifecycle,
      () => ({ exportSave: () => ({ bytes: new Uint8Array([7]), filename: "moria.vhsave" }) }),
      post,
    )).toBe(true);
    expect(posted.at(-1)?.message).toMatchObject({
      type: "saveBlob", id: 4, ok: true, filename: "moria.vhsave",
    });

    const late = bridge.getKeyInput(blocking());
    let lateSettled = false;
    void late.then(() => { lateSettled = true; }, () => { lateSettled = true; });
    lifecycle.closing = true;
    expect(handleMoriaWorkerMessage(
      { type: "key", id: 2, result: { status: "key", key: 66 } },
      bridge, lifecycle, () => undefined, post,
    )).toBe(false);
    await Promise.resolve();
    expect(lateSettled).toBe(false);
  });

  it("correlates ordered request ids and preserves explicit NUL and no-key replies", async () => {
    const delays: number[] = [];
    const { bridge, posted } = harness({
      delay: async (milliseconds) => { delays.push(milliseconds); },
    });

    const first = bridge.getKeyInput(blocking({
      context: "outer-command",
      roguelike: true,
    }));
    expect(inputPosts(posted)).toEqual([{
      type: "getKey", id: 1, wait: true, context: "outer-command",
      mode: "roguelike", delayMicroseconds: 0,
    }]);
    expect(bridge.handleMessage({
      type: "key", id: 1, result: { status: "key", key: 0 },
    })).toBe(true);
    await expect(first).resolves.toEqual({ status: "key", key: 0 });

    const second = bridge.getKeyInput(poll(10_000));
    await vi.waitFor(() => expect(inputPosts(posted)).toHaveLength(2));
    expect(delays).toEqual([10]);
    expect(inputPosts(posted)[1]).toEqual({
      type: "getKey", id: 2, wait: false, context: "poll",
      mode: "original", delayMicroseconds: 10_000,
    });
    expect(bridge.handleMessage({
      type: "key", id: 2, result: { status: "none" },
    })).toBe(true);
    await expect(second).resolves.toEqual({ status: "none" });
  });

  it("allows only one outstanding native resolver", async () => {
    const { bridge } = harness();
    const first = bridge.getKeyInput(blocking());
    await expect(bridge.getKeyInput(blocking())).rejects.toThrow(/already outstanding/);
    expect(bridge.handleMessage({
      type: "key", id: 1, result: { status: "key", key: 65 },
    })).toBe(true);
    await expect(first).resolves.toEqual({ status: "key", key: 65 });
  });

  it("injects a timer task before even a zero-delay poll is posted", async () => {
    let releaseTimer!: () => void;
    const delays: number[] = [];
    const { bridge, posted } = harness({
      delay: (milliseconds) => {
        delays.push(milliseconds);
        return new Promise<void>((resolve) => { releaseTimer = resolve; });
      },
    });

    const answer = bridge.getKeyInput(poll(0));
    expect(delays).toEqual([0]);
    expect(inputPosts(posted)).toHaveLength(0);
    releaseTimer();
    await vi.waitFor(() => expect(inputPosts(posted)).toHaveLength(1));
    expect(bridge.handleMessage({
      type: "key", id: 1, result: { status: "none" },
    })).toBe(true);
    await expect(answer).resolves.toEqual({ status: "none" });
  });

  it("honors the requested 10ms poll delay with a real task and elapsed-time floor", async () => {
    const { bridge, posted } = harness();
    const started = performance.now();
    const answer = bridge.getKeyInput(poll(10_000));
    await vi.waitFor(() => expect(inputPosts(posted)).toHaveLength(1), { timeout: 250 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(9);
    expect(bridge.handleMessage({
      type: "key", id: 1, result: { status: "none" },
    })).toBe(true);
    await expect(answer).resolves.toEqual({ status: "none" });
  });

  it("preserves the exact timer/post rejection and frees its resolver", async () => {
    const sentinel = new Error("timer failed");
    const { bridge } = harness({ delay: () => Promise.reject(sentinel) });
    await expect(bridge.getKeyInput(poll(0))).rejects.toBe(sentinel);

    const followup = bridge.getKeyInput(blocking());
    expect(bridge.handleMessage({
      type: "key", id: 2, result: { status: "key", key: 27 },
    })).toBe(true);
    await expect(followup).resolves.toEqual({ status: "key", key: 27 });

    const postFailure = new Error("post failed");
    const throwing = new MoriaWorkerBridge(() => { throw postFailure; });
    await expect(throwing.getKeyInput(blocking())).rejects.toBe(postFailure);
  });

  it("ignores a mismatched late reply without stealing the outstanding request", async () => {
    const { bridge } = harness();
    const answer = bridge.getKeyInput(blocking());
    expect(bridge.handleMessage({
      type: "key", id: 99, result: { status: "key", key: 88 },
    })).toBe(false);
    expect(bridge.handleMessage({
      type: "key", id: 1, result: { status: "key", key: 89 },
    })).toBe(true);
    await expect(answer).resolves.toEqual({ status: "key", key: 89 });
  });
});

describe("MoriaWorkerBridge release", () => {
  it("forwards the source-classified terminal outcome to the finalization hook", async () => {
    const beforeExit = vi.fn(async () => {});
    const { bridge } = harness({ beforeExit });

    await bridge.beforeExit(0, 2);

    expect(beforeExit).toHaveBeenCalledExactlyOnceWith(0, 2);
  });

  it("marks closing synchronously, leaves blocked input unresolved, and acknowledges after its hook", async () => {
    const order: string[] = [];
    let finishRelease!: () => void;
    const { bridge, posted } = harness({
      release: () => new Promise<void>((resolve) => {
        order.push("hook");
        finishRelease = () => { order.push("hook-done"); resolve(); };
      }),
    });
    const input = bridge.getKeyInput(blocking());
    let inputSettled = false;
    void input.then(() => { inputSettled = true; }, () => { inputSettled = true; });

    const release = bridge.handleMessage({ type: "release" });
    expect(bridge.closing).toBe(true);
    expect(bridge.handleMessage({
      type: "key", id: 1, result: { status: "key", key: 0 },
    })).toBe(false);
    await Promise.resolve();
    expect(inputSettled).toBe(false);
    expect(order).toEqual(["hook"]);
    expect(posted.some(({ message }) => message.type === "released")).toBe(false);

    finishRelease();
    await release;
    expect(order).toEqual(["hook", "hook-done"]);
    expect(posted.at(-1)?.message).toEqual({ type: "released" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inputSettled).toBe(false);
  });

  it("does not post a poll or settle it when release wins during its timer task", async () => {
    let finishTimer!: () => void;
    const { bridge, posted } = harness({
      delay: () => new Promise<void>((resolve) => { finishTimer = resolve; }),
    });
    const input = bridge.getKeyInput(poll(0));
    let inputSettled = false;
    void input.then(() => { inputSettled = true; }, () => { inputSettled = true; });

    await bridge.handleMessage({ type: "release" });
    finishTimer();
    await Promise.resolve();
    expect(inputPosts(posted)).toHaveLength(0);
    expect(inputSettled).toBe(false);
  });

  it("keeps input parked when a poll timer rejects after release", async () => {
    const sentinel = new Error("late timer rejection");
    let rejectTimer!: (error: unknown) => void;
    const { bridge, posted } = harness({
      delay: () => new Promise<void>((_resolve, reject) => { rejectTimer = reject; }),
    });
    const input = bridge.getKeyInput(poll(0));
    let inputSettled = false;
    void input.then(() => { inputSettled = true; }, () => { inputSettled = true; });

    await bridge.handleMessage({ type: "release" });
    rejectTimer(sentinel);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inputPosts(posted)).toHaveLength(0);
    expect(inputSettled).toBe(false);
  });
});

describe("Moria worker boot and terminal classification", () => {
  it("installs fixed module options, posts ready, then calls moria_start exactly once", async () => {
    const { bridge } = harness();
    const order: string[] = [];
    const checkpointCommand = vi.fn(() => true);
    const checkpointLanded = vi.fn(async () => true);
    const checkpointRecoveryPath = vi.fn(() => "/vect-moria/recover/checkpoint-4.sav");
    let options: Record<string, unknown> | undefined;
    const module: MoriaRuntimeModule = {
      moriaPreExit: true,
      ccall: vi.fn(async (...args: unknown[]) => {
        order.push("ccall");
        expect(args).toEqual([
          "moria_start", "number", ["number", "boolean"], [0, false], { async: true },
        ]);
        return undefined;
      }),
    };

    await runMoriaEngine(async (received) => {
      order.push("factory");
      options = received;
      expect(received.preRun).toHaveLength(1);
      (received.preRun as Array<(module: object) => void>)[0]!({ marker: "module" });
      return module;
    }, bridge, "https://example.test/base/modules/moria/", {
      semantic: semanticCallbacks(),
      checkpointCommand,
      checkpointLanded,
      checkpointRecoveryPath,
      preRun: (received) => order.push(
        `preRun:${(received as unknown as { marker: string }).marker}`,
      ),
      ready: () => order.push("ready"),
      quit: () => order.push("quit"),
    });

    expect(order).toEqual(["factory", "preRun:module", "ready", "ccall", "quit"]);
    expect(module.ccall).toHaveBeenCalledOnce();
    expect(options?.locateFile).toBeTypeOf("function");
    expect((options!.locateFile as (path: string) => string)("moria.wasm"))
      .toBe("https://example.test/base/modules/moria/moria.wasm");
    expect(options).toMatchObject({
      terminalFlush: bridge.terminalFlush,
      terminalBell: bridge.terminalBell,
      getKeyInput: bridge.getKeyInput,
      beforeExit: bridge.beforeExit,
      checkpointCommand,
      checkpointLanded,
      checkpointRecoveryPath,
      semanticMap: expect.any(Function),
      semanticState: expect.any(Function),
      semanticMessage: expect.any(Function),
    });
  });

  it.each([0, 1])("treats numeric native return %s as fatal even with the pre-exit marker", async (result) => {
    const { bridge } = harness();
    const module: MoriaRuntimeModule = {
      moriaPreExit: true,
      ccall: async () => result,
    };
    await expect(runMoriaEngine(async () => module, bridge, "https://example.test/", {
      semantic: semanticCallbacks(), ready: () => {}, quit: () => {},
    })).rejects.toThrow(/unexpected numeric return/);
  });

  it("treats undefined without the native pre-exit marker as fatal", async () => {
    const { bridge } = harness();
    const module: MoriaRuntimeModule = { ccall: async () => undefined };
    await expect(runMoriaEngine(async () => module, bridge, "https://example.test/", {
      semantic: semanticCallbacks(), ready: () => {}, quit: () => {},
    })).rejects.toThrow(/without the pre-exit marker/);
  });

  it("preserves factory and ccall rejections for the worker fatal path", async () => {
    const { bridge } = harness();
    const factoryFailure = new Error("factory failed");
    await expect(runMoriaEngine(async () => { throw factoryFailure; }, bridge, "https://example.test/", {
      semantic: semanticCallbacks(), ready: () => {}, quit: () => {},
    })).rejects.toBe(factoryFailure);

    const runtimeFailure = new Error("runtime failed");
    await expect(runMoriaEngine(async () => ({
      ccall: async () => { throw runtimeFailure; },
    }), bridge, "https://example.test/", {
      semantic: semanticCallbacks(), ready: () => {}, quit: () => {},
    })).rejects.toBe(runtimeFailure);
  });

  it("posts only the first terminal outcome so teardown noise cannot add a fatal", () => {
    const messages: MoriaWorkerToMain[] = [];
    const reporter = createMoriaTerminalReporter((message) => messages.push(message));
    expect(reporter.quit({ saved: true, persistent: true, reason: null })).toBe(true);
    expect(reporter.fatal(new Error("late ExitStatus noise"))).toBe(false);
    expect(reporter.quit({ saved: false, persistent: false, reason: "late" })).toBe(false);
    expect(messages).toEqual([{
      type: "quit", saved: true, persistent: true, reason: null,
    }]);

    const faults: MoriaWorkerToMain[] = [];
    const fatalFirst = createMoriaTerminalReporter((message) => faults.push(message));
    expect(fatalFirst.fatal("factory failed")).toBe(true);
    expect(fatalFirst.fatal("duplicate rejection")).toBe(false);
    expect(fatalFirst.quit({ saved: false, persistent: false, reason: "late" })).toBe(false);
    expect(faults).toEqual([{ type: "fatal", message: "factory failed" }]);
  });

  it("never requires a WASM call to handle a main-thread reply", async () => {
    const { bridge } = harness();
    const answer = bridge.getKeyInput(blocking());
    const message: MoriaMainToWorker = {
      type: "key", id: 1, result: { status: "key", key: 32 },
    };
    expect(bridge.handleMessage(message)).toBe(true);
    await expect(answer).resolves.toEqual({ status: "key", key: 32 });
  });

  realArtifactIt("drives the real artifact through the production bridge and quit classifier", async () => {
    const coreUrl = new URL("../../public/modules/moria/", import.meta.url);
    const moduleUrl = new URL(`moria.js?worker-bridge=${Date.now()}`, coreUrl);
    if (!existsSync(moduleUrl)) {
      throw new Error("public Moria artifacts are missing — run npm run build:moria");
    }
    const createMoriaModule = (await import(/* @vite-ignore */ moduleUrl.href)).default as
      (options: Record<string, unknown>) => Promise<MoriaRuntimeModule>;
    const order: string[] = [];
    const creation = [13, 97, 109, 27, 97, 13, 32];
    const afterCreation = [24, 32, 27];
    let bridge!: MoriaWorkerBridge;
    let requestCount = 0;
    let sawOuterCommand = false;
    let frameCount = 0;
    const post: MoriaWorkerPost = (message) => {
      if (message.type === "event" && message.ev.name === "frame") frameCount += 1;
      if (message.type !== "getKey") return;
      if (++requestCount > 80) throw new Error("real Moria bridge exceeded 80 input requests");
      let result: Extract<MoriaMainToWorker, { type: "key" }>["result"];
      if (!message.wait) {
        result = { status: "none" };
      } else {
        const key = creation.length > 0 ? creation.shift() : afterCreation.shift();
        if (message.context === "outer-command") sawOuterCommand = true;
        if (key === undefined) throw new Error(`unexpected live ${message.context} request ${message.id}`);
        result = { status: "key", key };
      }
      queueMicrotask(() => bridge.handleMessage({ type: "key", id: message.id, result }));
    };
    bridge = new MoriaWorkerBridge(post, {
      beforeExit: async (status, outcome) => {
        order.push(`beforeExit:${status}:${outcome}`);
      },
    });

    await runMoriaEngine(createMoriaModule, bridge, fileURLToPath(coreUrl), {
      semantic: semanticCallbacks(),
      ready: () => order.push("ready"),
      quit: () => order.push("quit"),
    });

    expect(order).toEqual(["ready", "beforeExit:0:1", "quit"]);
    expect(creation).toHaveLength(0);
    expect(afterCreation).toHaveLength(0);
    expect(sawOuterCommand).toBe(true);
    expect(frameCount).toBeGreaterThan(0);
  }, 20_000);
});

// The real src/modules/nethack/worker.ts, imported and booted. Every engine
// driver under scripts/test/nethack/ boots the wasm module itself and answers
// the shim with its own copy of the dispatch, so nothing else in the suite
// would notice the worker's own switch drifting: a decodeGlyph offset, the
// BL_CONDITION bitmask, the RECOVER_QUERY auto-answer, exit_nhwindows'
// checkpoint.clear(), the describe gate, or announcing `ready` before the
// engine has filled in its constants.
//
// The worker is a script with top-level side effects, so it is loaded the way
// a browser loads it: worker globals stubbed (self, postMessage, onmessage),
// then imported once per test with a fresh module registry. Its one import
// that cannot run here — the emscripten artifact — resolves through
// import.meta.env.BASE_URL, so BASE_URL points at a temp directory holding a
// one-line stand-in that hands the options object to the test, which plays
// the emscripten runtime: preRun, then the exports, then onRuntimeInitialized.
// The volume mount and the checkpointer are swapped at their factories; the
// worker's wiring of them is what is under test, and checkpoint.ts and
// persist.ts are tested on their own.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MainToWorker, WorkerToMain } from "../../../src/modules/nethack/protocol";
import type { CheckpointDeps } from "../../../src/modules/nethack/checkpoint";

const seam = vi.hoisted(() => ({
  seedEngineFS: (_m: unknown): unknown => undefined,
  createCheckpointer: (_deps: unknown): unknown => undefined,
}));

vi.mock("../../../src/modules/nethack/engineBoot", () => ({
  seedEngineFS: (m: unknown) => seam.seedEngineFS(m),
}));
vi.mock("../../../src/modules/nethack/checkpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/nethack/checkpoint")>()),
  createCheckpointer: (deps: unknown) => seam.createCheckpointer(deps),
}));

const { RECOVER_QUERY, answerInPlace } = await import("../../../src/modules/nethack/checkpoint");

const BRIDGE = "nethackShimBridge";
const BL_CONDITION = 22;
const CONSTANTS = {
  STATUS_FIELD: { BL_CONDITION },
  GLYPH: { GLYPH_MON_OFF: 0 },
};

let coreDir = "";
beforeAll(() => {
  coreDir = mkdtempSync(join(tmpdir(), "vh-nethack-core-"));
  mkdirSync(join(coreDir, "modules/nethack"), { recursive: true });
  writeFileSync(join(coreDir, "modules/nethack/nethack.js"),
    "export default (opts) => globalThis.__vhFakeNethackCore(opts);\n");
  return () => rmSync(coreDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Linear wasm memory, little-endian, with a bump allocator — the slice of
 *  the emscripten runtime the worker and wasmAbi.ts call. */
class Heap {
  readonly view = new DataView(new ArrayBuffer(1 << 16));
  private top = 0x4000;
  malloc = vi.fn((n: number) => { const p = this.top; this.top += (n + 7) & ~7; return p; });
  free = vi.fn();
  getValue = (p: number, t: string): number => {
    if (t === "i8") return this.view.getInt8(p);
    if (t === "i16") return this.view.getInt16(p, true);
    return this.view.getInt32(p, true); // "i32" and "*" are both 32-bit on wasm32
  };
  setValue = vi.fn((p: number, v: number, t: string) => {
    if (t === "i8") this.view.setInt8(p, v);
    else if (t === "i16") this.view.setInt16(p, v, true);
    else this.view.setInt32(p, v, true);
  });
  str(s: string): number {
    const bytes = new TextEncoder().encode(s);
    const p = this.malloc(bytes.length + 1);
    bytes.forEach((b, i) => this.view.setUint8(p + i, b));
    this.view.setUint8(p + bytes.length, 0);
    return p;
  }
  UTF8ToString = (p: number): string => {
    let end = p;
    while (this.view.getUint8(end) !== 0) end++;
    return new TextDecoder().decode(new Uint8Array(this.view.buffer, p, end - p));
  };
  stringToUTF8 = vi.fn((s: string, p: number, max: number) => {
    const bytes = new TextEncoder().encode(s).slice(0, max - 1);
    bytes.forEach((b, i) => this.view.setUint8(p + i, b));
    this.view.setUint8(p + bytes.length, 0);
  });
  /** A glyph_info struct at the wasm32 offsets include/wintype.h gives. */
  glyph(g: { glyph: number; ttychar: number; glyphflags: number; color: number }): number {
    const p = this.malloc(36);
    this.view.setInt32(p, g.glyph, true);
    this.view.setInt32(p + 4, g.ttychar, true);
    this.view.setUint32(p + 8, 0xdeadbeef, true); // framecolor: must not be read as anything
    this.view.setUint32(p + 12, g.glyphflags, true);
    this.view.setInt32(p + 16, g.color, true);
    this.view.setInt32(p + 20, 999, true); // sym.symidx: not the color
    return p;
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((y, n) => { resolve = y; reject = n; });
  return { promise, resolve, reject };
}

const turn = () => new Promise((r) => setTimeout(r, 0));

type Bridge = (name: string, ...args: unknown[]) => Promise<unknown>;

/** Load worker.ts as a fresh worker and run the fake runtime through boot. */
async function boot(opts: { durable?: boolean; factoryError?: Error } = {}) {
  vi.resetModules();
  const posted: WorkerToMain[] = [];
  const listeners = new Map<string, (e: unknown) => void>();
  const heap = new Heap();
  const persist = {
    ready: Promise.resolve(opts.durable ?? true),
    flush: vi.fn(async () => {}),
    exportSave: vi.fn(() => ({ bytes: new Uint8Array([1, 2, 3]), filename: "nethack.vhsave" })),
  };
  const checkpoint = {
    command: vi.fn(),
    maybe: vi.fn(async () => false),
    clear: vi.fn(async () => {}),
    dead: null,
  };
  let deps: CheckpointDeps | undefined;
  seam.seedEngineFS = vi.fn(() => persist);
  seam.createCheckpointer = vi.fn((d: unknown) => { deps = d as CheckpointDeps; return checkpoint; });

  const mod: Record<string, unknown> = {};
  const factory = deferred();
  vi.stubGlobal("__vhFakeNethackCore", async (o: Record<string, any>) => {
    if (opts.factoryError) { factory.resolve(); throw opts.factoryError; }
    for (const fn of o.preRun) fn(o);
    Object.assign(o, {
      ccall: vi.fn(),
      getValue: heap.getValue,
      setValue: heap.setValue,
      stringToUTF8: heap.stringToUTF8,
      UTF8ToString: heap.UTF8ToString,
      _malloc: heap.malloc,
      _free: heap.free,
      _save_currentstate: vi.fn(),
      _do_screen_description: vi.fn(() => 0),
    });
    o.onRuntimeInitialized();
    Object.assign(mod, { opts: o });
    factory.resolve();
  });
  vi.stubGlobal("eval", globalThis.eval); // installEvalShim replaces it; restored after
  vi.stubGlobal("postMessage", (m: WorkerToMain) => void posted.push(m));
  vi.stubGlobal("self", {
    addEventListener: (t: string, fn: (e: unknown) => void) => void listeners.set(t, fn),
    location: { origin: "file://" },
  });
  vi.stubGlobal("onmessage", null);
  vi.stubGlobal(BRIDGE, undefined);
  vi.stubGlobal("nethackGlobal", { constants: {}, globals: { iflags: {}, svp: {} } });
  vi.stubEnv("BASE_URL", coreDir + "/");

  await import("../../../src/modules/nethack/worker");
  await factory.promise;
  await turn(); // persist.ready.then -> createCheckpointer

  const g = globalThis as Record<string, any>;
  const engine = (mod.opts ?? {}) as Record<string, any>;
  const calls = () => posted.filter((m): m is Extract<WorkerToMain, { type: "call" }> => m.type === "call");
  const send = (data: MainToWorker) => (g.onmessage as (e: { data: MainToWorker }) => void)({ data });
  return {
    posted, listeners, heap, persist, checkpoint, engine, calls, send,
    deps: () => deps,
    bridge: ((name, ...args) => (g[BRIDGE] as Bridge)(name, ...args)) as Bridge,
    /** Answer the latest round trip the way EngineSession does. */
    reply: (value: Extract<MainToWorker, { type: "reply" }>["value"]) =>
      send({ type: "reply", id: calls().at(-1)!.id, value }),
    lastEv: () => calls().at(-1)!.ev,
  };
}

describe("NetHack worker boot", () => {
  it("points the shim dispatcher at the global it installed the bridge under", async () => {
    const w = await boot();
    // The engine reaches the bridge by name; a name that drifted from the
    // global would leave every windowport call unanswered.
    expect(w.engine.ccall).toHaveBeenCalledWith("shim_graphics_set_callback", null, ["string"], [BRIDGE]);
    expect(typeof (globalThis as Record<string, unknown>)[BRIDGE]).toBe("function");
  });

  it("announces ready at the first windowport call, with the constants main() has filled in by then", async () => {
    const w = await boot();
    // onRuntimeInitialized has run, but js_constants_init() has not:
    // announcing now would hand the view an empty table.
    expect(w.posted.filter((m) => m.type === "ready")).toEqual([]);
    (globalThis as Record<string, any>).nethackGlobal.constants = CONSTANTS;

    void w.bridge("shim_init_nhwindows");
    void w.bridge("shim_status_init");
    const ready = w.posted.filter((m) => m.type === "ready");
    expect(ready).toEqual([{ type: "ready", constants: CONSTANTS }]); // once, not per call
    expect(w.posted.indexOf(ready[0]!)).toBe(0); // and ahead of the call that prompted it
  });

  it("reports a runtime that would not start as fatal", async () => {
    const w = await boot({ factoryError: new Error("wasm streaming compile failed") });
    await turn();
    expect(w.posted).toContainEqual({ type: "fatal", message: "Error: wasm streaming compile failed" });
  });

  it("turns an unhandled rejection and a worker error into fatal messages", async () => {
    const w = await boot();
    w.listeners.get("unhandledrejection")!({ reason: "boom" });
    w.listeners.get("error")!({ message: "kaput" });
    expect(w.posted.slice(-2)).toEqual([
      { type: "fatal", message: "unhandled rejection: boom" },
      { type: "fatal", message: "worker error: kaput" },
    ]);
  });
});

describe("NetHack worker shim dispatch", () => {
  it("round-trips a call: posted with an id, resolved by the reply carrying it", async () => {
    const w = await boot();
    const r = w.bridge("shim_create_nhwindow", 3);
    expect(w.lastEv()).toEqual({ name: "create_nhwindow", wintype: 3 });
    // A reply for an id nobody is waiting on is dropped, not misdelivered.
    w.send({ type: "reply", id: 999, value: 7 });
    w.reply(5);
    await expect(r).resolves.toBe(5);
  });

  it("decodes glyph_info at its wasm32 offsets, and a null or NO_GLYPH pointer as no cell", async () => {
    const w = await boot();
    const fg = w.heap.glyph({ glyph: 1234, ttychar: "@".charCodeAt(0), glyphflags: 0x10, color: 14 });
    const none = w.heap.glyph({ glyph: -1, ttychar: 0, glyphflags: 0, color: 0 });
    void w.bridge("shim_print_glyph", 2, 10, 5, fg, 0);
    expect(w.lastEv()).toEqual({
      name: "print_glyph", win: 2, x: 10, y: 5,
      cell: { glyph: 1234, ch: "@", color: 14, glyphflags: 0x10 }, bg: null,
    });
    void w.bridge("shim_print_glyph", 2, 11, 5, fg, none);
    expect(w.lastEv()).toMatchObject({ x: 11, bg: null });
  });

  it("builds an add_menu item from the dispatcher's pre-converted args", async () => {
    const w = await boot();
    const g = w.heap.glyph({ glyph: 77, ttychar: ")".charCodeAt(0), glyphflags: 0, color: 6 });
    void w.bridge("shim_add_menu", 4, g, 42, "a".charCodeAt(0), ")".charCodeAt(0), 1, 6, "a - a long sword", 0x2);
    expect(w.lastEv()).toEqual({
      name: "add_menu", win: 4, item: {
        glyph: { glyph: 77, ch: ")", color: 6, glyphflags: 0 },
        identifier: 42, accelerator: "a", groupAccel: ")", attr: 1, color: 6,
        text: "a - a long sword", itemflags: 0x2,
      },
    });
    // A heading: no glyph, no identifier, no accelerators.
    void w.bridge("shim_add_menu", 4, 0, 0, 0, 0, 0, 0, "Weapons", 0);
    expect(w.lastEv()).toMatchObject({ item: { glyph: null, identifier: 0, accelerator: "", groupAccel: "" } });
  });

  it("decodes status_enablefield's name and format pointers", async () => {
    const w = await boot();
    void w.bridge("shim_status_enablefield", 3, w.heap.str("Dx"), w.heap.str(" Dx:%s"), true);
    expect(w.lastEv()).toEqual({ name: "status_enablefield", fieldidx: 3, nm: "Dx", fmt: " Dx:%s", enable: true });
  });

  it("decodes the extended-command table once and hands the same list to every #", async () => {
    const w = await boot();
    const table = w.heap.malloc(48); // two ext_func_tab rows, stride 24; the second ends the list
    w.heap.setValue(table + 4, w.heap.str("pray"), "*");
    w.heap.setValue(table + 8, w.heap.str("pray to your god"), "*");
    w.heap.setValue(table + 24 + 4, 0, "*");
    (globalThis as Record<string, any>).nethackGlobal.pointers = { extcmdlist: table };
    void w.bridge("shim_get_ext_cmd");
    expect(w.lastEv()).toEqual({ name: "get_ext_cmd", commands: [{ name: "pray", desc: "pray to your god" }] });
    w.heap.setValue(table + 4, w.heap.str("quit"), "*"); // a re-decode would now read "quit"
    void w.bridge("shim_get_ext_cmd");
    expect(w.lastEv()).toMatchObject({ commands: [{ name: "pray" }] });
  });

  it("writes select_menu picks into a malloc'd menu_item array and returns the count", async () => {
    const w = await boot();
    const out = w.heap.malloc(4);
    const r = w.bridge("shim_select_menu", 4, 2, out);
    expect(w.lastEv()).toEqual({ name: "select_menu", win: 4, how: 2 });
    w.reply({ picks: [{ identifier: 42, count: -1, itemflags: 0 }, { identifier: 43, count: 3, itemflags: 1 }] });
    await expect(r).resolves.toBe(2);
    const arr = w.heap.getValue(out, "*");
    expect(arr).not.toBe(0);
    expect([arr, arr + 8, arr + 16, arr + 24, arr + 28].map((p) => w.heap.getValue(p, "i32")))
      .toEqual([42, -1, 43, 3, 1]);
  });

  it("answers an empty pick 0 and a cancelled menu -1, with a NULL list either way", async () => {
    const w = await boot();
    const out = w.heap.malloc(4);
    w.heap.view.setInt32(out, 0x1234, true);
    const empty = w.bridge("shim_select_menu", 4, 1, out);
    w.reply({ picks: [] });
    await expect(empty).resolves.toBe(0);
    expect(w.heap.getValue(out, "*")).toBe(0);

    w.heap.view.setInt32(out, 0x1234, true);
    const cancelled = w.bridge("shim_select_menu", 4, 1, out);
    w.reply(null);
    await expect(cancelled).resolves.toBe(-1);
    expect(w.heap.getValue(out, "*")).toBe(0);
  });

  it("answers getlock()'s recover prompt with r itself, and asks the view every other question", async () => {
    const w = await boot();
    await expect(w.bridge("shim_yn_function", RECOVER_QUERY, "ynq", 0)).resolves.toBe("r".charCodeAt(0));
    expect(w.calls().map((c) => c.ev.name)).not.toContain("yn_function");

    const r = w.bridge("shim_yn_function", "Really quit?", "yn", "n".charCodeAt(0));
    expect(w.lastEv()).toEqual({ name: "yn_function", query: "Really quit?", choices: "yn", def: "n".charCodeAt(0) });
    w.reply("y".charCodeAt(0));
    await expect(r).resolves.toBe("y".charCodeAt(0));
  });

  it("writes a getlin answer into the engine's buffer, and ESC for a cancel", async () => {
    const w = await boot();
    const buf = w.heap.malloc(256);
    const named = w.bridge("shim_getlin", "Call it:", buf);
    expect(w.lastEv()).toEqual({ name: "getlin", query: "Call it:" });
    w.reply("Sting");
    await named;
    expect(w.heap.UTF8ToString(buf)).toBe("Sting");

    const cancelled = w.bridge("shim_getlin", "Call it:", buf);
    w.reply(null);
    await cancelled;
    expect(w.heap.UTF8ToString(buf)).toBe("\x1b");
  });

  it("reads BL_CONDITION's pointer as a bitmask and every other field's as a string", async () => {
    const w = await boot();
    (globalThis as Record<string, any>).nethackGlobal.constants = CONSTANTS;
    const mask = w.heap.malloc(4);
    w.heap.view.setInt32(mask, 0x41, true);
    void w.bridge("shim_status_update", BL_CONDITION, mask, 0, 0, 7);
    expect(w.lastEv()).toEqual({
      name: "status_update", fldidx: BL_CONDITION, text: null, condbits: 0x41, chg: 0, percent: 0, color: 7,
    });
    void w.bridge("shim_status_update", 1, w.heap.str("St:18/50"), 1, 50, 3);
    expect(w.lastEv()).toEqual({
      name: "status_update", fldidx: 1, text: "St:18/50", condbits: 0, chg: 1, percent: 50, color: 3,
    });
  });

  it("drops message_menu's unreadable letter and forwards how and the text", async () => {
    const w = await boot();
    void w.bridge("shim_message_menu", 0x66000004, 1, "f - 5 lembas wafers");
    expect(w.lastEv()).toEqual({ name: "message_menu", how: 1, text: "f - 5 lembas wafers" });
  });

  it("sets window_inited after init_nhwindows and the player's name after askname", async () => {
    const w = await boot();
    const ng = (globalThis as Record<string, any>).nethackGlobal;
    const init = w.bridge("shim_init_nhwindows");
    expect(ng.globals.iflags.window_inited).toBeUndefined(); // not before the view answered
    w.reply(null);
    await init;
    expect(ng.globals.iflags.window_inited).toBe(true);

    const named = w.bridge("shim_askname");
    w.reply("");
    await named;
    expect(ng.globals.svp.plname).toBe("player");
  });

  it("answers the sync/no-op family locally and forwards anything unknown as other", async () => {
    const w = await boot();
    await expect(w.bridge("shim_mark_synch")).resolves.toBeUndefined();
    await expect(w.bridge("shim_update_inventory")).resolves.toBeUndefined();
    await expect(w.bridge("shim_player_selection_or_tty")).resolves.toBe(true);
    expect(w.calls()).toEqual([]);
    void w.bridge("shim_something_new", 1, "x");
    expect(w.lastEv()).toEqual({ name: "other", shim: "shim_something_new", args: ["1", "x"] });
  });
});

describe("NetHack worker autosave wiring", () => {
  it("counts the command and lets a checkpoint finish before asking for the key", async () => {
    const w = await boot();
    const landed = deferred<boolean>();
    w.checkpoint.maybe.mockReturnValueOnce(landed.promise);
    const mods = w.heap.malloc(4);
    w.heap.view.setInt32(mods, 0x55, true);
    const key = w.bridge("shim_nh_poskey", 0, 0, mods);
    expect(w.checkpoint.command).toHaveBeenCalledOnce();
    expect(w.checkpoint.maybe).toHaveBeenCalledOnce();
    expect(w.calls()).toEqual([]); // nothing goes to the main thread mid-checkpoint
    landed.resolve(true);
    await turn();
    expect(w.lastEv()).toEqual({ name: "nh_poskey" });
    w.reply("j".charCodeAt(0));
    await expect(key).resolves.toBe("j".charCodeAt(0));
    expect(w.heap.getValue(mods, "i32")).toBe(0); // keyboard, not a click
  });

  it("drops the mirror and flushes the volume after the exit window, in that order", async () => {
    const w = await boot();
    const order: string[] = [];
    w.checkpoint.clear.mockImplementation(async () => void order.push("clear"));
    w.persist.flush.mockImplementation(async () => void order.push("flush"));
    const exit = w.bridge("shim_exit_nhwindows", "Goodbye.");
    expect(w.lastEv()).toEqual({ name: "exit_nhwindows", text: "Goodbye." });
    expect(order).toEqual([]); // not before the view has shown the line
    w.reply(null);
    await exit;
    expect(order).toEqual(["clear", "flush"]);
  });

  it("tells the player rather than going fatal when the final flush fails", async () => {
    const w = await boot();
    w.persist.flush.mockRejectedValueOnce(new Error("IDBFS failed"));
    const exit = w.bridge("shim_exit_nhwindows", "");
    w.reply(null);
    await expect(exit).resolves.toBeNull();
    expect(w.posted.at(-1)).toEqual({
      type: "notice", text: "Your game may not have been saved — Error: IDBFS failed.",
    });
  });

  it("gives the checkpointer the engine's save, the bridge swap, the volume flush and a notice", async () => {
    const w = await boot();
    const deps = w.deps()!;
    deps.saveCurrentState();
    expect(w.engine._save_currentstate).toHaveBeenCalledOnce();
    await deps.flush();
    expect(w.persist.flush).toHaveBeenCalledOnce();

    const g = globalThis as Record<string, unknown>;
    const outer = g[BRIDGE];
    const restore = deps.suspendBridge(answerInPlace);
    expect(g[BRIDGE]).toBe(answerInPlace);
    restore();
    expect(g[BRIDGE]).toBe(outer);

    deps.onDead!("the disk is full");
    expect(w.posted.at(-1)).toEqual({ type: "notice", text: "Autosave stopped — the disk is full." });
  });

  it("builds no checkpointer for a volume that will not persist", async () => {
    const w = await boot({ durable: false });
    expect(w.deps()).toBeUndefined();
    // and the main loop still runs without one
    void w.bridge("shim_nh_poskey", 0, 0, w.heap.malloc(4));
    await turn();
    expect(w.lastEv()).toEqual({ name: "nh_poskey" });
  });
});

describe("NetHack worker describe and export", () => {
  const describeAt = (w: Awaited<ReturnType<typeof boot>>, id: number) => {
    w.send({ type: "describe", id, x: 10, y: 5 });
    return w.posted.at(-1);
  };

  it("names nothing before the windows are up and the map is drawn, or after they come down", async () => {
    const w = await boot();
    const name = w.heap.str("a newt");
    w.engine._do_screen_description.mockImplementation(
      (_cc: number, _l: number, _s: number, _out: number, first: number) => {
        w.heap.setValue(first, name, "*");
        return 1;
      });
    const glyph = w.heap.glyph({ glyph: 1, ttychar: ":".charCodeAt(0), glyphflags: 0, color: 2 });

    expect(describeAt(w, 1)).toEqual({ type: "describeReply", id: 1, text: null });
    void w.bridge("shim_print_glyph", 2, 10, 5, glyph, 0); // drawn, but no windows yet
    expect(describeAt(w, 2)).toEqual({ type: "describeReply", id: 2, text: null });
    expect(w.engine._do_screen_description).not.toHaveBeenCalled();

    void w.bridge("shim_init_nhwindows");
    expect(describeAt(w, 3)).toEqual({ type: "describeReply", id: 3, text: "a newt" });

    void w.bridge("shim_exit_nhwindows", "");
    expect(describeAt(w, 4)).toEqual({ type: "describeReply", id: 4, text: null });
    expect(w.engine._do_screen_description).toHaveBeenCalledOnce();
  });

  it("names nothing while the windows are up but no glyph has been drawn", async () => {
    const w = await boot();
    w.engine._do_screen_description.mockImplementation(
      (_cc: number, _l: number, _s: number, _out: number, first: number) => {
        w.heap.setValue(first, w.heap.str("dark part of a room"), "*");
        return 1;
      });
    void w.bridge("shim_init_nhwindows"); // character creation: windows, no map yet
    expect(describeAt(w, 1)).toEqual({ type: "describeReply", id: 1, text: null });
    expect(w.engine._do_screen_description).not.toHaveBeenCalled();
    void w.bridge("shim_print_glyph", 2, 10, 5, w.heap.glyph({ glyph: 1, ttychar: 46, glyphflags: 0, color: 7 }), 0);
    expect(describeAt(w, 2)).toEqual({ type: "describeReply", id: 2, text: "dark part of a room" });
  });

  it("describes under the in-place bridge and puts the outer one back", async () => {
    const w = await boot();
    const g = globalThis as Record<string, unknown>;
    const outer = g[BRIDGE];
    let during: unknown;
    w.engine._do_screen_description.mockImplementation(() => { during = g[BRIDGE]; throw new Error("trap"); });
    void w.bridge("shim_init_nhwindows");
    void w.bridge("shim_print_glyph", 2, 1, 1, w.heap.glyph({ glyph: 1, ttychar: 46, glyphflags: 0, color: 7 }), 0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {}); // describe.ts logs the throw
    expect(describeAt(w, 1)).toEqual({ type: "describeReply", id: 1, text: null });
    warn.mockRestore();
    expect(during).toBe(answerInPlace);
    expect(g[BRIDGE]).toBe(outer); // restored even though the describe threw
  });

  it("answers an export from the volume handle", async () => {
    const w = await boot();
    w.send({ type: "exportSave", id: 9 });
    expect(w.posted.at(-1)).toEqual({
      type: "saveBlob", id: 9, ok: true, bytes: new Uint8Array([1, 2, 3]), filename: "nethack.vhsave",
    });
  });
});

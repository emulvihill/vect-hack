// The ?game=angband composition path in main.ts: the view is built before the
// session (so no engine event can race an uninstalled handler), the window
// globals are exposed for the page helpers, the save export binds to the
// session just constructed, and the degrade policy picks the right view.
//
// Since vect-hack-l11 it also pins the thing the split exists for: booting
// Angband must load none of NetHack's, Larn's or Moria's code. The other three
// Modules are mocked with factories that record being called, and a factory
// runs on first import — so a static import creeping back into main.ts turns
// one of those counters non-zero. The byte-level proof is the browser gate
// (npm run check:payload); this is the half that runs in npm test.
import { expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  tty: { onNotice: vi.fn() } as object & { onNotice: ReturnType<typeof vi.fn> },
  vector: { look: {} } as object
    & { look: { describe?: (x: number, y: number) => unknown } },
  vectorArgs: [] as unknown[],
  handler: null as object | null,
  gpu: true,
  exportSave: vi.fn(async () => ({ bytes: new Uint8Array([1]), filename: "a.vhsave" })),
  installMenu: vi.fn(),
  describe: vi.fn(async () => "a floor"),
  setBorgDelay: vi.fn(),
  borgWrapped: null as object | null,
  /** One counter per foreign Module, bumped by that Module's mock factory. */
  foreign: { nethack: vi.fn(), larn: vi.fn(), moria: vi.fn() },
}));
vi.mock("../../src/modules/angband/ui/TtyView", () => ({
  TtyView: class { constructor() { return seam.tty; } },
}));
  // The vector seam carries a `look` because main.ts reaches for it — and it
  // reaches through chooseView()'s discriminant now, not `view instanceof
  // VectorView` (vect-hack-po4: the call site cannot hold the vector class as a
  // value without re-importing the module the tty arm exists to skip). Under
  // the old instanceof the mock's plain object made that gate FALSE here, so
  // the look wiring in this arm was never executed by this file at all; the
  // test below is what that gate now buys.
vi.mock("../../src/modules/angband/ui/VectorView", () => ({
  VectorView: class { constructor(...args: unknown[]) { seam.vectorArgs = args; return seam.vector; } },
}));
vi.mock("../../src/modules/angband/ui/BorgPlayer", () => ({
  BorgPlayer: class { constructor(view: object) { seam.borgWrapped = view; } },
}));
vi.mock("../../src/modules/angband/session", () => ({
  AngbandSession: class {
    exportSave = seam.exportSave;
    describe = seam.describe;
    setBorgDelay = seam.setBorgDelay;
    constructor(handler: object) { seam.handler = handler; }
  },
}));
// The three Modules this page is not playing, at every entry point main.ts
// could plausibly reach: a session, a view, a self-playing decorator.
vi.mock("../../src/modules/nethack/session", () => (seam.foreign.nethack(), { NetHackSession: class {} }));
vi.mock("../../src/modules/nethack/ui/VectorView", () => (seam.foreign.nethack(), { VectorView: class {} }));
vi.mock("../../src/modules/nethack/ui/DebugView", () => (seam.foreign.nethack(), { DebugView: class {} }));
vi.mock("../../src/modules/nethack/bot/BotPlayer", () => (seam.foreign.nethack(), { BotPlayer: class {} }));
vi.mock("../../src/modules/larn/session", () => (seam.foreign.larn(), { LarnSession: class {} }));
vi.mock("../../src/modules/larn/ui/VectorView", () => (seam.foreign.larn(), { VectorView: class {} }));
vi.mock("../../src/modules/larn/ui/TtyView", () => (seam.foreign.larn(), { TtyView: class {} }));
vi.mock("../../src/modules/larn/bot/LarnBotPlayer", () => (seam.foreign.larn(), { LarnBotPlayer: class {} }));
vi.mock("../../src/modules/moria/session", () => (seam.foreign.moria(), { MoriaSession: class {} }));
vi.mock("../../src/modules/moria/ui/VectorView", () => (seam.foreign.moria(), { VectorView: class {} }));
vi.mock("../../src/modules/moria/ui/TtyView", () => (seam.foreign.moria(), { TtyView: class {} }));
// Partial: saveRisk.ts reaches the Saves button by the id this module owns,
// so a factory that returned installSaveMenu alone would leave that constant
// undefined on the mock and throw the moment the storage grant resolves.
vi.mock("../../src/ui/saveMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/ui/saveMenu")>(),
  installSaveMenu: seam.installMenu,
}));
vi.mock("../../src/ui/gpuSupport", () => ({
  GPU_UNAVAILABLE_NOTICE: "no gpu", browserGpuProbe: () => ({}), gpuAvailable: async () => seam.gpu,
}));
vi.mock("../../src/skins", () => ({ applySkinCss() {} }));

class El {
  removed = false;
  remove() { this.removed = true; }
}

/** One page load. Boot is not synchronous any more (vect-hack-l11): the arm
 *  waits on the dynamic import that keeps the other three Modules off this
 *  page, so this awaits main's own `booted` promise rather than counting
 *  microtasks — a count that goes stale the next time an await moves. */
async function boot(search: string) {
  vi.resetModules();
  seam.handler = null;
  seam.vectorArgs = [];
  seam.installMenu.mockClear();
  seam.exportSave.mockClear();
  seam.describe.mockClear();
  seam.vector.look = {};
  seam.tty.onNotice.mockClear();
  const els = new Map([["view", new El()], ["cmdbtn", new El()]]);
  (globalThis as any).window = {};
  (globalThis as any).location = { search };
  (globalThis as any).document = { getElementById: (id: string) => els.get(id) ?? null };
  await (await import("../../src/main")).booted;
  return { els };
}

it("composes Angband's debug tty view before constructing its session", async () => {
  seam.gpu = true;
  const { els } = await boot("?game=angband&view=debug");
  expect(els.get("view")!.removed).toBe(true);
  expect(els.get("cmdbtn")!.removed).toBe(true);
  expect((window as any).__angbandView).toBe(seam.tty);
  expect((window as any).__angbandSession).toBeTruthy();
  expect(seam.handler).toBe(seam.tty);
});

it("binds the save menu to the session it just built and the view's notices", async () => {
  seam.gpu = true;
  await boot("?game=angband&view=debug");
  expect(seam.installMenu).toHaveBeenCalledOnce();
  const ui = seam.installMenu.mock.calls[0]![0] as {
    request(): Promise<unknown>; notify(text: string): void; volume: { id: string };
  };

  // The menu refuses another game's file, so it has to know whose page it is.
  expect(ui.volume.id).toBe("angband");

  await ui.request();
  expect(seam.exportSave).toHaveBeenCalledOnce();

  ui.notify("saved");
  expect(seam.tty.onNotice).toHaveBeenCalledWith("saved");
});

it("falls back to tty with a notice when no GPU is available", async () => {
  seam.gpu = false;
  const { els } = await boot("?game=angband");
  expect((window as any).__angbandView).toBe(seam.tty);
  expect(els.get("view")!.removed).toBe(true);
  expect(seam.tty.onNotice).toHaveBeenCalledWith("no gpu");
});

it("keeps the canvas and builds the vector view when a GPU is available", async () => {
  seam.gpu = true;
  const { els } = await boot("?game=angband&gl");
  expect((window as any).__angbandView).toBe(seam.vector);
  expect(els.get("view")!.removed).toBe(false);
  expect(seam.vectorArgs).toEqual([els.get("view"), { forceWebGL: true }]);
});

it("loads no other Module's code (vect-hack-l11)", async () => {
  seam.gpu = true;
  // ?borg on purpose: the self-playing arm reaches for the most, so it is the
  // arm most likely to reach for something that belongs to another Module.
  await boot("?game=angband&borg");
  expect(seam.foreign.nethack).not.toHaveBeenCalled();
  expect(seam.foreign.larn).not.toHaveBeenCalled();
  expect(seam.foreign.moria).not.toHaveBeenCalled();
});

it("connects the look HUD to the session it just built, and only on the vector view", async () => {
  seam.gpu = true;
  await boot("?game=angband&gl");
  expect(typeof seam.vector.look.describe).toBe("function");
  await seam.vector.look.describe!(3, 4);
  expect(seam.describe).toHaveBeenCalledWith(3, 4);

  // The tty view has no canvas and no look, so the arm must not reach for one.
  await boot("?game=angband&view=debug");
  expect(seam.describe).not.toHaveBeenCalled();
});

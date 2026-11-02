import { expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  tty: { onNotice: vi.fn() },
  vector: { onNotice: vi.fn(), look: {} } as {
    onNotice: ReturnType<typeof vi.fn>;
    look: { describe?: (x: number, y: number) => unknown };
  },
  vectorArgs: [] as unknown[],
  handler: null as object | null,
  gpu: true,
  exportSave: vi.fn(async () => ({ bytes: new Uint8Array([1]), filename: "moria.vhsave" })),
  installMenu: vi.fn(),
  describe: vi.fn(async () => "a floor"),
  /** One counter per foreign Module, bumped by that Module's mock factory. */
  foreign: { nethack: vi.fn(), angband: vi.fn(), larn: vi.fn() },
}));
vi.mock("../../src/modules/moria/ui/TtyView", () => ({
  TtyView: class { constructor() { return seam.tty; } },
}));
  // The vector seam carries a `look` because main.ts reaches for it — and it
  // reaches through chooseView()'s discriminant now, not `view instanceof
  // VectorView` (vect-hack-po4: the call site cannot hold the vector class as a
  // value without re-importing the module the tty arm exists to skip). Under
  // the old instanceof the mock's plain object made that gate FALSE here, so
  // the look wiring in this arm was never executed by this file at all; the
  // test below is what that gate now buys.
vi.mock("../../src/modules/moria/ui/VectorView", () => ({
  VectorView: class {
    constructor(...args: unknown[]) { seam.vectorArgs = args; return seam.vector; }
  },
}));
vi.mock("../../src/modules/moria/session", () => ({
  MoriaSession: class {
    exportSave = seam.exportSave;
    describe = seam.describe;
    constructor(handler: object) { seam.handler = handler; }
  },
}));
// The three Modules this page is not playing, at every entry point main.ts
// could plausibly reach: a session, a view, a self-playing decorator. A
// factory runs on first import, so a static import creeping back into main.ts
// turns one of these counters non-zero (vect-hack-l11).
vi.mock("../../src/modules/nethack/session", () => (seam.foreign.nethack(), { NetHackSession: class {} }));
vi.mock("../../src/modules/nethack/ui/VectorView", () => (seam.foreign.nethack(), { VectorView: class {} }));
vi.mock("../../src/modules/nethack/ui/DebugView", () => (seam.foreign.nethack(), { DebugView: class {} }));
vi.mock("../../src/modules/nethack/bot/BotPlayer", () => (seam.foreign.nethack(), { BotPlayer: class {} }));
vi.mock("../../src/modules/angband/session", () => (seam.foreign.angband(), { AngbandSession: class {} }));
vi.mock("../../src/modules/angband/ui/VectorView", () => (seam.foreign.angband(), { VectorView: class {} }));
vi.mock("../../src/modules/angband/ui/TtyView", () => (seam.foreign.angband(), { TtyView: class {} }));
vi.mock("../../src/modules/angband/ui/BorgPlayer", () => (seam.foreign.angband(), { BorgPlayer: class {} }));
vi.mock("../../src/modules/larn/session", () => (seam.foreign.larn(), { LarnSession: class {} }));
vi.mock("../../src/modules/larn/ui/VectorView", () => (seam.foreign.larn(), { VectorView: class {} }));
vi.mock("../../src/modules/larn/ui/TtyView", () => (seam.foreign.larn(), { TtyView: class {} }));
vi.mock("../../src/modules/larn/bot/LarnBotPlayer", () => (seam.foreign.larn(), { LarnBotPlayer: class {} }));
// Partial: saveRisk.ts reaches the Saves button by the id this module owns,
// so a factory that returned installSaveMenu alone would leave that constant
// undefined on the mock and throw the moment the storage grant resolves.
vi.mock("../../src/ui/saveMenu", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/ui/saveMenu")>(),
  installSaveMenu: seam.installMenu,
}));
vi.mock("../../src/ui/gpuSupport", () => ({
  GPU_UNAVAILABLE_NOTICE: "no gpu", browserGpuProbe: () => ({}),
  gpuAvailable: async () => seam.gpu,
}));
vi.mock("../../src/skins", () => ({ applySkinCss() {} }));

class El { removed = false; remove() { this.removed = true; } }

async function boot(search: string) {
  vi.resetModules();
  seam.handler = null;
  seam.vectorArgs = [];
  seam.installMenu.mockClear();
  seam.exportSave.mockClear();
  seam.describe.mockClear();
  seam.vector.look = {};
  seam.tty.onNotice.mockClear();
  seam.vector.onNotice.mockClear();
  const els = new Map([["view", new El()], ["cmdbtn", new El()]]);
  const replace = vi.fn();
  (globalThis as any).window = {};
  (globalThis as any).location = { search, replace, pathname: "/play", hash: "#hud" };
  (globalThis as any).document = { getElementById: (id: string) => els.get(id) ?? null };
  // Boot is not synchronous any more (vect-hack-l11): the arm waits on the
  // dynamic import that keeps the other three Modules off this page, so this
  // awaits the composition itself rather than a fixed number of microtasks.
  // `booted` is undefined on the redirect path, which composes nothing.
  await (await import("../../src/main")).booted;
  return { els, replace };
}

it("composes the explicit Moria vector view before its session and F3 export", async () => {
  seam.gpu = true;
  const { els, replace } = await boot("?game=moria&skin=ghost");
  expect(els.get("view")!.removed).toBe(false);
  expect(els.get("cmdbtn")!.removed).toBe(true);
  expect((window as any).__moriaView).toBe(seam.vector);
  expect((window as any).__moriaSession).toBeTruthy();
  expect(seam.handler).toBe(seam.vector);
  expect(seam.vectorArgs).toEqual([els.get("view"), { forceWebGL: false }]);
  expect(replace).not.toHaveBeenCalled();

  expect(seam.installMenu).toHaveBeenCalledOnce();
  const exportUi = seam.installMenu.mock.calls[0]![0];
  await exportUi.request();
  expect(seam.exportSave).toHaveBeenCalledOnce();
  exportUi.notify("Moria save downloaded.");
  expect(seam.vector.onNotice).toHaveBeenCalledWith("Moria save downloaded.");
});

it("retains the debug TTY and no-GPU fallback with an honest notice", async () => {
  seam.gpu = true;
  let result = await boot("?game=moria&view=debug");
  expect(result.els.get("view")!.removed).toBe(true);
  expect((window as any).__moriaView).toBe(seam.tty);
  expect(seam.handler).toBe(seam.tty);

  seam.gpu = false;
  result = await boot("?game=moria");
  expect(result.els.get("view")!.removed).toBe(true);
  expect((window as any).__moriaView).toBe(seam.tty);
  expect(seam.tty.onNotice).toHaveBeenCalledWith("no gpu");
});

it("forces WebGL only for the explicit Moria gl route", async () => {
  seam.gpu = true;
  const { els } = await boot("?game=moria&gl");
  expect((window as any).__moriaView).toBe(seam.vector);
  expect(seam.vectorArgs).toEqual([els.get("view"), { forceWebGL: true }]);
  expect(els.get("view")!.removed).toBe(false);
});

it("loads no other Module's code (vect-hack-l11)", async () => {
  seam.gpu = true;
  await boot("?game=moria");
  expect(seam.foreign.nethack).not.toHaveBeenCalled();
  expect(seam.foreign.angband).not.toHaveBeenCalled();
  expect(seam.foreign.larn).not.toHaveBeenCalled();
});

it("redirects a missing game without constructing an implicit session", async () => {
  const { replace } = await boot("?view=debug&trace");
  expect(replace).toHaveBeenCalledOnce();
  expect(replace).toHaveBeenCalledWith("/play?view=debug&trace=&game=nethack#hud");
  expect(seam.handler).toBeNull();
  expect((window as any).__moriaSession).toBeUndefined();
});

it("connects the look HUD to the session it just built, and only on the vector view", async () => {
  seam.gpu = true;
  await boot("?game=moria&gl");
  expect(typeof seam.vector.look.describe).toBe("function");
  await seam.vector.look.describe!(3, 4);
  expect(seam.describe).toHaveBeenCalledWith(3, 4);

  // The tty view has no canvas and no look, so the arm must not reach for one.
  await boot("?game=moria&view=debug");
  expect(seam.describe).not.toHaveBeenCalled();
});

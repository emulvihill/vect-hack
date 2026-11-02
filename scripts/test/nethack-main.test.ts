// The ?game=nethack composition path in main.ts: the view is built before the
// session (so no engine event can race an uninstalled handler), the window
// global is exposed for the page helpers, the save export binds to the session
// just constructed, and the degrade policy picks the right view. Mirror of
// angband-main.test.ts, including its vect-hack-l11 half: booting NetHack must
// load none of Angband's, Larn's or Moria's code.
//
// NetHack is the widest arm and the parts that are not a copy are the reason
// this file exists (vect-hack-2cg). It is the default game, so a URL with no
// ?game redirects here; it is the one Module that KEEPS the pointer command
// button; it is the only Module with ?touch; and it is the only one whose
// handler declares `onNotice?` optional, which is why its save menu notifies
// through `view.onNotice?.(text)` rather than calling it outright.
//
// Two of those lines are gated on `view instanceof VectorView`, so unlike the
// three sibling files this VectorView mock returns a real instance of the
// mocked class rather than a plain seam object. A mock that returned another
// object would make both gates false and both assertions unfalsifiable.
import { expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  tty: { onNotice: vi.fn() } as object & { onNotice: ReturnType<typeof vi.fn> },
  vector: null as null | {
    look: { describe?: (x: number, y: number) => unknown };
    onNotice?: (text: string) => void;
    installTouch: ReturnType<typeof vi.fn>;
  },
  vectorArgs: [] as unknown[],
  vectorNotice: vi.fn(),
  installTouch: vi.fn(),
  handler: null as object | null,
  gpu: true,
  describe: vi.fn(async () => "a floor"),
  exportSave: vi.fn(async () => ({ bytes: new Uint8Array([1]), filename: "n.vhsave" })),
  installMenu: vi.fn(),
  botWrapped: null as object | null,
  botDelay: null as number | null,
  /** One counter per foreign Module, bumped by that Module's mock factory. */
  foreign: { angband: vi.fn(), larn: vi.fn(), moria: vi.fn() },
}));
vi.mock("../../src/modules/nethack/ui/DebugView", () => ({
  DebugView: class { constructor() { return seam.tty; } },
}));
vi.mock("../../src/modules/nethack/ui/VectorView", () => ({
  VectorView: class {
    // The real view's point-and-look HUD and its touch installer: main.ts
    // reaches both only after `view instanceof VectorView`, so this class
    // hands back an instance of itself and records it on the seam.
    look: { describe?: (x: number, y: number) => unknown } = {};
    onNotice: ((text: string) => void) | undefined = seam.vectorNotice;
    installTouch = seam.installTouch;
    constructor(...args: unknown[]) { seam.vectorArgs = args; seam.vector = this; }
  },
}));
vi.mock("../../src/modules/nethack/bot/BotPlayer", () => ({
  BotPlayer: class {
    constructor(view: object, delayMs: number) { seam.botWrapped = view; seam.botDelay = delayMs; }
  },
}));
vi.mock("../../src/modules/nethack/session", () => ({
  NetHackSession: class {
    exportSave = seam.exportSave;
    describe = seam.describe;
    constructor(handler: object) { seam.handler = handler; }
  },
}));
// The three Modules this page is not playing, at every entry point main.ts
// could plausibly reach: a session, a view, a self-playing decorator. A factory
// runs on first import, so a static import creeping back into main.ts turns one
// of these counters non-zero (vect-hack-l11).
vi.mock("../../src/modules/angband/session", () => (seam.foreign.angband(), { AngbandSession: class {} }));
vi.mock("../../src/modules/angband/ui/VectorView", () => (seam.foreign.angband(), { VectorView: class {} }));
vi.mock("../../src/modules/angband/ui/TtyView", () => (seam.foreign.angband(), { TtyView: class {} }));
vi.mock("../../src/modules/angband/ui/BorgPlayer", () => (seam.foreign.angband(), { BorgPlayer: class {} }));
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
 *  microtasks — a count that goes stale the next time an await moves.
 *
 *  It deliberately does NOT clear `seam.foreign`. A mock factory runs once per
 *  FILE, so the counter a foreign Module's factory bumped was bumped by
 *  whichever boot first pulled it in; clearing here would throw that evidence
 *  away and let a static import in main.ts pass the l11 assertion. */
async function boot(search: string) {
  vi.resetModules();
  seam.handler = null;
  seam.vector = null;
  seam.vectorArgs = [];
  seam.botWrapped = null;
  seam.botDelay = null;
  seam.installMenu.mockClear();
  seam.exportSave.mockClear();
  seam.describe.mockClear();
  seam.installTouch.mockClear();
  seam.tty.onNotice.mockClear();
  seam.vectorNotice.mockClear();
  const els = new Map([["view", new El()], ["cmdbtn", new El()]]);
  const replace = vi.fn();
  (globalThis as any).window = {};
  (globalThis as any).location = { search, replace, pathname: "/play", hash: "#hud" };
  (globalThis as any).document = { getElementById: (id: string) => els.get(id) ?? null };
  await (await import("../../src/main")).booted;
  return { els, replace };
}

/** The one argument installSaveMenu was called with on the boot just done. */
function saveUi() {
  expect(seam.installMenu).toHaveBeenCalledOnce();
  return seam.installMenu.mock.calls[0]![0] as {
    request(): Promise<unknown>; notify(text: string): void; volume: { id: string };
  };
}

it("composes NetHack's debug view before its session, and keeps the command button", async () => {
  seam.gpu = true;
  const { els, replace } = await boot("?game=nethack&view=debug");
  expect(els.get("view")!.removed).toBe(true);
  // NetHack is the only Module with a pointer command menu, so it is the only
  // arm that must NOT remove the button the other three delete on sight.
  expect(els.get("cmdbtn")!.removed).toBe(false);
  expect((window as any).__nhView).toBe(seam.tty);
  expect(seam.handler).toBe(seam.tty);
  expect(replace).not.toHaveBeenCalled();
});

it("binds the save menu to the session it just built and the view's notices", async () => {
  seam.gpu = true;
  await boot("?game=nethack&view=debug");
  const ui = saveUi();

  // The menu refuses another game's file, so it has to know whose page it is.
  expect(ui.volume.id).toBe("nethack");

  await ui.request();
  expect(seam.exportSave).toHaveBeenCalledOnce();

  ui.notify("saved");
  expect(seam.tty.onNotice).toHaveBeenCalledWith("saved");
});

it("still downloads for a view with no onNotice at all", async () => {
  // NethackHandler declares `onNotice?` optional (src/modules/nethack/session.ts),
  // and NetHack is the only Module whose save-menu binding therefore calls it
  // with `?.`. A view without one keeps the download and loses only the
  // confirmation, which is what that `?.` buys.
  seam.gpu = true;
  await boot("?game=nethack&gl");
  const ui = saveUi();
  seam.vector!.onNotice = undefined;

  expect(() => ui.notify("saved")).not.toThrow();
  await ui.request();
  expect(seam.exportSave).toHaveBeenCalledOnce();
});

it("falls back to tty with a notice when no GPU is available", async () => {
  seam.gpu = false;
  const { els } = await boot("?game=nethack");
  expect((window as any).__nhView).toBe(seam.tty);
  expect(els.get("view")!.removed).toBe(true);
  expect(seam.tty.onNotice).toHaveBeenCalledWith("no gpu");
});

it("keeps the canvas and builds the vector view when a GPU is available", async () => {
  seam.gpu = true;
  const { els } = await boot("?game=nethack&gl");
  expect((window as any).__nhView).toBe(seam.vector);
  expect(els.get("view")!.removed).toBe(false);
  expect(seam.vectorArgs).toEqual([els.get("view"), { forceWebGL: true }]);

  saveUi().notify("saved");
  expect(seam.vectorNotice).toHaveBeenCalledWith("saved");
});

it("connects the look HUD to the session it just built, and only on the vector view", async () => {
  seam.gpu = true;
  await boot("?game=nethack&gl");
  expect(typeof seam.vector!.look.describe).toBe("function");
  await seam.vector!.look.describe!(3, 4);
  expect(seam.describe).toHaveBeenCalledWith(3, 4);

  // The tty view has no canvas and no look, so the arm must not reach for one.
  await boot("?game=nethack&view=debug");
  expect(seam.describe).not.toHaveBeenCalled();
});

it("builds the touch scheme only for ?touch on the vector view", async () => {
  seam.gpu = true;
  await boot("?game=nethack&touch&gl");
  expect(seam.installTouch).toHaveBeenCalledOnce();

  // A URL without the flag builds none of it (vect-hack-21k).
  await boot("?game=nethack&gl");
  expect(seam.installTouch).not.toHaveBeenCalled();

  // And the flag alone is not enough: the pad hangs off the vector view's
  // canvas, which a debug or no-GPU page does not have.
  await boot("?game=nethack&touch&view=debug");
  expect(seam.installTouch).not.toHaveBeenCalled();
});

it("hands ?bot the view it just built, and a human game no bot at all", async () => {
  seam.gpu = true;
  await boot("?game=nethack&view=debug&bot=fast");
  // The session sees the decorator, and the decorator sees the view — the
  // order that lets the bot answer every key the engine asks for.
  expect(seam.botWrapped).toBe(seam.tty);
  expect(seam.botDelay).toBe(0);
  expect(seam.handler).not.toBe(seam.tty);
  expect((seam.handler as object).constructor.name).toBe("BotPlayer");

  await boot("?game=nethack&view=debug&bot=250");
  expect(seam.botDelay).toBe(250);

  await boot("?game=nethack&view=debug");
  expect(seam.botWrapped).toBeNull();
  expect(seam.handler).toBe(seam.tty);
});

it("loads no other Module's code (vect-hack-l11)", async () => {
  seam.gpu = true;
  // The widest arm on purpose: touch and the self-playing decorator both reach
  // for more than a plain game, so this is the boot most likely to reach for
  // something that belongs to another Module.
  await boot("?game=nethack&touch&bot=fast");
  expect(seam.foreign.angband).not.toHaveBeenCalled();
  expect(seam.foreign.larn).not.toHaveBeenCalled();
  expect(seam.foreign.moria).not.toHaveBeenCalled();
});

it("redirects a URL with no game to NetHack without booting NetHack here", async () => {
  const { replace } = await boot("?gl&trace");
  // NetHack is the default game, and the redirect keeps every other flag.
  expect(replace).toHaveBeenCalledOnce();
  expect(replace).toHaveBeenCalledWith("/play?gl=&trace=&game=nethack#hud");
  // replace() is async, so this evaluation must compose nothing: a session
  // built here would be a doomed engine racing the navigation.
  expect(seam.handler).toBeNull();
  expect((window as any).__nhView).toBeUndefined();
});

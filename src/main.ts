import { chooseView } from "./ui/chooseView";
import { applySkinCss } from "./skins";
import { requestPersistentStorage } from "./backplane/persistentStorage";
import { showSaveRisk, showSessionOnlySaves } from "./ui/saveRisk";
import { onSessionOnly } from "./backplane/session";
import { installNoKeyboardNotice } from "./ui/noKeyboard";
import { touchRequested } from "./ui/touch/scheme";
import { installSaveMenu } from "./ui/saveMenu";
import { VOLUMES } from "./backplane/volumes";
// Every Module reference above this line is a TYPE, and that is the point
// (vect-hack-l11). A `import type` is erased, so naming NetHackSession here
// costs a ?game=larn visitor nothing; the values arrive through the dynamic
// imports inside each arm's boot function below.
import type { NethackHandler } from "./modules/nethack/session";
import type { AngbandSession, AngbandHandler } from "./modules/angband/session";
import type { LarnSession, LarnHandler } from "./modules/larn/session";
import type { MoriaSession, MoriaHandler } from "./modules/moria/session";

declare global {
  interface Window {
    __vhBooted?: number;
    __nhView?: NethackHandler;
    __angbandSession?: AngbandSession;
    __angbandView?: AngbandHandler;
    __larnSession?: LarnSession;
    __larnView?: LarnHandler;
    __moriaSession?: MoriaSession;
    __moriaView?: MoriaHandler;
  }
}

/**
 * The chosen Module's composition, as a promise, or undefined when this
 * evaluation composed nothing — the ?game redirect, or a second evaluation.
 *
 * It exists because boot is no longer synchronous (vect-hack-l11): each arm
 * now waits on a dynamic import before it builds anything, so "one microtask
 * later" is no longer a truthful way to wait for it. The composition tests
 * await this rather than counting ticks, which is a thing that stops being
 * true the moment the number of awaits changes. Nothing in the page needs it:
 * the gates poll for the view globals, which is what a console does too.
 */
export let booted: Promise<void> | undefined;

// Guard against double module evaluation (HMR edge cases): one engine only.
window.__vhBooted = (window.__vhBooted ?? 0) + 1;
if (window.__vhBooted === 1) {
  applySkinCss();
  // ?game names the Module — always explicitly, so nothing downstream can grow
  // a "default game" dependency. A URL without it redirects to ?game=nethack,
  // keeping every other flag (?gl, ?bot, ...) and the hash intact.
  const params = new URLSearchParams(location.search);
  // The eviction exemption is origin-wide, so it is asked for here, once per
  // page, and never from a Module or its worker. Skipped on the redirect
  // evaluation below, whose page is already going away — Firefox prompts, and a
  // prompt that navigation dismisses is a prompt spent for nothing. Fired and
  // not awaited: a permission heuristic must not stand in front of engine boot.
  if (params.has("game")) {
    // Fired and not awaited, still: the .then() only decides what the page
    // shows about the answer, and showSaveRisk reaches the Saves button by id
    // precisely so it can land after the views and the menu already exist.
    // Since l11 it can also land BEFORE them, because a Module's arm now waits
    // on a download first — which changes nothing, because the button is in
    // index.html and the id is there from the first paint.
    void requestPersistentStorage().then((persisted) => showSaveRisk({ persisted }));
    // The other half of the same warning, and the harder one (vect-hack-dem):
    // a tab whose save volume never mounted keeps nothing at all. Registered
    // before any Module builds its session, because the mount settles during
    // engine boot; whichever of the two answers first, showSessionOnlySaves
    // wins the banner and the button. One registration for all four Modules —
    // every one of them mounts a volume, and the Backplane routes the message
    // for all of them (src/backplane/session.ts). It is registered here, on the
    // synchronous path, rather than inside an arm, so no Module's dynamic
    // import can land after its own worker has already reported the mount.
    onSessionOnly((code) => showSessionOnlySaves({ code }));
    // A phone or tablet has no way to send the keys this game is played with
    // (vect-hack-d72). Say so, and offer the self-playing demo, which needs
    // none. A desktop matches neither media query and sees nothing.
    installNoKeyboardNotice({ game: params.get("game")!, search: location.search });
  }
  if (!params.has("game")) {
    params.set("game", "nethack");
    // No boot on this evaluation: replace() is async, so falling through here
    // would race a doomed engine against the navigation.
    location.replace(`${location.pathname}?${params}${location.hash}`);
  } else if (params.get("game") === "angband") {
    // Angband has no pointer command menu in either view; its vector view keeps
    // the canvas for camera drag while debug/no-GPU modes replace it with tty.
    // Removed on the synchronous path, before the arm's download: chrome that
    // this Module does not have should never be painted, not even briefly.
    document.getElementById("cmdbtn")?.remove();
    booted = bootAngband(params);
  } else if (params.get("game") === "larn") {
    // Larn has no pointer command menu, so the button chrome goes the way of
    // Angband's. The canvas stays: phase 2 gave Larn a vector view.
    document.getElementById("cmdbtn")?.remove();
    booted = bootLarn(params);
  } else if (params.get("game") === "moria") {
    // Moria has no pointer command menu. Its vector view owns camera drag;
    // debug/no-GPU modes remove the canvas and retain the proven 80x24 tty.
    document.getElementById("cmdbtn")?.remove();
    booted = bootMoria(params);
  } else if (params.get("game") === "nethack") {
    booted = bootNethack(params);
  }
} else {
  console.warn("main.ts evaluated again (count:", window.__vhBooted, ") — skipping boot");
}

// One boot function per Module, and one `await import` inside each of them.
//
// A Module downloads when someone plays it, not before (vect-hack-l11). Before
// this, main.ts named all four Modules' sessions, views and bots at the top of
// the file, so a visitor who followed a link to ?game=larn downloaded NetHack's
// 6 MB-engine UI, Angband's and Moria's as well — the wasm was already
// per-Module, and only the JavaScript was not.
//
// The `?game` branch above is still an explicit chain naming each Module
// literally, with no registry abstraction: a registry that existed only to
// enumerate four names would hide exactly the thing this file is for. What
// changed is where each name is resolved, not how many places know it.
//
// Two orderings survive the change and are worth naming, because an await in
// the wrong place would break either one silently:
//
//  - The view is constructed before the session, so no engine event can reach
//    a handler that has not installed its grid. chooseView() builds the view it
//    picked before its promise settles, and each function below constructs its
//    session only after that promise has — so the ordering holds even though
//    the session's own download now runs beside the choice rather than behind it.
//  - The storage grant and the session-only registration are fired on the
//    synchronous path above, before any of these functions runs. Moving either
//    behind a dynamic import would race them against a worker that mounts its
//    volume during boot.
//
// Each function fetches its Module's session ALONGSIDE the view choice, and
// hands chooseView a loader per view rather than the two classes (vect-hack-po4,
// src/ui/chooseView.ts). Only the arm that wins is fetched, so a browser with no
// GPU — or a ?view=debug page — never downloads three/webgpu and src/render to
// draw a character grid. The session goes in the same Promise.all because it is
// not what the probe is deciding between: it names no view, and putting it
// behind the choice would add a serial round trip in front of the engine for
// nothing. No module is named twice inside one of these Promise.all
// batches, and that is a constraint rather than tidiness: vitest 4.1.10 hands
// the REAL module to the second of two concurrent dynamic imports of a mocked
// one, so a duplicate here loads the whole render layer into a test that mocked
// it away, and the failure surfaces a directory away from its cause. The two
// view loaders are inside chooseView's call, and at most one of them ever runs,
// so neither can collide with the session import beside it.
// A self-playing decorator is fetched separately and only when
// its flag is present: ?bot and ?borg are demos, and a human game should not
// download a bot to not use it.

/** ?bot pacing, shared by NetHack's and Larn's decorators: one second per
 *  command by default — the point of watching it is watching it — with
 *  ?bot=fast unthrottled and ?bot=<ms> for anything in between. */
function botDelayMs(bot: string): number {
  return bot === "fast" ? 0 : /^\d+$/.test(bot) ? Number(bot) : 1000;
}

async function bootNethack(params: URLSearchParams): Promise<void> {
  // One await, for the GPU probe and the winning view's download. Everything
  // reading window.__nhView already polls for it
  // (scripts/dev/browser-check.mjs), so the wait costs nothing.
  const [{ NetHackSession }, chosen] = await Promise.all([
    import("./modules/nethack/session"),
    chooseView({
      vector: async () => (await import("./modules/nethack/ui/VectorView")).VectorView,
      tty: async () => (await import("./modules/nethack/ui/DebugView")).DebugView,
    }),
  ]);
  const view = chosen.view;
  // Exposed for the console and for scripts/dev/browser-check.mjs.
  window.__nhView = view;
  // ?bot: the self-playing decorator answers all input.
  const bot = params.get("bot");
  const player = bot !== null
    ? new (await import("./modules/nethack/bot/BotPlayer")).BotPlayer(view, botDelayMs(bot))
    : view;
  const session = new NetHackSession(player);
  // Point-and-look (spec 2026-08-18): the one line per Module that
  // connects the shared HUD to this Module's engine. Only the vector view
  // has a canvas and a look — the discriminant rather than a structural cast,
  // so renaming the field is a type error here instead of a HUD that
  // silently never asks anything.
  if (chosen.kind === "vector") chosen.view.look.describe = (x, y) => session.describe(x, y);
  // Touch controls (vect-hack-21k), behind ?touch: a thumb pad and an
  // action bar, so a phone can take a turn. A URL without the flag builds
  // nothing and the page is exactly what it is today.
  if (touchRequested(location.search) && chosen.kind === "vector") chosen.view.installTouch();
  installSaveMenu({
    volume: VOLUMES.nethack,
    request: () => session.exportSave(),
    // Views without a notice channel still get the download; only the
    // confirmation is lost, and a missing file is visible either way.
    notify: (text) => view.onNotice?.(text),
  });
}

async function bootAngband(params: URLSearchParams): Promise<void> {
  const [{ AngbandSession }, chosen] = await Promise.all([
    import("./modules/angband/session"),
    chooseView({
      vector: async () => (await import("./modules/angband/ui/VectorView")).VectorView,
      tty: async () => (await import("./modules/angband/ui/TtyView")).TtyView,
    }),
  ]);
  const view = chosen.view;
  window.__angbandView = view;
  // ?borg: the self-playing decorator answers all input and forwards every
  // event, so the view renders exactly what a human game would.
  const borg = params.get("borg");
  const player = borg !== null
    ? new (await import("./modules/angband/ui/BorgPlayer")).BorgPlayer(view)
    : view;
  // Construction waits for the async GPU choice, so no engine event can
  // race a view that has not installed its term mirror and input queue.
  const session = new AngbandSession(player);
  window.__angbandSession = session;
  // ?borg=<ms> paces the borg like ?bot=<ms> paces the bot; bare ?borg is
  // unthrottled. Sent even for 0: borg.txt persists, so the last run's
  // pace would otherwise carry over (src/modules/angband/borgConfig.ts).
  if (borg !== null) session.setBorgDelay(/^\d+$/.test(borg) ? Number(borg) : 0);
  // Point-and-look (spec 2026-08-18): the one line per Module that
  // connects the shared HUD to this Module's engine. Only the vector view
  // has a canvas and a look — the discriminant rather than a structural cast,
  // so renaming the field is a type error here instead of a HUD that
  // silently never asks anything.
  if (chosen.kind === "vector") chosen.view.look.describe = (x, y) => session.describe(x, y);
  installSaveMenu({
    volume: VOLUMES.angband,
    request: () => session.exportSave(),
    notify: (text) => view.onNotice(text),
  });
}

async function bootLarn(params: URLSearchParams): Promise<void> {
  const [{ LarnSession }, chosen] = await Promise.all([
    import("./modules/larn/session"),
    chooseView({
      vector: async () => (await import("./modules/larn/ui/VectorView")).VectorView,
      tty: async () => (await import("./modules/larn/ui/TtyView")).TtyView,
    }),
  ]);
  const view = chosen.view;
  window.__larnView = view;
  // Construction order matters: the view exists before the session, so
  // no engine event can race a handler that has not installed its grid.
  // ?bot: the self-playing decorator answers every key, paced like the
  // NetHack bot.
  const bot = params.get("bot");
  // Fetched only for the bot: a human game loads none of its code.
  const player = bot !== null
    ? new (await import("./modules/larn/bot/LarnBotPlayer")).LarnBotPlayer(view, botDelayMs(bot))
    : view;
  const session = new LarnSession(player);
  window.__larnSession = session;
  // Point-and-look (spec 2026-08-18): the one line per Module that
  // connects the shared HUD to this Module's engine. Only the vector view
  // has a canvas and a look — the discriminant rather than a structural cast,
  // so renaming the field is a type error here instead of a HUD that
  // silently never asks anything.
  if (chosen.kind === "vector") chosen.view.look.describe = (x, y) => session.describe(x, y);
  installSaveMenu({
    volume: VOLUMES.larn,
    request: () => session.exportSave(),
    notify: (text) => view.onNotice(text),
  });
}

async function bootMoria(_params: URLSearchParams): Promise<void> {
  const [{ MoriaSession }, chosen] = await Promise.all([
    import("./modules/moria/session"),
    chooseView({
      vector: async () => (await import("./modules/moria/ui/VectorView")).VectorView,
      tty: async () => (await import("./modules/moria/ui/TtyView")).TtyView,
    }),
  ]);
  const view = chosen.view;
  window.__moriaView = view;
  const session = new MoriaSession(view);
  window.__moriaSession = session;
  // Point-and-look (spec 2026-08-18): the one line per Module that
  // connects the shared HUD to this Module's engine. Only the vector view
  // has a canvas and a look — the discriminant rather than a structural cast,
  // so renaming the field is a type error here instead of a HUD that
  // silently never asks anything.
  if (chosen.kind === "vector") chosen.view.look.describe = (x, y) => session.describe(x, y);
  installSaveMenu({
    volume: VOLUMES.moria,
    request: () => session.exportSave(),
    notify: (text) => view.onNotice(text),
  });
}

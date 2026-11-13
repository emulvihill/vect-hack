// Drives the real app in a real browser on a real GPU: boots a character,
// walks a few turns, then reports the backend three chose, the frame rate, and
// whether the strokes actually glow. Runs once per Module (NetHack, Angband,
// Larn, Moria)
// per backend (WebGPU, ?gl).
//
// Renderer diagnostics and CellGrid reads are public API. Larn and Moria
// startup intentionally read their VectorViews' runtime-private retained
// tty/KeyQueue from dev-only adapters confined here. They fail closed if either
// field changes, keeping the public Module APIs clean.
//
// Two more arms test the CHOICE rather than the renderer (vect-hack-4d0). Those
// eight drive a backend that is there: ?gl pins WebGL, and the WebGPU arm runs
// on a machine that has WebGPU. Neither says what happens to a visitor whose
// browser hands the page less than that, which is the state a large share of
// beta visitors arrive in. So the degrade arms below take WebGPU away and let
// the page's own probe pick (src/ui/gpuSupport.ts), then take WebGL away too
// and require the text view, its notice and a playable game — the degrade
// policy in src/ui/chooseView.ts, driven end to end. They are shared-policy
// arms, so they run on one Module rather than four.
//
// Needs a dev server (npm run dev -- --port 5199) and a GPU. Headless Chromium
// gates WebGPU behind --enable-unsafe-webgpu, and only exposes it on a secure
// origin, which is why this talks to localhost rather than a file:// page.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { STORAGE_DECLINED_WARNING } from "./gate-console.mjs";

const URL_BASE = process.env.NH_URL ?? "http://localhost:5199/";
const OUT_DIR = ".preview";
const FPS_SAMPLE_MS = 3000;
const BOOT_MS = 30000;
/** How long the HUD may keep asking for keys before the run is called stuck. */
const SETTLE_MS = 60000;
/** One key is a full engine round trip through the worker. */
const TURN_MS = 120;
/** Steps taken down one direction before trying the next. */
const STEPS_PER_DIRECTION = 3;
/** Below this a screenshot is a black rectangle with nothing to measure. */
const MIN_LIT_PIXELS = 2000;
/** Halo the bloom stack adds per bare-core pixel; see bloomGain(). */
const MIN_BLOOM_GAIN = 0.5;
/** LOOK_HINT from src/ui/hud/Look.ts — this is a .mjs script and cannot import
 *  the TypeScript module, so the string is copied. The look probe below has to
 *  tell the hint apart from an engine's answer: a Module whose describe seam
 *  was never wired still shows ring plus hint, and "a non-empty label" would
 *  read that as a pass. */
const LOOK_HINT = "Point at anything to name it";
/** GPU_UNAVAILABLE_NOTICE from src/ui/gpuSupport.ts, copied for the same reason
 *  LOOK_HINT is: a .mjs script cannot import the TypeScript module. Matched
 *  exactly, so an edit there that never reaches the player fails this gate. */
const GPU_UNAVAILABLE_NOTICE =
  "This browser gives the page neither WebGPU nor WebGL, so the vector view has "
  + "nothing to draw on — running in the text view instead. Open the same URL in "
  + "Chrome or Firefox for the 3D dungeon.";
const CHROMIUM_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"];
/**
 * WebGPU denied, WebGL left exactly as the ?gl arms have it. --disable-features
 * =WebGPUService switches off Chromium's own WebGPU service, so navigator.gpu
 * survives and requestAdapter() hands back nothing — the state gpuSupport.ts was
 * written for, and what a blocklisted GPU or a browser with acceleration off
 * gives a real visitor. Denial by a switch and not by omission: dropping
 * --enable-features=Vulkan would also take the adapter away, but it takes the
 * hardware WebGL renderer with it (Chromium falls back to SwiftShader), and
 * then the arm would be measuring a different machine as well as a different
 * choice. The URL carries no ?gl, so the page has to choose — and the arm
 * asserts the denial landed, so a Chromium that renames the switch goes red
 * here rather than quietly becoming a ninth WebGPU arm.
 */
const NO_WEBGPU_ARGS = ["--disable-features=WebGPUService", "--enable-features=Vulkan", "--use-angle=vulkan"];
/**
 * Neither API. --disable-3d-apis is Chromium's own switch for "3D content is
 * blocked" (the blocklist and the accelerated-graphics setting reach the same
 * place): navigator.gpu returns no adapter and getContext("webgl2") returns
 * null, in the renderer process, before any page script runs. Denied by the
 * browser rather than by a stub of ours, which is the only way the page's probe
 * sees what a real visitor's browser would show it.
 */
const NO_3D_ARGS = ["--disable-3d-apis"];
/**
 * Everything a browser says out loud while refusing WebGPU: Chromium's own two
 * lines as requestAdapter() and the canvas context come back empty, and three
 * announcing the fallback it then took. Expected only by the degrade arms, on
 * top of EXPECTED_CONSOLE below — on the eight backend arms a missing adapter is
 * a finding, and the backend assertion is what says so.
 */
const DENIED_GPU_CONSOLE = [
  /^No available adapters\.$/,
  /^Failed to create WebGPU Context Provider$/,
  /^THREE\.WebGPURenderer: WebGPU is not available, running under WebGL2 backend\.$/,
];
/** Below this the text view painted no level, whatever else is on screen. */
const MIN_TTY_GLYPHS = 20;
/** WCAG contrast of the notice against what is painted behind it. */
const MIN_CONTRAST = 4.5;

/**
 * What the NetHack HUD is currently blocking on, if anything. Character
 * creation is driven reactively rather than as a fixed key script: the exact
 * sequence depends on the rolled character and on which prompts the engine
 * raises.
 */
const HUD_STATE = () => {
  const shown = (id) => {
    const el = document.getElementById(id);
    return el && !el.hidden ? el : null;
  };
  const overlay = shown("overlay");
  // TextHud gives every pickable menu row a .macc accelerator and closes the
  // menu with a hint naming its kind; a plain text window has neither.
  const accels = overlay ? [...overlay.querySelectorAll(".macc")].map((e) => e.textContent) : [];
  return {
    linein: !!document.getElementById("linein"),
    prompt: shown("prompt")?.innerText ?? null,
    overlay: overlay?.innerText ?? null,
    menu: accels.length ? { accels, pickAny: /letters toggle/.test(overlay.innerText) } : null,
    hero: window.__nhView?.renderer?.map?.hero ?? null,
  };
};

/** The key a player would hit for whatever NetHack is showing. */
function replyTo(state) {
  if (state.linein) return "Enter";           // name -> default
  if (state.prompt !== null) return promptKey(state.prompt);
  if (state.menu) return menuKey(state);
  if (state.overlay !== null) return " ";     // text window: dismiss
  return null;
}

/**
 * The hero and the level as the text view actually paints them. A no-GPU page
 * has no renderer and no CellGrid, so the walk is read from DebugView's
 * <pre id="map"> — which is the product surface in that state. '@' is the
 * player's glyph in every role; anything else wearing one on the level fails
 * loudly below rather than being guessed at.
 */
const TTY_MAP = () => {
  const rows = (document.getElementById("map")?.textContent ?? "").split("\n");
  const at = [];
  let glyphs = 0;
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch !== " ") glyphs++;
    if (ch === "@") at.push({ x, y });
  }));
  return {
    hero: at.length === 1 ? at[0] : null,
    heroes: at.length,
    glyphs,
    status: document.getElementById("status")?.textContent?.trim() ?? "",
  };
};

/**
 * The two APIs as the page's own probe asks for them (src/ui/gpuSupport.ts):
 * an adapter that actually arrives, and a WebGL 2 context that can actually be
 * created. Reported by every arm and asserted by the degrade arms — "the page
 * chose WebGL" is only worth something if WebGPU was really denied to it, and
 * "the page fell back to text" only if WebGL was gone too.
 */
const GPU_PROBE = async () => {
  let webgpu = false, webgl2 = false;
  try { webgpu = navigator.gpu != null && await navigator.gpu.requestAdapter() != null; } catch { /* denied */ }
  try { webgl2 = document.createElement("canvas").getContext("webgl2") != null; } catch { /* denied */ }
  return { webgpu, webgl2 };
};

/**
 * What the no-GPU page shows the moment its view exists: which view chooseView()
 * built, whether the canvas is gone, and whether the notice is on screen rather
 * than merely in the DOM. "Readable" has to mean something a stubbed-out or
 * invisible notice would fail, so it is measured: the whole line inside the
 * message box's own scroll viewport and inside the window, painted, and at a
 * real size and contrast against the first ancestor that paints a background.
 */
const NOGPU_CHROME = ([view, notice]) => {
  const messages = document.getElementById("messages");
  const el = [...messages.children].find((d) => d.textContent.trim() === notice);
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (css) => {
    const [r, g, b] = css.match(/[\d.]+/g).map(Number);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const behind = (node) => {
    for (let n = node; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (!/,\s*0\)$/.test(bg)) return bg;
    }
    return "rgb(0, 0, 0)";
  };
  let shown = null;
  if (el) {
    const rect = el.getBoundingClientRect();
    const box = messages.getBoundingClientRect();
    const style = getComputedStyle(el);
    const ink = luminance(style.color), paper = luminance(behind(el));
    shown = {
      // Painted at a real size, somewhere a player is looking.
      onScreen: rect.width > 0 && rect.height > 0
        && rect.top >= 0 && rect.bottom <= innerHeight
        && rect.left >= 0 && rect.right <= innerWidth
        && style.display !== "none" && style.visibility === "visible"
        && Number(style.opacity) > 0,
      // The message box scrolls: a notice pushed out of its own viewport is
      // in the DOM and not on screen.
      clipped: rect.top < box.top - 1 || rect.bottom > box.bottom + 1,
      fontPx: parseFloat(style.fontSize),
      contrast: (Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05),
    };
  }
  return {
    view: window[view]?.constructor?.name ?? null,
    canvas: !!document.getElementById("view"),
    map: !!document.getElementById("map"),
    notice: shown,
  };
};

/**
 * Angband birth, read off the chrome the vector view paints: main-wasm.c marks
 * the term overlay active while `!character_generated`, so a visible #overlay
 * is exactly "still in birth" (plus stores and menus later). The tty's top
 * strip carries -more- once play starts.
 */
const ANGBAND_STATE = () => {
  const shown = (id) => {
    const el = document.getElementById(id);
    return el && !el.hidden ? el : null;
  };
  return {
    overlay: shown("overlay")?.innerText ?? null,
    prompt: shown("prompt")?.innerText ?? null,
    hero: window.__angbandView?.renderer?.map?.hero ?? null,
  };
};

/** The same birth answers BorgPlayer gives: '@' takes the quick-start path
 *  (random role, race and class), everything else before play wants Enter. */
function angbandReplyTo(state) {
  if (state.overlay !== null) {
    return /select your character traits|Human/.test(state.overlay) ? "@" : "Enter";
  }
  if (state.prompt !== null && /-more-/.test(state.prompt)) return "Enter";
  return null;
}

const LARN_STATE = () => {
  // Dev-only adapter: VectorView keeps its canonical Larn tty and input queue
  // private in TypeScript, but both are ordinary runtime fields. DOM overlay
  // visibility is intentionally not evidence here: flush ordering can paint
  // the welcome tty while the overlay transition coalesces away.
  const view = window.__larnView;
  const keys = view?.keys;
  return {
    tty: view?.tty?.toText() ?? "",
    frameBytes: view?.tty?.cells?.byteLength ?? null,
    waiting: !!keys?.waiter,
    queued: keys?.buffer?.length ?? 0,
    hero: view?.renderer?.map?.hero ?? null,
    overlay: document.getElementById("overlay")?.hidden === false
      ? document.getElementById("overlay")?.innerText ?? ""
      : null,
  };
};

const MORIA_STATE = () => {
  // Dev-only synchronization adapter, like Larn's above. Moria's retained tty
  // proves which source screen owns the live KeyQueue waiter; commandInput is
  // true only for a genuinely parked outer-command request.
  const view = window.__moriaView;
  const keys = view?.keys;
  return {
    tty: view?.tty?.toText() ?? "",
    frameBytes: view?.tty?.cells?.byteLength ?? null,
    waiting: !!keys?.waiter,
    queued: keys?.buffer?.length ?? 0,
    commandInput: !!view?.commandInput,
    hero: view?.renderer?.map?.hero ?? null,
    notices: [...(document.getElementById("messages")?.children ?? [])]
      .slice(-5).map((node) => node.textContent ?? "").join("\n"),
  };
};

/** Exact source-owned fresh-character handshake. Each answer is sent only
 * after its retained 80x24 screen and live blocking waiter agree; this never
 * speculatively fills KeyQueue while C is still painting the next prompt. */
const MORIA_BIRTH = [
  { screen: /Umoria 5\.7\.15/, key: "Enter" },
  { screen: /Choose a race \(\? for Help\):/, key: "a" },
  { screen: /Choose a sex \(\? for Help\):/, key: "m" },
  { screen: /Hit space to re-roll or ESC to accept characteristics:/, key: "Escape" },
  { screen: /Choose a class \(\? for Help\):/, key: "a" },
  { screen: /Name\s*:/, key: "Enter" },
  { screen: /press any key to continue, or Q to exit/i, key: " " },
];

async function settleMoria(page, _game, label, needHero = false) {
  const deadline = Date.now() + SETTLE_MS;
  let birthAt = needHero ? 0 : MORIA_BIRTH.length;
  for (;;) {
    const state = await page.evaluate(MORIA_STATE);
    if (/Moria engine died/i.test(state.notices))
      throw new Error(`${label}: ${state.notices.slice(-300)}`);
    if (state.frameBytes !== null && state.frameBytes !== 80 * 24)
      throw new Error(`${label}: Moria retained terminal has ${state.frameBytes} bytes`);
    if (state.queued)
      throw new Error(`${label}: Moria queued ${state.queued} speculative key(s)`);
    if (Date.now() > deadline)
      throw new Error(`${label}: Moria stuck at birth ${birthAt}: ${JSON.stringify(state).slice(0, 400)}`);

    if (birthAt < MORIA_BIRTH.length) {
      const step = MORIA_BIRTH[birthAt];
      if (!state.waiting || !step.screen.test(state.tty)) {
        await page.waitForTimeout(30);
        continue;
      }
      await send(page, step.key);
      birthAt++;
      continue;
    }

    if (state.waiting && !state.commandInput && state.tty.includes(" -more-")) {
      await send(page, " ");
      continue;
    }

    if (state.waiting && state.commandInput && state.hero) return state;
    await page.waitForTimeout(30);
  }
}

/** The same source-pinned handshake as scripts/test/larn-play.mjs, but driven
 * through the real browser view. Each send waits for KeyQueue's live waiter,
 * so no speculative i keys pile up while C is painting a direct object prompt.
 * The final no-input waiter is parse()->yylex(), not a hero-shaped guess. */
async function settleLarn(page, _game, label, needHero = false) {
  const deadline = Date.now() + SETTLE_MS;
  // The first acquire owns welcome->retcont(); every post-move acquire starts
  // at the following lookforobject()/parse boundary instead.
  let phase = needHero ? "welcome" : "inventory";
  let inventoryPaintedAt = 0;
  for (;;) {
    const state = await page.evaluate(LARN_STATE);
    if (state.queued) throw new Error(`${label}: Larn queued ${state.queued} handshake key(s)`);
    if (Date.now() > deadline)
      throw new Error(`${label}: Larn stuck at ${JSON.stringify(state).slice(0, 300)}`);
    if (!state.waiting) {
      await page.waitForTimeout(30);
      continue;
    }
    if (phase === "welcome") {
      if (!state.tty.includes("Welcome to the game of Larn")) {
        await page.waitForTimeout(30);
        continue;
      }
      await send(page, "Enter"); // help.c: retcont() accepts LF only
      phase = "inventory";
      continue;
    }
    if (phase === "inventory") {
      if (state.tty.includes("Elapsed time is")) {
        // A small inventory is painted with cl_up(), not clear(). It must
        // still reach the public full-term overlay: otherwise the retained
        // tty proves command readiness while the player sees only the 3D map.
        if (state.overlay === null || !state.overlay.includes("Elapsed time is")) {
          inventoryPaintedAt ||= Date.now();
          if (Date.now() - inventoryPaintedAt > 1500)
            throw new Error(`${label}: Larn inventory stayed hidden from #overlay`);
          await page.waitForTimeout(30);
          continue;
        }
        await send(page, " "); // main.c qshowstr()->more()
        phase = "command";
      } else {
        await send(page, "i"); // lookforobject() decline, or yylex inventory
      }
      continue;
    }
    if (state.tty.includes("Elapsed time is")) {
      await page.waitForTimeout(30);
      continue;
    }
    if (needHero && !state.hero) {
      await page.waitForTimeout(30);
      continue;
    }
    return state; // the post-pager parse()->yylex() request is parked
  }
}

/** yn_function renders as `query [choices]`. Take yes where it is on offer,
 *  otherwise something the engine will actually accept. */
function promptKey(prompt) {
  const choices = /\[([^\]]*)\]\s*$/.exec(prompt.trim())?.[1] ?? "";
  if (!choices || choices === "any" || choices.includes("y")) return "y";
  return choices[0];
}

/** Menus are the character-creation path (the tutorial offer is one, not a yn
 *  prompt). Anything but an accelerator the menu offers is ignored, and a run
 *  that answers with one of those spins to the deadline and reports "stuck". */
function menuKey(state) {
  const { accels, pickAny } = state.menu;
  if (pickAny) return "Enter";                                         // PICK_ANY: pick nothing
  if (/tutorial/i.test(state.overlay) && accels.includes("n")) return "n"; // just start play
  return accels[0];
}

/**
 * The Modules: where the view hangs off window, what URL boots it, how its
 * chrome asks for input, and what a player presses to walk. NetHack takes the
 * classic direction letters; Angband's arrows go through the camera-relative
 * gaze bindings, which is the path a player actually uses.
 */
const GAMES = {
  nethack: {
    view: "__nhView",
    query: "game=nethack",
    state: HUD_STATE,
    reply: replyTo,
    directions: ["l", "h", "j", "k", "y", "u", "b", "n"],
  },
  angband: {
    view: "__angbandView",
    query: "game=angband",
    state: ANGBAND_STATE,
    reply: angbandReplyTo,
    directions: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "Home", "PageUp", "End", "PageDown"],
  },
  larn: {
    view: "__larnView",
    query: "game=larn",
    sidebar: "#larn-sidebar",
    state: LARN_STATE,
    settle: settleLarn,
    settleEveryStep: true,
    // Larn does have the gaze bindings, but they only arm on a parked command
    // request and only remap arrows; a raw vi byte still walks in either
    // camera. That is the path this walk wants — it needs a key that moves the
    // hero whatever the camera is doing, not one more test of the remap.
    directions: ["l", "h", "j", "k", "y", "u", "b", "n"],
  },
  moria: {
    view: "__moriaView",
    query: "game=moria",
    sidebar: "#moria-sidebar",
    state: MORIA_STATE,
    settle: settleMoria,
    settleEveryStep: true,
    directions: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "Home", "PageUp", "End", "PageDown"],
  },
};

/**
 * The two arms that drive the degrade policy rather than a renderer
 * (src/ui/chooseView.ts, vect-hack-4d0). NetHack because it is the Module a
 * visitor lands on — a URL with no ?game redirects to it (src/main.ts) — so it
 * is the page a browser without WebGPU actually opens. The policy and both
 * views' chrome are shared, so a second Module here would buy nothing the
 * eight arms above do not already cover.
 */
const DEGRADE_ARMS = [
  {
    // No ?gl anywhere: gpuAvailable() is what has to land on WebGL, and three's
    // own fallback is what has to bring it up.
    label: "nethack-fallback",
    game: GAMES.nethack,
    args: NO_WEBGPU_ARGS,
    flag: "",
    expectBackend: "webgl",
    expectProbe: { webgpu: false, webgl2: true },
    expectedConsole: DENIED_GPU_CONSOLE,
  },
  {
    label: "nethack-nogpu",
    game: GAMES.nethack,
    args: NO_3D_ARGS,
    flag: "",
    expectBackend: "none",
    expectView: "DebugView",
    expectProbe: { webgpu: false, webgl2: false },
    expectedConsole: DENIED_GPU_CONSOLE,
    drive: driveTty,
  },
];

/** Named keys go through press(); a printable character goes through type(),
 *  which is the only way to get one whose browser key needs a modifier. */
async function send(page, key) {
  if ([...key].length === 1 && key !== " ") await page.keyboard.type(key);
  else await page.keyboard.press(key);
}

/**
 * Answer whatever the game's chrome is blocking on until it stops asking —
 * and, while booting, until the hero is standing on a level.
 */
async function settle(page, game, label, needHero = false, reply = game.reply) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const state = await page.evaluate(game.state);
    const key = reply(state);
    if (!key && (state.hero || !needHero)) return state;
    if (Date.now() > deadline)
      throw new Error(`${label}: stuck at ${JSON.stringify(state).slice(0, 300)}`);
    if (key) await send(page, key);
    await page.waitForTimeout(150);
  }
}

/**
 * settle(), for a view with no renderer. The chrome is the same TextHud, so the
 * same replies drive character creation; only the hero moves house. TTY_MAP's
 * `hero` deliberately overwrites HUD_STATE's, which reads a renderer no text
 * view has and would otherwise report null forever.
 */
async function settleTty(page, game, label, needHero = false) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const state = { ...await page.evaluate(HUD_STATE), ...await page.evaluate(TTY_MAP) };
    const key = game.reply(state);
    if (!key && (state.hero || !needHero)) return state;
    if (Date.now() > deadline)
      throw new Error(`${label}: stuck at ${JSON.stringify(state).slice(0, 300)}`);
    if (key) await send(page, key);
    await page.waitForTimeout(150);
  }
}

/**
 * Brightness histogram of a screenshot. Additive beam bloom lays a wide skirt
 * of dim pixels around every bright core pixel, so halo/core reads how much
 * light surrounds the strokes. It is a scene-size number, not a verdict — see
 * bloomGain() for what the assertion is actually made of.
 *
 * Read from the composited screenshot rather than the canvas: drawImage() off a
 * WebGPU canvas outside its frame comes back blank.
 */
function glowProfile(png) {
  const out = execFileSync("magick", [png, "-format", "%c", "histogram:info:-"], { maxBuffer: 1 << 30 });
  let halo = 0, mid = 0, core = 0;
  for (const line of out.toString().split("\n")) {
    const m = line.match(/^\s*(\d+):\s*\(\s*(\d+),\s*(\d+),\s*(\d+)/);
    if (!m) continue;
    const n = +m[1], v = Math.max(+m[2], +m[3], +m[4]);
    if (v < 6) continue;                       // black
    if (v < 70) halo += n; else if (v < 170) mid += n; else core += n;
  }
  return { lit: halo + mid + core, halo, mid, core, haloRatio: core ? halo / core : 0 };
}

/**
 * Console noise NetHack itself makes on a healthy run. winshim.c's
 * reentryMutexLock (win/shim/winshim.c:313) logs on every nested
 * local_callback, and autosave makes one on purpose: worker.ts reaches
 * checkpoint.maybe() from inside shim_nh_poskey, and save_currentstate() opens
 * with mark_synch(). The guard cannot tell that from the unwinding kind it is
 * there to catch, but answerInPlace() resolves in place, so nothing unwinds and
 * nothing crashes — see checkpoint.ts's answerInPlace(). test:nethack-autosave
 * covers the real failure.
 */
const SHIM_REENTRY =
  /'shim_\w+' attempting second call to 'local_callback' before 'shim_nh_poskey' has finished/;

/**
 * What a healthy run may say without failing an arm. The storage-grant warning
 * is shared with the borg gate rather than copied into it — its why, and the
 * reason only the DECLINED answer is listed, are in gate-console.mjs.
 */
const EXPECTED_CONSOLE = [SHIM_REENTRY, STORAGE_DECLINED_WARNING];

/**
 * One arm: the browser it launches (`args`), the URL flag it adds (`flag` — the
 * degrade arms add none on purpose), the backend it expects, and who drives it.
 */
async function run(game, label, arm) {
  const browser = await chromium.launch({ headless: true, args: arm.args ?? CHROMIUM_ARGS });
  // A thrown assertion must close its browser anyway, or the leaked Chromium
  // takes the other backend's run down with it — and which one broke is the
  // whole point of running both.
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    return await (arm.drive ?? drive)(page, game, label, arm);
  } finally {
    await browser.close();
  }
}

/** Console noise this arm's browser makes on top of EXPECTED_CONSOLE. */
function watchConsole(page, arm, errors) {
  const expected = [...EXPECTED_CONSOLE, ...arm.expectedConsole ?? []];
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    if (expected.some((re) => re.test(m.text()))) return;
    errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
}

async function drive(page, game, label, arm) {
  const { expectBackend } = arm;
  const errors = [];
  watchConsole(page, arm, errors);

  const query = [game.query, arm.flag].filter(Boolean).join("&");
  const url = URL_BASE + (query ? `?${query}` : "");
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Null until init() resolves, so this waits for the backend that actually
  // came up rather than the one the constructor set out to build.
  const backend = await page.waitForFunction(
    (view) => window[view]?.renderer?.backend ?? null, game.view, { timeout: BOOT_MS },
  ).then((h) => h.jsonValue());

  const settleGame = game.settle ?? settle;
  const reply = game.reply;
  await settleGame(page, game, label, true, reply);

  if (game.sidebar) {
    const sidebar = await page.locator(game.sidebar).evaluate((el) => ({
      hidden: el.hidden,
      position: getComputedStyle(el).position,
    }));
    if (sidebar.hidden || sidebar.position !== "absolute")
      throw new Error(`${label}: Module sidebar is not visible above the canvas (${JSON.stringify(sidebar)})`);
  }

  // Grid dimensions belong to each Module; count whatever the view actually
  // presents rather than pinning one game's rectangle here.
  const cells = await page.evaluate((view) => {
    const m = window[view].renderer.map;
    let n = 0;
    for (let y = 0; y < m.rows; y++)
      for (let x = 0; x < m.cols; x++) if (m.at(x, y).category !== "unseen") n++;
    return n;
  }, game.view);

  // Walk. Which way is open depends on where the hero spawned — a wall, a shut
  // door or a monster in the way all eat a key without moving anyone — so try
  // each direction in turn and stop at the first that lands.
  const hero = () => page.evaluate((view) => ({ ...window[view].renderer.map.hero }), game.view);
  const before = await hero();
  let at = before;
  for (const key of game.directions) {
    for (let step = 0; step < STEPS_PER_DIRECTION; step++) {
      await send(page, key);
      if (game.settleEveryStep) await settleGame(page, game, label, false, reply);
      else await page.waitForTimeout(TURN_MS);
    }
    if (!game.settleEveryStep) await settleGame(page, game, label, false, reply);
    at = await hero();
    if (at.x !== before.x || at.y !== before.y) break;
  }
  const moved = at.x !== before.x || at.y !== before.y;

  // The camera eases toward the hero, so give the follow a moment to land.
  await page.waitForTimeout(500);
  const drift = await page.evaluate((view) => window[view].renderer.cameraDrift, game.view);

  const fps = await page.evaluate(async ([view, ms]) => {
    const r = window[view].renderer;
    const t0 = performance.now(), f0 = r.frames;
    await new Promise((done) => setTimeout(done, ms));
    return (r.frames - f0) / ((performance.now() - t0) / 1000);
  }, [game.view, FPS_SAMPLE_MS]);

  // Look HUD (spec 2026-08-18): hover the hero and require both halves — the
  // renderer's ring on that cell, and a label with the engine's word for it.
  // Read through the public accessor, never a private: an assertion that
  // cannot fail is worse than no assertion (vect-hack-azf).
  const box = await page.locator("#view").boundingBox();
  const heroPoint = await page.evaluate((view) => {
    const r = window[view].renderer;
    return r.map.hero ? { ...r.map.hero } : null;
  }, game.view);
  let look = { ring: null, label: "" };
  if (heroPoint && box) {
    // The hero is what the camera is centred on, so the middle of the canvas
    // is over it in both cameras.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(600);
    look = await page.evaluate((view) => ({
      ring: window[view].renderer.highlightedCell,
      label: document.getElementById("looklabel")?.hidden === false
        ? document.getElementById("looklabel").textContent : "",
    }), game.view);
    if (!look.ring) throw new Error(`${label}: hovering the map lit no look ring`);
    if (!look.label) throw new Error(`${label}: hovering the map named nothing`);
    if (look.label === LOOK_HINT)
      throw new Error(`${label}: hovering the map left the hint up — no engine answer`);
    // Move the pointer to the corner, off the map: LookHud.point() clears the
    // ring and hides the label synchronously (LookHud.clear()) the instant
    // pickCell() comes back null, so the still below is not contaminated by
    // the ring's ink or the label's own glow in the halo-per-core measurement.
    // Inside the guard: `box` is only known non-null here.
    await page.mouse.move(box.x + 2, box.y + 2);
  }

  // The radar is 2D chrome inside #stage with a beam stack of its own, and the
  // bloom toggle below cannot reach it. Left in, it puts the same halo floor
  // into both shots and flattens the ratio the probe is trying to measure.
  // #looklabel goes with it and for the same reason: it lives inside #stage,
  // so a label still up lands in both shots as halo the beam stack never drew.
  await page.evaluate(() => {
    for (const id of ["radar", "looklabel"]) {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    }
  });

  // A frozen still, then the same still with the bloom stack off: the only
  // honest baseline for "does it glow", since how much geometry is on screen
  // depends on where the hero spawned. Nothing but the bloom moves between the
  // two — the frame loop is stopped for both.
  await page.evaluate((view) => window[view].renderer.renderStill(), game.view);
  const shot = `${OUT_DIR}/browser-${label}.png`;
  await page.locator("#stage").screenshot({ path: shot });

  await page.evaluate((view) => {
    const r = window[view].renderer;
    r.setBloomEnabled(false);
    r.renderStill();
  }, game.view);
  const flat = `${OUT_DIR}/browser-${label}-nobloom.png`;
  await page.locator("#stage").screenshot({ path: flat });

  // Asked last: a throwaway WebGL 2 context during the frame-rate sample would
  // be measuring something else.
  const probe = await page.evaluate(GPU_PROBE);

  return {
    label, url, backend, expectBackend, cells, fps, shot, errors, moved, drift, look,
    probe, expectProbe: arm.expectProbe,
    directions: game.directions,
    glow: glowProfile(shot), flat: glowProfile(flat),
  };
}

/**
 * The no-GPU arm. No renderer to wait on and no CellGrid to count, so this
 * drives the same Module through its text view instead: the chrome chooseView()
 * left behind, then the same reactive character creation and the same walk,
 * read off the painted map. What it is asserting is that the text view is a way
 * to play and not an error screen.
 */
async function driveTty(page, game, label, arm) {
  const errors = [];
  watchConsole(page, arm, errors);

  const url = URL_BASE + `?${game.query}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Nothing here resolves a backend, so the view object itself is the boot
  // signal — and chooseView() has already dropped the canvas and shown the
  // notice by the time it exists.
  await page.waitForFunction((view) => window[view] != null, game.view, { timeout: BOOT_MS });
  const chrome = await page.evaluate(NOGPU_CHROME, [game.view, GPU_UNAVAILABLE_NOTICE]);

  const booted = await settleTty(page, game, label, true);

  // Walk, the same way the vector arms do: which way is open depends on where
  // the hero spawned, so try each direction until one lands.
  const before = booted.hero;
  let at = before, state = booted;
  for (const key of game.directions) {
    for (let step = 0; step < STEPS_PER_DIRECTION; step++) {
      await send(page, key);
      await page.waitForTimeout(TURN_MS);
    }
    state = await settleTty(page, game, label);
    at = state.hero ?? at;
    if (at.x !== before.x || at.y !== before.y) break;
  }

  const shot = `${OUT_DIR}/browser-${label}.png`;
  await page.locator("#stage").screenshot({ path: shot });
  const probe = await page.evaluate(GPU_PROBE);

  return {
    label, url, shot, errors,
    expectBackend: arm.expectBackend,
    expectView: arm.expectView,
    probe, expectProbe: arm.expectProbe,
    directions: game.directions,
    tty: {
      ...chrome,
      glyphs: state.glyphs,
      status: state.status,
      from: before,
      to: at,
      moved: at.x !== before.x || at.y !== before.y,
    },
  };
}

await fetch(URL_BASE).catch(() => {
  console.error(`FAIL: no dev server at ${URL_BASE} — run: npm run dev -- --port 5199`);
  process.exit(1);
});

await mkdir(OUT_DIR, { recursive: true });
const results = [];
for (const [name, game] of Object.entries(GAMES)) {
  for (const backend of ["webgpu", "webgl"]) {
    const label = `${name}-${backend}`;
    // ?gl pins WebGL; the WebGPU arm carries no flag and runs on a real adapter.
    const arm = { expectBackend: backend, flag: backend === "webgl" ? "gl" : "" };
    try {
      results.push(await run(game, label, arm));
    } catch (e) {
      results.push({ label, expectBackend: backend, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
for (const arm of DEGRADE_ARMS) {
  try {
    results.push(await run(arm.game, arm.label, arm));
  } catch (e) {
    results.push({ label: arm.label, expectBackend: arm.expectBackend, error: e instanceof Error ? e.message : String(e) });
  }
}

let failed = false;
for (const r of results) {
  if (r.error) {
    failed = true;
    console.log(`\n[${r.label}] did not finish\n  FAIL: ${r.error}`);
    continue;
  }
  if (r.tty) { if (reportTty(r)) failed = true; continue; }
  const g = r.glow, f = r.flat;
  // Both shots have to be real pictures for the comparison to mean anything: a
  // blank baseline has no core to normalise by.
  const haveBaseline = f.lit >= MIN_LIT_PIXELS && f.core > 0;
  const gain = haveBaseline ? bloomGain(g, f) : null;
  const problems = [];
  if (r.backend !== r.expectBackend) problems.push(`backend is ${r.backend}, expected ${r.expectBackend}`);
  if (r.cells < 5) problems.push(`only ${r.cells} map cells reached the renderer`);
  if (g.lit < MIN_LIT_PIXELS) problems.push(`canvas is nearly blank (${g.lit} lit pixels)`);
  if (!haveBaseline) problems.push(`no bare-core baseline to measure against (${f.lit} lit, ${f.core} core)`);
  else if (gain < MIN_BLOOM_GAIN) problems.push(`bloom adds little over the bare core (${showGain(gain)})`);
  if (r.fps < 55) problems.push(`${r.fps.toFixed(1)} fps`);
  if (!r.moved) problems.push(`the hero never moved (tried ${r.directions.join(" ")})`);
  if (r.drift > 1) problems.push(`camera did not settle on the hero (drift ${r.drift.toFixed(2)})`);
  if (r.errors.length) problems.push(`console: ${r.errors.slice(0, 5).join(" | ")}`);
  // Belt and braces: the throws in drive() only fire when the look block
  // actually ran (heroPoint and box both truthy). If either came back null
  // instead, the block is skipped entirely, look stays {ring:null,label:""},
  // and no throw ever fires — a hole this check closes so a skipped probe is
  // reported as a problem rather than passing quietly.
  if (!r.look.ring || !r.look.label || r.look.label === LOOK_HINT)
    problems.push(`look: no ring, or no engine answer, after hovering the hero (${JSON.stringify(r.look)})`);
  problems.push(...probeProblems(r));

  console.log(`\n[${r.label}] backend=${r.backend} cells=${r.cells} fps=${r.fps.toFixed(1)} camera-drift=${r.drift.toFixed(2)} look=${JSON.stringify(r.look)}`);
  // Which URL this arm actually opened, and what its browser handed the page:
  // the fallback arm's whole claim is that it chose WebGL with no flag in the
  // URL and no adapter on offer.
  console.log(`  url ${r.url}`);
  console.log(`  probe ${showProbe(r.probe)}`);
  console.log(`  bloom on  lit=${g.lit} core=${g.core} halo=${g.halo} halo/core=${g.haloRatio.toFixed(2)}`);
  console.log(`  bloom off lit=${f.lit} core=${f.core} halo=${f.halo} halo/core=${f.haloRatio.toFixed(2)}`);
  console.log(`  bloom-added halo per core pixel ${showGain(gain)}`);
  console.log(`  screenshot ${r.shot}`);
  if (problems.length) { failed = true; problems.forEach((p) => console.log(`  FAIL: ${p}`)); }
  else console.log("  OK");
}

/**
 * The no-GPU arm's report: the same shape as the block above, over what a text
 * view has instead of a canvas. Returns true if anything failed.
 */
function reportTty(r) {
  const t = r.tty, n = t.notice;
  const problems = [];
  if (t.view !== r.expectView) problems.push(`the page built ${t.view}, not ${r.expectView}`);
  if (t.canvas) problems.push("the canvas is still in the page");
  if (!t.map) problems.push("no text map was built");
  if (!n) problems.push("the GPU notice is not in the message window at all");
  else {
    if (!n.onScreen) problems.push("the GPU notice is in the DOM but not on screen");
    if (n.clipped) problems.push("the GPU notice is cut off by the message window");
    if (n.fontPx < 10) problems.push(`the GPU notice is ${n.fontPx}px`);
    if (n.contrast < MIN_CONTRAST) problems.push(`the GPU notice contrast is ${n.contrast.toFixed(1)}:1`);
  }
  problems.push(...probeProblems(r));
  if (t.glyphs < MIN_TTY_GLYPHS) problems.push(`the text map is nearly empty (${t.glyphs} glyphs)`);
  if (!t.status) problems.push("the status line is empty — no character is in play");
  if (!t.moved) problems.push(`the hero never moved (tried ${r.directions.join(" ")})`);
  if (r.errors.length) problems.push(`console: ${r.errors.slice(0, 5).join(" | ")}`);

  console.log(`\n[${r.label}] view=${t.view} canvas=${t.canvas ? "still there" : "removed"} glyphs=${t.glyphs}`);
  console.log(`  url ${r.url}`);
  console.log(`  probe ${showProbe(r.probe)}`);
  console.log(`  notice ${n ? `on-screen=${n.onScreen} clipped=${n.clipped} ${n.fontPx}px contrast=${n.contrast.toFixed(1)}:1` : "missing"}`);
  console.log(`  hero ${JSON.stringify(t.from)} -> ${JSON.stringify(t.to)}${t.moved ? "" : " (never moved)"}`);
  console.log(`  status ${t.status || "(empty)"}`);
  console.log(`  screenshot ${r.shot}`);
  if (problems.length) { problems.forEach((p) => console.log(`  FAIL: ${p}`)); return true; }
  console.log("  OK");
  return false;
}

/**
 * How much halo the bloom stack itself put on the screen, per bare-core pixel:
 * ((halo with bloom) - (halo without)) / (core without).
 *
 * The two shots are the same frozen frame, so everything but the bloom stack
 * cancels in the subtraction. That matters because a scene can be full of dim
 * strokes that were never bloom: Angband's town fills the frame with distant
 * floor grid, whose faint lines land in the halo bucket on their own and drag
 * a plain halo/core ratio up to ~6 with the stack off. Comparing the two
 * ratios then reads "bloom added nothing" on a scene that plainly glows.
 * Measured here, the Modules and both backends land well above the gate; with
 * the stack disabled the numerator collapses to roughly zero.
 */
function bloomGain(glow, flat) {
  return (glow.halo - flat.halo) / flat.core;
}

/**
 * Whether the browser really denied what this arm says it denied. An arm that
 * only asserts what the page then did would pass just as well on a browser that
 * denied nothing — and it is the denial that makes the rest evidence.
 */
function probeProblems(r) {
  return Object.entries(r.expectProbe ?? {})
    .filter(([api, want]) => r.probe[api] !== want)
    .map(([api, want]) => `the browser was launched to ${want ? "offer" : "deny"} ${api}, and the page saw ${r.probe[api]}`);
}

function showProbe(probe) {
  return `webgpu-adapter=${probe.webgpu} webgl2=${probe.webgl2}`;
}

function showGain(gain) {
  return gain === null ? "no baseline" : `${gain.toFixed(2)}`;
}

await writeFile(`${OUT_DIR}/browser-check.json`, JSON.stringify(results.map(
  ({ glow, ...r }) => ({ ...r, glow }),
), null, 2));
process.exit(failed ? 1 : 0);

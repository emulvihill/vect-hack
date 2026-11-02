// The first-person control scheme, driven end to end in a real browser: boots a
// character the way browser-check.mjs does, then asserts what only a live game
// can show — that forward walks where the camera is actually looking, that a
// turn costs no game time, and that a prompt never sees a remapped arrow. It
// also proves the orbital rotated scheme: the dragged camera bearing steers
// the direction keys, and Clear (keypad 5) eases the bearing back to north-up.
//
// Then the same scheme against Angband, whose composition has more to go wrong:
// the gaze arithmetic is shared but the key encoding is not (Angband takes a
// keypad digit with its own modifier bits), and its map arrives as semantic
// records rather than glyphs. That run also fires a real projection through
// wizard mode, because effect Cells are the one thing on the map with no
// engine-owned lifetime of their own — nothing else proves the engine's own
// follow-up repaint is what clears them.
//
// Moria adds another composition-specific encoding: original-mode run is two
// source reads ('.' at the outer command, then a literal direction). Its gate
// records both consumed bytes and their native contexts before asserting the
// same two camera schemes.
//
// The unit tests (scripts/test/move-keys.test.ts, remap.test.ts) pin the same
// rules in isolation. What they cannot reach is the composition: the sign of
// the yaw convention surviving all the way from FirstPersonCam's rotation order
// to the cell NetHack actually moved the hero into. That is one place a sign
// error hides from every isolated test, so it is checked against the engine.
//
// Two assertions are deliberately indirect:
//  - "turning is free" counts windowport events rather than reading a turn
//    counter, because NetHack's `time` option is off by default and there is no
//    T: on the status line to watch. Watching it would be an assertion that
//    cannot fail (docs/DECISIONS.md, vect-hack-azf).
//  - the prompt check asserts only that the camera did not turn. What an
//    invalid key does to a getobj prompt is NetHack's business, not this port's.
//
// Every arm waits for a readiness CONDITION before an observed press, never for
// a fixed interval. Camera actions are armed only while a command request is
// pending, so a direction key pressed while the previous turn is still
// resolving is delivered as the raw arrow it was — correct behaviour, and a
// race this gate must not run into when it is asking what a remapped arrow
// becomes. Each Module spells that condition in its own terms: NetHack polls
// for a parked command read (nethackReady), Angband for event quiescence
// (angbandQuiet), Moria for its exact parked native request (moriaPending),
// Larn for the __wrap_yylex discriminator (larnParked). The NetHack arm slept
// 200 ms instead of asking until vect-hack-hfa, and went red about one run in
// eight: a mode message the engine had already overwritten, and an ArrowLeft
// spent on what was still in the way rather than on turning.
//
// Needs a dev server (npm run dev -- --port 5199) and a GPU, like
// browser-check.mjs, so it is not part of npm test.
import { chromium } from "playwright";
import { GRID_STRIDE } from "../../src/modules/angband/mapRecords.ts";
import { nethackArmed } from "./fp-gate-utils.mjs";
import { exactNewKeys } from "./moria-gate-utils.mjs";

const URL_BASE = process.env.NH_URL ?? "http://localhost:5199/";
const SETTLE_MS = 60000;
const TURN_MS = 200;
/** How often a readiness poll asks again. Moria's arm has always used this. */
const POLL_MS = 30;
/** How long a reply to a boot prompt, menu or overlay is given to land. */
const ANSWER_MS = 150;
const CHROMIUM_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"];
const STEP = Math.PI / 4;

/** Clockwise from north, matching src/modules/nethack/ui/keys.ts DIRECTIONS. */
const DELTA = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const NAME = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (yaw) => Math.round(-yaw / STEP) & 7;

const HUD_STATE = () => {
  const shown = (id) => {
    const el = document.getElementById(id);
    return el && !el.hidden ? el : null;
  };
  const overlay = shown("overlay");
  const accels = overlay ? [...overlay.querySelectorAll(".macc")].map((e) => e.textContent) : [];
  // What the engine is doing, which no part of the DOM shows. TextHud's `hud`
  // field and its KeyQueue are private in TypeScript and exact at runtime —
  // the same dev-only reach the Moria and Larn arms already make into their
  // own views, and the only place this state exists: NetHack's HUD is fed from
  // a document keydown listener rather than through a `nextKey` seam, so there
  // is no call to wrap from outside the way those two arms wrap theirs.
  const hud = window.__nhView?.hud ?? null;
  return {
    linein: !!document.getElementById("linein"),
    prompt: shown("prompt")?.innerText ?? null,
    overlay: overlay?.innerText ?? null,
    menu: accels.length ? { accels, pickAny: /letters toggle/.test(overlay.innerText) } : null,
    hero: window.__nhView?.renderer?.map?.hero ?? null,
    /** A waiter is parked: the engine is blocked in nhgetch and, until it is
     *  answered, can produce nothing more of its own. */
    parked: !!hud?.keys?.waiter,
    /** Keys buffered ahead of the read — none of which this gate meant to
     *  send. Moria's arm refuses on the same count for the same reason. */
    queued: hud?.keys?.buffer?.length ?? 0,
    /** "none" is the one state TextHud consults `remap` in, so it is the one
     *  state the gaze bindings are armed in. Every other value is a question,
     *  where an arrow is a plain 'h' and not a turn. */
    pendingInput: hud?.pendingInput ?? null,
  };
};

const GAME_STATE = () => ({
  mode: window.__nhView?.renderer?.mode ?? null,
  heading: window.__nhView?.renderer?.heading ?? null,
  hero: window.__nhView?.renderer?.map?.hero ?? null,
  msg: [...document.getElementById("messages").children].slice(-1).map((d) => d.textContent)[0] ?? "",
});

function promptKey(prompt) {
  const choices = /\[([^\]]*)\]\s*$/.exec(prompt.trim())?.[1] ?? "";
  if (!choices || choices === "any" || choices.includes("y")) return "y";
  return choices[0];
}

function replyTo(state) {
  if (state.linein) return "Enter";
  if (state.menu) {
    const { accels, pickAny } = state.menu;
    if (pickAny) return "Enter";
    if (/tutorial/i.test(state.overlay) && accels.includes("n")) return "n";
    return accels[0];
  }
  if (state.prompt !== null) return promptKey(state.prompt);
  if (state.overlay !== null) return " ";
  return null;
}

/**
 * Wait until NetHack is parked on a command read, answering whatever the engine
 * put in the way on the journey there. `nethackArmed` (fp-gate-utils.mjs) is
 * the condition and says why each half of it is needed.
 *
 * This is the Angband arm's `angbandQuiet` and the Moria arm's `moriaPending`
 * in NetHack's own terms — a parked-REQUEST poll rather than a quiescence one,
 * because NetHack does park a request, and quiescence alone cannot tell a
 * command read from a prompt. The arm slept 200 ms instead of asking until
 * vect-hack-hfa; this function is that bug's whole fix.
 */
async function nethackReady(page, label, needHero = false) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const state = await page.evaluate(HUD_STATE);
    // Asked before replyTo, not after: an overlay still on screen at a command
    // read is text the engine has finished with, and answering it would spend
    // a game turn on a keystroke nothing was waiting for.
    if (nethackArmed(state, needHero)) return state;
    if (Date.now() > deadline)
      throw new Error(`${label}: never reached a command read — ${JSON.stringify(state).slice(0, 300)}`);
    const key = replyTo(state);
    if (key) {
      await page.keyboard.press(key);
      // The engine answers on its own schedule and the DOM is not repainted in
      // the same tick, so the reply is given the interval settle() always gave
      // it. Polling an answer faster presses a second accelerator into a menu
      // that has not closed yet; polling readiness faster costs nothing.
      await page.waitForTimeout(ANSWER_MS);
    } else {
      await page.waitForTimeout(POLL_MS);
    }
  }
}

/**
 * Wait for one specific `pendingInput` shape. The prompt arm drives the engine
 * INTO a question deliberately, so it cannot use nethackReady(), whose whole
 * job is to answer questions and get past them.
 *
 * `parked` is not required here: `lineInput` is a DOM <input> rather than a
 * key-queue read, so a getlin() is a wait with no waiter, and the flag itself
 * is set the moment the engine asks — which is the readiness being waited for.
 */
async function nethackPending(page, want, label) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const state = await page.evaluate(HUD_STATE);
    if (state.pendingInput === want) return state;
    if (Date.now() > deadline)
      throw new Error(`${label}: HUD never reached a ${want} read — ${JSON.stringify(state).slice(0, 300)}`);
    await page.waitForTimeout(POLL_MS);
  }
}

const fail = [];
const check = (ok, msg) => { console.log(`  ${ok ? "OK  " : "FAIL"} ${msg}`); if (!ok) fail.push(msg); };

// The same guard browser-check.mjs and angband-borg-check.mjs have, and this
// gate went without it for a long time: with no server, the four boot waits
// below each time out after 30 seconds against a page that never loaded, and
// two minutes of silence then reports a broken control scheme. A missing
// server must not look like a broken gate (vect-hack-zt7).
await fetch(URL_BASE).catch(() => {
  console.error(`FAIL: no dev server at ${URL_BASE} — run: npm run dev -- --port 5199`);
  process.exit(1);
});

async function nethackSection(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${URL_BASE}?game=nethack`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__vhBooted, null, { timeout: 30000 });
  await nethackReady(page, "boot", true);
  console.log("booted, hero on the level\n");

  // --- entering first person ---
  // There is no wait between a press and the read that follows it anywhere in
  // this arm, and none is wanted. F2 is a document keydown handler that swaps
  // the camera and posts its message in place (VectorView.onF2), a turn is
  // resolved inside TextHud.onKey, and `heading` is the committed target
  // rather than the eased angle (DungeonCamera.heading) — so everything this
  // arm observes has already happened by the time keyboard.press() resolves.
  // What had to be waited for was the engine going quiet BEFORE the press, and
  // that is what nethackReady() is. A sleep afterwards was never the check; it
  // was only ever a guess at how long the engine still had left to talk.
  await page.keyboard.press("F2");
  let s = await page.evaluate(GAME_STATE);
  check(s.mode === "first", `F2 enters first person (mode=${s.mode})`);
  check(/[Aa]rrows walk where you look/.test(s.msg), `the mode message names the controls`);

  // --- turning is free ---
  // NetHack's `time` option is off by default, so there is no T: to watch. Count
  // windowport traffic instead: a turn that costs game time makes the engine
  // redraw, a free one produces no events at all. Patching __nhView.handle is the
  // sanctioned way to see what the engine actually sends (AGENTS.md).
  await page.evaluate(() => {
    const v = window.__nhView;
    window.__evs = 0;
    const inner = v.handle.bind(v);
    v.handle = (ev) => { window.__evs++; return inner(ev); };
  });
  const evs = () => page.evaluate(() => window.__evs);
  const before = await page.evaluate(GAME_STATE);
  const evsBefore = await evs();
  await page.keyboard.press("ArrowLeft");
  let after = await page.evaluate(GAME_STATE);
  check(Math.abs(after.heading - before.heading - STEP) < 1e-9,
    `ArrowLeft turns +45 deg (${before.heading.toFixed(4)} -> ${after.heading.toFixed(4)})`);
  const evsAfterTurn = await evs();
  check(evsAfterTurn === evsBefore,
    `turning sends the engine nothing, so no game time passes (${evsBefore} -> ${evsAfterTurn} events)`);
  check(after.hero.x === before.hero.x && after.hero.y === before.hero.y, `turning does not move the hero`);

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  after = await page.evaluate(GAME_STATE);
  check(Math.abs(after.heading - before.heading + STEP) < 1e-9,
    `ArrowRight turns -45 deg (net ${(after.heading - before.heading).toFixed(4)})`);

  // --- forward walks where the camera looks ---
  // Which way is open depends on where the hero spawned, so turn through all
  // eight headings and assert on the first press that actually moves.
  let walked = null;
  for (let i = 0; i < 8 && !walked; i++) {
    await nethackReady(page, "walk");
    const pre = await page.evaluate(GAME_STATE);
    await page.keyboard.press("ArrowUp");
    await nethackReady(page, "walk");
    const post = await page.evaluate(GAME_STATE);
    const dx = post.hero.x - pre.hero.x, dy = post.hero.y - pre.hero.y;
    if (dx || dy) {
      const idx = compass(pre.heading);
      const [ex, ey] = DELTA[idx];
      walked = { dx, dy, ex, ey, idx, yaw: pre.heading };
      check(dx === ex && dy === ey,
        `ArrowUp at heading ${pre.heading.toFixed(3)} (${NAME[idx]}) moved (${dx},${dy}), expected (${ex},${ey})`);
    } else {
      await page.keyboard.press("ArrowRight");
    }
  }
  check(!!walked, "the hero walked at least once in first person");
  check((await evs()) > evsBefore, `walking does reach the engine (${await evs()} events total)`);

  // --- back to orbital: arrows are absolute again ---
  await nethackReady(page, "orbital");
  await page.keyboard.press("F2");
  s = await page.evaluate(GAME_STATE);
  check(s.mode === "orbital", `F2 returns to orbital (mode=${s.mode})`);
  {
    const pre = await page.evaluate(GAME_STATE);
    await page.keyboard.press("ArrowLeft");
    await nethackReady(page, "orbital walk");
    const post = await page.evaluate(GAME_STATE);
    const dx = post.hero.x - pre.hero.x, dy = post.hero.y - pre.hero.y;
    const idx = (compass(pre.heading) + 6) & 7; // screen-left of the carried bearing
    const [ex, ey] = DELTA[idx];
    check(post.heading === pre.heading, `orbital ArrowLeft does not turn the camera`);
    check((dx === ex && dy === ey) || (dx === 0 && dy === 0),
      `orbital ArrowLeft walks screen-left (${NAME[idx]}) or is blocked, moved (${dx},${dy})`);
  }

  // --- orbital: direction keys follow the dragged camera, Clear resets ---
  // The camera is rotated the way a player does it — dragging the canvas —
  // never by writing renderer internals. OrbitCam turns 0.006 rad per pixel.
  {
    const pre = await page.evaluate(GAME_STATE);
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(640 + 524, 400, { steps: 8 }); // ~pi of azimuth
    await page.mouse.up();
    const turned = await page.evaluate(GAME_STATE);
    check(Math.abs(turned.heading - pre.heading) > Math.PI / 2,
      `dragging swings the orbital bearing (${pre.heading.toFixed(3)} -> ${turned.heading.toFixed(3)})`);

    // Which way is open depends on the room, so drag another eighth and retry
    // until a press lands — same loop shape as the first-person walk above.
    let rotatedWalk = null;
    for (let i = 0; i < 8 && !rotatedWalk; i++) {
      await nethackReady(page, "orbital rotated walk");
      const p = await page.evaluate(GAME_STATE);
      await page.keyboard.press("ArrowUp");
      await nethackReady(page, "orbital rotated walk");
      const q = await page.evaluate(GAME_STATE);
      const dx = q.hero.x - p.hero.x, dy = q.hero.y - p.hero.y;
      if (dx || dy) {
        const idx = compass(p.heading);
        const [ex, ey] = DELTA[idx];
        rotatedWalk = true;
        check(dx === ex && dy === ey,
          `orbital ArrowUp at heading ${p.heading.toFixed(3)} (${NAME[idx]}) moved (${dx},${dy}), expected (${ex},${ey})`);
      } else {
        await page.mouse.move(640, 400);
        await page.mouse.down();
        await page.mouse.move(640 - 131, 400, { steps: 4 }); // one more eighth
        await page.mouse.up();
      }
    }
    check(!!rotatedWalk, "the hero walked at least once in rotated orbital");

    // Numpad5 arrives as key "Clear" with NumLock off — Playwright's default.
    await nethackReady(page, "clear");
    await page.keyboard.press("Numpad5");
    const reset = await page.evaluate(GAME_STATE);
    const mod = ((reset.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    check(Math.min(mod, 2 * Math.PI - mod) < 1e-6,
      `Clear (keypad 5) resets the bearing to north-up (heading=${reset.heading.toFixed(4)})`);
  }

  // --- a prompt must not see remapped arrows ---
  await nethackReady(page, "prompt check");
  await page.keyboard.press("F2");            // back to first person
  await page.keyboard.press("#");             // extended command
  await nethackPending(page, "line", "extended command");
  await page.keyboard.type("quit");
  await page.keyboard.press("Enter");         // -> "Really quit? [yn]"
  {
    // nethackPending throws with the state it was left in if the prompt never
    // arrives, which is the old `check(false, "expected a quit prompt")` said
    // by the wait itself — and, unlike that check, it cannot go on to press
    // keys at whatever came up instead.
    const st = await nethackPending(page, "yesno", "quit prompt");
    const t0 = (await page.evaluate(GAME_STATE)).heading;
    await page.keyboard.press("ArrowLeft");   // would be a free turn on the command path
    const t1 = (await page.evaluate(GAME_STATE)).heading;
    check(t1 === t0, `an arrow during "${(st.prompt ?? "").trim()}" does not turn the camera`);
    await page.keyboard.press("n");
  }
}

// ---------------------------------------------------------------------------
// Angband
// ---------------------------------------------------------------------------

/** Angband's native keypad digits, clockwise from north — the encoding
 *  src/modules/angband/keys.ts movementKey() produces. */
const ANGBAND_DIGITS = ["8", "9", "6", "3", "2", "1", "4", "7"];
const KC_MOD_SHIFT = 0x02, KC_MOD_KEYPAD = 0x10;
const ANGBAND_STATE = () => {
  const shown = (id) => {
    const el = document.getElementById(id);
    return el && !el.hidden ? el : null;
  };
  const overlay = shown("overlay");
  const prompt = shown("prompt")?.innerText ?? "";
  const r = window.__angbandView?.renderer ?? null;
  return {
    overlay: overlay?.innerText ?? null,
    prompt,
    // Whatever the player can currently read, wherever the view put it.
    text: `${overlay?.innerText ?? ""}\n${prompt}`,
    mode: r?.mode ?? null,
    heading: r?.heading ?? null,
    hero: r?.map?.hero ?? null,
    counters: window.__ang ?? null,
  };
};

/** Birth, answered the way BorgPlayer answers it: '@' is quick-start (random
 *  role, race and class), everything else before play wants Enter. */
async function angbandBirth(page) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const s = await page.evaluate(ANGBAND_STATE);
    if (s.overlay === null && s.hero) return s;
    if (Date.now() > deadline)
      throw new Error(`angband birth: stuck at ${JSON.stringify(s).slice(0, 300)}`);
    if (s.overlay !== null) {
      if (/select your character traits|Human/.test(s.overlay)) await page.keyboard.type("@");
      else await page.keyboard.press("Enter");
    }
    await page.waitForTimeout(150);
  }
}

/**
 * Wait for `want` to show up in the visible text, clearing only what the engine
 * put in the way: -more- takes Enter, and the debug-command warning takes its
 * y. Nothing else is answered — a wrong turn stalls here rather than typing
 * letters at a command prompt, where "SPHERE" is six unrelated commands.
 */
const IN_THE_WAY = [[/-more-/, "Enter"], [/use the debug commands/, "y"]];
async function angbandUntil(page, want, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const s = await page.evaluate(ANGBAND_STATE);
    if (want.test(s.text)) return s;
    const rule = IN_THE_WAY.find(([re]) => re.test(s.text));
    if (rule) {
      if (rule[1] === "Enter") await page.keyboard.press("Enter");
      else await page.keyboard.type(rule[1]);
    }
    await page.waitForTimeout(TURN_MS);
  }
  // Loudly, and without going on: the next thing a caller does is type an
  // answer, and an answer typed at a command prompt is a handful of unrelated
  // commands ("SPHERE" eats a ration and locates a map sector). A slow machine
  // must fail this run, not play a different game.
  const s = await page.evaluate(ANGBAND_STATE);
  throw new Error(`angband never showed ${want}; prompt was ${JSON.stringify(s.prompt)}`
    + (s.overlay ? `, overlay ${JSON.stringify(s.overlay.slice(0, 120))}` : ""));
}

/** Type one answer into a get_string/get_quantity prompt and wait for the next. */
async function angbandAnswer(page, text, next) {
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(TURN_MS);
  return angbandUntil(page, next);
}

/**
 * Wait until the engine has stopped producing events, which is the point it has
 * re-parked its command request. The gaze bindings are armed only while a
 * command request is pending (VectorView.commandInput, vect-hack 0575af0), so a
 * direction key pressed while the previous turn is still resolving is delivered
 * as the raw arrow it was — correct behaviour, and a race this check must not
 * run into when it is asking what a remapped arrow becomes.
 */
async function angbandQuiet(page, tries = 20) {
  let last = -1;
  for (let i = 0; i < tries; i++) {
    const now = await page.evaluate(() => window.__ang.evs);
    if (now === last) return;
    last = now;
    await page.waitForTimeout(TURN_MS / 2);
  }
}

/** The key the engine consumed after `before`, once it has consumed one.
 *  Polled rather than timed: the engine answers on its own schedule, and a
 *  fixed wait would make this a flake rather than a check. */
async function angbandKeyAfter(page, before, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const now = await page.evaluate(() => JSON.parse(JSON.stringify(window.__ang)));
    if (now.keys.length > before.keys.length) return now.keys[before.keys.length];
    await page.waitForTimeout(TURN_MS / 2);
  }
  return null;
}

/**
 * Dismiss any message pause standing in the way, before typing a command.
 *
 * A -more- answers nothing with the key that dismisses it, so a command typed
 * into one is a command the engine never runs — and the arm that follows then
 * waits for a prompt that will never come. angbandUntil() clears a -more- too,
 * but only after the caller has already spent a keystroke on it; this is for
 * the keystroke that must not be spent. Detection in particular prints four
 * paused messages in a row.
 */
async function angbandDrainMore(page, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const s = await page.evaluate(ANGBAND_STATE);
    if (!/-more-/.test(s.text)) return;
    await page.keyboard.press("Enter");
    await page.waitForTimeout(TURN_MS);
  }
}

/**
 * Watch the frame loop for a blast, over the view's own onFrame.
 *
 * Two measurements, because they are two different questions. `frames` counts
 * frames whose GRID held an effect Cell; `ghost` counts frames that DREW one
 * the grid did not hold, which only the effect-event residue can put on screen
 * (src/render/effects/mapFx.ts). At Angband's default delay_factor the first is
 * the interesting number; at 0 it is zero by construction and the second is.
 *
 * Re-wraps the ORIGINAL onFrame every time, so a second run does not count each
 * frame twice through a stack of wrappers.
 */
async function angbandWatchEffects(page) {
  await page.evaluate(() => {
    const r = window.__angbandView.renderer;
    const c = window.__ang;
    if (!c.baseOnFrame) c.baseOnFrame = r.onFrame;
    c.frames = 0; c.ghost = 0; c.fxPeak = 0; c.drawnPeak = 0;
    const base = c.baseOnFrame;
    r.onFrame = (heading) => {
      let n = 0;
      for (const cell of r.map.cells) if (cell.category === "effect") n++;
      const drawn = r.drawnEffects;
      c.fxPeak = Math.max(c.fxPeak, n);
      c.drawnPeak = Math.max(c.drawnPeak, drawn);
      if (n) c.frames++;
      else if (drawn) c.ghost++;
      return base?.(heading);
    };
  });
}

/**
 * Fire one SPHERE from the debug command prompt and report what the watcher
 * saw. SPHERE is centred on the player (effect-handler-attack.c
 * effect_handler_SPHERE), so it needs no target and no aiming prompt.
 */
async function angbandFireSphere(page) {
  await page.keyboard.type("E");                        // Perform an effect
  await angbandUntil(page, /Do which effect/);
  await angbandAnswer(page, "SPHERE", /damage dice/);
  await angbandAnswer(page, "1d1", /effect subtype/);
  await angbandAnswer(page, "LIGHT", /radius/);
  await angbandAnswer(page, "3", /other/);
  await angbandAnswer(page, "0", /y parameter/);
  await angbandAnswer(page, "0", /x parameter/);
  await page.keyboard.type("0");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(TURN_MS * 8);               // the blast, then its repaint
  return page.evaluate(() => {
    const m = window.__angbandView.renderer.map;
    let live = 0;
    for (const c of m.cells) if (c.category === "effect") live++;
    const c = window.__ang;
    return {
      peak: c.fxPeak, frames: c.frames, ghost: c.ghost, drawnPeak: c.drawnPeak,
      effects: c.effect, live,
    };
  });
}

async function angbandSection(browser) {
  const apage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  console.log("\n--- Angband ---");

  // Everything below reads the engine's own traffic: which key the view handed
  // the engine, and which events came back. Patching the view's handle/nextKey is
  // the sanctioned way to see that (AGENTS.md); both wrappers forward.
  //
  // Installed by intercepting the assignment rather than polling for it, because
  // both halves are lost by a wrapper that arrives late: main.ts constructs
  // AngbandSession in the same turn it sets __angbandView, so the first blocking
  // key request is already parked — its promise resolves through the unwrapped
  // nextKey and the first keystroke of the run is invisible — and the level event
  // carrying the cave's dimensions has long since gone by.
  await apage.addInitScript((stride) => {
    let view = null;
    const counters = { evs: 0, map: 0, msg: 0, effect: 0, maxBatch: 0, keys: [], fxPeak: 0 };
    window.__ang = counters;
    Object.defineProperty(window, "__angbandView", {
      configurable: true,
      get: () => view,
      set: (v) => {
        view = v;
        const inner = v.handle.bind(v);
        v.handle = (ev) => {
          counters.evs++;
          if (ev.name === "map") {
            counters.map++;
            counters.lastBatch = ev.records.length / stride;
            counters.maxBatch = Math.max(counters.maxBatch, counters.lastBatch);
          }
          if (ev.name === "message") counters.msg++;
          if (ev.name === "effect") counters.effect++;
          if (ev.name === "level") counters.level = { width: ev.width, height: ev.height };
          return inner(ev);
        };
        const nextKey = v.nextKey.bind(v);
        v.nextKey = (wait, cmd) => {
          const result = nextKey(wait, cmd);
          if (result && typeof result.then === "function") {
            return result.then((k) => { if (k) counters.keys.push(k); return k; });
          }
          if (result) counters.keys.push(result);
          return result;
        };
      },
    });
    // The stride arrives as an argument rather than a literal: a page function
    // is serialized, so the node-side GRID_STRIDE cannot close over it, and a
    // hand-copied 15 here would skew every record count the day mapRecords.ts
    // changed — silently, since nothing else reads that number (vect-hack-8r0).
  }, GRID_STRIDE);

  await apage.goto(`${URL_BASE}?game=angband`, { waitUntil: "domcontentloaded" });
  await apage.waitForFunction(() => window.__angbandView?.renderer?.backend ?? null,
    null, { timeout: 30000 });
  await angbandBirth(apage);
  console.log("booted, character on the level\n");

  const ang = () => apage.evaluate(() => JSON.parse(JSON.stringify(window.__ang)));

  // --- entering first person ---
  await apage.keyboard.press("F2");
  await apage.waitForTimeout(TURN_MS);
  let a = await apage.evaluate(ANGBAND_STATE);
  check(a.mode === "first", `F2 enters first person (mode=${a.mode})`);

  // --- turning is free, and never reaches the engine ---
  {
    const before = await ang();
    const pre = await apage.evaluate(ANGBAND_STATE);
    await apage.keyboard.press("ArrowLeft");
    await apage.waitForTimeout(TURN_MS);
    const post = await apage.evaluate(ANGBAND_STATE);
    const after = await ang();
    check(Math.abs(post.heading - pre.heading - STEP) < 1e-9,
      `ArrowLeft turns +45 deg (${pre.heading.toFixed(4)} -> ${post.heading.toFixed(4)})`);
    check(after.keys.length === before.keys.length,
      `turning sends the engine no key (${before.keys.length} -> ${after.keys.length})`);
    check(after.map === before.map && after.msg === before.msg,
      `turning produces no map or message events (map ${before.map}->${after.map}, msg ${before.msg}->${after.msg})`);
    await apage.keyboard.press("ArrowRight");
    await apage.waitForTimeout(TURN_MS);
  }

  // --- forward emits the keypad digit the camera is facing ---
  {
    await angbandQuiet(apage);
    const pre = await apage.evaluate(ANGBAND_STATE);
    const before = await ang();
    await apage.keyboard.press("ArrowUp");
    const sent = await angbandKeyAfter(apage, before);
    const want = ANGBAND_DIGITS[compass(pre.heading)].codePointAt(0);
    check(!!sent && sent.code === want && (sent.mods & KC_MOD_KEYPAD) !== 0,
      `ArrowUp at heading ${pre.heading.toFixed(3)} (${NAME[compass(pre.heading)]}) sent `
      + `${JSON.stringify(sent)}, expected code ${want} ('${ANGBAND_DIGITS[compass(pre.heading)]}') with the keypad bit`);
    check(!!sent && (sent.mods & KC_MOD_SHIFT) === 0, `an unshifted arrow is a walk, not a run`);
  }

  // --- shift carries run ---
  {
    await angbandQuiet(apage);
    const pre = await apage.evaluate(ANGBAND_STATE);
    const before = await ang();
    await apage.keyboard.press("Shift+ArrowUp");
    const sent = await angbandKeyAfter(apage, before);
    check(!!sent && (sent.mods & KC_MOD_SHIFT) !== 0 && (sent.mods & KC_MOD_KEYPAD) !== 0,
      `Shift+ArrowUp carries run (${JSON.stringify(sent)})`);
    check(!!sent && sent.code === ANGBAND_DIGITS[compass(pre.heading)].codePointAt(0),
      `running goes the way the camera faces (${NAME[compass(pre.heading)]})`);
    await apage.waitForTimeout(TURN_MS * 3); // a run keeps going; let it stop
  }

  // --- a menu overlay gets the arrow the browser sent, unremapped ---
  {
    await apage.keyboard.press("?");           // the help menu: a full-term screen_save
    await apage.waitForTimeout(TURN_MS * 2);
    const menu = await apage.evaluate(ANGBAND_STATE);
    check(menu.overlay !== null, `? opens a full-term overlay`);
    const before = await ang();
    await apage.keyboard.press("ArrowDown");
    const sent = await angbandKeyAfter(apage, before);
    // 0x80 is ArrowDown in src/modules/angband/keys.ts SPECIAL; a remapped arrow
    // would arrive as a keypad digit instead and scroll nothing.
    check(!!sent && sent.code === 0x80 && (sent.mods & KC_MOD_KEYPAD) === 0,
      `an arrow in a menu reaches the engine unremapped (${JSON.stringify(sent)})`);
    for (let i = 0; i < 4; i++) {
      await apage.keyboard.press("Escape");
      await apage.waitForTimeout(TURN_MS);
      if ((await apage.evaluate(ANGBAND_STATE)).overlay === null) break;
    }
  }

  // --- orbital: the dragged bearing steers the direction keys, Clear resets ---
  await apage.keyboard.press("F2");
  await apage.waitForTimeout(TURN_MS);
  a = await apage.evaluate(ANGBAND_STATE);
  check(a.mode === "orbital", `F2 returns to orbital (mode=${a.mode})`);
  {
    const pre = await apage.evaluate(ANGBAND_STATE);
    await apage.mouse.move(640, 400);
    await apage.mouse.down();
    await apage.mouse.move(640 + 524, 400, { steps: 8 }); // ~pi of azimuth
    await apage.mouse.up();
    await apage.waitForTimeout(TURN_MS);
    const turned = await apage.evaluate(ANGBAND_STATE);
    check(Math.abs(turned.heading - pre.heading) > Math.PI / 2,
      `dragging swings the orbital bearing (${pre.heading.toFixed(3)} -> ${turned.heading.toFixed(3)})`);

    await angbandQuiet(apage);
    const before = await ang();
    await apage.keyboard.press("ArrowUp");
    const sent = await angbandKeyAfter(apage, before);
    const want = ANGBAND_DIGITS[compass(turned.heading)].codePointAt(0);
    check(!!sent && sent.code === want,
      `orbital ArrowUp follows the dragged bearing (${NAME[compass(turned.heading)]}): `
      + `sent ${JSON.stringify(sent)}, expected code ${want}`);

    await angbandQuiet(apage);                 // camera actions are armed with the command request
    await apage.keyboard.press("Numpad5");     // Clear, with NumLock off
    await apage.waitForTimeout(TURN_MS);
    const reset = await apage.evaluate(ANGBAND_STATE);
    const mod = ((reset.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    check(Math.min(mod, 2 * Math.PI - mod) < 1e-6,
      `Clear (keypad 5) resets the bearing to north-up (heading=${reset.heading.toFixed(4)})`);
  }

  // --- a real projection: effect Cells appear, and the engine clears them ---
  // Wizard mode's "Perform an effect" is the only way to fire one on demand from
  // a character the birth screen chose at random. SPHERE is centred on the player
  // (effect-handler-attack.c effect_handler_SPHERE), so it needs no target and no
  // aiming prompt — project() draws the blast, EVENT_EXPLOSION reaches the tap,
  // and every lit grid becomes an effect Cell.
  //
  // Effect Cells are the only Cells with no engine-owned lifetime: nothing in the
  // record stream retracts them. They live for Angband's own per-radius animation
  // delay and are cleared by its follow-up repaint of those grids. Both halves are
  // checked, and the sample is per animation frame, not per Cell write: an effect
  // that never survives to a drawn frame is invisible to the player however
  // briefly it existed in the model (main-wasm.c arm_effect_handlers). A lingering
  // effect CELL is a failure here, not an invitation to add a grid-level TTL —
  // and the arm at the end of this section is why that stayed the rule: the
  // lifetime a blast is owed lives on the effect EVENT instead, where a Cell
  // that never survived a frame can still be drawn (vect-hack-auo).
  {
    await angbandDrainMore(apage);
    await apage.keyboard.press("Control+a");
    const cmd = await angbandUntil(apage, /Debug Command/);
    check(/Debug Command/.test(cmd.prompt), `Ctrl-A opens the debug command prompt`);

    // Watch from before the effect: the blast lasts about as long as the
    // engine's delay_factor per radius, so looking afterwards would find nothing
    // either way — an assertion that cannot fail.
    await angbandWatchEffects(apage);
    const fx = await angbandFireSphere(apage);
    check(fx.effects > 0, `the projection reached the view as effect events (${fx.effects})`);
    check(fx.peak > 0, `effect Cells landed on the grid (peak ${fx.peak})`);
    check(fx.frames > 0, `the blast survived to a drawn frame (${fx.frames} frames)`);
    check(fx.live === 0, `the engine's follow-up repaint cleared them (${fx.live} left)`);
  }

  // --- the debug detect command reaches the engine and the grid keeps up ---
  // This block used to claim it proved the EVENT_ITEMLIST -> dirty_fallback
  // full sweep ("detection repacked the whole level in one batch"). It never
  // did, and it cannot from here (vect-hack-8r0). Two measurements:
  //
  //  * counters.maxBatch is a cumulative maximum, and on_level marks dirty_all
  //    on every level entry, so the birth-time paint of this very level had
  //    already set it to `area`. The check held with the on_itemlist handler
  //    deleted outright — it was reading the boot paint.
  //  * Zeroed just before the keystroke, the largest batch "Detect all nearby"
  //    produces in TOWN is 1 grid of 1452, and nothing new is found (things
  //    2 -> 2, known cells 974 -> 974). The town has nothing to detect, so
  //    nothing sets PR_ITEMLIST and the fallback never arms. Later commands do
  //    not change it either.
  //
  // The remaining checks are the ones this scenario can actually fail on. The
  // fallback itself is still unpinned: a whole-map redraw (EVENT_MAP with the
  // (-1,-1) payload, which cave-map.c raises alongside PR_ITEMLIST on every
  // detection) reaches on_map and sets dirty_all on its own, so even a summon
  // that repacks the whole level does so with on_itemlist unregistered —
  // measured. Only a PR_ITEMLIST-without-PR_MAP path (a pickup) would isolate
  // it, and this gate never drives one.
  {
    const before = await ang();
    const known = () => apage.evaluate(() => {
      const m = window.__angbandView.renderer.map;
      let seen = 0, things = 0;
      for (const c of m.cells) {
        if (c.category !== "unseen") seen++;
        if (c.category === "item" || c.category === "being") things++;
      }
      return { seen, things };
    });
    const knownBefore = await known();
    // Drain any -more- first: it eats the command key, and both of these
    // sites were watched failing that way (vect-hack-auo).
    await angbandDrainMore(apage);
    // Then zero, so the batch size printed below is the one this command
    // produced and not the boot paint's or the pager's. It is reported, not
    // asserted: see the block header.
    await apage.evaluate(() => { window.__ang.maxBatch = 0; });
    await apage.keyboard.press("Control+a");
    await angbandUntil(apage, /Debug Command/);
    await apage.keyboard.type("d");                       // Detect all nearby
    await apage.waitForTimeout(TURN_MS * 6);
    const after = await ang();
    const knownAfter = await known();
    // The level event carries the cave's own dimensions, so a batch can be
    // compared against the engine's own number rather than the grid's maximum.
    const area = (after.level?.width ?? 0) * (after.level?.height ?? 0);
    check(after.map > before.map,
      `the detect command reached the engine and flushed the map `
      + `(${before.map} -> ${after.map} batches, largest ${after.maxBatch} of ${area} grids, `
      + `${GRID_STRIDE} words each)`);
    // Only the "kept" half is an assertion: >= passes on equality, and a sweep
    // that lands nothing new leaves both numbers where they were — which is
    // what a town sweep does. Named for what it can fail on.
    check(knownAfter.things >= knownBefore.things && knownAfter.seen >= knownBefore.seen,
      `the sweep kept what was already known `
      + `(things ${knownBefore.things} -> ${knownAfter.things}, `
      + `known cells ${knownBefore.seen} -> ${knownAfter.seen})`);
  }

  // --- the same projection with delay_factor 0 (vect-hack-auo) ---
  // delay_factor is an ordinary in-game option, saved per character and reachable
  // from the options menu (ui-options.c do_cmd_delay). It is also the ONLY thing
  // that used to keep an effect Cell on the grid across a frame boundary:
  // ui-display.c draws a step, Term_fresh()es, then
  // Term_xtra(TERM_XTRA_DELAY, delay_factor), and main-wasm.c's TERM_XTRA_DELAY
  // only emscripten_sleep()s for a POSITIVE value. At 0 the whole blast — every
  // set and the repaint that erases it — reaches the main thread between two
  // frames, so the grid a frame samples never holds it and the arm above would
  // measure nothing at all.
  //
  // What has to be non-zero here is therefore what the frame DREW: `ghost`
  // counts frames that drew an effect the grid did NOT hold, which nothing but
  // the effect-event residue can produce. The grid-sampled `frames` is printed
  // beside it as the measurement that goes blind — the before to its after.
  // Last in the section on purpose: it leaves the option set.
  {
    await angbandQuiet(apage);
    await angbandDrainMore(apage);
    await apage.keyboard.type("=");
    await angbandUntil(apage, /Options Menu/);
    await apage.keyboard.type("d");
    await angbandUntil(apage, /Base Delay Factor/);
    // askfor_aux() opens on the current value and the first character replaces
    // the whole buffer, so this is "0", not "400".
    await apage.keyboard.type("0");
    await apage.keyboard.press("Enter");
    await apage.waitForTimeout(TURN_MS);

    // Read it back from the engine rather than assuming the keystrokes landed:
    // an arm that ran at the default delay would pass for the wrong reason.
    await apage.keyboard.type("d");
    const delay = await angbandUntil(apage, /Current base delay factor/);
    const shown = /Current base delay factor: (\d+) msec/.exec(delay.text);
    check(!!shown && shown[1] === "0",
      `the options menu set delay_factor to 0 (engine reports ${shown ? shown[1] : "?"})`);
    await apage.keyboard.press("Escape");                 // leave the prompt unchanged
    await apage.waitForTimeout(TURN_MS);
    for (let i = 0; i < 4; i++) {
      await apage.keyboard.press("Escape");
      await apage.waitForTimeout(TURN_MS);
      if ((await apage.evaluate(ANGBAND_STATE)).overlay === null) break;
    }
    const state = await apage.evaluate(ANGBAND_STATE);
    check(state.overlay === null, `the options menu closed`);

    const before = (await ang()).effect;
    await angbandDrainMore(apage);
    await apage.keyboard.press("Control+a");
    await angbandUntil(apage, /Debug Command/);
    await angbandWatchEffects(apage);
    const fx = await angbandFireSphere(apage);
    console.log(`    delay_factor 0: grid-sampled frames ${fx.frames} (peak ${fx.peak} Cells), `
      + `drawn-from-residue frames ${fx.ghost} (peak ${fx.drawnPeak} glyphs)`);
    check(fx.effects > before,
      `the projection reached the view as effect events (${fx.effects - before})`);
    check(fx.ghost > 0,
      `the blast was DRAWN on ${fx.ghost} frame(s) whose grid no longer held it`);
    check(fx.live === 0, `the engine's follow-up repaint cleared the grid (${fx.live} left)`);
  }
}

// ---------------------------------------------------------------------------
// Moria
// ---------------------------------------------------------------------------

const MORIA_DIGITS = ["8", "9", "6", "3", "2", "1", "4", "7"];
const MORIA_BIRTH = [
  { screen: /Umoria 5\.7\.15/, key: "Enter" },
  { screen: /Choose a race \(\? for Help\):/, key: "a" },
  { screen: /Choose a sex \(\? for Help\):/, key: "m" },
  { screen: /Hit space to re-roll or ESC to accept characteristics:/, key: "Escape" },
  { screen: /Choose a class \(\? for Help\):/, key: "a" },
  { screen: /Name\s*:/, key: "Enter" },
  { screen: /press any key to continue, or Q to exit/i, key: " " },
];

const MORIA_STATE = () => {
  const view = window.__moriaView;
  const r = view?.renderer ?? null;
  const keys = view?.keys;
  return {
    tty: view?.tty?.toText() ?? "",
    frameBytes: view?.tty?.cells?.byteLength ?? null,
    waiting: !!keys?.waiter,
    queued: keys?.buffer?.length ?? 0,
    commandInput: !!view?.commandInput,
    mode: r?.mode ?? null,
    heading: r?.heading ?? null,
    hero: r?.map?.hero ?? null,
    pending: window.__moria?.pending ?? null,
    notices: [...(document.getElementById("messages")?.children ?? [])]
      .slice(-5).map((node) => node.textContent ?? "").join("\n"),
  };
};

let moriaAutomaticKeys = 0;

async function moriaState(page) {
  return page.evaluate(MORIA_STATE);
}

/** Await the source request itself, not merely a quiet DOM or a visible hero. */
async function moriaPending(page, context, screen = null) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const state = await moriaState(page);
    if (/Moria engine died/i.test(state.notices)) throw new Error(state.notices.slice(-300));
    if (state.frameBytes !== null && state.frameBytes !== 80 * 24)
      throw new Error(`Moria retained terminal has ${state.frameBytes} bytes`);
    if (state.queued) throw new Error(`Moria queued ${state.queued} speculative key(s)`);
    if (state.pending?.context === context && state.pending.wait
      && (screen === null || screen.test(state.tty))) return state;
    if (state.pending?.context === "literal" && state.tty.includes(" -more-")) {
      await page.keyboard.press(" ");
      moriaAutomaticKeys++;
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Moria never parked ${context}: ${JSON.stringify(state).slice(0, 500)}`);
    }
    await page.waitForTimeout(30);
  }
}

async function moriaBirth(page) {
  for (const { screen, key } of MORIA_BIRTH) {
    await moriaPending(page, "literal", screen);
    if ([...key].length === 1 && key !== " ") await page.keyboard.type(key);
    else await page.keyboard.press(key);
  }
  const state = await moriaPending(page, "outer-command");
  if (!state.hero) throw new Error("Moria reached an outer command without a semantic hero");
  return state;
}

async function moriaKeysAfter(page, before, count = 1) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const keys = await page.evaluate(() => window.__moria.keys.slice());
    const exact = exactNewKeys(keys, before, count);
    if (exact !== null) return exact;
    if (Date.now() > deadline)
      throw new Error(`Moria consumed ${keys.length - before} of ${count} expected key(s)`);
    await page.waitForTimeout(30);
  }
}

/** A source-semantic adjacent tile known to be walkable right now. The old
 * hero tile guarantees at least one after the first successful walk. */
async function moriaOpenDirection(page) {
  return page.evaluate(() => {
    const map = window.__moriaView.renderer.map;
    const hero = map.hero;
    const delta = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
    return delta.findIndex(([dx, dy]) => {
      const cell = map.at(hero.x + dx, hero.y + dy);
      return cell.category === "floor" || cell.category === "corridor"
        || cell.category === "door-open";
    });
  });
}

/** Rotate through the real pointer gesture to the nearest equivalent of a
 * compass heading. OrbitCam uses -0.006 radians per horizontal pixel. */
async function moriaDragTo(page, target) {
  const heading = (await moriaState(page)).heading;
  let delta = target - heading;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  const pixels = Math.round(-delta / 0.006);
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.move(640 + pixels, 400, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(TURN_MS);
}

async function moriaSection(browser) {
  const mpage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  console.log("\n--- Moria ---");

  // Install before main.ts assigns the view. MoriaSession is constructed on the
  // very next line, so polling afterward would miss the first parked birth read.
  await mpage.addInitScript(() => {
    let view = null;
    const counters = {
      events: 0, maps: 0, states: 0, messages: 0, keys: [], requests: [], pending: null,
    };
    window.__moria = counters;
    Object.defineProperty(window, "__moriaView", {
      configurable: true,
      get: () => view,
      set: (v) => {
        view = v;
        const handle = v.handle.bind(v);
        v.handle = (ev) => {
          counters.events++;
          if (ev.name === "map") counters.maps++;
          if (ev.name === "state") counters.states++;
          if (ev.name === "message") counters.messages++;
          return handle(ev);
        };
        const nextKey = v.nextKey.bind(v);
        v.nextKey = (wait, context, mode) => {
          const request = {
            id: counters.requests.length, wait, context, mode, settled: false, key: null,
          };
          counters.requests.push(request);
          const result = nextKey(wait, context, mode);
          const settle = (key) => {
            request.settled = true;
            request.key = key;
            if (key !== null) counters.keys.push({
              request: request.id, key, context, mode, wait,
            });
            if (counters.pending?.id === request.id) counters.pending = null;
            return key;
          };
          if (result && typeof result.then === "function") {
            if (wait) counters.pending = request;
            return result.then(settle);
          }
          return settle(result);
        };
      },
    });
  });

  await mpage.goto(`${URL_BASE}?game=moria`, { waitUntil: "domcontentloaded" });
  await mpage.waitForFunction(() => window.__moriaView?.renderer?.backend ?? null,
    null, { timeout: 30000 });
  await moriaBirth(mpage);
  console.log("booted, character on the town level\n");

  const moriaCounters = () => mpage.evaluate(() => JSON.parse(JSON.stringify(window.__moria)));

  // --- F2 and first-person turning are local chrome ---
  {
    await moriaPending(mpage, "outer-command");
    const before = await moriaCounters();
    await mpage.keyboard.press("F2");
    await mpage.waitForTimeout(TURN_MS);
    let state = await moriaState(mpage);
    let after = await moriaCounters();
    check(state.mode === "first", `Moria F2 enters first person (mode=${state.mode})`);
    check(after.keys.length === before.keys.length,
      `Moria F2 never reaches the engine (${before.keys.length} keys)`);

    const pre = state;
    const eventsBefore = after.events;
    await mpage.keyboard.press("ArrowLeft");
    await mpage.waitForTimeout(TURN_MS);
    state = await moriaState(mpage);
    after = await moriaCounters();
    check(Math.abs(state.heading - pre.heading - STEP) < 1e-9,
      `Moria ArrowLeft turns +45 deg (${pre.heading.toFixed(4)} -> ${state.heading.toFixed(4)})`);
    check(after.keys.length === before.keys.length,
      `Moria first-person turn sends no key (${before.keys.length} -> ${after.keys.length})`);
    check(after.events === eventsBefore,
      `Moria first-person turn produces no engine events (${eventsBefore} -> ${after.events})`);
    check(state.hero.x === pre.hero.x && state.hero.y === pre.hero.y,
      `Moria first-person turn does not move the hero`);

    await mpage.keyboard.press("ArrowRight");
    await mpage.waitForTimeout(TURN_MS);
  }

  // --- first-person forward: exact source byte and real cell delta ---
  let moriaWalked = false;
  for (let i = 0; i < 8 && !moriaWalked; i++) {
    await moriaPending(mpage, "outer-command");
    const pre = await moriaState(mpage);
    const before = (await moriaCounters()).keys.length;
    await mpage.keyboard.press("ArrowUp");
    const [sent] = await moriaKeysAfter(mpage, before);
    const direction = compass(pre.heading);
    const want = MORIA_DIGITS[direction].codePointAt(0);
    check(sent?.key === want && sent?.context === "outer-command" && sent?.mode === "original",
      `Moria ArrowUp at ${NAME[direction]} consumed original byte ${want} under outer-command `
      + `(${JSON.stringify(sent)})`);
    await moriaPending(mpage, "outer-command");
    const post = await moriaState(mpage);
    const dx = post.hero.x - pre.hero.x, dy = post.hero.y - pre.hero.y;
    if (dx || dy) {
      const [ex, ey] = DELTA[direction];
      moriaWalked = true;
      check(dx === ex && dy === ey,
        `Moria forward at ${NAME[direction]} moved (${dx},${dy}), expected (${ex},${ey})`);
    } else {
      // Turning is local and leaves this exact outer request parked for the retry.
      await mpage.keyboard.press("ArrowRight");
      await mpage.waitForTimeout(TURN_MS);
    }
  }
  check(moriaWalked, "Moria hero walked at least once in first person");

  // --- original-mode run is two source reads, not a shift bit ---
  {
    await moriaPending(mpage, "outer-command");
    const pre = await moriaState(mpage);
    const before = (await moriaCounters()).keys.length;
    const automaticBefore = moriaAutomaticKeys;
    await mpage.keyboard.press("Shift+ArrowUp");
    const sent = await moriaKeysAfter(mpage, before, 2);
    const want = MORIA_DIGITS[compass(pre.heading)].codePointAt(0);
    check(sent[0]?.key === ".".codePointAt(0) && sent[0]?.context === "outer-command"
      && sent[0]?.mode === "original",
      `Moria Shift+ArrowUp starts source run with '.' at outer-command (${JSON.stringify(sent[0])})`);
    check(sent[1]?.key === want && sent[1]?.context === "literal" && sent[1]?.mode === "original",
      `Moria run direction is literal byte ${want} (${JSON.stringify(sent[1])})`);
    await moriaPending(mpage, "outer-command");
    const after = await moriaCounters();
    const expected = 2 + moriaAutomaticKeys - automaticBefore;
    check(after.keys.length === before + expected,
      `Moria run consumed only its exact pair plus ${expected - 2} accounted pager key(s) `
      + `(${after.keys.length - before} total)`);
  }

  // --- orbital bearing steers bytes; Clear is local north-up chrome ---
  {
    await moriaPending(mpage, "outer-command");
    let before = await moriaCounters();
    await mpage.keyboard.press("F2");
    await mpage.waitForTimeout(TURN_MS);
    let state = await moriaState(mpage);
    check(state.mode === "orbital", `Moria F2 returns to orbital (mode=${state.mode})`);
    check((await moriaCounters()).keys.length === before.keys.length,
      `Moria F2 return sends no key`);

    const startHeading = state.heading;
    await mpage.mouse.move(640, 400);
    await mpage.mouse.down();
    await mpage.mouse.move(640 + 524, 400, { steps: 8 });
    await mpage.mouse.up();
    await mpage.waitForTimeout(TURN_MS);
    state = await moriaState(mpage);
    check(Math.abs(state.heading - startHeading) > Math.PI / 2,
      `Moria drag swings orbital bearing (${startHeading.toFixed(3)} -> ${state.heading.toFixed(3)})`);

    // Aim at an actually open semantic neighbor before consuming the command.
    // This keeps a random town entrance from dropping the gate into a store's
    // literal command loop while still using only the player's pointer gesture.
    const openDirection = await moriaOpenDirection(mpage);
    if (openDirection < 0) throw new Error("Moria semantic town has no open adjacent tile");
    await moriaDragTo(mpage, -openDirection * STEP);
    state = await moriaState(mpage);
    check(compass(state.heading) === openDirection,
      `Moria pointer aimed orbital camera at open ${NAME[openDirection]} tile`);

    await moriaPending(mpage, "outer-command");
    before = await moriaCounters();
    const heading = (await moriaState(mpage)).heading;
    await mpage.keyboard.press("ArrowUp");
    const [sent] = await moriaKeysAfter(mpage, before.keys.length);
    const want = MORIA_DIGITS[compass(heading)].codePointAt(0);
    check(sent?.key === want && sent?.context === "outer-command",
      `Moria orbital ArrowUp follows dragged ${NAME[compass(heading)]} bearing (${JSON.stringify(sent)})`);

    await moriaPending(mpage, "outer-command");
    before = await moriaCounters();
    await mpage.keyboard.press("Numpad5");
    await mpage.waitForTimeout(TURN_MS);
    state = await moriaState(mpage);
    const mod = ((state.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    check(Math.min(mod, 2 * Math.PI - mod) < 1e-6,
      `Moria Clear resets north-up (heading=${state.heading.toFixed(4)})`);
    check((await moriaCounters()).keys.length === before.keys.length,
      `Moria Clear never reaches the engine (${before.keys.length} keys)`);
  }

  // --- literal source prompt: an arrow neither turns nor answers it ---
  {
    await moriaPending(mpage, "outer-command");
    await mpage.keyboard.press("F2");
    await mpage.waitForTimeout(TURN_MS);
    check((await moriaState(mpage)).mode === "first", "Moria prompt check enters first person");

    let before = await moriaCounters();
    await mpage.keyboard.type("B"); // originalCommands: bash, then getDirectionWithMemory
    const [command] = await moriaKeysAfter(mpage, before.keys.length);
    check(command?.key === "B".codePointAt(0) && command?.context === "outer-command",
      `Moria bash command reached the real outer read (${JSON.stringify(command)})`);
    const prompt = await moriaPending(mpage, "literal", /Which direction\?/);
    before = await moriaCounters();
    const heading = prompt.heading;
    const pendingId = prompt.pending.id;
    await mpage.keyboard.press("ArrowLeft");
    await mpage.waitForTimeout(TURN_MS);
    const afterArrow = await moriaState(mpage);
    const counters = await moriaCounters();
    check(afterArrow.heading === heading,
      `Moria arrow at literal direction prompt does not turn the camera`);
    check(counters.keys.length === before.keys.length && afterArrow.pending?.id === pendingId,
      `Moria arrow neither answers nor remaps literal request ${pendingId}`);

    await mpage.keyboard.type("8");
    const [direction] = await moriaKeysAfter(mpage, before.keys.length);
    check(direction?.key === "8".codePointAt(0) && direction?.context === "literal"
      && direction?.mode === "original",
      `Moria literal direction byte answers the prompt (${JSON.stringify(direction)})`);
    await moriaPending(mpage, "outer-command");
  }
}

// ---------------------------------------------------------------------------
// Larn
// ---------------------------------------------------------------------------
// Larn's gaze scheme is the shared adapter over the __wrap_yylex command seam,
// encoded as Larn's own vi bytes. The vectorview unit suite and the boot
// smoke's per-phase cmd assertions pin those rules in isolation; what only a
// live game shows is the composition, so this leg asserts the byte the engine
// actually consumed and the cell it actually moved the hero into.
//
// The prompt arm is the sharp one, and it is deliberately a PAIR. Larn is the
// only Module where the two answers are both legal bytes: at a command read a
// gazed ArrowUp is the vi letter for the compass eighth the camera faces, and
// at a prompt the same key is plain 'k'. The gate presses ArrowUp twice at one
// heading — once inside qshowstr()'s more() pager, once at the next command —
// and asserts the two bytes differ in exactly the documented way. Checking
// only the prompt half would pass on a build that never armed gaze at all
// (AGENTS.md: an assertion that cannot fail is worse than no assertion).
//
// Keep the startup oddities here, not in the shared control harness or public
// Module interface.

const LARN_STATE = () => {
  // Deliberately dev-only: Larn's retained tty and KeyQueue are private in
  // TypeScript but exact at runtime. Visible overlay state coalesces across
  // flushes and cannot prove retcont()/yylex() boundaries.
  const view = window.__larnView;
  const keys = view?.keys;
  const r = view?.renderer ?? null;
  return {
    tty: view?.tty?.toText() ?? "",
    waiting: !!keys?.waiter,
    queued: keys?.buffer?.length ?? 0,
    mode: r?.mode ?? null,
    heading: r?.heading ?? null,
    hero: r?.map?.hero ?? null,
    msg: [...document.getElementById("messages").children].slice(-1).map((d) => d.textContent)[0] ?? "",
  };
};

/** Fresh Larn start, pinned to welcome()->retcont() (LF), then the real
 * lookforobject()/inventory/more() handshake. The retained tty supplies the
 * markers and KeyQueue's runtime waiter paces each answer, so no key is ever
 * buffered ahead of C. The returned request is the post-pager parse/yylex(). */
async function larnBirth(page) {
  const deadline = Date.now() + SETTLE_MS;
  let phase = "welcome";
  for (;;) {
    const s = await page.evaluate(LARN_STATE);
    if (s.queued) throw new Error(`larn start: queued ${s.queued} handshake key(s)`);
    if (Date.now() > deadline)
      throw new Error(`larn start: stuck at ${JSON.stringify(s).slice(0, 300)}`);
    if (!s.waiting) {
      await page.waitForTimeout(30);
      continue;
    }
    if (phase === "welcome") {
      if (!s.tty.includes("Welcome to the game of Larn")) {
        await page.waitForTimeout(30);
        continue;
      }
      phase = "inventory";
      await page.keyboard.press("Enter");
    } else if (phase === "inventory") {
      if (s.tty.includes("Elapsed time is")) {
        phase = "command";
        await page.keyboard.press(" ");
      } else {
        await page.keyboard.type("i");
      }
    } else {
      if (!s.tty.includes("Elapsed time is") && s.hero) return s;
    }
  }
}

async function larnKeyAfter(page, before, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const keys = await page.evaluate(() => window.__larn.keys);
    if (keys.length > before) return keys[before];
    await page.waitForTimeout(TURN_MS / 2);
  }
  return null;
}

/** Wait until the engine is parked on the kind of read the next arm means to
 *  drive: a command (parse() -> __wrap_yylex, cmd=1) or a prompt (ttgetch,
 *  cmd=0). Pressing without this races the engine into the other context,
 *  where the same key legitimately means something else — which would read as
 *  a broken control scheme rather than as a mistimed gate. */
async function larnParked(page, wantCmd, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const pending = await page.evaluate(() => window.__larn.pending);
    if (pending && pending.cmd === wantCmd) return pending;
    await page.waitForTimeout(TURN_MS / 2);
  }
  const state = await page.evaluate(LARN_STATE);
  const pending = await page.evaluate(() => window.__larn.pending);
  throw new Error(`larn: never parked on a ${wantCmd ? "command" : "prompt"} read `
    + `(pending=${JSON.stringify(pending)} msg=${JSON.stringify(state.msg)} `
    + `hero=${JSON.stringify(state.hero)} tail=${JSON.stringify(state.tty.trim().slice(-300))})`);
}

/** Larn's home level is a town, not a room: home, the bank, the school, the
 *  DND store, the trading post, the dungeon entrance and the volcanic shaft
 *  all answer a step onto them with a ttgetch() prompt (object.c:158-505,
 *  ostairs at :564). Any gate that moves the hero has to be able to decline
 *  one, or where the hero happens to land decides whether the run passes.
 *  Every one of those loops takes ESC as "stay here"; more() takes only a
 *  space. Send both, bounded, until the engine is back at a command read.
 *  Detection stays in larnParked — a helper that recovered silently would hide
 *  the difference between a declined doorway and a control scheme that has
 *  stopped answering. */
async function larnDecline(page, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    const pending = await page.evaluate(() => window.__larn.pending);
    if (pending && pending.cmd) return;
    if (!pending) { await page.waitForTimeout(TURN_MS); continue; }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(TURN_MS);
    const still = await page.evaluate(() => window.__larn.pending);
    if (still && !still.cmd) {
      await page.keyboard.press(" ");
      await page.waitForTimeout(TURN_MS);
    }
  }
}

/** Press one chord and return the LarnKey the engine actually consumed. */
async function larnSend(page, press) {
  const before = await page.evaluate(() => window.__larn.keys.length);
  await page.keyboard.press(press);
  return larnKeyAfter(page, before);
}

/** Larn's movement bytes, clockwise from north — keys.ts movementKey, which is
 *  parse()'s own switch (main.c:675-720). Spelled out rather than imported
 *  because a gate that shares the table under test cannot catch it changing. */
const VI = ["k", "u", "l", "n", "j", "b", "h", "y"];
const LARN_SHIFT = 0x02; // KC_MOD_SHIFT, protocol.ts

async function larnSection(browser) {
  const lpage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  console.log("\n--- Larn ---");

  await lpage.addInitScript(() => {
    let view = null;
    // `pending` is the read the engine is parked on right now and `cmd` rides
    // along on every consumed byte: the __wrap_yylex discriminator is the whole
    // reason a Larn arrow means two different things, so the gate records it
    // beside the byte rather than inferring it from the screen (Moria's
    // byte+context precedent).
    const counters = { events: 0, maps: 0, keys: [], pending: null };
    window.__larn = counters;
    Object.defineProperty(window, "__larnView", {
      configurable: true,
      get: () => view,
      set: (v) => {
        view = v;
        const handle = v.handle.bind(v);
        v.handle = (ev) => {
          counters.events++;
          if (ev.name === "map") counters.maps++;
          return handle(ev);
        };
        const nextKey = v.nextKey.bind(v);
        v.nextKey = (wait, cmd) => {
          const result = nextKey(wait, cmd);
          if (result && typeof result.then === "function") {
            counters.pending = { cmd: !!cmd };
            return result.then((key) => {
              counters.pending = null;
              if (key) counters.keys.push({ ...key, cmd: !!cmd });
              return key;
            });
          }
          if (result) counters.keys.push({ ...result, cmd: !!cmd });
          return result;
        };
      },
    });
  });

  await lpage.goto(`${URL_BASE}?game=larn`, { waitUntil: "domcontentloaded" });
  await lpage.waitForFunction(() => window.__larnView?.renderer?.backend ?? null,
    null, { timeout: 30000 });
  await larnBirth(lpage);
  console.log("booted, character on the level\n");

  let f2Keys = await lpage.evaluate(() => window.__larn.keys.length);
  await lpage.keyboard.press("F2");
  await lpage.waitForTimeout(TURN_MS);
  let l = await lpage.evaluate(LARN_STATE);
  check(l.mode === "first", `Larn F2 enters first person (mode=${l.mode})`);
  check(/[Aa]rrows walk where you look/.test(l.msg), `Larn's mode message names the gaze controls`);
  check((await lpage.evaluate(() => window.__larn.keys.length)) === f2Keys,
    `Larn F2 enters first person without reaching the engine (${f2Keys} keys)`);

  // The byte is the assertion: a future gaze mapper would be free to move the
  // hero somewhere valid, but it must not silently turn raw 'l' into a different
  // compass byte. The wrapper sees exactly what the view gave the real engine.
  {
    await larnParked(lpage, true);
    const before = await lpage.evaluate(() => window.__larn.keys.length);
    await lpage.keyboard.type("l");
    const sent = await larnKeyAfter(lpage, before);
    check(!!sent && sent.code === "l".codePointAt(0) && sent.mods === 0,
      `Larn first-person raw vi l reaches the engine unchanged (${JSON.stringify(sent)})`);
  }

  // --- turning is free, and never reaches the engine ---
  await larnParked(lpage, true);
  {
    const pre = await lpage.evaluate(LARN_STATE);
    const quiet = await lpage.evaluate(() => window.__larn.keys.length);
    await lpage.keyboard.press("ArrowLeft");
    await lpage.waitForTimeout(TURN_MS);
    const turned = await lpage.evaluate(LARN_STATE);
    check(Math.abs(turned.heading - pre.heading - STEP) < 1e-9,
      `Larn ArrowLeft turns +45 deg (${pre.heading.toFixed(4)} -> ${turned.heading.toFixed(4)})`);
    check((await lpage.evaluate(() => window.__larn.keys.length)) === quiet,
      `Larn's first-person turn sends the engine nothing (${quiet} keys)`);
    check(turned.hero.x === pre.hero.x && turned.hero.y === pre.hero.y,
      `Larn's first-person turn does not move the hero`);

    // Shift rides along on a turn deliberately. Without the shifted binding the
    // chord falls through to mapKey, which folds Shift+ArrowLeft to 'H' — run
    // west — and the camera never turns at all (vect-hack-029).
    await lpage.keyboard.press("Shift+ArrowLeft");
    await lpage.waitForTimeout(TURN_MS);
    const shifted = await lpage.evaluate(LARN_STATE);
    check(Math.abs(shifted.heading - turned.heading - STEP) < 1e-9,
      `Larn Shift+ArrowLeft turns instead of falling through to run-west `
      + `(${turned.heading.toFixed(4)} -> ${shifted.heading.toFixed(4)})`);
    check((await lpage.evaluate(() => window.__larn.keys.length)) === quiet,
      `Larn Shift+ArrowLeft sends the engine nothing either (${quiet} keys)`);
  }

  // --- forward walks the gazed cell, spelled as Larn's own vi byte ---
  // Which way is open depends on where the hero spawned, so turn through the
  // eight headings and assert the cell on the first press that actually moves.
  // The byte is asserted on every press, moving or not: it is determined by the
  // heading alone, and it is where a sign error in the yaw convention shows up.
  {
    let walked = null;
    for (let i = 0; i < 8 && !walked; i++) {
      await larnDecline(lpage);
      await larnParked(lpage, true);
      const pre = await lpage.evaluate(LARN_STATE);
      const idx = compass(pre.heading);
      const sent = await larnSend(lpage, "ArrowUp");
      check(!!sent && sent.code === VI[idx].codePointAt(0) && sent.mods === 0 && sent.cmd === true,
        `Larn first-person ArrowUp facing ${NAME[idx]} sends '${VI[idx]}' at a command read `
        + `(${JSON.stringify(sent)})`);
      await lpage.waitForTimeout(TURN_MS * 2);
      const post = await lpage.evaluate(LARN_STATE);
      const dx = post.hero.x - pre.hero.x, dy = post.hero.y - pre.hero.y;
      if (dx || dy) {
        const [ex, ey] = DELTA[idx];
        walked = true;
        check(dx === ex && dy === ey,
          `Larn ArrowUp facing ${NAME[idx]} moved (${dx},${dy}), expected (${ex},${ey})`);
      } else {
        // Turning is only a camera action while a command read is parked; from
        // a prompt the same key falls through to mapKey and would be typed at
        // whatever is asking. Re-establish the context before turning.
        await larnDecline(lpage);
        await larnParked(lpage, true);
        await lpage.keyboard.press("ArrowRight");
        await lpage.waitForTimeout(TURN_MS);
      }
    }
    check(!!walked, "the hero walked at least once in Larn first person");
  }

  // --- shift carries run, as the uppercase byte and the mod together ---
  // movementKey sets both, and they have two different readers: parse()
  // switches on the byte while the worker branches on mods. One without the
  // other is a half-encoded run that only one of them would notice.
  await larnDecline(lpage);
  await larnParked(lpage, true);
  {
    const pre = await lpage.evaluate(LARN_STATE);
    const idx = compass(pre.heading);
    const sent = await larnSend(lpage, "Shift+ArrowUp");
    check(!!sent && sent.code === VI[idx].toUpperCase().codePointAt(0)
      && sent.mods === LARN_SHIFT && sent.cmd === true,
      `Larn Shift+ArrowUp facing ${NAME[idx]} runs as '${VI[idx].toUpperCase()}' with the shift mod `
      + `(${JSON.stringify(sent)})`);
    await lpage.waitForTimeout(TURN_MS * 2);
  }

  // --- back to orbital: the dragged bearing steers the bytes, Clear resets ---
  f2Keys = await lpage.evaluate(() => window.__larn.keys.length);
  await lpage.keyboard.press("F2");
  await lpage.waitForTimeout(TURN_MS);
  l = await lpage.evaluate(LARN_STATE);
  check(l.mode === "orbital", `Larn F2 returns to orbital (mode=${l.mode})`);
  check((await lpage.evaluate(() => window.__larn.keys.length)) === f2Keys,
    `Larn F2 returns to orbital without reaching the engine (${f2Keys} keys)`);

  {
    // Rotated the way a player does it — dragging the canvas — never by writing
    // renderer internals. OrbitCam turns 0.006 rad per pixel.
    await larnDecline(lpage);
    await larnParked(lpage, true);
    const pre = await lpage.evaluate(LARN_STATE);
    await lpage.mouse.move(640, 400);
    await lpage.mouse.down();
    await lpage.mouse.move(640 + 524, 400, { steps: 8 }); // ~pi of azimuth
    await lpage.mouse.up();
    await lpage.waitForTimeout(TURN_MS);
    const turned = await lpage.evaluate(LARN_STATE);
    check(Math.abs(turned.heading - pre.heading) > Math.PI / 2,
      `dragging swings Larn's orbital bearing (${pre.heading.toFixed(3)} -> ${turned.heading.toFixed(3)})`);

    const idx = compass(turned.heading);
    const sent = await larnSend(lpage, "ArrowUp");
    check(!!sent && sent.code === VI[idx].codePointAt(0) && sent.cmd === true,
      `Larn orbital ArrowUp follows the dragged bearing (${NAME[idx]} -> '${VI[idx]}') `
      + `(${JSON.stringify(sent)})`);
    await lpage.waitForTimeout(TURN_MS * 2);

    // Numpad5 arrives as key "Clear" with NumLock off — Playwright's default.
    //
    // Moria's leg also asserts that Clear reaches the engine with no key, and
    // Larn's deliberately does not. There, original mode sends keypad digits, so
    // a keypad 5 that leaked through would be a real byte; here Larn has no
    // keypad path at all — mapKey has no "Clear" case and returns null — so
    // while the binding exists gazeKey answers first and mapKey is unreachable,
    // and when the binding is gone the reset assertion below already fails. It
    // would be an assertion that cannot fail (AGENTS.md, vect-hack-azf), so it
    // is left out rather than left in looking like coverage.
    await larnDecline(lpage);
    await larnParked(lpage, true);
    await lpage.keyboard.press("Numpad5");
    await lpage.waitForTimeout(TURN_MS);
    const reset = await lpage.evaluate(LARN_STATE);
    const mod = ((reset.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    check(Math.min(mod, 2 * Math.PI - mod) < 1e-6,
      `Clear (keypad 5) resets Larn's bearing to north-up (heading=${reset.heading.toFixed(4)})`);
  }

  // --- a prompt sees the unremapped arrow, and the next command does not ---
  await lpage.keyboard.press("F2");
  await lpage.waitForTimeout(TURN_MS);
  {
    // Off north first. At heading north the gazed byte IS 'k', so the pair below
    // would agree for the wrong reason and neither half could fail. The turns
    // themselves need the command context, for the same reason the walk loop's
    // do.
    await larnDecline(lpage);
    await larnParked(lpage, true);
    let state = await lpage.evaluate(LARN_STATE);
    for (let i = 0; i < 8 && compass(state.heading) === 0; i++) {
      await lpage.keyboard.press("ArrowRight");
      await lpage.waitForTimeout(TURN_MS);
      state = await lpage.evaluate(LARN_STATE);
    }
    const idx = compass(state.heading);
    check(idx !== 0,
      `the camera is off north, so the two reads must answer differently `
      + `(${NAME[idx]} -> '${VI[idx]}' vs plain 'k')`);

    // qshowstr() (main.c:342) ends in more(), which reads through ttgetch() and
    // so arrives with cmd=0 — outside __wrap_yylex, the one thing the gaze
    // arming is allowed to look at.
    await lpage.keyboard.press("i");
    await larnParked(lpage, false);
    const pager = await lpage.evaluate(LARN_STATE);
    check(/press\s+space\s+to continue/.test(pager.tty.replace(/\s+/g, " ")),
      `Larn's inventory pager is on screen and waiting`);

    const atPrompt = await larnSend(lpage, "ArrowUp");
    check(!!atPrompt && atPrompt.code === 0x6b && atPrompt.mods === 0 && atPrompt.cmd === false,
      `an arrow at Larn's more() pager arrives as plain 'k', unremapped (${JSON.stringify(atPrompt)})`);

    await lpage.keyboard.press(" "); // more() loops until a space
    await larnParked(lpage, true);
    const atCommand = await larnSend(lpage, "ArrowUp");
    check(!!atCommand && atCommand.code === VI[idx].codePointAt(0) && atCommand.cmd === true,
      `the same key at the next command read is the gazed '${VI[idx]}' (${JSON.stringify(atCommand)})`);
    check(!!atPrompt && !!atCommand && atPrompt.code !== atCommand.code,
      `Larn answered one key two ways, by read kind alone `
      + `(prompt ${atPrompt?.code} vs command ${atCommand?.code})`);
  }
}

// One browser for the four Modules, and a try/finally around them: the exact
// structure browser-check.mjs has carried since vect-hack-azf, and never
// propagated to this sibling (vect-hack-8r0). Without it a single settle
// timeout threw straight out of top-level code — leaking the Chromium it had
// launched, and taking every later Module's section with it. Three of the four
// arms then never ran, and a gate that says nothing about what it did not
// check is worse than one that fails.
const SECTIONS = [
  ["NetHack", nethackSection],
  ["Angband", angbandSection],
  ["Moria", moriaSection],
  ["Larn", larnSection],
];

const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
try {
  for (const [name, section] of SECTIONS) {
    // A section that throws fails its own Module and nothing else. Its message
    // is recorded as a failed check so that it reaches the tally and the exit
    // code, rather than as an exception nobody counts.
    try {
      await section(browser);
    } catch (e) {
      check(false, `${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
} finally {
  await browser.close();
}
console.log(fail.length ? `\nFAILED (${fail.length})` : "\nALL CHECKS PASSED");
process.exit(fail.length ? 1 : 0);

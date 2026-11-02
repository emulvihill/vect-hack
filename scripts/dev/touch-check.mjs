// The touch scheme, driven end to end in a real browser at a phone-sized
// viewport (vect-hack-21k). What the unit tests cannot reach is the
// composition: whether a real finger on a real pad, over a real engine, moves
// a real hero — and whether the whole of character creation can be got
// through without a key.
//
// THE RULE THIS SCRIPT IS BUILT AROUND: it never synthesises a keyboard event.
// There is no page.keyboard call in this file and the browser context is
// asserted to have delivered none — a keydown listener installed before boot
// counts every one, and a nonzero count fails the run. Without that, a script
// that quietly pressed Enter once would "prove" a touch build that cannot
// start a game.
//
// Needs a dev server (npm run dev -- --port 5199) and a GPU, like
// browser-check.mjs and fp-controls-check.mjs, so it is not part of npm test.
// `npm run check:gates` drives it as the third of the four hosted gates and
// starts that server for it (vect-hack-hnw); running it on its own still needs
// one.
import { chromium } from "playwright";

const URL_BASE = process.env.NH_URL ?? "http://localhost:5199/";
const SETTLE_MS = 90000;
const TAP_MS = 260;
const CHROMIUM_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"];
// iPhone-ish portrait: the size the whole scheme was designed against.
const VIEWPORT = { width: 390, height: 844 };

const fail = [];
const check = (ok, msg) => { console.log(`  ${ok ? "OK  " : "FAIL"} ${msg}`); if (!ok) fail.push(msg); };

/** Everything the driver decides from, read in one round trip. */
const STATE = () => {
  const shown = (id) => {
    const el = document.getElementById(id);
    return el && !el.hidden ? el : null;
  };
  const overlay = shown("overlay");
  const prompt = shown("prompt");
  return {
    linein: !!document.getElementById("linein"),
    notice: !!shown("storagenotice"),
    chips: prompt ? [...prompt.querySelectorAll("[data-yn]")].map((e) => e.dataset.yn) : [],
    promptText: prompt?.innerText ?? null,
    overlayText: overlay?.innerText ?? null,
    rows: overlay ? [...overlay.querySelectorAll("[data-i],[data-pi],[data-act]")].length : 0,
    hero: window.__nhView?.renderer?.map?.hero ?? null,
    mode: window.__nhView?.renderer?.mode ?? null,
    heading: window.__nhView?.renderer?.heading ?? null,
    status: document.getElementById("status")?.textContent ?? "",
    msg: [...document.getElementById("messages").children].slice(-1).map((d) => d.textContent)[0] ?? "",
    keydowns: window.__keydowns ?? 0,
    bar: [...(document.getElementById("touchbar")?.children ?? [])].map((b) => b.title),
    barLocked: !!document.getElementById("touchbar")?.classList.contains("locked"),
    pad: [...(document.getElementById("touchpad")?.children ?? [])].map((b) => b.textContent),
    cam: document.getElementById("touchcam")?.textContent ?? null,
  };
};

/**
 * How much map the camera frames, in columns across the middle of the view,
 * read through the renderer's OWN inverse mapping: pickCell() is what the Look
 * HUD uses to turn a pointer position into a cell, so this asks the live camera
 * rather than re-deriving a projection here. Scanned rather than probed at the
 * two extremes — at this framing the top of the view is above the floor plane
 * and pickCell rightly answers null there.
 *
 * An UPPER bound: a sample near the horizon still names a distant cell that is
 * not legible. It is the same measure scripts/dev/mobile-preview.mjs prints,
 * so the two can be read against each other.
 */
const COLS_ACROSS = () => {
  const r = window.__nhView.renderer;
  const c = document.getElementById("view").getBoundingClientRect();
  const xs = [];
  for (let f = 0.02; f <= 0.99; f += 0.02) {
    const cell = r.pickCell(c.x + c.width * f, c.y + c.height * 0.5);
    if (cell) xs.push(cell.x);
  }
  return xs.length ? Math.max(...xs) - Math.min(...xs) + 1 : 0;
};

/** Tap one element by CSS selector, as a finger would. Playwright's tap()
 *  dispatches real touch events; nothing here goes near the keyboard. */
async function tap(page, selector, nth = 0) {
  await page.locator(selector).nth(nth).tap();
  await page.waitForTimeout(TAP_MS);
}

/** Answer whatever the engine is asking, with a finger, until it stops asking.
 *  Every branch is an affordance that already existed (yn chips, menu rows,
 *  the overlay's own "press any key") except the bar's Done, which is the one
 *  thing the touch layer had to add. */
async function settle(page, label, needHero = false) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const s = await page.evaluate(STATE);
    if (s.notice) {
      // The storage warning is chrome a player dismisses with a finger too,
      // and at 390px it overlaps the top of the overlay.
      await tap(page, "#storagenoticedismiss");
    } else if (s.linein) {
      // getlin: the soft keyboard would fill it; an empty name is "player".
      await tap(page, "#touchbar button", 0);
    } else if (s.chips.length) {
      const want = /tutorial/i.test(s.promptText ?? "") ? "n"
        : s.chips.includes("y") ? "y" : s.chips[0];
      await tap(page, `#prompt [data-yn="${want}"]`);
    } else if (s.rows) {
      await tap(page, "#overlay [data-i],#overlay [data-pi],#overlay [data-act]", 0);
    } else if (s.overlayText !== null) {
      await tap(page, "#overlay");
    } else if (s.hero || !needHero) {
      return s;
    } else {
      await page.waitForTimeout(200);
    }
    if (Date.now() > deadline) throw new Error(`${label}: stuck at ${JSON.stringify(await page.evaluate(STATE)).slice(0, 300)}`);
  }
}

// Same guard, same message, as the other three gates. Without it a missing
// server is a timeout somewhere inside settle() — the gate reads as broken when
// nothing was ever there to test, which is the confusion this whole area exists
// to remove.
await fetch(URL_BASE).catch(() => {
  console.error(`FAIL: no dev server at ${URL_BASE} — run: npm run dev -- --port 5199`);
  process.exit(1);
});

const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
const context = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
const page = await context.newPage();
// The no-keyboard counter goes in before any script runs, so it sees every
// keydown the page ever gets — including one this script might send by
// mistake, which is the whole point of counting.
await page.addInitScript(() => {
  window.__keydowns = 0;
  window.addEventListener("keydown", () => { window.__keydowns++; }, true);
});
page.on("pageerror", (e) => check(false, `page error: ${e.message}`));

await page.goto(`${URL_BASE}?game=nethack&touch`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__vhBooted, null, { timeout: 30000 });
await page.waitForFunction(() => document.getElementById("touchbar"), null, { timeout: 30000 });

console.log(`viewport ${VIEWPORT.width}x${VIEWPORT.height}, touch context\n`);

// --- the layer exists and fits ---
let s = await page.evaluate(STATE);
check(s.pad.length === 9, `the pad has nine keys (${s.pad.join("")})`);
check(s.bar.length === 7, `the bar has seven slots (${s.bar.join(", ")})`);
check(s.bar[0] === "Search" && s.bar[6] === "More", `the tail is last and the verbs come first`);
check(s.cam !== null, `the camera button is there (${s.cam})`);
const box = await page.evaluate(() => {
  const r = (id) => { const b = document.getElementById(id)?.getBoundingClientRect(); return b && { x: b.x, y: b.y, w: b.width, h: b.height }; };
  return { bar: r("touchbar"), pad: r("touchpad"), cam: r("touchcam"), doc: document.documentElement.scrollWidth };
});
check(box.doc <= VIEWPORT.width, `the page does not scroll sideways (scrollWidth ${box.doc})`);
check(box.bar.x >= 0 && box.bar.x + box.bar.w <= VIEWPORT.width, `the bar fits the width (${Math.round(box.bar.w)}px)`);
check(box.bar.w / 7 >= 44, `each bar slot is at least a 44px target (${(box.bar.w / 7).toFixed(1)}px)`);
check(box.pad.w / 3 >= 44, `each pad key is at least a 44px target (${(box.pad.w / 3).toFixed(1)}px)`);
check(box.pad.x + box.pad.w <= VIEWPORT.width && box.pad.y + box.pad.h <= box.bar.y,
  `the pad sits clear of the bar (pad bottom ${Math.round(box.pad.y + box.pad.h)}, bar top ${Math.round(box.bar.y)})`);

// --- the whole of character creation, by finger ---
const t0 = Date.now();
s = await settle(page, "character creation", true);
const bornMs = Date.now() - t0;
check(!!s.hero, `a character was created and a hero is on the level (${JSON.stringify(s.hero)}) in ${(bornMs / 1000).toFixed(1)}s`);
check(/HP:/.test(s.status), `the status line is live: ${s.status.trim().slice(0, 70)}`);
check(s.keydowns === 0, `no keyboard event reached the page during creation (${s.keydowns})`);

// --- walking, by finger ---
// Which way is open depends on where the hero spawned, so try every pad key
// in turn until one of them moves the hero, exactly as browser-check does.
const PAD_ORDER = [1, 7, 3, 5, 0, 2, 6, 8];
let moved = null;
for (const i of PAD_ORDER) {
  const before = (await page.evaluate(STATE)).hero;
  await tap(page, "#touchpad button", i);
  const after = (await page.evaluate(STATE)).hero;
  if (after && before && (after.x !== before.x || after.y !== before.y)) {
    moved = { i, before, after };
    break;
  }
}
check(!!moved, moved
  ? `the hero walks on a pad tap: key ${moved.i} moved ${JSON.stringify(moved.before)} -> ${JSON.stringify(moved.after)}`
  : `the hero never moved for any of the eight pad keys`);

// One tap is one step: the hero must not still be travelling.
if (moved) {
  const settled = (await page.evaluate(STATE)).hero;
  await page.waitForTimeout(700);
  const later = (await page.evaluate(STATE)).hero;
  check(settled.x === later.x && settled.y === later.y,
    `one tap is one step — the hero stopped where the tap put it (${JSON.stringify(later)})`);
}

// --- the pad centre and the camera button are chrome ---
const evsPatch = await page.evaluate(() => {
  const v = window.__nhView;
  window.__evs = 0;
  const inner = v.handle.bind(v);
  v.handle = (ev) => { window.__evs++; return inner(ev); };
  return true;
});
const evs = () => page.evaluate(() => window.__evs);
check(evsPatch, "windowport traffic instrumented");
let before = await evs();
await tap(page, "#touchpad button", 4);
let after = await evs();
let hs = await page.evaluate(STATE);
check(after === before, `the pad centre feeds the engine nothing (${after - before} events)`);
check(Math.abs(hs.heading) < 1e-6, `the pad centre faces the camera north (heading ${hs.heading})`);

before = await evs();
await tap(page, "#touchcam");
after = await evs();
hs = await page.evaluate(STATE);
check(hs.mode === "first", `the camera button is the F2 equivalent (mode ${hs.mode}, label ${hs.cam})`);
check(after === before, `and it feeds the engine nothing (${after - before} events)`);
await tap(page, "#touchcam");
hs = await page.evaluate(STATE);
check(hs.mode === "orbital", `and toggles back (mode ${hs.mode})`);

// --- a non-movement action, by finger: Search ---
before = await evs();
const beforeHero = (await page.evaluate(STATE)).hero;
await tap(page, "#touchbar button", 0); // Search
await page.waitForTimeout(400);
after = await evs();
hs = await page.evaluate(STATE);
check(after > before, `Search took a turn: the engine redrew (${after - before} events)`);
check(hs.hero.x === beforeHero.x && hs.hero.y === beforeHero.y,
  `and Search is not a step — the hero stayed put (${JSON.stringify(hs.hero)})`);

// --- the tail: the Module's own command menu, opened by finger ---
// Settle first: a search that turns something up leaves a blocking window,
// and showActionMenu rightly declines to stomp on one. Without this the step
// below is a coin flip on what the last turn happened to print.
await settle(page, "before More");
await tap(page, "#touchbar button", 6); // More
hs = await page.evaluate(STATE);
check(/Items\.\.\./.test(hs.overlayText ?? ""), `More opens NetHack's own command menu (${(hs.overlayText ?? "").split("\n")[0]})`);
await tap(page, "#overlay [data-pi]", 0); // Items...
await tap(page, "#overlay [data-pi]", 0); // Inventory
await page.waitForTimeout(400);
hs = await page.evaluate(STATE);
check(/have|Not carrying|empty-handed|Coins|weapon/i.test(`${hs.overlayText ?? ""}${hs.msg}`),
  `and a two-level pick reaches the engine: ${(hs.overlayText ?? hs.msg).split("\n")[0].slice(0, 60)}`);
await settle(page, "after inventory");

// --- a directional verb, which is the thing the pad unlocked ---
await settle(page, "before Open");
await tap(page, "#touchbar button", 2); // Open
hs = await page.evaluate(STATE);
const askedDirection = /direction/i.test(hs.promptText ?? "");
check(askedDirection, `Open reaches NetHack's own getdir(): ${(hs.promptText ?? "(no prompt)").slice(0, 50)}`);
if (askedDirection) {
  check(hs.barLocked, `and the bar locks itself while the question is up`);
  await tap(page, "#touchpad button", 1); // answer it with the pad
  hs = await page.evaluate(STATE);
  check(!/direction/i.test(hs.promptText ?? ""), `and the pad answers it (prompt now ${JSON.stringify(hs.promptText)})`);
  check(hs.msg.length > 0, `the engine answered: "${hs.msg}"`);
}
await settle(page, "after open");

// --- and nothing anywhere used a key ---
hs = await page.evaluate(STATE);
check(hs.keydowns === 0, `the whole run sent zero keyboard events (${hs.keydowns})`);

// --- observations, not checks -------------------------------------------
// No pass mark was written down before this run for the numbers in THIS block,
// so they are reported and not judged (AGENTS.md: a bar set afterwards is not
// evidence). The view's width does now have one — see the framing section
// below, which vect-hack-lxd pre-registered.
const opening = await page.evaluate(COLS_ACROSS);
const seen = await page.evaluate(() => {
  const r = window.__nhView.renderer;
  const c = document.getElementById("view").getBoundingClientRect();
  const ys = [];
  for (let f = 0.02; f <= 0.99; f += 0.02) {
    const v = r.pickCell(c.x + c.width * 0.5, c.y + c.height * f);
    if (v) ys.push(v.y);
  }
  return {
    rows: ys.length ? Math.max(...ys) - Math.min(...ys) + 1 : null,
    stage: document.getElementById("stage").getBoundingClientRect().height,
    messages: document.getElementById("messages").getBoundingClientRect().height,
    status: document.getElementById("status").getBoundingClientRect().height,
  };
});
console.log(`\nobserved (no pass mark set beforehand):`);
console.log(`  map cells across the view: ${opening} wide x ${seen.rows} deep (of 80x21)`);
console.log(`  vertical budget: messages ${Math.round(seen.messages)}px, stage ${Math.round(seen.stage)}px, status ${Math.round(seen.status)}px`);
const labels = await page.evaluate(() => [...document.querySelectorAll("#touchbar .tblabel")]
  .map((e) => ({ t: e.textContent, w: e.scrollWidth, box: Math.round(e.getBoundingClientRect().width) })));
console.log(`  bar labels: ${labels.map((l) => `${l.t}=${l.w}/${l.box}px`).join(" ")}`);

await page.screenshot({ path: ".preview/touch-390x844.png" });
console.log("\nscreenshot: .preview/touch-390x844.png");

// --- the framing, and the pinch that changes it (vect-hack-lxd) ------------
// The half of the touch spike that was not about controls at all. A phone
// could orbit and never zoom — wheel was the only zoom input and a touchscreen
// cannot produce one — and at a portrait aspect the fixed orbit radius framed
// about seven of the map's eighty columns. Driving a hero you cannot see is
// not playable, so this is a gate and not an observation.
//
// The pass marks were written down before the first post-change run (design
// target: hold ~21 columns across the view at and below a 1.6:1 stage):
//   1. the opening framing shows at least 16 columns;
//   2. a pinch that draws the fingers together leaves at least 1.2x that;
//   3. a pinch the other way leaves fewer than both — a zoom that only goes
//      one way is not a zoom.
//
// It goes through CDP rather than page.touchscreen, which can only tap: a real
// two-finger gesture is the only thing that proves OrbitCam's pointer
// bookkeeping, and synthesising pointer events in the page would test nothing
// but the code that synthesised them.
const MIN_OPENING_COLUMNS = 16;
const MIN_ZOOM_OUT_RATIO = 1.2;
console.log(`\ncamera framing and pinch zoom (vect-hack-lxd):`);
check(opening >= MIN_OPENING_COLUMNS,
  `the view opens on enough map to play: ${opening} columns of 80 (>= ${MIN_OPENING_COLUMNS})`);

const cdp = await context.newCDPSession(page);
const viewBox = await page.evaluate(() => {
  const b = document.getElementById("view").getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
});
/** Two fingers on the canvas, `from` pixels apart, taken to `to` pixels apart.
 *  Clear of the pad and the bar: 40% down the canvas is open map. */
async function pinch(from, to, steps = 10) {
  const cx = viewBox.x + viewBox.w / 2, cy = viewBox.y + viewBox.h * 0.4;
  const at = (span) => [
    { x: cx - span / 2, y: cy, id: 1 },
    { x: cx + span / 2, y: cy, id: 2 },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(from) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent",
      { type: "touchMove", touchPoints: at(from + ((to - from) * i) / steps) });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(300);
  return page.evaluate(COLS_ACROSS);
}

const out = await pinch(240, 60);
check(out >= opening * MIN_ZOOM_OUT_RATIO,
  `two fingers drawn together pull the camera back: ${opening} -> ${out} columns`
  + ` (>= ${(opening * MIN_ZOOM_OUT_RATIO).toFixed(1)})`);
const back = await pinch(60, 240);
check(back < out && back < opening,
  `and spread apart they push it in again: ${out} -> ${back} columns`
  + ` (below both ${out} and the ${opening} it opened on)`);
const afterPinch = await page.evaluate(STATE);
check(afterPinch.keydowns === 0,
  `and the pinches sent no keyboard event either (${afterPinch.keydowns})`);

// --- and the same phone WITHOUT the flag is exactly what it was yesterday ---
// The constraint the whole layer is gated for: a visitor who did not ask for
// touch must see no trace of it, and must still get vect-hack-d72's
// explanation. Same emulated device, one flag apart.
console.log("\nwithout the flag, same device:");
const plain = await context.newPage();
await plain.goto(`${URL_BASE}?game=nethack`, { waitUntil: "domcontentloaded" });
await plain.waitForFunction(() => window.__vhBooted, null, { timeout: 30000 });
await plain.waitForTimeout(1500);
const bare = await plain.evaluate(() => ({
  touchEls: ["touchbar", "touchpad", "touchcam"].filter((id) => document.getElementById(id)),
  bodyClass: document.body.className,
  notice: !document.getElementById("nokeyboard").hidden,
  noticeText: document.getElementById("nokeyboardtext").textContent,
}));
check(bare.touchEls.length === 0, `no touch element is built (${JSON.stringify(bare.touchEls)})`);
check(!/vh-touch/.test(bare.bodyClass), `the body carries no touch class ("${bare.bodyClass}")`);
check(bare.notice, `and vect-hack-d72's explanation still shows: "${bare.noticeText.slice(0, 48)}..."`);
await plain.close();

// --- and it shows LEGIBLY, on every Module (vect-hack-0a4) -----------------
// This is the one part of the gate that is not about ?touch, and it is here
// rather than in mobile-preview.mjs because that script is a scratch tool
// nobody's merge depends on: it PRINTS "<-- SCROLLS SIDEWAYS" and exits 0. A
// number that only shames you is not a guard.
//
// What it pins: at 390px no Module may widen the layout viewport. #overlay
// carries 80 columns of monospace and its containing block is the initial
// one, so an unconstrained overlay pushed the ICB to 549 — and #nokeyboard,
// though correctly position:fixed, is fixed to THAT, which is how its button
// and its dismiss link ended up past the right edge of a 390px phone with no
// way to reach them.
//
// So the assertion is the two of them together, and both halves are load
// bearing. The width alone would go green on a page that stopped drawing the
// notice at all; the notice's own box alone would go green at 549 the day
// something else widened the document. And because the overlay is the thing
// that used to do the widening, a Module that happens to have no overlay up
// proves nothing — so `overlayUp` is checked too for the three that do, and
// the run fails rather than passes if this ever measures an empty page.
console.log("\nno Module scrolls a phone sideways (vect-hack-0a4):");
const FIT = () => {
  const box = (id) => {
    const el = document.getElementById(id);
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
  };
  return {
    docScroll: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    overlayUp: !document.getElementById("overlay").hidden,
    overlay: box("overlay"),
    notice: !document.getElementById("nokeyboard").hidden,
    watch: box("nokeyboardwatch"),
    dismiss: box("nokeyboarddismiss"),
  };
};
for (const game of ["nethack", "larn", "angband", "moria"]) {
  const p = await context.newPage();
  await p.goto(`${URL_BASE}?game=${game}`, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => window.__vhBooted, null, { timeout: 30000 });
  // Wait for the engine to have PAINTED whatever it opens with, rather than
  // sleeping a fixed interval and hoping. The three Modules this check exists
  // for greet the player with a text window, so the overlay going up is the
  // readiness condition; a fixed sleep here would be the vect-hack-hfa bug in
  // a second gate, and under machine load it would go red for the wrong
  // reason. NetHack opens with no overlay, so its condition is the notice,
  // which every Module draws. A timeout is swallowed on purpose: the
  // assertions below report what was actually on screen, and a clean FAIL
  // naming the box beats a stack trace from the wait.
  const ready = game === "nethack"
    ? () => !document.getElementById("nokeyboard").hidden
    : () => !document.getElementById("overlay").hidden
        && !document.getElementById("nokeyboard").hidden;
  await p.waitForFunction(ready, null, { timeout: 30000 }).catch(() => {});
  const f = await p.evaluate(FIT);
  const inside = (b) => b && b.left >= 0 && b.right <= VIEWPORT.width;
  check(f.docScroll <= VIEWPORT.width && f.innerWidth <= VIEWPORT.width,
    `${game}: the page does not widen the viewport (scrollWidth ${f.docScroll}, innerWidth ${f.innerWidth})`);
  check(f.notice && inside(f.watch) && inside(f.dismiss),
    `${game}: the no-keyboard button and link are both on screen`
    + ` (watch ${JSON.stringify(f.watch)}, dismiss ${JSON.stringify(f.dismiss)})`);
  if (game !== "nethack") {
    check(f.overlayUp && inside(f.overlay),
      `${game}: and its opening text window is up and inside the width (${JSON.stringify(f.overlay)})`);
  } else {
    console.log(`       (nethack has no overlay up here — overlayUp=${f.overlayUp}, which is why it escaped 0a4)`);
  }
  await p.close();
}

await browser.close();

if (fail.length) {
  console.error(`\n${fail.length} failed:\n  ${fail.join("\n  ")}`);
  process.exit(1);
}
console.log("\nall touch checks passed");

// Phone preview: drives the real page in a real touch context at 390x844 and
// writes screenshots to .preview/mobile-*.png, plus a measurement of how much
// of the map the camera actually shows and whether the page scrolls sideways.
//
// The settle() below is lifted from touch-check.mjs — same affordances, same
// order — because reimplementing it simpler is how a preview ends up showing
// a state a player never reaches.
//
// Scratch tool, not a gate. Needs a dev server and a GPU.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const URL_BASE = process.env.NH_URL ?? "http://localhost:5199/";
const VIEWPORT = { width: 390, height: 844 };
const TAP_MS = 260;
const SETTLE_MS = 90000;
const CHROMIUM_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"];

mkdirSync(".preview", { recursive: true });

const STATE = () => {
  const shown = (id) => { const el = document.getElementById(id); return el && !el.hidden ? el : null; };
  const overlay = shown("overlay");
  const prompt = shown("prompt");
  const view = window.__nhView ?? window.__larnView ?? window.__angView ?? window.__moriaView;
  return {
    linein: !!document.getElementById("linein"),
    notice: !!shown("storagenotice"),
    nokeyboard: shown("nokeyboard")?.innerText?.trim().slice(0, 200) ?? null,
    chips: prompt ? [...prompt.querySelectorAll("[data-yn]")].map((e) => e.dataset.yn) : [],
    promptText: prompt?.innerText ?? null,
    overlayText: overlay?.innerText ?? null,
    rows: overlay ? [...overlay.querySelectorAll("[data-i],[data-pi],[data-act]")].length : 0,
    hero: view?.renderer?.map?.hero ?? null,
    mode: view?.renderer?.mode ?? null,
    status: document.getElementById("status")?.textContent ?? "",
    touchbar: !!document.getElementById("touchbar"),
    scrollWidth: document.documentElement.scrollWidth,
  };
};

/** How much of the map the player can actually see, measured through the
 *  renderer's OWN inverse mapping: pickCell() is what the Look HUD uses to
 *  turn a pointer position into a cell, so sampling the viewport with it asks
 *  the live camera rather than re-deriving a projection here. A probe that
 *  guessed the grid-to-world transform would return null the first time that
 *  transform changed, and a preview that silently measures nothing is worse
 *  than one that measures nothing loudly.
 *
 *  Read it as an UPPER bound: pickCell resolves through the floor plane, so a
 *  sample aimed near the horizon still names a distant cell the player cannot
 *  really read. If this says 11 of 80, fewer than 11 are legible. */
const COVERAGE = () => {
  const view = window.__nhView ?? window.__larnView ?? window.__angView ?? window.__moriaView;
  const r = view?.renderer;
  if (!r?.map || typeof r.pickCell !== "function") return null;
  const canvas = r.canvas ?? document.querySelector("canvas");
  const box = canvas?.getBoundingClientRect();
  if (!box || !box.width || !box.height) return null;
  const cols = new Set(), rows = new Set();
  const STEPS = 60;
  for (let i = 0; i <= STEPS; i++) {
    for (let j = 0; j <= STEPS; j++) {
      const cell = r.pickCell(box.x + (box.width * i) / STEPS, box.y + (box.height * j) / STEPS);
      if (cell) { cols.add(cell.x); rows.add(cell.y); }
    }
  }
  return { cols: r.map.cols, rows: r.map.rows, colsVisible: cols.size, rowsVisible: rows.size };
};

const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });

async function tap(page, selector, nth = 0) {
  await page.locator(selector).nth(nth).tap();
  await page.waitForTimeout(TAP_MS);
}

async function settle(page, label, needHero = false) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const s = await page.evaluate(STATE);
    if (s.notice) await tap(page, "#storagenoticedismiss");
    else if (s.linein) await tap(page, "#touchbar button", 0);
    else if (s.chips.length) {
      const want = /tutorial/i.test(s.promptText ?? "") ? "n"
        : s.chips.includes("y") ? "y" : s.chips[0];
      await tap(page, `#prompt [data-yn="${want}"]`);
    } else if (s.rows) await tap(page, "#overlay [data-i],#overlay [data-pi],#overlay [data-act]", 0);
    else if (s.overlayText !== null) await tap(page, "#overlay");
    else if (s.hero || !needHero) return s;
    else await page.waitForTimeout(200);
    if (Date.now() > deadline) { console.log(`      (${label}: gave up)`); return page.evaluate(STATE); }
  }
}

async function shot(page, name, note) {
  await page.screenshot({ path: `.preview/mobile-${name}.png` });
  const s = await page.evaluate(STATE);
  const cov = await page.evaluate(COVERAGE).catch(() => null);
  console.log(`  mobile-${name}.png — ${note}`);
  console.log(`      hero=${JSON.stringify(s.hero)} mode=${s.mode} touchbar=${s.touchbar}`
    + `  scrollWidth=${s.scrollWidth}${s.scrollWidth > VIEWPORT.width ? "  <-- SCROLLS SIDEWAYS" : ""}`);
  if (s.nokeyboard) console.log(`      no-keyboard notice up`);
  if (cov) console.log(`      camera shows ${cov.colsVisible}/${cov.cols} columns, ${cov.rowsVisible}/${cov.rows} rows`);
  return s;
}

async function phone(url) {
  const context = await browser.newContext({
    viewport: VIEWPORT, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  return { context, page };
}

console.log(`\n=== phone preview @ ${VIEWPORT.width}x${VIEWPORT.height}, real touch context ===\n`);

{
  const { context, page } = await phone(`${URL_BASE}?game=nethack&touch`);
  await shot(page, "1-nethack-touch-landing", "first paint, ?touch");
  await settle(page, "character creation", true);
  await page.waitForTimeout(1500);
  await shot(page, "2-nethack-touch-playing", "in a game, orbital, touch layer up");
  if (await page.locator("#touchcam").count()) {
    await tap(page, "#touchcam");
    await page.waitForTimeout(1500);
    await shot(page, "3-nethack-touch-firstperson", "same game, first person");
  }
  await context.close();
}

{
  const { context, page } = await phone(`${URL_BASE}?game=nethack`);
  await shot(page, "4-nethack-plain", "no ?touch: what a phone gets today");
  await context.close();
}

for (const game of ["larn", "angband", "moria"]) {
  const { context, page } = await phone(`${URL_BASE}?game=${game}`);
  await shot(page, `5-${game}`, `?game=${game}: no touch layer yet (vect-hack-21k)`);
  await context.close();
}

await browser.close();
console.log("\ndone\n");

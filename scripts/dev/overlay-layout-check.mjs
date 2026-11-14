// Real CSS layout, without an engine, server, or GPU. The shared panel must
// center regardless of its content height, and still scroll within the screen.
// Restoring the old fixed 6em top offset must fail the centering/prompt checks;
// forgetting the touch transform override must fail the touch bounds check.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Pass marks and samples are fixed before the first browser measurement.
const TOLERANCE_PX = 1;
const SAMPLES = [
  { width: 1652, height: 1252, rows: 24, clearPrompt: true },
  { width: 1280, height: 800, rows: 24, clearPrompt: true },
  { width: 1280, height: 800, rows: 6, clearPrompt: true },
  { width: 390, height: 844, rows: 24, clearPrompt: true, scrollX: true },
  { width: 960, height: 360, rows: 80, scrollY: true },
  { width: 390, height: 844, rows: 24, touch: true, scrollX: true },
];
const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
const skin = JSON.parse(await readFile(new URL("../../src/skins/quadrascan.json", import.meta.url), "utf8"));
const browser = await chromium.launch({
  headless: true, args: ["--disable-gpu", "--disable-3d-apis"],
});
try {
  for (const sample of SAMPLES) {
    const started = performance.now();
    // The page's own scripts stay off: index.html's module entry would boot the
    // app. page.evaluate still runs, because it goes through the debugger.
    const page = await browser.newPage({
      viewport: { width: sample.width, height: sample.height }, javaScriptEnabled: false,
    });
    try {
      await page.setContent(html);
      await page.evaluate((skin) => {
        document.documentElement.style.setProperty("--vh-bg", skin.background);
        for (const [prop, value] of Object.entries(skin.css)) {
          document.documentElement.style.setProperty(prop, value);
        }
      }, skin);
      await page.evaluate(({ rows, touch }) => {
        document.getElementById("messages").textContent = "You do not have enough gold for this item.";
        const prompt = document.getElementById("prompt");
        prompt.hidden = false;
        prompt.textContent = "Buy a Necromantic Tome? [ESC, any other key to accept]";
        document.getElementById("status").textContent = "Gold Remaining: 139";
        const overlay = document.getElementById("overlay");
        overlay.textContent = Array.from({ length: rows }, (_, i) =>
          String(i).padStart(2, "0") + " Store Inventory".padEnd(78)).join("\n");
        overlay.hidden = false;
        if (touch) {
          document.body.classList.add("vh-touch");
          const bar = document.createElement("div");
          bar.id = "touchbar";
          bar.innerHTML = "<button>Done</button>";
          document.getElementById("stage").appendChild(bar);
        }
      }, sample);
      const bounds = await page.evaluate(() => {
        const overlay = document.getElementById("overlay");
        const rect = overlay.getBoundingClientRect();
        return {
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2,
          rows: overlay.textContent.split("\n").length,
          visible: getComputedStyle(overlay).display !== "none",
          promptBottom: document.getElementById("prompt").getBoundingClientRect().bottom,
          statusTop: document.getElementById("status").getBoundingClientRect().top,
          touchBarTop: document.getElementById("touchbar")?.getBoundingClientRect().top,
          docWidth: document.documentElement.scrollWidth,
        };
      });
      const label = `${sample.width}x${sample.height}, ${sample.rows} rows${sample.touch ? ", touch" : ""}`;
      console.log(`${label}: ${JSON.stringify(bounds)} (${Math.round(performance.now() - started)}ms)`);
      assert.equal(bounds.visible, true, `${label}: panel must actually be visible`);
      assert.equal(bounds.rows, sample.rows, `${label}: no terminal rows may be discarded`);
      assert.ok(bounds.left >= 0 && bounds.right <= sample.width,
        `${label}: panel must fit horizontally`);
      assert.ok(bounds.top >= 0 && bounds.bottom <= sample.height,
        `${label}: panel must fit vertically`);
      assert.ok(bounds.docWidth <= sample.width, `${label}: page must not scroll sideways`);
      assert.ok(Math.abs(bounds.centerX - sample.width / 2) <= TOLERANCE_PX,
        `${label}: panel must be horizontally centered`);
      if (!sample.touch) {
        assert.ok(Math.abs(bounds.centerY - sample.height / 2) <= TOLERANCE_PX,
          `${label}: panel must be vertically centered`);
      } else {
        assert.ok(bounds.bottom <= bounds.touchBarTop,
          `${label}: panel must leave the touch action bar exposed`);
      }
      if (sample.clearPrompt) {
        assert.ok(bounds.top >= bounds.promptBottom, `${label}: panel must not cover the prompt`);
        assert.ok(bounds.bottom <= bounds.statusTop, `${label}: panel must not cover the status`);
      }
      // Programmatic scroll assignments also succeed with overflow:hidden.
      // Wheel input tests whether a USER can reach the clipped terminal text.
      if (sample.scrollX || sample.scrollY) {
        await page.mouse.move(bounds.centerX, bounds.centerY);
        await page.mouse.wheel(sample.scrollX ? 100 : 0, sample.scrollY ? 100 : 0);
        await page.waitForFunction(({ x, y }) => {
          const overlay = document.getElementById("overlay");
          return (!x || overlay.scrollLeft > 0) && (!y || overlay.scrollTop > 0);
        }, { x: sample.scrollX, y: sample.scrollY }, { timeout: 1500 }).catch(() => {});
        const scroll = await page.evaluate(() => {
          const overlay = document.getElementById("overlay");
          return { x: overlay.scrollLeft, y: overlay.scrollTop };
        });
        console.log(`  wheel scrolling: ${JSON.stringify(scroll)}`);
        if (sample.scrollX) assert.ok(scroll.x > 0, `${label}: hidden columns must be user-scrollable`);
        if (sample.scrollY) assert.ok(scroll.y > 0, `${label}: hidden rows must be user-scrollable`);
      }
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log("all overlay layout checks passed");

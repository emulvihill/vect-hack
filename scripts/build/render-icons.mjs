// Renders the raster icons index.html links from public/favicon.svg, the one
// source for the mark: public/apple-touch-icon.png (180x180, the home-screen
// icon) and public/og.png (1200x630, the link-preview card). Both are
// committed; this is run by hand when the SVG changes, never by the build,
// so a plain `vite build` needs no browser. Chromium through Playwright,
// because it is already a dev dependency and it rasterises the SVG exactly
// as a browser tab does.
//
//   node scripts/build/render-icons.mjs
import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";

const svg = await readFile("public/favicon.svg", "utf8");
const inline = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** The og card: the mark at the left, the wordmark in the www site's voice. */
const card = `<!doctype html><html><head><style>
  html, body { margin: 0; background: #000; }
  body { width: 1200px; height: 630px; display: flex; align-items: center; gap: 64px; padding: 0 96px; box-sizing: border-box; }
  img { width: 400px; height: 400px; }
  h1 { margin: 0; color: #fff; font: 400 92px/1 "Courier New", Courier, monospace; letter-spacing: 0.18em;
       text-shadow: 0 0 2px #fff, 0 0 8px #80d0ff, 0 0 24px #1030ff; }
  p { margin: 18px 0 0; color: #80d0ff; font: 400 27px/1.35 "Courier New", Courier, monospace; }
</style></head><body>
  <img src="${inline}">
  <div><h1>VECTHACK</h1><p>NetHack · Angband · Larn · Moria<br>as arcade vector graphics</p></div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(card);
  await writeFile("public/og.png", await page.screenshot({ type: "png" }));

  await page.setViewportSize({ width: 180, height: 180 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#000"><img src="${inline}" style="display:block;width:180px;height:180px"></body></html>`);
  await writeFile("public/apple-touch-icon.png", await page.screenshot({ type: "png" }));
} finally {
  await browser.close();
}
console.log("wrote public/og.png (1200x630) and public/apple-touch-icon.png (180x180)");

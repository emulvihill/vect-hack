// The acceptance test for vect-hack-l11: a Module downloads when someone plays
// it, not before. Visiting ?game=larn must fetch none of NetHack's, Angband's
// or Moria's JavaScript.
//
// It asks the question as a browser asks it — request URLs on a cold cache
// against a real production build — rather than as a chunk graph, because a
// build whose graph looks split can still import every arm eagerly and a
// visitor would never know the difference.
//
// Attribution is exact, not a string heuristic: a rolldown plugin records each
// emitted chunk's own module ids at generateBundle time, so a chunk "belongs
// to" a Module when it contains a file under src/modules/<M>/. The same pass
// records which chunks contain three.js, which is the bead's named regression
// in disguise — a split that copies the shared render layer per Module trades
// one big download for four.
//
// It is also the acceptance test for vect-hack-po4's first direction: a browser
// with no GPU takes the tty view (src/ui/chooseView.ts) and must not download
// the WebGPU renderer to draw a character grid. That arm denies both APIs at
// the Chromium switch, as browser-check.mjs's nogpu arm does, and fails if the
// page still fetched the three.js chunk. Denied by the browser rather than by a
// stub, because the page's own probe is what decides.
//
// Needs no GPU: the normal arm takes whatever view this machine's headless
// Chromium can give it, and the view it built is recorded beside the bytes so a
// reading of the table can tell which path it measured. Needs no dev server
// either — hence `standalone: true` in gate-run-utils.mjs's GATES, which is
// what lets `npm run check:gates` drive this first, before it asks the machine
// for a render node or starts anything on 5199 (vect-hack-qv1).
import { build, preview } from "vite";
import { chromium } from "playwright";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";

const MODULES = ["nethack", "angband", "larn", "moria"];
/** Loads per Module for the time-to-interactive median. */
const TTI_SAMPLES = Number(process.env.VH_TTI_SAMPLES ?? 5);
/** A cold boot on a slow machine; the tty fallback path is the slowest. */
const BOOT_MS = 30000;
const OUT = process.env.VH_PAYLOAD_OUT ?? ".preview/payload.json";

/** The global each Module's boot block publishes its view on (src/main.ts). */
const VIEW_GLOBAL = {
  nethack: "__nhView",
  angband: "__angbandView",
  larn: "__larnView",
  moria: "__moriaView",
};

/** Chunk name -> the Modules whose sources it carries, plus a three.js flag. */
async function buildAndAttribute() {
  const chunks = new Map();
  await build({
    logLevel: "warn",
    plugins: [{
      name: "vh-payload-attribution",
      generateBundle(_options, bundle) {
        for (const [fileName, out] of Object.entries(bundle)) {
          if (out.type !== "chunk") continue;
          const owners = new Set();
          let three = false;
          for (const id of out.moduleIds ?? []) {
            const norm = id.replaceAll("\\", "/");
            for (const m of MODULES) if (norm.includes(`/src/modules/${m}/`)) owners.add(m);
            if (/\/node_modules\/(\.vite\/deps\/)?three[/@]/.test(norm)) three = true;
          }
          chunks.set(fileName, { owners: [...owners], three, bytes: out.code.length });
        }
      },
    }],
  });
  return chunks;
}

/** One cold-cache load: every JS URL the page fetched, and when the view appeared. */
async function load(browser, url, viewGlobal) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Stamp the moment the view object exists, in the page's own clock, so the
  // number is navigation start to interactive and not "when the poll noticed".
  await page.addInitScript((name) => {
    const tick = () => {
      if (window[name]) window.__vhTti = performance.now();
      else setTimeout(tick, 1);
    };
    tick();
  }, viewGlobal);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const requests = [];
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (u.pathname.endsWith(".js")) requests.push(u.pathname.replace(/^\//, ""));
  });
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForFunction(() => window.__vhTti !== undefined, null, { timeout: BOOT_MS });
  const tti = await page.evaluate(() => window.__vhTti);
  // The request set is collected after the page settles, not at the moment the
  // view appeared: a Module's worker chunk is fetched by the worker thread and
  // lands after boot, and a run that stopped at the view would count a
  // different number of requests every time it raced that fetch.
  await page.waitForLoadState("networkidle", { timeout: BOOT_MS }).catch(() => {});
  // Transferred size is what the visitor paid for, so read it from the entries
  // rather than from the file sizes: a compressed response is smaller than the
  // chunk, and the point of the bead is what crosses the wire.
  const transferred = await page.evaluate(() =>
    performance.getEntriesByType("resource")
      .filter((e) => new URL(e.name).pathname.endsWith(".js"))
      .reduce((n, e) => n + (e.transferSize || e.encodedBodySize || 0), 0));
  // Which arm of the degrade policy actually ran. Bytes alone cannot say, and
  // after vect-hack-po4 the two arms fetch different chunks — a normal run that
  // quietly fell back to the tty view would report the no-GPU number as if it
  // were the common case. Read as "is the canvas still there", because a
  // production build mangles the view class's name and `oe` says nothing;
  // dropping the canvas is what chooseView() does on both tty arms.
  const canvas = await page.evaluate(() => !!document.getElementById("view"));
  await context.close();
  return { requests: [...new Set(requests)], tti, transferred, canvas };
}

// "transferred" is what vite preview sent the page: gzip (preview compresses),
// and only the page's own fetches — a worker's requests are on the worker's
// performance timeline, so the worker chunk and the engine glue never count.
// vecthack.com's CloudFront serves brotli where the browser accepts it. So
// beside it, every request the load recorded, page and worker alike, is
// compressed from the built file it maps to: what a visitor pays, both ways.
// A request with no built file behind it — the engine glue on a machine that
// never built the engines, CI included — adds nothing and is listed instead.
const compressedSizes = new Map();
async function compressed(requests, distDir, base) {
  const sum = { gzip: 0, brotli: 0, notBuilt: [] };
  for (const p of requests) {
    if (!compressedSizes.has(p)) {
      let body = null;
      try {
        body = await readFile(resolve(distDir, p.startsWith(base) ? p.slice(base.length) : p));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      compressedSizes.set(p, body && { gzip: gzipSync(body).length, brotli: brotliCompressSync(body).length });
    }
    const size = compressedSizes.get(p);
    if (!size) { sum.notBuilt.push(p); continue; }
    sum.gzip += size.gzip;
    sum.brotli += size.brotli;
  }
  return sum;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const chunks = await buildAndAttribute();
const threeChunks = [...chunks].filter(([, c]) => c.three).map(([f]) => f);

const server = await preview({ logLevel: "warn", preview: { port: 0, strictPort: false } });
const base = server.resolvedUrls.local[0];
const distDir = resolve(server.config.root, server.config.build.outDir);
// Request paths are recorded without their leading slash, so the base is too.
const basePath = server.config.base.replace(/^\//, "");
const browser = await chromium.launch();
// The no-GPU visitor's browser. --disable-3d-apis is Chromium's own switch for
// "3D content is blocked": navigator.gpu returns no adapter and
// getContext("webgl2") returns null, in the renderer process, before any page
// script runs (scripts/dev/browser-check.mjs says the same at more length).
const blindBrowser = await chromium.launch({ args: ["--disable-3d-apis"] });

const report = { modules: {}, threeChunks, chunks: Object.fromEntries(chunks) };
let failures = [];
for (const m of MODULES) {
  const url = `${base}?game=${m}`;
  const first = await load(browser, url, VIEW_GLOBAL[m]);
  const ttis = [first.tti];
  for (let i = 1; i < TTI_SAMPLES; i++) ttis.push((await load(browser, url, VIEW_GLOBAL[m])).tti);
  // A request is a leak when the chunk it named carries ANY other Module's
  // source — not merely when it fails to carry this one's. The difference is
  // the whole test: today's single index chunk is owned by all four Modules at
  // once, so "does it include m?" is an assertion that cannot fail, and the
  // unsplit build would pass its own acceptance test. A chunk owned by nobody
  // is shared code and is not a leak.
  const leaks = first.requests.filter((p) => {
    const c = chunks.get(p);
    return c && c.owners.some((o) => o !== m);
  });
  // The same page in a browser that was denied both graphics APIs. One load,
  // no TTI samples: this arm is about which chunks crossed the wire, and the
  // tty view's boot time is not a number anyone is tuning.
  const blind = await load(blindBrowser, url, VIEW_GLOBAL[m]);
  const blindThree = blind.requests.filter((p) => chunks.get(p)?.three);
  const packed = await compressed(first.requests, distDir, basePath);
  const blindPacked = await compressed(blind.requests, distDir, basePath);
  report.modules[m] = {
    requests: first.requests,
    js: first.requests.length,
    transferred: first.transferred,
    gzip: packed.gzip,
    brotli: packed.brotli,
    notBuilt: packed.notBuilt,
    vector: first.canvas,
    ttiMedian: Math.round(median(ttis)),
    ttis: ttis.map(Math.round),
    leaks,
    noGpu: {
      requests: blind.requests,
      js: blind.requests.length,
      transferred: blind.transferred,
      gzip: blindPacked.gzip,
      brotli: blindPacked.brotli,
      notBuilt: blindPacked.notBuilt,
      vector: blind.canvas,
      three: blindThree,
    },
  };
  if (leaks.length) failures.push(`${m}: fetched ${leaks.join(", ")} — chunks belonging to another Module`);
  if (blindThree.length) {
    failures.push(`${m}: a browser with no GPU fetched ${blindThree.join(", ")} — the tty view `
      + `must not download the WebGPU renderer (vect-hack-po4)`);
  }
  console.log(`${m.padEnd(8)} js=${String(first.requests.length).padStart(2)} `
    + `transferred=${(first.transferred / 1024).toFixed(1)}kB `
    + `gzip=${(packed.gzip / 1024).toFixed(1)}kB brotli=${(packed.brotli / 1024).toFixed(1)}kB `
    + `tti=${Math.round(median(ttis))}ms leaks=${leaks.length} vector=${first.canvas}`
    + (packed.notBuilt.length ? ` not-built=${packed.notBuilt.join(",")}` : ""));
  console.log(`${"".padEnd(8)} no-GPU: js=${String(blind.requests.length).padStart(2)} `
    + `transferred=${(blind.transferred / 1024).toFixed(1)}kB `
    + `gzip=${(blindPacked.gzip / 1024).toFixed(1)}kB brotli=${(blindPacked.brotli / 1024).toFixed(1)}kB `
    + `three=${blindThree.length} vector=${blind.canvas}`
    + (blindPacked.notBuilt.length ? ` not-built=${blindPacked.notBuilt.join(",")}` : ""));
}

// If the GPU arm never got a canvas on ANY Module, this machine has no 3D at
// all and both arms measured the same tty page — which makes the assertion
// above ("a browser with no GPU fetched no renderer") true by construction,
// the one outcome this repo treats as worse than no assertion. A headless
// Chromium normally supplies WebGL through SwiftShader, which is why the
// browser gate's nogpu arm has to pass --disable-3d-apis to deny it; a run
// where that is not so has not measured the split and must not report green.
if (Object.values(report.modules).every((r) => !r.vector)) {
  failures.push("no Module's GPU arm produced a canvas, so both arms measured the tty view and the "
    + "no-GPU assertion proved nothing — this machine has no 3D for headless Chromium to use");
}

if (threeChunks.length !== 1) {
  failures.push(`three.js appears in ${threeChunks.length} chunks (${threeChunks.join(", ") || "none"}); `
    + `exactly one is required — a per-Module copy is a regression in disguise`);
}
console.log(`three.js chunks: ${threeChunks.join(", ") || "none"}`);

await browser.close();
await blindBrowser.close();
await server.close();

await mkdir(OUT.replace(/\/[^/]*$/, ""), { recursive: true });
await writeFile(OUT, JSON.stringify(report, null, 2));
console.log(`wrote ${OUT}`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("PASS every Module fetched only its own JavaScript, and no-GPU fetched no renderer");

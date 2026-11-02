// Serves the deployed layout of vecthack.com locally, on one port:
//   /play/*  -> dist/          (this repo, built with `vite build --base /play/`)
//   /*       -> the landing page in ../vect-hack-www/site (VH_SITE overrides)
// Static files only, no rebuild on change: rerun `npm run serve:www` after a
// source edit. Nothing here reaches production — that is vect-hack-www's job.
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DIST = join(ROOT, "dist");
const SITE = resolve(process.env.VH_SITE ?? join(ROOT, "..", "vect-hack-www", "site"));
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

for (const [name, dir] of [["dist", DIST], ["site", SITE]]) {
  const s = await stat(dir).catch(() => null);
  if (!s?.isDirectory()) {
    console.error(`serve-www: ${name} directory missing: ${dir}`);
    process.exit(1);
  }
}

/** null when the path is not valid percent-encoding: the caller answers 400. */
function locate(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // a stray "%zz" would otherwise throw out of the async handler and take the server down
  }
  const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  if (clean === "/play" || clean.startsWith("/play/")) {
    return { base: DIST, rel: clean.slice("/play".length) || "/" };
  }
  return { base: SITE, rel: clean };
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const located = locate(pathname);
  if (!located) {
    res.writeHead(400, { "content-type": "text/plain" }).end("bad request");
    return;
  }
  const { base, rel } = located;
  let file = resolve(join(base, rel));
  if (!file.startsWith(base)) {
    res.writeHead(403).end();
    return;
  }
  let s = await stat(file).catch(() => null);
  if (s?.isDirectory()) {
    file = join(file, "index.html");
    s = await stat(file).catch(() => null);
  }
  if (!s?.isFile()) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": s.size,
    "cache-control": "no-cache",
  });
  createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`site  ${SITE}`);
  console.log(`play  ${DIST}`);
  console.log(`http://127.0.0.1:${PORT}/  ->  /play/?game=nethack`);
});

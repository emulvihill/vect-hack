// Which engine artifacts each game needs under public/modules/, and a Vite
// plugin that says so out loud when they are missing.
//
// public/modules/ is gitignored build output, so a fresh clone has no engines.
// Without this plugin the dev server answers a missing /modules/<game>/<file>
// with index.html at status 200 (its SPA fallback), the worker's dynamic
// import of that HTML fails, and the page reports an engine death that offers
// the Saves button as the cure. A clone that skipped the four builds then
// looks like a broken save rather than a missing build step.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** One row per game: the files its worker loads; `npm run build:<game>` makes them. */
export const ENGINES = [
  { game: "nethack", files: ["nethack.js", "nethack.wasm"] },
  { game: "angband", files: ["angband.js", "angband.wasm", "angband.data"] },
  { game: "larn", files: ["larn.js", "larn.wasm", "larn.data"] },
  { game: "moria", files: ["moria.js", "moria.wasm", "moria.data"] },
];

/** The games whose artifacts are not all present under `<root>/public/modules/`. */
export function missingEngines(root) {
  return ENGINES.filter(({ game, files }) =>
    files.some((f) => !existsSync(join(root, "public", "modules", game, f))),
  ).map(({ game }) => game);
}

function warning(missing) {
  return [
    "",
    `  vect-hack: engine not built: ${missing.join(", ")}`,
    "  Those games die on load. Build them with",
    missing.length === ENGINES.length
      ? "    npm run build:engines"
      : `    ${missing.map((g) => `npm run build:${g}`).join(" && ")}`,
    "  (first time: npm run setup does the toolchain and all four; see README).",
    "",
  ].join("\n");
}

/**
 * Vite plugin: warn at dev-server start and at build time when an engine is
 * missing, and answer a missing /modules/ file with a 404 instead of the SPA
 * fallback's index.html. Warns, never refuses: CI's check:payload runs a real
 * `vite build` with no engines on purpose.
 */
export function engineArtifacts(root) {
  let command = "serve";
  return {
    name: "vect-hack-engine-artifacts",
    configResolved(config) {
      command = config.command;
    },
    configureServer(server) {
      const base = server.config.base;
      const missing = missingEngines(root);
      if (missing.length) server.config.logger.warn(warning(missing));
      server.middlewares.use((req, res, next) => {
        let path;
        try {
          path = decodeURIComponent((req.url ?? "").split("?")[0]);
        } catch {
          return next(); // malformed escape: Vite's own handling answers it
        }
        if (!path.startsWith(base + "modules/")) return next();
        const rel = path.slice(base.length);
        if (rel.includes("..") || existsSync(join(root, "public", rel))) return next();
        const game = (rel.split("/")[1] ?? "").replace(/-versions$/, ""); // moria-versions/ is Moria's
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain");
        res.end(`${rel} is not built. Run: npm run build:${game}\n`);
      });
    },
    buildStart() {
      // Dev runs buildStart too; configureServer already warned there.
      if (command !== "build") return;
      const missing = missingEngines(root);
      if (missing.length) this.warn(warning(missing));
    },
  };
}

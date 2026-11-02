import { defineConfig } from "vite";

export default defineConfig({
  // The deploy serves the app under a sub-path (/play/), and the base is
  // load-bearing for more than asset hrefs: every worker builds its module
  // URL from import.meta.env.BASE_URL, so a wrong base 403s the engine too.
  // It arrives as an env var because `npm run build -- --base /play/` CANNOT
  // work — npm appends those args after the whole `&&` chain, so they land on
  // stage-licenses.mjs (which ignores them) and vite never sees a base.
  base: process.env.VH_BASE ?? "/",
  // Keep vite's scanner/watcher out of external/ (NetHack submodule + emsdk).
  optimizeDeps: { entries: ["index.html"] },
  server: { watch: { ignored: ["**/external/**"] } },
});

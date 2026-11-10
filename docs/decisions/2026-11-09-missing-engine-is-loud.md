## 2026-11-09 — A missing engine is a dev-server warning and a 404

**Decision:** `vite.config.ts` loads `scripts/build/engine-artifacts.mjs`. At
dev-server start and in `vite build` it lists the games whose
`public/modules/<game>/` artifacts are missing, with the build command. A
request for a missing `/modules/` file gets a plain-text 404 that names the build
command. The plugin warns and never refuses. `npm run setup` (toolchain plus
`build:engines`) is the single first-time command the README leads with.

**Why:** a fresh clone on TRON ran `npm install`, `setup-toolchain.sh`,
`npm run build` and `npm run dev`, but none of the four engine builds. Vite's
SPA fallback answered `angband.js` with `index.html` at 200, the worker's
import failed, and the page blamed the stored save. Refusing is out because
CI's `check:payload` runs a real `vite build` with no engines on purpose.

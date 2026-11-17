import { defineConfig } from "vite";
import { engineArtifacts } from "./scripts/build/engine-artifacts.mjs";

export default defineConfig({
  base: process.env.VH_BASE ?? "/",
  optimizeDeps: { entries: ["index.html"] },
  server: { watch: { ignored: ["**/external/**"] } },
  // A fresh clone has no engines; say so instead of serving index.html for them.
  plugins: [engineArtifacts(import.meta.dirname)],
});

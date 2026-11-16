import { defineConfig } from "vitest/config";

// `npm run preview` only: the radar image generator draws through the real
// drawRadar() and asserts nothing, so it lives outside the `unit` project's
// `*.test.ts` glob and never runs under `npm test`.
export default defineConfig({
  test: { include: ["scripts/dev/radar-preview.ts"], environment: "node" },
});

import { defineConfig } from "vitest/config";

// `npm run preview` only: the scene and radar image generators draw through the
// real renderers and assert nothing, so they live outside the `unit` project's
// `*.test.ts` glob and never run under `npm test`.
export default defineConfig({
  test: {
    include: ["scripts/dev/scene-preview.ts", "scripts/dev/radar-preview.ts"],
    environment: "node",
  },
});

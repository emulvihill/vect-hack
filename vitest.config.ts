import { defineConfig } from "vitest/config";

// `unit` is every *.test.ts: no engine build needed (CI runs it). Each
// `engine-<game>` project runs that Module's `test:<game>-*` package.json
// scripts against its real WASM build, one after another; the four engine
// projects run in parallel with each other and with `unit`.
const GAMES = ["nethack", "angband", "larn", "moria"];

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["scripts/{test,dev}/**/*.test.ts"], environment: "node" } },
      ...GAMES.map((game) => ({
        test: { name: `engine-${game}`, include: [`scripts/test/${game}/*.engine.ts`], environment: "node" },
      })),
    ],
  },
});

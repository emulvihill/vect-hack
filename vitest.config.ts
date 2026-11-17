import { defineConfig } from "vitest/config";

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

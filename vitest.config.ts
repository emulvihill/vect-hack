import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/{test,dev}/**/*.test.ts"],
    environment: "node",
  },
});

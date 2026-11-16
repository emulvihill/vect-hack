import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../../../vitest.config";
import { engineScripts } from "../engine";

const GAMES = ["nethack", "angband", "larn", "moria"];
const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

describe("engine projects", () => {
  it("gives every Module an engine project over its own folder, beside unit", () => {
    const projects = (config.test?.projects ?? []) as { test: { name: string; include: string[] } }[];
    expect(projects.map((p) => p.test.name)).toEqual(["unit", ...GAMES.map((g) => `engine-${g}`)]);
    for (const game of GAMES) {
      const project = projects.find((p) => p.test.name === `engine-${game}`);
      expect(project?.test.include).toEqual([`scripts/test/${game}/*.engine.ts`]);
      expect(readFileSync(new URL(`../${game}/${game}.engine.ts`, import.meta.url), "utf8"))
        .toContain(`engineTests("${game}")`);
      expect(pkg.scripts[`test:${game}`]).toBe(`vitest run --project engine-${game}`);
    }
  });

  it("finds every Module's engine scripts, in package.json order, each with its time limit", () => {
    for (const game of GAMES) {
      const scripts = engineScripts(game, pkg.scripts);
      expect(scripts.length, game).toBeGreaterThan(0);
      expect(scripts.map((s) => s.name)).toEqual(Object.keys(pkg.scripts).filter((k) => k.startsWith(`test:${game}-`)));
    }
  });

  it("reads the limit from the timeout prefix and skips the aggregate script", () => {
    expect(engineScripts("larn", {
      "test:larn": "vitest run --project engine-larn",
      "test:larn-boot": "timeout 120 node boot.mjs",
      "test:larn-trace": "timeout 900 node trace.mjs",
    })).toEqual([{ name: "test:larn-boot", seconds: 120 }, { name: "test:larn-trace", seconds: 900 }]);
  });

  it("refuses an engine script with no timeout of its own", () => {
    expect(() => engineScripts("larn", { "test:larn-boot": "node boot.mjs" })).toThrow(/no `timeout N` prefix/);
  });
});

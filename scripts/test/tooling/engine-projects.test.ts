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
    // Expected from what each script runs, not from its name: a script that
    // runs a Module's driver but is named so its project misses it would
    // silently drop out of `npm test`.
    for (const game of GAMES) {
      const expected = Object.entries(pkg.scripts).flatMap(([name, command]) => {
        const m = /^timeout (\d+) node scripts\/test\/([a-z]+)\/test-\2-[\w-]+\.mjs\b/.exec(command);
        return m?.[2] === game ? [{ name, seconds: Number(m[1]) }] : [];
      });
      expect(expected.length, game).toBeGreaterThan(0);
      expect(engineScripts(game, pkg.scripts)).toEqual(expected);
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

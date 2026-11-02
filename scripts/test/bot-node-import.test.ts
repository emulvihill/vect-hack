// The headless gym (scripts/dev/bot-gym-larn.mjs) loads the bot straight
// from source under node's own type stripping — no bundler. That works only
// while every file on the chain uses relative imports with a .ts extension
// and erasable-only TypeScript (no parameter properties, no enum). This
// test is the guard: an extensionless import anywhere in the chain fails
// here, not in the gym at 2am. Task 6 points it at LarnBotPlayer.ts.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function importsUnderNode(relPath: string, symbol: string): string {
  const url = new URL(relPath, import.meta.url).href;
  return execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `const m = await import(${JSON.stringify(url)}); console.log(typeof m[${JSON.stringify(symbol)}]);`],
    { encoding: "utf8" },
  ).trim();
}

describe("the Larn bot chain loads under plain node", () => {
  it("imports the classifier, the tty grid, the key table and the CellGrid", () => {
    expect(importsUnderNode("../../src/modules/larn/classifier.ts", "LarnClassifier")).toBe("function");
    expect(importsUnderNode("../../src/modules/larn/grid.ts", "LarnGrid")).toBe("function");
    expect(importsUnderNode("../../src/modules/larn/keys.ts", "movementKey")).toBe("function");
    expect(importsUnderNode("../../src/backplane/cell.ts", "CellGrid")).toBe("function");
  });

  // The reproducibility gate (scripts/test/test-larn-repro.mjs) loads this one
  // straight from source too, so it is on the same no-bundler chain.
  it("imports the canonical record the reproducibility gate compares with", () => {
    expect(importsUnderNode("../../src/bot/canonical.ts", "canonicalLine")).toBe("function");
  });

  it("imports LarnBotPlayer.ts — the top of the gym's chain", () => {
    expect(importsUnderNode("../../src/modules/larn/bot/LarnBotPlayer.ts", "LarnBotPlayer")).toBe("function");
  });

  // The shared VectLarn bridge (vect-hack-dwb) is a third head: five of its
  // six hosts are .mjs files node loads with no bundler, so an extensionless
  // import or a non-erasable construct in it would break the gym and four
  // engine gates at once — which is the failure this bead's refactor is
  // supposed to have made impossible, not moved.
  it("imports the Larn shim bridge — the head of the five .mjs hosts' chain", () => {
    expect(importsUnderNode("../../src/modules/larn/shimBridge.ts", "installLarnShim")).toBe("function");
  });

  // A second head of the same chain: the digest builder is loaded from source
  // by scripts/dev/bot-reflect.mjs and by nothing else, so an extensionless
  // import there would fail only inside the reflect host, at batch time.
  it("imports the Larn digest builder — the head of the reflect host's chain", () => {
    expect(importsUnderNode("../../src/modules/larn/bot/digest.ts", "buildLarnDigest")).toBe("function");
  });

  // The KB is on the same chain: importing it here proves node can load it;
  // the grep proves it does not need node to. The grep covers the whole of
  // src/bot, not just kb.ts — the browser bot shares every file in there, so
  // "no filesystem" binds the directory, and a new file that reached for node
  // would otherwise land uncovered.
  it("imports the KB loader; nothing in src/bot reaches for the filesystem", () => {
    expect(importsUnderNode("../../src/bot/kb.ts", "loadKb")).toBe("function");
    const dir = new URL("../../src/bot/", import.meta.url);
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      expect(readFileSync(new URL(name, dir), "utf8"), name).not.toMatch(/from\s+"node:/);
    }
  });
});

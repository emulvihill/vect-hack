import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STORAGE_DECLINED_WARNING } from "../dev/gate-console.mjs";

// The three things src/backplane/persistentStorage.ts can say, copied verbatim
// from lines 28, 36 and 39. Only the middle one is a healthy answer; the other
// two mean the storage manager is missing or the request itself threw, and a
// gate that swallowed those would be hiding a real fault.
const NO_MANAGER = "[vect-hack] saves may be evicted: this browser has no storage manager";
const DECLINED = "[vect-hack] saves may be evicted: the browser declined persistence";
const REQUEST_FAILED = "[vect-hack] saves may be evicted: the persistence request failed: SecurityError";

describe("the storage-grant warning the gates allow", () => {
  it("matches the declined answer, which every headless run makes", () => {
    expect(STORAGE_DECLINED_WARNING.test(DECLINED)).toBe(true);
  });

  // This is the constraint that makes the allowlist worth having: it allows one
  // expected warning, not warnings in general.
  it("does not match the two answers that mean something is wrong", () => {
    expect(STORAGE_DECLINED_WARNING.test(NO_MANAGER)).toBe(false);
    expect(STORAGE_DECLINED_WARNING.test(REQUEST_FAILED)).toBe(false);
  });

  // Whole-message anchors, so a warning that merely quotes this one still fails.
  it("is anchored at both ends", () => {
    expect(STORAGE_DECLINED_WARNING.test(`while handling: ${DECLINED}`)).toBe(false);
    expect(STORAGE_DECLINED_WARNING.test(`${DECLINED} (twice)`)).toBe(false);
  });
});

describe("both gates that assert on console output share it", () => {
  // The bug this replaces was a regex that lived in one gate and not the other:
  // browser-check.mjs learned about the warning when the save-risk work shipped
  // and angband-borg-check.mjs did not, so the borg gate was red for two days.
  // A second copy of the pattern would let that happen again, so neither gate
  // may carry its own.
  const gates = ["browser-check.mjs", "angband-borg-check.mjs"];

  it.each(gates)("%s imports the shared constant", (gate) => {
    const src = readFileSync(new URL(`../dev/${gate}`, import.meta.url), "utf8");
    expect(src).toContain('import { STORAGE_DECLINED_WARNING } from "./gate-console.mjs"');
    expect(src).toMatch(/EXPECTED_CONSOLE.some\(\(re\) => re\.test\(m\.text\(\)\)\)|\.\.\.arm\.expectedConsole/);
  });

  it.each(gates)("%s does not carry its own copy of the pattern", (gate) => {
    const src = readFileSync(new URL(`../dev/${gate}`, import.meta.url), "utf8");
    expect(src).not.toMatch(/the browser declined persistence\$?\//);
  });
});

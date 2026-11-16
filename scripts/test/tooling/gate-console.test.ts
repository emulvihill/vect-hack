import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { STORAGE_DECLINED_WARNING } from "../../browser-check/gate-console.mjs";
import { requestPersistentStorage, type StorageManagerLike } from "../../../src/backplane/persistentStorage";

// The three things src/backplane/persistentStorage.ts can say, taken from the
// code itself so a reword there fails here rather than only in check:browser.
// Only the declined answer is a healthy one; the other two mean the storage
// manager is missing or the request itself threw, and a gate that swallowed
// those would be hiding a real fault. The page console joins a warning's
// arguments with spaces, which is what the gate's m.text() sees.
async function warning(storage: StorageManagerLike | null): Promise<string> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await requestPersistentStorage(storage);
    expect(warn).toHaveBeenCalledOnce();
    return warn.mock.calls[0]!.map(String).join(" ");
  } finally {
    warn.mockRestore();
  }
}
const NO_MANAGER = await warning(null);
const DECLINED = await warning({ persisted: async () => false, persist: async () => false });
const REQUEST_FAILED = await warning({
  persisted: async () => false,
  persist: () => Promise.reject(new Error("SecurityError")),
});

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
    const src = readFileSync(new URL(`../../browser-check/${gate}`, import.meta.url), "utf8");
    expect(src).toContain('import { STORAGE_DECLINED_WARNING } from "./gate-console.mjs"');
    expect(src).toMatch(/EXPECTED_CONSOLE.some\(\(re\) => re\.test\(m\.text\(\)\)\)|\.\.\.arm\.expectedConsole/);
  });

  it.each(gates)("%s does not carry its own copy of the pattern", (gate) => {
    const src = readFileSync(new URL(`../../browser-check/${gate}`, import.meta.url), "utf8");
    expect(src).not.toMatch(/the browser declined persistence\$?\//);
  });
});

import { describe, expect, it } from "vitest";
import { savedOnQuit } from "../../src/modules/larn/protocol";

describe("savedOnQuit", () => {
  it("does not let a checkpoint make a later non-save quit safe", () => {
    expect(savedOnQuit(true, 0)).toBe(false);
  });

  it("requires both a flushed save and native successful S-save", () => {
    expect(savedOnQuit(false, 1)).toBe(false);
    expect(savedOnQuit(true, 1)).toBe(true);
  });
});

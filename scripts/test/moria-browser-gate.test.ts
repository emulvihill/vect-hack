import { describe, expect, it } from "vitest";
import { exactNewKeys } from "../dev/moria-gate-utils.mjs";

describe("Moria browser-gate input accounting", () => {
  const keys = [
    { key: 46, context: "outer-command" },
    { key: 56, context: "literal" },
  ];

  it("waits until the exact expected count exists", () => {
    expect(exactNewKeys(keys.slice(0, 1), 0, 2)).toBeNull();
    expect(exactNewKeys(keys, 0, 2)).toEqual(keys);
  });

  it("rejects rather than slicing away a surplus command", () => {
    expect(() => exactNewKeys([...keys, { key: 56, context: "outer-command" }], 0, 2))
      .toThrow(/consumed 3 keys, expected exactly 2/);
  });
});

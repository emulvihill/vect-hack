import { describe, expect, it } from "vitest";
import { createMoriaCheckpoint } from "../../src/modules/moria/checkpoint";

describe("Moria checkpoint cadence", () => {
  it("requires both completed commands and elapsed wall time with no free first checkpoint", () => {
    let now = 1_000;
    const checkpoint = createMoriaCheckpoint({
      commands: 3,
      minIntervalMs: 20,
      now: () => now,
    });

    expect(checkpoint.due()).toBe(false);
    checkpoint.command();
    checkpoint.command();
    now = 1_020;
    expect(checkpoint.due()).toBe(false);
    checkpoint.command();
    expect(checkpoint.due()).toBe(true);
  });

  it("stays due after an attempted write and resets only after durable landing", () => {
    let now = 0;
    const checkpoint = createMoriaCheckpoint({
      commands: 1,
      minIntervalMs: 5,
      now: () => now,
    });

    checkpoint.command();
    now = 5;
    expect(checkpoint.due()).toBe(true);
    expect(checkpoint.due()).toBe(true);

    checkpoint.landed();
    expect(checkpoint.due()).toBe(false);
    checkpoint.command();
    now = 9;
    expect(checkpoint.due()).toBe(false);
    now = 10;
    expect(checkpoint.due()).toBe(true);
  });
});

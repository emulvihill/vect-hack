import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMMANDS, DEFAULT_MIN_INTERVAL_MS,
  createAngbandCheckpoint,
} from "../../src/modules/angband/angbandCheckpoint";

describe("createAngbandCheckpoint", () => {
  it("starts not due", () => {
    const c = createAngbandCheckpoint();
    expect(c.due()).toBe(false);
  });

  it("does not checkpoint on the command count alone", () => {
    let t = 0;
    const c = createAngbandCheckpoint({ now: () => t });

    for (let i = 0; i < DEFAULT_COMMANDS; i++) c.command();
    expect(c.due()).toBe(false);
  });

  it("does not checkpoint on elapsed time alone", () => {
    let t = 0;
    const c = createAngbandCheckpoint({ now: () => t });

    t += DEFAULT_MIN_INTERVAL_MS * 10;
    expect(c.due()).toBe(false);

    // One short of the count, with the interval long past.
    for (let i = 0; i < DEFAULT_COMMANDS - 1; i++) c.command();
    expect(c.due()).toBe(false);
    c.command();
    expect(c.due()).toBe(true);
  });

  it("follows the plan's cadence scenario", () => {
    let t = 0;
    const now = () => t;
    const c = createAngbandCheckpoint({ commands: 100, minIntervalMs: 20_000, now });

    expect(c.due()).toBe(false);
    for (let i = 0; i < 100; i++) c.command();
    t += 19_999;
    expect(c.due()).toBe(false);
    t += 1;
    expect(c.due()).toBe(true);
    c.landed();
    expect(c.due()).toBe(false);
  });

  it("honours non-default options", () => {
    let t = 0;
    const now = () => t;
    const c = createAngbandCheckpoint({ commands: 10, minIntervalMs: 500, now });

    for (let i = 0; i < 10; i++) c.command();
    t += 499;
    expect(c.due()).toBe(false);
    t += 1;
    expect(c.due()).toBe(true);
    c.landed();
    expect(c.due()).toBe(false);
  });
});

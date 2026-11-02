import { describe, expect, it } from "vitest";
import { borgDelayFactor, withBorgDelay } from "../../src/modules/angband/borgConfig";

describe("?borg pacing via borg.txt", () => {
  it("maps ms to the factor the engine will square back", () => {
    // borg_think_dungeon sleeps factor² ms, so the pace lands on the nearest
    // perfect square: 250 asked, 256 delivered.
    expect(borgDelayFactor(250)).toBe(16);
    expect(borgDelayFactor(1000)).toBe(32);
    expect(borgDelayFactor(0)).toBe(0);
  });

  it("replaces the existing line wherever the parser would accept it", () => {
    // borg_proc_setting skips leading spaces and matches case-insensitively.
    const text = "borg_worships_gold = false\n  Borg_Delay_Factor=9\n";
    expect(withBorgDelay(text, 250))
      .toBe("borg_worships_gold = false\nborg_delay_factor = 16\n");
  });

  it("appends to a file that never set one, touching nothing else", () => {
    const text = "# the player's own settings\nborg_respawn_race = 5";
    expect(withBorgDelay(text, 100))
      .toBe("# the player's own settings\nborg_respawn_race = 5\nborg_delay_factor = 10\n");
  });

  it("writes a bare ?borg's zero, so the last run's pace cannot carry over", () => {
    // borg.txt persists in the volume; only an explicit reset undoes a value.
    expect(withBorgDelay("borg_delay_factor = 16\n", 0)).toBe("borg_delay_factor = 0\n");
    expect(withBorgDelay("", 0)).toBe("borg_delay_factor = 0\n");
  });
});

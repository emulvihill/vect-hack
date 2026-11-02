import { describe, expect, it } from "vitest";

import {
  GRID,
  GRID_STRIDE,
  KIND_NAMES,
  MORIA_MAX_COLS,
  MORIA_MAX_ROWS,
  OVERLAY,
  STATE,
  STATE_STRIDE,
  TERRAIN,
  TOP,
} from "../../src/modules/moria/mapRecords";

describe("Moria sanitized semantic ABI", () => {
  it("pins the seven public record words without a source identity slot", () => {
    expect(GRID_STRIDE).toBe(7);
    expect(GRID).toEqual({
      X: 0,
      Y: 1,
      TERRAIN_CAT: 2,
      TERRAIN_KIND: 3,
      TERRAIN_CHAR: 4,
      TOP_CAT: 5,
      TOP_CHAR: 6,
    });
    expect(Object.keys(GRID)).not.toContain("FEATURE_ID");
    expect(Object.keys(GRID)).not.toContain("TREASURE_ID");
    expect(Object.keys(GRID)).not.toContain("CREATURE_ID");
  });

  it("pins append-only presentation enums and maximum active bounds", () => {
    expect(MORIA_MAX_COLS).toBe(198);
    expect(MORIA_MAX_ROWS).toBe(66);
    expect(TERRAIN).toEqual({
      UNSEEN: 0,
      FLOOR: 1,
      CORRIDOR: 2,
      WALL: 3,
      DOOR: 4,
      DOOR_OPEN: 5,
      STAIRS: 6,
      TRAP: 7,
      FEATURE: 8,
    });
    expect(TOP).toEqual({ NONE: 0, HERO: 1, MONSTER: 2, ITEM: 3 });
    expect(KIND_NAMES).toEqual([
      "",
      "floor",
      "corridor",
      "wall",
      "magma-seam",
      "quartz-seam",
      "rubble",
      "door-open",
      "door-closed",
      "stairs-up",
      "stairs-down",
      "trap",
      "store",
    ]);
  });

  it("pins the separately emitted structured-state layout and overlay ids", () => {
    expect(STATE_STRIDE).toBe(25);
    expect(STATE).toEqual({
      WIDTH: 0,
      HEIGHT: 1,
      PANEL_TOP: 2,
      PANEL_BOTTOM: 3,
      PANEL_LEFT: 4,
      PANEL_RIGHT: 5,
      HERO_X: 6,
      HERO_Y: 7,
      DEPTH: 8,
      TURN: 9,
      PLAYER_LEVEL: 10,
      EXPERIENCE: 11,
      GOLD: 12,
      HP: 13,
      MAX_HP: 14,
      MANA: 15,
      MAX_MANA: 16,
      AC: 17,
      BLIND: 18,
      HALLUCINATING: 19,
      CONFUSED: 20,
      AFRAID: 21,
      POISONED: 22,
      RESTING: 23,
      OVERLAY: 24,
    });
    expect(OVERLAY).toEqual({
      NONE: 0,
      EQUIPMENT: 1,
      INVENTORY: 2,
      WEAR: 3,
      HELP: 4,
      STORE: 5,
      TOMB: 6,
      SCORE: 7,
      MAP: 8,
      CHARACTER: 9,
    });
  });
});

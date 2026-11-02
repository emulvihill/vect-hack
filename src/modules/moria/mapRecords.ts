/** Fixed sanitized Int32 layout shared by Moria's native exporter and classifier. */
export const GRID_STRIDE = 7;

export const MORIA_MAX_COLS = 198;
export const MORIA_MAX_ROWS = 66;

export const GRID = {
  X: 0,
  Y: 1,
  TERRAIN_CAT: 2,
  TERRAIN_KIND: 3,
  TERRAIN_CHAR: 4,
  TOP_CAT: 5,
  TOP_CHAR: 6,
} as const;

// Public presentation categories. These are deliberately not Umoria fval or
// tval values: hidden source identity never belongs in the browser protocol.
export const TERRAIN = {
  UNSEEN: 0,
  FLOOR: 1,
  CORRIDOR: 2,
  WALL: 3,
  DOOR: 4,
  DOOR_OPEN: 5,
  STAIRS: 6,
  TRAP: 7,
  FEATURE: 8,
} as const;

export const TOP = {
  NONE: 0,
  HERO: 1,
  MONSTER: 2,
  ITEM: 3,
} as const;

// GRID.TERRAIN_KIND indexes this array. Never reorder; append new kinds.
export const KIND_NAMES: readonly string[] = [
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
];

/** Structured state is emitted independently from map batches. */
export const STATE_STRIDE = 25;

export const STATE = {
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
} as const;

export const OVERLAY = {
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
} as const;

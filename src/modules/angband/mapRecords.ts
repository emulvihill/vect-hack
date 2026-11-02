/** Fixed Int32 word layout shared by Angband's native tap and classifier. */
export const GRID_STRIDE = 15;

export const GRID = {
  X: 0,
  Y: 1,
  FEATURE: 2,
  FLAGS: 3,
  LIGHTING: 4,
  TOP_COLOR: 5,
  TOP_RGB: 6,
  TOP_CHAR: 7,
  TERRAIN_COLOR: 8,
  TERRAIN_RGB: 9,
  TERRAIN_CHAR: 10,
  TRAP_COLOR: 11,
  TRAP_RGB: 12,
  TRAP_CHAR: 13,
  TRAP_KIND: 14,
} as const;

export const GRID_FLAG = {
  PLAYER: 1 << 0,
  MONSTER: 1 << 1,
  PILE: 1 << 2,
  OBJECT: 1 << 3,
  UNSEEN_OBJECT: 1 << 4,
  UNSEEN_MONEY: 1 << 5,
  HALLUCINATE: 1 << 6,
  IN_VIEW: 1 << 7,
} as const;

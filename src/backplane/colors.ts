// NetHack's CLR_* colour indices (include/color.h). The single source of the
// index numbering; every palette in the client is keyed by it. This is the
// Backplane's 16-slot color vocabulary: Cell.color is an index into it,
// whatever Module produced the Cell.
export const CLR = {
  BLACK: 0, RED: 1, GREEN: 2, BROWN: 3, BLUE: 4, MAGENTA: 5, CYAN: 6, GRAY: 7,
  NO_COLOR: 8, ORANGE: 9, BRIGHT_GREEN: 10, YELLOW: 11, BRIGHT_BLUE: 12,
  BRIGHT_MAGENTA: 13, BRIGHT_CYAN: 14, WHITE: 15,
} as const;

export const CLR_MAX = 16;

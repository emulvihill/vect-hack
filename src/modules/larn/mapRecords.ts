// Fixed Int32 word layout shared by Larn's native tap and classifier.
//
// The C mirror lives in src/modules/larn/native/main-wasm.c (Task 4), which
// emits a packed Int32Array of GRID_STRIDE-word records into wasm memory for
// the worker (Task 5) to hand the classifier (Task 2). The two must stay in
// lockstep: every offset here is a `#define` mirror there, and the
// TERRAIN_KIND index written into word 5 is an index into KIND_NAMES below.
//
// The terrain categories are vect-hack's own grouping of Larn's dungeon
// cells; the KIND_NAMES labels are the feature names Larn draws (altars,
// thrones, fountains, stores, traps, ...), sourced from `objectname[]` in
// external/larn/data.c:182 (with the `objnamelist[]`/`monstnamelist[]` char
// maps at data.c:179-180) and the cell/feature globals declared in
// external/larn/header.h:341-363. KIND_NAMES[0] is the "none" slot so an
// empty TERRAIN_KIND indexes a label rather than underflowing.
export const GRID_STRIDE = 9;

export const GRID = {
  X: 0,
  Y: 1,
  TERRAIN_CAT: 2,
  TERRAIN_CHAR: 3,
  TERRAIN_COLOR: 4,
  TERRAIN_KIND: 5,
  TOP_CAT: 6,
  TOP_CHAR: 7,
  TOP_COLOR: 8,
} as const;

// The terrain category written into word GRID.TERRAIN_CAT. UNSEEN is 0 so a
// zeroed record reads as "nothing drawn here" before the first paint.
export const TERRAIN = {
  UNSEEN: 0,
  FLOOR: 1,
  WALL: 2,
  DOOR: 3,
  DOOR_OPEN: 4,
  STAIRS: 5,
  FEATURE: 6,
  TRAP: 7,
} as const;

// The top-of-cell entity written into word GRID.TOP_CAT. NONE is 0 so an
// empty cell and an unseen cell share the same zero word.
export const TOP = {
  NONE: 0,
  HERO: 1,
  MONSTER: 2,
  ITEM: 3,
} as const;

// Stable index ordering for the TERRAIN_KIND word (GRID.TERRAIN_KIND). The C
// shim's larn_map_info (Task 4) writes TERRAIN_KIND as an index INTO THIS
// ARRAY; the classifier (Task 2) reads KIND_NAMES[idx] for the feature label.
// Index 0 is the "none" slot — a floor or wall carries no feature kind.
//
// This is a vect-hack-chosen index ordering, NOT Larn's object-ID order:
// Larn's `objectname[]` (external/larn/data.c:182) interleaves fixtures with
// orb/pit/stairs/elevator (altar, throne, orb, pit, stairs-up, elevator-up,
// fountain, ...). We regroup by renderer category so the classifier can
// switch on a contiguous range: dungeon fixtures first (altar, throne,
// dead-throne, statue, fountain, dead-fountain), then the buildings (school,
// bank, store, trade, lrs), then the interactable fixtures (mirror,
// teleporter, home), then the pits, the stairs, and the traps last.
//
// DO NOT reorder: changing an index breaks the C mirror silently. Add new
// kinds by appending; the C side switches on the index, not the label.
// Slots 13 and 18..20 remain readable in historical records but are no longer
// emitted: visible traps share the generic "trap" kind.
export const KIND_NAMES: readonly string[] = [
  "",              // 0  — none
  "altar",         // 1
  "throne",        // 2
  "dead-throne",   // 3
  "statue",        // 4
  "fountain",      // 5
  "dead-fountain", // 6
  "school",        // 7
  "bank",          // 8
  "store",         // 9
  "trade",         // 10
  "lrs",           // 11
  "mirror",        // 12
  "teleporter",    // 13
  "home",          // 14
  "pit",           // 15
  "up",            // 16
  "down",          // 17
  "trap-door",     // 18
  "trap-dart",     // 19
  "trap-arrow",    // 20
  "trap",          // 21
];

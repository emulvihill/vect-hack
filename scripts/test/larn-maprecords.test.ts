// The Int32 record-word layout shared between the Larn native tap
// (src/modules/larn/native/main-wasm.c, Task 4) and the TS classifier
// (Task 2). Pins the stride, field offsets, the terrain + top category
// enums, and the WHOLE positional KIND_NAMES table.
//
// KIND_NAMES is positional and hand-mirrored by `#define KIND_*` in
// main-wasm.c under a "DO NOT reorder" comment, so a swap there is silent:
// nothing in the running game says the stairs are labelled the wrong way
// round, and the bot descends on the "down" kind. Pinning slot 0 alone —
// which is all this file used to do — left slots 1..20 free to move
// (vect-hack-8r0). Both directions are checked: the literal below catches any
// change to the TS table, and the re-derivation from the C mirror catches the
// two tables drifting apart, the recover-save.test.ts house pattern.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GRID, GRID_STRIDE, TERRAIN, TOP, KIND_NAMES } from "../../src/modules/larn/mapRecords";

const MAIN_WASM = new URL("../../src/modules/larn/native/main-wasm.c", import.meta.url);

/**
 * The `#define KIND_<NAME> <index>` block, as the label each index must carry:
 * KIND_NONE is the empty slot, and every other macro is its label uppercased
 * with hyphens as underscores (KIND_DEAD_FOUNTAIN -> "dead-fountain").
 */
function kindNamesFromCMirror(): string[] {
  const src = readFileSync(MAIN_WASM, "utf8");
  const names: string[] = [];
  for (const m of src.matchAll(/^#define\s+KIND_([A-Z_]+)\s+(\d+)$/gm)) {
    const index = Number(m[2]);
    if (names[index] !== undefined) throw new Error(`duplicate KIND index ${index}`);
    names[index] = m[1] === "NONE" ? "" : m[1]!.toLowerCase().replace(/_/g, "-");
  }
  if (names.length === 0) throw new Error("no KIND_* defines found in main-wasm.c");
  return names;
}

describe("larn mapRecords rendered-record layout", () => {
  it("pins the 9-word stride and field offsets", () => {
    expect(GRID_STRIDE).toBe(9);
    expect(GRID).toEqual({
      X: 0, Y: 1, TERRAIN_CAT: 2, TERRAIN_CHAR: 3, TERRAIN_COLOR: 4,
      TERRAIN_KIND: 5, TOP_CAT: 6, TOP_CHAR: 7, TOP_COLOR: 8,
    });
  });
  it("stride advances past the last field", () => {
    expect(GRID_STRIDE).toBe(GRID.TOP_COLOR + 1);
  });
  it("pins the terrain + top category enums", () => {
    expect(TERRAIN).toEqual({ UNSEEN: 0, FLOOR: 1, WALL: 2, DOOR: 3, DOOR_OPEN: 4, STAIRS: 5, FEATURE: 6, TRAP: 7 });
    expect(TOP).toEqual({ NONE: 0, HERO: 1, MONSTER: 2, ITEM: 3 });
  });
  it("pins every positional KIND_NAMES slot", () => {
    expect(KIND_NAMES).toEqual([
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
    ]);
  });
  it("agrees slot for slot with the C mirror in main-wasm.c", () => {
    const mirror = kindNamesFromCMirror();
    // The fixture must be non-vacuous: an empty or truncated parse would make
    // the comparison below pass for the wrong reason.
    expect(mirror.length).toBe(22);
    expect(mirror).toEqual([...KIND_NAMES]);
  });
});

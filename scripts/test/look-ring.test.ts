// The look ring (spec 2026-08-18): the mark that says which cell the pointer
// is naming, before the engine's word for it arrives. Drawn by the entity
// pass, so it lives and dies with the frame like everything else there.
import { describe, expect, it } from "vitest";
import { Color } from "three/webgpu";
import { buildEntities } from "../../src/render/EntityLayer";
import { INK } from "../../src/render/palette";
import { CellGrid } from "../../src/backplane/cell";

interface Seg { x: number; z: number; color: Color }

/** A LineBatch that only remembers what it was asked to draw. */
function recorder() {
  const segs: Seg[] = [];
  return {
    segs,
    begin() { segs.length = 0; },
    commit() {},
    add(x1: number, _y1: number, z1: number, _x2: number, _y2: number, _z2: number,
        color: Color) {
      segs.push({ x: x1, z: z1, color });
    },
  };
}

const emptyGrid = () => new CellGrid(8, 8);

describe("the look ring", () => {
  it("draws nothing when no cell is highlighted", () => {
    const batch = recorder();
    buildEntities(emptyGrid(), batch as never, 0, 0);
    expect(batch.segs).toHaveLength(0);
  });

  it("rings the highlighted cell in the pick ink", () => {
    const batch = recorder();
    buildEntities(emptyGrid(), batch as never, 0, 0, undefined, { highlight: { x: 3, y: 5 } });
    expect(batch.segs.length).toBeGreaterThan(0);
    // A closed ring around (3, 5): every vertex within a cell of the centre.
    for (const s of batch.segs) {
      expect(Math.hypot(s.x - 3, s.z - 5)).toBeLessThan(1);
      expect(s.color).toBe(INK.cursor);
    }
  });
});

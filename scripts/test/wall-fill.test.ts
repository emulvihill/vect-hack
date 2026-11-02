// The depth mask that makes walls opaque: emitWall's exposed-face walk also
// emits fill quads. Geometry is tested through a recording sink — no GPU.
import { describe, expect, it } from "vitest";
import type { Color } from "three/webgpu";
import { WALL_HEIGHT, buildTerrain, type FillSink } from "../../src/render/TerrainBuilder";
import { WallFill } from "../../src/render/WallFill";
import type { LineBatch } from "../../src/render/LineBatch";
import type { Cell, CellGrid } from "../../src/backplane/cell";

/** A map that is all void except the given wall/floor cells. */
function fakeMap(walls: [number, number][], floors: [number, number][] = []): CellGrid {
  const key = (x: number, y: number) => `${x},${y}`;
  const w = new Set(walls.map(([x, y]) => key(x, y)));
  const f = new Set(floors.map(([x, y]) => key(x, y)));
  return {
    cols: 80, rows: 21,
    at: (x: number, y: number) => ({
      category: w.has(key(x, y)) ? "wall" : f.has(key(x, y)) ? "floor" : "unseen",
      ch: " ", color: 7,
    }),
  } as unknown as CellGrid;
}

const nullBatch = {
  begin() {}, commit() {},
  add(_a: number, _b: number, _c: number, _d: number, _e: number, _f: number, _g: Color) {},
} as unknown as LineBatch;

class LineRecorder {
  segments: number[][] = [];
  begin() { this.segments = []; }
  add(...args: unknown[]) { this.segments.push(args.slice(0, 6) as number[]); }
  commit() {}
}

function oneCell(cell: Cell): CellGrid {
  return {
    cols: 1, rows: 1,
    at: (x: number, y: number) => x === 0 && y === 0
      ? cell
      : { category: "unseen", ch: " ", color: 7 },
  } as unknown as CellGrid;
}

class Recorder implements FillSink {
  quads: number[][] = [];
  began = 0; committed = 0;
  begin() { this.began++; }
  quad(...c: number[]) { this.quads.push(c); }
  commit() { this.committed++; }
}

describe("wall fill emission", () => {
  it("an isolated wall cell emits four side faces and a top cap", () => {
    const sink = new Recorder();
    buildTerrain(fakeMap([[5, 5]]), nullBatch, undefined, sink);
    expect(sink.began).toBe(1);
    expect(sink.committed).toBe(1);
    expect(sink.quads).toHaveLength(5);
    const tops = sink.quads.filter((q) => [1, 4, 7, 10].every((i) => q[i] === WALL_HEIGHT));
    expect(tops).toHaveLength(1); // exactly one horizontal cap at full height
  });

  it("two adjacent wall cells omit the shared face but cap both cells", () => {
    const sink = new Recorder();
    buildTerrain(fakeMap([[5, 5], [6, 5]]), nullBatch, undefined, sink);
    // 6 exposed side faces (2x4 minus the 2 facing each other) + 2 caps
    expect(sink.quads).toHaveLength(8);
  });

  it("emits nothing when no sink is passed", () => {
    buildTerrain(fakeMap([[5, 5]]), nullBatch); // must simply not throw
  });

  it("draws floor beneath a being, while a being without underlay stays unseen", () => {
    const covered = new LineRecorder();
    const bare = new LineRecorder();
    const floor = { category: "floor", ch: ".", color: 7 } as const;
    buildTerrain(oneCell({ category: "being", ch: "o", color: 2, terrain: floor } as Cell), covered as unknown as LineBatch);
    buildTerrain(oneCell({ category: "being", ch: "o", color: 2 }), bare as unknown as LineBatch);
    expect(covered.segments).toHaveLength(4);
    expect(bare.segments).toHaveLength(0);
  });

  it("keeps a being with malformed underlay unseen", () => {
    const batch = new LineRecorder();
    const malformed = { category: "being", ch: "x", color: 1 } as const;
    buildTerrain(oneCell({ category: "being", ch: "o", color: 2, terrain: malformed } as Cell), batch as unknown as LineBatch);
    expect(batch.segments).toHaveLength(0);
  });

  it("uses the underlay glyph when terrain features are covered", () => {
    const batch = new LineRecorder();
    const stairs = { category: "stairs", ch: ">", color: 7 } as const;
    buildTerrain(oneCell({ category: "being", ch: "@", color: 15, terrain: stairs } as Cell), batch as unknown as LineBatch);
    const heights = batch.segments.flatMap((segment) => [segment[1], segment[4]]);
    expect(heights.some((height) => height !== undefined && height < 0)).toBe(true);
  });
});

describe("WallFill geometry", () => {
  it("draws exactly the committed quads and is an invisible occluder", () => {
    const fill = new WallFill(16);
    fill.begin();
    fill.quad(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
    fill.quad(0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1);
    fill.commit();
    expect(fill.mesh.geometry.drawRange.count).toBe(2 * 6); // two quads, six indices each
    const material = fill.mesh.material as { colorWrite: boolean; depthWrite: boolean };
    expect(material.colorWrite).toBe(false);
    expect(material.depthWrite).toBe(true);
  });

  it("stays hidden before the first commit and while empty, so a zero-index draw never reaches the GPU", () => {
    const fill = new WallFill(16);
    expect(fill.mesh.visible).toBe(false);
    fill.begin();
    fill.commit(); // no quads emitted this pass
    expect(fill.mesh.visible).toBe(false);
  });

  it("becomes visible once a commit has quads, and hides again after an empty one", () => {
    const fill = new WallFill(16);
    fill.begin();
    fill.quad(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
    fill.commit();
    expect(fill.mesh.visible).toBe(true);
    fill.begin(); // next pass emits nothing (e.g. no walls left on screen)
    fill.commit();
    expect(fill.mesh.visible).toBe(false);
  });
});

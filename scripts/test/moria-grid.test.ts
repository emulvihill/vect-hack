import { describe, expect, it } from "vitest";
import { MoriaGrid, gridToHtml } from "../../src/modules/moria/grid";
import { MORIA_FRAME_BYTES } from "../../src/modules/moria/protocol";

describe("MoriaGrid", () => {
  it("copies an exact 80x24 Latin-1 frame", () => {
    const source = new Uint8Array(MORIA_FRAME_BYTES).fill(32);
    source.set([0x40, 0xe9, 0x00, 0x26, 0x3c, 0x3e], 80 + 2);
    const grid = new MoriaGrid();
    grid.frame(source, 7, 3);
    source[82] = 0x58;
    expect(grid.cells[82]).toBe(0x40);
    expect(grid.cells[83]).toBe(0xe9);
    expect(grid.cells[84]).toBe(0);
    expect(grid.cursor).toEqual({ x: 7, y: 3 });
    expect(grid.toText().split("\n")[1]!.slice(2, 4)).toBe("@é");
  });

  it("rejects malformed frames", () => {
    expect(() => new MoriaGrid().frame(new Uint8Array(MORIA_FRAME_BYTES - 1), 0, 0))
      .toThrow(/1,920/);
  });

  it("escapes HTML and marks only an in-range cursor", () => {
    const bytes = new Uint8Array(MORIA_FRAME_BYTES).fill(32);
    bytes.set(new TextEncoder().encode("<&>"));
    const grid = new MoriaGrid();
    grid.frame(bytes, 1, 0);
    const row = gridToHtml(grid).split("\n")[0]!;
    expect(row).toContain("&lt;");
    expect(row).toContain("&amp;");
    expect(row).toContain("&gt;");
    expect(row).toContain('class="cursor"');

    grid.frame(bytes, 999, -4);
    expect(gridToHtml(grid)).not.toContain('class="cursor"');
  });
});

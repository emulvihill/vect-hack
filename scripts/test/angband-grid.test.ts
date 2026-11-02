// The 80x24 grid model behind the Angband tty view and the boot smoke test.
// Pure: no DOM. gridToHtml is the render half, kept pure so vitest can pin
// color runs and the cursor without a browser.
import { describe, expect, it } from "vitest";
import {
  AngbandGrid, COLS, ROWS, gridRegionToHtml, gridToHtml,
} from "../../src/modules/angband/grid";

describe("AngbandGrid", () => {
  it("starts blank at 80x24", () => {
    const g = new AngbandGrid();
    expect(g.cells.length).toBe(ROWS);
    expect(g.cells[0]!.length).toBe(COLS);
    expect(g.toText()).toBe(Array.from({ length: ROWS }, () => " ".repeat(COLS)).join("\n"));
  });

  it("places a text run with its color", () => {
    const g = new AngbandGrid();
    g.text(2, 1, 0xff0000, "orc");
    expect(g.cells[1]![2]).toEqual({ ch: "o", rgb: 0xff0000 });
    expect(g.cells[1]![4]).toEqual({ ch: "c", rgb: 0xff0000 });
    expect(g.toText().split("\n")[1]).toBe("  orc" + " ".repeat(COLS - 5));
  });

  it("iterates by code point, one cell per astral char", () => {
    const g = new AngbandGrid();
    g.text(0, 0, 0xffffff, "a\u{1d538}b"); // 𝔸 is a surrogate pair in UTF-16
    expect(g.cells[0]![1]!.ch).toBe("\u{1d538}");
    expect(g.cells[0]![2]!.ch).toBe("b");
  });

  it("clips out-of-range writes instead of throwing", () => {
    const g = new AngbandGrid();
    g.text(COLS - 2, 0, 0xffffff, "abcdef"); // spills off the right edge
    g.text(0, ROWS + 5, 0xffffff, "x");      // row off the bottom
    g.wipe(-3, 0, 5);                          // partially off the left
    expect(g.cells[0]![COLS - 1]!.ch).toBe("b");
    expect(g.toText().length).toBe(ROWS * COLS + ROWS - 1);
  });

  it("wipe blanks n cells; clear blanks everything", () => {
    const g = new AngbandGrid();
    g.text(0, 3, 0x00ff00, "hello");
    g.wipe(1, 3, 2);
    expect(g.toText().split("\n")[3]!.startsWith("h  lo")).toBe(true);
    g.clear();
    expect(g.toText().trim()).toBe("");
  });

  it("tracks the cursor", () => {
    const g = new AngbandGrid();
    g.curs(10, 5);
    expect(g.cursor).toEqual({ x: 10, y: 5 });
  });
});

describe("gridToHtml", () => {
  it("emits color runs and escapes HTML", () => {
    const g = new AngbandGrid();
    g.text(0, 0, 0xff0000, "<b>");
    g.curs(40, 12); // off row 0: the cursor gets its own span (below) and
                    // would otherwise split the run it starts on top of
    const row0 = gridToHtml(g).split("\n")[0]!;
    expect(row0).toContain("&lt;b&gt;");
    expect(row0).toContain("color:#ff0000");
  });

  it("marks the cursor cell", () => {
    const g = new AngbandGrid();
    g.text(0, 2, 0xffffff, "@");
    g.curs(0, 2);
    expect(gridToHtml(g).split("\n")[2]).toContain('class="cursor"');
  });

  it("renders a clipped region with the same escaping, color runs, and cursor semantics", () => {
    const g = new AngbandGrid();
    g.text(11, 1, 0xff0000, "<&A");
    g.text(14, 1, 0x00ff00, "B");
    g.curs(13, 1);

    const html = gridRegionToHtml(g, 11, 1, 100, 1);
    expect(html).toContain("&lt;&amp;");
    expect(html).toContain('class="cursor"');
    expect(html).toContain("color:#ff0000");
    expect(html).toContain("color:#00ff00");
    expect(html).not.toContain("\n");
  });

  it("delegates the full grid to region rendering", () => {
    const g = new AngbandGrid();
    g.text(0, 0, 0x123456, "x");
    expect(gridToHtml(g)).toBe(gridRegionToHtml(g, 0, 0, COLS, ROWS));
  });
});

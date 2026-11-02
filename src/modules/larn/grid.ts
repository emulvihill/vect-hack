// 80x24 character grid — the raw tty surface Larn draws through the five
// display events (protocol.ts). Pure model: TtyView renders it to DOM via
// gridToHtml, and the node smoke test asserts on toText(). What crosses the
// Backplane in the spike is exactly this grid; classification is a later phase.
export const COLS = 80;
export const ROWS = 24;

// TtyCell is the Module's tty scratch surface, deliberately NOT the Backplane's
// Cell (backplane design: two tty grids do not make a Backplane).
export interface TtyCell { ch: string; rgb: number }

const blank = (): TtyCell => ({ ch: " ", rgb: 0xffffff });

export class LarnGrid {
  cells: TtyCell[][] = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, blank));
  cursor = { x: 0, y: 0 };

  /** Place a run of characters; writes outside the grid are clipped.
   * Iterates by code point: an astral glyph is one cell, not two. */
  text(x: number, y: number, rgb: number, s: string) {
    const row = this.cells[y];
    if (!row) return;
    let i = 0;
    for (const ch of s) {
      const col = x + i++;
      if (col >= 0 && col < COLS) row[col] = { ch, rgb };
    }
  }

  wipe(x: number, y: number, n: number) {
    const row = this.cells[y];
    if (!row) return;
    for (let i = 0; i < n; i++) {
      const col = x + i;
      if (col >= 0 && col < COLS) row[col] = blank();
    }
  }

  curs(x: number, y: number) { this.cursor = { x, y }; }

  clear() {
    for (const row of this.cells)
      for (let x = 0; x < COLS; x++) row[x] = blank();
  }

  /** Plain-text dump, rows joined with \n; trailing spaces kept. */
  toText(): string {
    return this.cells.map((row) => row.map((c) => c.ch).join("")).join("\n");
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const css = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;

/** Color-run HTML for a rectangular <pre>; requested bounds are clipped to
 * the 80x24 term and preserve the full-grid cursor and escaping semantics. */
export function gridRegionToHtml(
  grid: LarnGrid, x0: number, y0: number, width: number, height: number,
): string {
  const left = Math.max(0, x0);
  const top = Math.max(0, y0);
  const right = Math.min(COLS, x0 + Math.max(0, width));
  const bottom = Math.min(ROWS, y0 + Math.max(0, height));
  const rows: string[] = [];
  for (let y = top; y < bottom; y++) {
    const row = grid.cells[y]!;
    let html = "", run = "", runRgb = -1;
    const emit = () => {
      if (run) html += `<span style="color:${css(runRgb)}">${escapeHtml(run)}</span>`;
      run = "";
    };
    for (let x = left; x < right; x++) {
      const c = row[x]!;
      if (y === grid.cursor.y && x === grid.cursor.x) {
        emit();
        runRgb = c.rgb;
        html += `<span class="cursor" style="color:${css(c.rgb)};text-decoration:underline">${escapeHtml(c.ch)}</span>`;
        continue;
      }
      if (c.rgb !== runRgb) { emit(); runRgb = c.rgb; }
      run += c.ch;
    }
    emit();
    rows.push(html);
  }
  return rows.join("\n");
}

/** Color-run HTML for the complete 80x24 term. */
export function gridToHtml(grid: LarnGrid): string {
  return gridRegionToHtml(grid, 0, 0, COLS, ROWS);
}

import { MORIA_COLS, MORIA_FRAME_BYTES, MORIA_ROWS } from "./protocol";

const escapeHtml = (text: string) => text
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

export class MoriaGrid {
  cells = new Uint8Array(MORIA_FRAME_BYTES).fill(0x20);
  cursor = { x: 0, y: 0 };

  frame(cells: Uint8Array, x: number, y: number): void {
    if (cells.byteLength !== MORIA_FRAME_BYTES)
      throw new Error(`Moria frame must contain exactly 1,920 bytes, got ${cells.byteLength}`);
    this.cells = Uint8Array.from(cells);
    this.cursor = { x, y };
  }

  toText(): string {
    const rows: string[] = [];
    for (let y = 0; y < MORIA_ROWS; y++) {
      let row = "";
      for (let x = 0; x < MORIA_COLS; x++)
        row += String.fromCharCode(this.cells[y * MORIA_COLS + x]!);
      rows.push(row);
    }
    return rows.join("\n");
  }
}

export function gridToHtml(grid: MoriaGrid): string {
  const rows: string[] = [];
  const cursorInRange = grid.cursor.x >= 0 && grid.cursor.x < MORIA_COLS
    && grid.cursor.y >= 0 && grid.cursor.y < MORIA_ROWS;
  for (let y = 0; y < MORIA_ROWS; y++) {
    let row = "";
    for (let x = 0; x < MORIA_COLS; x++) {
      const ch = escapeHtml(String.fromCharCode(grid.cells[y * MORIA_COLS + x]!));
      row += cursorInRange && x === grid.cursor.x && y === grid.cursor.y
        ? `<span class="cursor" style="text-decoration:underline">${ch}</span>`
        : ch;
    }
    rows.push(row);
  }
  return rows.join("\n");
}

import { describe, expect, it } from "vitest";
import { cell, ready } from "./bot-fixtures";

describe("BotModel", () => {
  it("builds the grid and explored mask from print_glyph", () => {
    const m = ready();
    m.observe({ name: "print_glyph", win: 30, x: 5, y: 6, cell: cell("."), bg: null });
    expect(m.map.at(5, 6).ch).toBe(".");
    expect(m.explored[6 * 80 + 5]).toBe(1);
    expect(m.explored[0]).toBe(0);
  });

  it("tracks the hero via MG_HERO", () => {
    const m = ready();
    m.observe({ name: "print_glyph", win: 30, x: 3, y: 4, cell: cell("@", { glyph: 1, glyphflags: 0x1 }), bg: null });
    expect(m.map.hero).toEqual({ x: 3, y: 4 });
  });

  it("clear_nhwindow on the map resets grid and explored; other windows don't", () => {
    const m = ready();
    m.observe({ name: "print_glyph", win: 30, x: 5, y: 6, cell: cell("."), bg: null });
    m.observe({ name: "clear_nhwindow", win: 10 });
    expect(m.explored[6 * 80 + 5]).toBe(1);
    m.observe({ name: "clear_nhwindow", win: 30 });
    expect(m.explored[6 * 80 + 5]).toBe(0);
    expect(m.map.at(5, 6).ch).toBe(" ");
  });

  it("keeps HP/hunger from status fields keyed by the STATUS_FIELD indexes", () => {
    const m = ready();
    m.observe({ name: "status_update", fldidx: 18, text: "16", condbits: 0, chg: 0, percent: 0, color: 0 });
    m.observe({ name: "status_update", fldidx: 19, text: "16", condbits: 0, chg: 0, percent: 0, color: 0 });
    m.observe({ name: "status_update", fldidx: 17, text: "Hungry  ", condbits: 0, chg: 0, percent: 0, color: 0 });
    expect(m.hp).toBe(16);
    expect(m.hpmax).toBe(16);
    expect(m.hunger).toBe("Hungry");
    m.observe({ name: "status_update", fldidx: 17, text: " ", condbits: 0, chg: 0, percent: 0, color: 0 });
    expect(m.hunger).toBe("");
  });

  it("collects message-window putstr and raw_print, capped at 30", () => {
    const m = ready();
    m.observe({ name: "putstr", win: 10, attr: 0, text: "You see here a long sword." });
    m.observe({ name: "putstr", win: 40, attr: 0, text: "menu text, not a message" });
    m.observe({ name: "raw_print", text: "Be careful!", bold: false });
    expect(m.lastMessage()).toBe("Be careful!");
    expect(m.messages).toEqual(["You see here a long sword.", "Be careful!"]);
    for (let i = 0; i < 40; i++) m.observe({ name: "putstr", win: 10, attr: 0, text: `msg ${i}` });
    expect(m.messages.length).toBe(30);
    expect(m.lastMessage()).toBe("msg 39");
  });

  it("buffers menu build-up per window and drops it on destroy", () => {
    const m = ready();
    m.observe({ name: "start_menu", win: 40, mbehavior: 0 });
    m.observe({ name: "add_menu", win: 40, item: { identifier: 7, accelerator: "a", groupAccel: "", attr: 0, color: 0, text: "a long sword", itemflags: 0, glyph: null } });
    m.observe({ name: "end_menu", win: 40, prompt: "Pick up what?" });
    const buf = m.menus.get(40)!;
    expect(buf.prompt).toBe("Pick up what?");
    expect(buf.items.map((i) => i.text)).toEqual(["a long sword"]);
    expect(buf.events.length).toBe(3);
    m.observe({ name: "destroy_nhwindow", win: 40 });
    expect(m.menus.has(40)).toBe(false);
  });

  it("remembers the downstairs position, surviving an object printed over it", () => {
    const m = ready();
    m.observe({ name: "print_glyph", win: 30, x: 10, y: 12, cell: cell(">"), bg: null });
    expect(m.stairsDown).toEqual({ x: 10, y: 12 });
    // An item lands on the stairs: the glyph changes, the tile still shows
    // the object, but the remembered position must not be lost.
    m.observe({ name: "print_glyph", win: 30, x: 10, y: 12, cell: cell("!", { glyph: 2400 }), bg: null });
    expect(m.map.at(10, 12).ch).toBe("!");
    expect(m.stairsDown).toEqual({ x: 10, y: 12 });
  });

  it("clears the remembered downstairs on a map clear (level change)", () => {
    const m = ready();
    m.observe({ name: "print_glyph", win: 30, x: 10, y: 12, cell: cell(">"), bg: null });
    expect(m.stairsDown).not.toBeNull();
    m.observe({ name: "clear_nhwindow", win: 30 });
    expect(m.stairsDown).toBeNull();
  });

  it("records game over from exit_nhwindows", () => {
    const m = ready();
    m.observe({ name: "exit_nhwindows", text: "Goodbye Bot the Valkyrie..." });
    expect(m.gameOver).toBe(true);
    expect(m.deathText).toContain("Goodbye");
  });
});

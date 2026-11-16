// The no-target command menu (vect-hack-be3.7). Nothing here talks to the
// engine, so the tests are invariants over the table itself — the kind of
// mistake a table of 28 hand-written key codes actually makes: a duplicate, a
// typo'd fold, or a directional verb that does not belong in a menu with no
// target.
import { describe, expect, it } from "vitest";
import { COMMAND_GROUPS } from "../../../src/modules/nethack/ui/commandMenu";
import { ctrl, key, meta } from "../../../src/modules/nethack/ui/keys";

const ALL = COMMAND_GROUPS.flatMap((g) => g.commands);

describe("COMMAND_GROUPS", () => {
  it("has no empty group, and none longer than a glance", () => {
    expect(COMMAND_GROUPS.length).toBeGreaterThan(0);
    for (const g of COMMAND_GROUPS) {
      expect(g.label).toBeTruthy();
      expect(g.commands.length).toBeGreaterThan(0);
      expect(g.commands.length).toBeLessThanOrEqual(8);
    }
  });

  it("names every group and every command exactly once", () => {
    const groups = COMMAND_GROUPS.map((g) => g.label);
    expect(new Set(groups).size).toBe(groups.length);
    const labels = ALL.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("binds each command to a distinct key", () => {
    const codes = ALL.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("uses only codes one of the keys.ts folds can produce", () => {
    // A bare printable byte, Ctrl on a letter, or Meta on a printable byte.
    // Anything else (NUL, ESC, DEL, a bare high byte, past 255) is a typo,
    // not a NetHack command.
    const printable = Array.from({ length: 126 - 33 + 1 }, (_, i) => String.fromCharCode(33 + i));
    const letters = printable.filter((ch) => /[a-z]/.test(ch));
    const folds = new Set([...printable.map(key), ...letters.map(ctrl), ...printable.map(meta)]);
    for (const c of ALL) expect(folds.has(c.code), `${c.label} -> ${c.code}`).toBe(true);
  });

  it("keeps the two Meta folds exactly as cmd.c compiles them", () => {
    // The folds most likely to be wrong, because no keyboard produces them
    // directly: pray is M('p') and the overview is C('o') (src/cmd.c).
    const byLabel = (l: string) => ALL.find((c) => c.label === l)?.code;
    expect(byLabel("Pray")).toBe(meta("p"));
    expect(byLabel("Dungeon overview")).toBe(ctrl("o"));
  });

  it("holds no verb that needs a target — those belong on the map", () => {
    // open, close, kick, untrap and chat all end in getdir(); offering them
    // from a menu with no target would leave NetHack asking "In what
    // direction?" with nothing behind the question.
    const directional = [key("o"), key("c"), ctrl("d"), meta("u"), meta("c")];
    for (const c of ALL) expect(directional).not.toContain(c.code);
  });

  it("covers the commands the epic's acceptance names", () => {
    // vect-hack-be3's acceptance criterion, spelled out: these are the
    // no-target commands the be3 review found unreachable without a letter.
    const labels = new Set(ALL.map((c) => c.label));
    for (const needed of ["Inventory", "Pick up", "Search", "Go up stairs",
                          "Go down stairs", "Save and quit"])
      expect(labels).toContain(needed);
  });
});
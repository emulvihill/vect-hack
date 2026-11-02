import { describe, expect, it } from "vitest";
import { answerMenu, answerYn, extCmdIndex } from "../../src/modules/nethack/bot/prompts";
import type { MenuItemData } from "../../src/modules/nethack/protocol";

const ESC = 27;
const row = (identifier: number, text: string): MenuItemData =>
  ({ identifier, accelerator: "", groupAccel: "", attr: 0, color: 0, text, itemflags: 0, glyph: null });

describe("answerYn", () => {
  it("confirms prayer", () => {
    expect(answerYn("Are you sure you want to pray?", "yn", 110)).toBe(121); // y
  });
  it("declines the tutorial and auto-pick", () => {
    expect(answerYn("Do you want to try the tutorial?", "yn", 110)).toBe(110);
    expect(answerYn("Shall I pick a character's race, role, gender and alignment for you?", "ynaq", 121)).toBe(110);
  });
  it("never attacks peacefuls, never eats off the floor", () => {
    expect(answerYn("Really attack the shopkeeper?", "yn", 110)).toBe(110);
    expect(answerYn("There is a lichen corpse here; eat it?", "ynq", 110)).toBe(110);
  });
  it("eats the first inventory letter offered from the query brackets", () => {
    expect(answerYn("What do you want to eat? [d-g or ?*]", "", 0)).toBe(100); // d
  });
  it("gives up on eat prompts with no inventory letter in the query", () => {
    expect(answerYn("What do you want to eat? [?*]", "", 0)).toBe(ESC);
  });
  it("falls back to choices when the query has no bracketed letters", () => {
    expect(answerYn("What do you want to eat?", "dfg or ?*", 0)).toBe(100); // d
  });
  it("falls back to the engine's default, then ESC", () => {
    expect(answerYn("Force its lock?", "ynq", 110)).toBe(110);
    expect(answerYn("weird question", "", 0)).toBe(ESC);
  });
});

describe("answerMenu", () => {
  const creation = [row(0, "Choose your role:"), row(101, "Barbarian"), row(102, "Samurai"), row(103, "Valkyrie")];
  it("PICK_NONE acknowledges with no picks", () => {
    expect(answerMenu("anything", creation, 0)).toEqual({ picks: [] });
  });
  it("creation menus pick Valkyrie / human / female / lawful by row text", () => {
    expect(answerMenu("Pick a role or profession", creation, 1).picks).toEqual([{ identifier: 103, count: -1, itemflags: 0 }]);
    const races = [row(0, "head"), row(201, "dwarf"), row(202, "human")];
    expect(answerMenu("Pick a race or species", races, 1).picks[0]!.identifier).toBe(202);
    const genders = [row(301, "male"), row(302, "female")];
    expect(answerMenu("Pick a gender or sex", genders, 1).picks[0]!.identifier).toBe(302);
    const aligns = [row(401, "chaotic"), row(402, "lawful")];
    expect(answerMenu("Pick an alignment or creed", aligns, 1).picks[0]!.identifier).toBe(402);
  });
  it("creation menus fall back to the first selectable row", () => {
    const roles = [row(0, "head"), row(501, "Archeologist")];
    expect(answerMenu("Pick a role or profession", roles, 1).picks[0]!.identifier).toBe(501);
  });
  it("pick-up menus take everything selectable", () => {
    const loot = [row(0, "Weapons"), row(601, "a long sword"), row(602, "3 daggers")];
    expect(answerMenu("Pick up what?", loot, 2).picks.map((p) => p.identifier)).toEqual([601, 602]);
  });
  it("pick-up menus leave corpses on the floor", () => {
    const loot = [row(0, "Items"), row(701, "a long sword"), row(702, "2 newt corpses"), row(703, "a food ration")];
    expect(answerMenu("Pick up what?", loot, 2).picks.map((p) => p.identifier)).toEqual([701, 703]);
  });
  it("eat menus take the first selectable row", () => {
    const food = [row(0, "Comestibles"), row(701, "a food ration"), row(702, "a tripe ration")];
    expect(answerMenu("What do you want to eat?", food, 1).picks).toEqual([{ identifier: 701, count: -1, itemflags: 0 }]);
  });
  it("unknown menus cancel", () => {
    expect(answerMenu("What do you want to sacrifice?", creation, 1)).toEqual({ picks: [] });
  });
  it("tutorial menu declines with matching no row", () => {
    const tutorial = [row(0, "Do you want a tutorial?"), row(801, "Yes, please"), row(802, "No, thank you")];
    expect(answerMenu("Do you want a tutorial?", tutorial, 1).picks[0]!.identifier).toBe(802);
  });
  it("tutorial menu falls back to first selectable when no matching no row", () => {
    const tutorial = [row(0, "Do you want a tutorial?"), row(803, "Sure"), row(804, "Maybe later")];
    expect(answerMenu("Do you want a tutorial?", tutorial, 1).picks[0]!.identifier).toBe(803);
  });
});

describe("extCmdIndex", () => {
  const cmds = [{ name: "chat", desc: "" }, { name: "pray", desc: "" }, { name: "force", desc: "" }];
  it("finds the wanted command", () => {
    expect(extCmdIndex(cmds, "pray")).toBe(1);
  });
  it("cancels when absent or unset", () => {
    expect(extCmdIndex(cmds, "loot")).toBe(-1);
    expect(extCmdIndex(cmds, "")).toBe(-1);
  });
});

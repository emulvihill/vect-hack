import { describe, expect, it } from "vitest";
import { answerPrompt, key, type PromptContext } from "../../src/modules/larn/bot/prompts";
import { KC_ESCAPE } from "../../src/modules/larn/protocol";

/** Default context: a pack with room, and a hero READY for the shaft — so the
 *  pre-vect-hack-h9x.5 answers below are unchanged, and the two gated rules
 *  each get their own test rather than being smuggled into every other one. */
const answers = (text: string, ctx: Partial<PromptContext> = {}) =>
  String.fromCharCode(
    answerPrompt(text, { packRoom: true, readyForShaft: true, wieldLetter: null, castDirection: key("k"), ...ctx }).code,
  );

/** object.c:320-345 — the one prompt in the game that ends most runs. */
const SHAFT_PROMPT =
  "You have found a volcanic shaft leaning downwardDo you (c) climb down, or (i) ignore it? ";

describe("answerPrompt", () => {
  it("advances the welcome page with return and a pager with space", () => {
    expect(answers("Welcome to the game of Larn ... Press return to continue: ")).toBe("\n");
    expect(answers("  --- press space to continue --- ")).toBe(" ");
  });
  it("goes into the dungeon entrance and down both kinds of descent", () => {
    expect(answers("You have found the dungeon entranceDo you (g) go inside, or (i) ignore it? ")).toBe("g");
    // ostairs(): the ordinary staircase, up or down.
    expect(answers("There is a circular staircase hereDo you (s) stay here  (d) go down  or (f) kick stairs? ")).toBe("d");
    expect(answers("There is a circular staircase hereDo you (s) stay here  (u) go up  or (f) kick stairs? ")).toBe("s");
    // OVOLDOWN: the volcanic shaft is the only "(c) climb down".
    expect(answers(SHAFT_PROMPT)).toBe("c");
  });
  it("takes items and opens doors but never chests, and declines everything else that can be ignored", () => {
    expect(answers("You have found a magic potionDo you (d) drink it, (t) take it, or (i) ignore it? ")).toBe("t");
    expect(answers("You have found a magic scrollDo you (r) read it, (t) take it, or (i) ignore it? ")).toBe("t");
    expect(answers("You have found a closed doorDo you (o) try to open it, or (i) ignore it? ")).toBe("o");
    expect(answers("There is a chest hereDo you (t) take it, (o) try to open it, or (i) ignore it? ")).toBe("i");
    expect(answers("You have found the College of Larn.Do you (g) go inside, or (i) stay here? ")).toBe("i");
    expect(answers("There is a Holy Altar here!Do you (p) pray, (d) desecrate, or (i) ignore it? ")).toBe("i");
    expect(answers("You have found your way home.Do you (g) go inside, or (i) stay here? ")).toBe("i");
  });
  it("ignores what it cannot carry once the engine has said the pack is full", () => {
    // take() prints "You can't carry anything else" and skips forget()
    // (external/larn/global.c:481), so the item is still on the map and a
    // second "t" buys a second refusal. Every prompt that offers "(t) take
    // it" also offers "(i) ignore it" — the engine's own out (iopts()).
    const scroll = "You have found a magic scrollDo you (r) read it, (t) take it, or (i) ignore it? ";
    const belt = "You have found a belt of striking + 1Do you want to (t) take it, or (i) ignore it? ";
    expect(answers(scroll, { packRoom: false })).toBe("i");
    expect(answers(belt, { packRoom: false })).toBe("i");
    // The other choice on the same text: with room in the pack both are still
    // taken, so it is the pack state doing the work and not the wording.
    expect(answers(scroll)).toBe("t");
    expect(answers(belt)).toBe("t");
    // A full pack is about carrying, and about nothing else: a door still
    // opens and a staircase is still descended.
    expect(answers("You have found a closed doorDo you (o) try to open it, or (i) ignore it? ", { packRoom: false })).toBe("o");
    expect(answers("There is a circular staircase hereDo you (s) stay here  (d) go down  or (f) kick stairs? ", { packRoom: false })).toBe("d");
    expect(answers("You have found a volcanic shaft leaning downwardDo you (c) climb down, or (i) ignore it? ", { packRoom: false })).toBe("c");
  });
  it("declines the volcanic shaft when the hero is not ready for it", () => {
    // vect-hack-h9x.5. The shaft drops the hero to internal 11 from level 0
    // whatever their experience level (object.c:345), and answering "c" at
    // level 1 was 50.6% of the 2026-08-28 bench dying in a median of 19
    // commands. Declining falls through to the "(i) ignore it" the same prompt
    // offers — there is no separate refusal key.
    expect(answers(SHAFT_PROMPT, { readyForShaft: false })).toBe("i");
    expect(answers(SHAFT_PROMPT, { readyForShaft: true })).toBe("c");

    // The bar is about the SHAFT and about nothing else. This is the half that
    // fails if the gate is put on the wrong rule, or on all of them: an
    // unready hero still goes into the dungeon entrance, still takes an
    // ordinary staircase down, and still opens a door.
    expect(answers("You have found the dungeon entranceDo you (g) go inside, or (i) ignore it? ",
      { readyForShaft: false })).toBe("g");
    expect(answers("There is a circular staircase hereDo you (s) stay here  (d) go down  or (f) kick stairs? ",
      { readyForShaft: false })).toBe("d");
    expect(answers("You have found a closed doorDo you (o) try to open it, or (i) ignore it? ",
      { readyForShaft: false })).toBe("o");
  });
  it("answers the item prompt with the letter the ladder asked for, and ESC with none", () => {
    // whatitem() (main.c:1290). vect-hack-h9x.6: the letter is chosen by the
    // wield step the same turn it emits `w`, so this is never a guess.
    const WIELD_PROMPT = "What do you want to wield [* for all] ? ";
    expect(answers(WIELD_PROMPT, { wieldLetter: "g" })).toBe("g");
    expect(answers(WIELD_PROMPT, { wieldLetter: "b" })).toBe("b");
    // With no letter the rule does not apply and the prompt falls through to
    // the ESC default. ESC and not "." — whatitem() accepts both, but wield()
    // treats "." as "ask again" inside a `while (1)` and would prompt for ever
    // (main.c:1015-1044); only \33 returns.
    expect(answerPrompt(WIELD_PROMPT,
      { packRoom: true, readyForShaft: true, wieldLetter: null, castDirection: key("k") }).code).toBe(KC_ESCAPE);
  });
  it("cancels anything it does not recognise", () => {
    expect(answerPrompt("Welcome to the DND store", { packRoom: true, readyForShaft: true, wieldLetter: null, castDirection: key("k") }).code).toBe(KC_ESCAPE);
    expect(answerPrompt("", { packRoom: true, readyForShaft: true, wieldLetter: null, castDirection: key("k") }).code).toBe(KC_ESCAPE);
  });
  it("key() builds a plain byte", () => {
    expect(key("c")).toEqual({ code: 99, mods: 0 });
  });
});

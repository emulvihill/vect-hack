// Clickable yn_function answers (vect-hack-be3.7). Without these the command
// menu dead-ends: half its rows end in a "[yn]" the pointer cannot answer.
// The stub records listeners so the delegated #prompt handler can be fired.
import { beforeEach, describe, expect, it } from "vitest";
import { key } from "../../src/modules/nethack/ui/keys";
import { embeddedChoices } from "../../src/modules/nethack/ui/TextHud";

type Listener = (e: never) => void;

class StubEl {
  innerHTML = "";
  hidden = true;
  scrollTop = 0;
  scrollHeight = 0;
  children: StubEl[] = [];
  listeners = new Map<string, Set<Listener>>();
  // Real DOM semantics: assigning textContent replaces every other child.
  // ynFunction's finally clause blanks #prompt that way, and the chip
  // assertions read innerHTML — a plain field would let the chips survive a
  // blank and the "clears the chips" test would pass against a bug.
  #text = "";
  get textContent() { return this.#text; }
  set textContent(v: string) { this.#text = v; this.innerHTML = v; this.children = []; }
  get childElementCount() { return this.children.length; }
  get firstChild() {
    const c = this.children[0];
    return c ? { remove: () => void this.children.shift() } : null;
  }
  appendChild(c: StubEl) { this.children.push(c); return c; }
  blur() {}
  contains() { return true; }
  addEventListener(t: string, fn: Listener) {
    const set = this.listeners.get(t) ?? new Set<Listener>();
    this.listeners.set(t, set).get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Listener) { this.listeners.get(t)?.delete(fn); }
  emit(t: string, e: unknown) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn(e as never); }
}

const els = new Map<string, StubEl>();
const el = (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!;

(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => el(id),
  createElement: () => new StubEl(),
  addEventListener: () => {},
  removeEventListener: () => {},
} as unknown as Document;

const { TextHud } = await import("../../src/modules/nethack/ui/TextHud");

/** The answers currently offered as chips, in order. */
const chips = (): string[] =>
  [...el("prompt").innerHTML.matchAll(/data-yn="([^"]*)"/g)].map((m) => m[1]!);

/** Fire the delegated chip handler for `answer`, as a real click would. */
const clickChip = (answer: string) =>
  el("prompt").emit("click", {
    target: { closest: (sel: string) => sel === "[data-yn]" ? { dataset: { yn: answer } } : null },
  });

describe("clickable yn_function answers", () => {
  let hud: InstanceType<typeof TextHud>;

  beforeEach(() => {
    els.clear();
    hud = new TextHud();
  });

  it("offers one chip per choice, plus a way out", () => {
    void hud.handle({ name: "yn_function", query: "Really save?", choices: "yn", def: 0 } as never);
    expect(chips()).toEqual(["y", "n", "esc"]);
  });

  it("answers the prompt with the chip that was clicked", async () => {
    const answer = hud.handle(
      { name: "yn_function", query: "Really save?", choices: "yn", def: 0 } as never);
    clickChip("y");
    expect(await answer).toBe(key("y"));
  });

  it("sends a real ESC for the esc chip, so the engine's own default applies", async () => {
    // ynFunction turns ESC into 'q' if offered, else 'n', else the default —
    // the chip must go through that, not guess at an answer of its own.
    const answer = hud.handle(
      { name: "yn_function", query: "Drink from the fountain?", choices: "ynq", def: 0 } as never);
    clickChip("esc");
    expect(await answer).toBe(key("q"));
  });

  it("ignores a chip whose answer the prompt never offered", async () => {
    // The listener is permanent, so a stale click must not become an answer.
    const answer = hud.handle(
      { name: "yn_function", query: "Really save?", choices: "yn", def: 0 } as never);
    clickChip("z");   // not in "yn": ynFunction loops and keeps waiting
    clickChip("n");
    expect(await answer).toBe(key("n"));
  });

  it("offers no chips for a direction prompt, which the camera answers", () => {
    // getdir() is the empty-choices prompt vect-hack-be3.6 routes arrows to.
    // A fixed chip set is exactly the wrong shape for it.
    void hud.handle(
      { name: "yn_function", query: "In what direction?", choices: "", def: 0 } as never);
    expect(chips()).toEqual([]);
  });

  it("clears the chips once the prompt is answered", async () => {
    const answer = hud.handle(
      { name: "yn_function", query: "Really save?", choices: "yn", def: 0 } as never);
    clickChip("n");
    await answer;
    expect(chips()).toEqual([]);
    expect(el("prompt").hidden).toBe(true);
  });
});

describe("a prompt that spells its answers inside the query (vect-hack-21k)", () => {
  // Found by driving the touch build: character selection passes NO choices
  // and leaves "[ynaq]" in the sentence (external/NetHack/src/role.c:2256), so
  // until now the very first question of every game had no clickable answer.
  it("reads a bracketed set only off the end of a choiceless query", () => {
    expect(embeddedChoices("Shall I pick a character for you? [ynaq]")).toBe("ynaq");
    expect(embeddedChoices("Shall I pick a character for you? [ynaq] ")).toBe("ynaq");
    // Not at the end: a bracketed aside mid-sentence is not an answer set.
    expect(embeddedChoices("Pick [ynaq] a thing, then confirm")).toBe("");
    // Not a letter run: a hint, a range, an item description.
    expect(embeddedChoices("What do you want to eat? [d or ?*]")).toBe("");
    expect(embeddedChoices("In what direction?")).toBe("");
    expect(embeddedChoices("Really attack the shopkeeper?")).toBe("");
  });

  it("offers those answers as chips, without doubling the set into the label", async () => {
    els.clear();
    const hud = new TextHud();
    const asked = hud.handle({
      name: "yn_function",
      query: "Shall I pick a character for you? [ynaq]",
      choices: "", def: 0,
    }) as unknown as Promise<number>;
    expect(chips()).toEqual(["y", "n", "a", "q", "esc"]);
    // The query already reads "[ynaq]"; appending "[any]" would be nonsense.
    expect(el("prompt").innerHTML).not.toContain("[any]");
    clickChip("a");
    expect(await asked).toBe(key("a"));
  });

  it("leaves a real choices set and a direction prompt exactly as they were", async () => {
    els.clear();
    const hud = new TextHud();
    const yn = hud.handle({ name: "yn_function", query: "Really quit?", choices: "yn", def: key("n") }) as unknown as Promise<number>;
    expect(chips()).toEqual(["y", "n", "esc"]);
    clickChip("n");
    expect(await yn).toBe(key("n"));
    // getdir() keeps no chips: eight letters is the wrong shape for it, and
    // the camera (or the thumb pad) is what answers it.
    void hud.handle({ name: "yn_function", query: "In what direction? [hjkl]", choices: "", def: 0 });
    expect(chips()).toEqual([]);
  });
});

// The seam a view remaps keys through (vect-hack-be3). What matters is where it
// is consulted: only on the command path. yn_function and message_menu block on
// the same key queue as nhgetch with no activeMenu or overlay to tell them
// apart, so without an explicit gate a remapped ArrowUp answers "Really quit?"
// with a k, or picks whichever inventory item is accelerated by one.
import { beforeEach, describe, expect, it } from "vitest";

/** Enough of an element for the message log and the prompt line. */
class StubEl {
  textContent = "";
  innerHTML = "";
  hidden = true;
  scrollTop = 0;
  scrollHeight = 0;
  children: StubEl[] = [];
  get childElementCount() { return this.children.length; }
  get firstChild() {
    const c = this.children[0];
    return c ? { remove: () => void this.children.shift() } : null;
  }
  appendChild(c: StubEl) { this.children.push(c); return c; }
  addEventListener() {}
  removeEventListener() {}
  blur() {}
}

const els = new Map<string, StubEl>();
let onKey: (e: { key: string; ctrlKey?: boolean; preventDefault(): void }) => void;

(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!,
  createElement: () => new StubEl(),
  addEventListener: (_t: string, fn: typeof onKey) => (onKey = fn),
} as unknown as Document;

// Imported after the stub: TextHud looks its elements up while constructing.
const { TextHud } = await import("../../src/modules/nethack/ui/TextHud");
const { key } = await import("../../src/modules/nethack/ui/keys");

const press = (k: string) => onKey({ key: k, preventDefault() {} });

describe("TextHud.remap", () => {
  let hud: InstanceType<typeof TextHud>;
  beforeEach(() => {
    els.clear();
    hud = new TextHud();
  });

  /** What the engine actually received, in order. */
  const drain = async (n: number) => {
    const got: number[] = [];
    const read = (hud as unknown as { readKey(): Promise<number> }).readKey.bind(hud);
    for (let i = 0; i < n; i++) got.push(await read());
    return got;
  };

  it("feeds the remapped code instead of KEYMAP's", async () => {
    hud.remap = (e) => (e.key === "ArrowUp" ? key("l") : null);
    press("ArrowUp");
    expect(await drain(1)).toEqual([key("l")]); // not "k", which KEYMAP would give
  });

  it("falls through to KEYMAP when the mapper declines", async () => {
    hud.remap = () => null;
    press("ArrowUp");
    press("s");
    expect(await drain(2)).toEqual([key("k"), key("s")]);
  });

  it("feeds nothing when the mapper consumes the key", async () => {
    hud.remap = (e) => (e.key === "ArrowLeft" ? "consumed" : null);
    press("ArrowLeft");
    press("s");
    expect(await drain(1)).toEqual([key("s")]); // the turn produced no game input
  });

  it("is not consulted while a prompt is waiting for an answer", async () => {
    // yn_function blocks on the same readKey() queue as the command loop, with
    // nothing else marking it. Without the gate, ArrowUp answers with a k.
    let asked = 0;
    hud.remap = () => { asked++; return key("l"); };
    const answer = hud.handle(
      { name: "yn_function", query: "Really quit?", choices: "yn", def: key("n") } as never);
    press("ArrowUp"); // KEYMAP's k — not a choice, so the prompt loops
    press("y");
    expect(await answer).toBe(key("y"));
    expect(asked).toBe(0);
  });

  it("is not consulted while a message_menu is waiting", async () => {
    let asked = 0;
    hud.remap = () => { asked++; return key("l"); };
    const answer = hud.handle({ name: "message_menu", how: 1, text: "Eat what?" } as never);
    press("ArrowUp");
    expect(await answer).toBe(key("k")); // the raw key, not the remapped l
    expect(asked).toBe(0);
  });

  it("is consulted again once the prompt is answered", async () => {
    hud.remap = (e) => (e.key === "ArrowUp" ? key("l") : null);
    const answer = hud.handle(
      { name: "yn_function", query: "Really quit?", choices: "yn", def: key("n") } as never);
    press("n");
    await answer;
    press("ArrowUp");
    expect(await drain(1)).toEqual([key("l")]);
  });

  it("is not consulted while a menu is up", () => {
    let asked = 0;
    hud.remap = () => { asked++; return null; };
    (hud as unknown as { activeMenu: unknown }).activeMenu =
      { items: [], prompt: "", how: 1, selected: new Set(), accels: new Map() };
    press("ArrowUp");
    expect(asked).toBe(0);
  });

  it("is not consulted while a line of text is being typed", () => {
    let asked = 0;
    hud.remap = () => { asked++; return null; };
    (hud as unknown as { lineInput: unknown }).lineInput = () => {};
    press("ArrowUp");
    expect(asked).toBe(0);
  });
});

// vect-hack-be3.6: getdir() (external/NetHack/src/cmd.c:3989) reaches this
// port as a yn_function with empty choices, same as several other prompts
// that pass NULL for `resp` (item-letter picks, "What do you look for?",
// "adjust?", "What command?" ...) — nothing in the ShimEvent shape alone
// tells them apart. Every getdir() query, default or caller-supplied,
// contains "direction"; no other empty-choices caller's does, so that
// substring is the narrower gate `isDirectionPrompt` opens.
describe("TextHud.remap during getdir()'s direction prompt", () => {
  let hud: InstanceType<typeof TextHud>;
  beforeEach(() => {
    els.clear();
    hud = new TextHud();
  });

  it("answers the default getdir prompt with the remapped direction", async () => {
    hud.remap = (e) => (e.key === "ArrowUp" ? key("l") : null);
    const answer = hud.handle(
      { name: "yn_function", query: "In what direction?", choices: "", def: 0 } as never);
    press("ArrowUp");
    expect(await answer).toBe(key("l")); // not "k", which KEYMAP would give
  });

  it("answers a custom getdir prompt the same way (dig.c, sounds.c, ... vary the text)", async () => {
    hud.remap = (e) => (e.key === "ArrowUp" ? key("l") : null);
    const answer = hud.handle(
      { name: "yn_function", query: "Loot in what direction?", choices: "", def: 0 } as never);
    press("ArrowUp");
    expect(await answer).toBe(key("l"));
  });

  it("still gates remap off for an empty-choices prompt that isn't getdir", async () => {
    // detect.c:1300 — same empty choices and def as getdir, different question.
    let asked = 0;
    hud.remap = () => { asked++; return key("l"); };
    const answer = hud.handle(
      { name: "yn_function", query: "What do you look for?", choices: "", def: 0 } as never);
    press("ArrowUp");
    expect(await answer).toBe(key("k")); // KEYMAP's raw key, not the remapped l
    expect(asked).toBe(0);
  });

  it("falls through to the raw key when remap declines (orbit mode, unbound key)", async () => {
    hud.remap = () => null; // e.g. a key bound in neither table
    const answer = hud.handle(
      { name: "yn_function", query: "In what direction?", choices: "", def: 0 } as never);
    press("ArrowUp");
    expect(await answer).toBe(key("k"));
  });

  it("feeds nothing and leaves the prompt waiting when remap turns the camera", async () => {
    hud.remap = (e) => (e.key === "ArrowLeft" ? "consumed" : null);
    const answer = hud.handle(
      { name: "yn_function", query: "In what direction?", choices: "", def: 0 } as never);
    press("ArrowLeft"); // turned the camera, answered nothing
    press("h"); // now answer for real
    expect(await answer).toBe(key("h"));
  });

  it("closes the gate again once the direction prompt is answered", async () => {
    let asked = 0;
    hud.remap = (e) => { asked++; return e.key === "ArrowUp" ? key("l") : null; };
    const answer = hud.handle(
      { name: "yn_function", query: "In what direction?", choices: "", def: 0 } as never);
    press("h");
    await answer;
    asked = 0;
    const again = hud.handle(
      { name: "yn_function", query: "Really quit?", choices: "yn", def: key("n") } as never);
    press("ArrowUp"); // KEYMAP's k — not a choice, so the prompt loops
    press("y");
    expect(await again).toBe(key("y"));
    expect(asked).toBe(0);
  });
});

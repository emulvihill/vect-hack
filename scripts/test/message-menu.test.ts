// message_menu() is the core asking a question from inside a menu: a single
// item put on the message line, answered from the prompt that is still up
// (doc/window.txt, src/invent.c:3199). It used to be stubbed to 'y' in the
// worker, which silently picked an item nobody chose — so what is asserted
// here is that a key comes back, and which key.
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

const press = (key: string) => onKey({ key, preventDefault() {} });
const messages = () => els.get("messages")!.children.map((c) => c.textContent);
const prompt = () => els.get("prompt")!;

describe("message_menu", () => {
  let hud: InstanceType<typeof TextHud>;

  beforeEach(() => {
    els.clear();
    hud = new TextHud();
  });

  const ask = (how: number, text = "f - 5 uncursed lembas wafers.") =>
    Promise.resolve(hud.handle({ name: "message_menu", how, text }));

  it("prints the message and asks nothing when nothing is selectable", async () => {
    expect(await ask(0)).toBe(0); // PICK_NONE
    expect(messages()).toEqual(["f - 5 uncursed lembas wafers."]);
    expect(prompt().hidden).toBe(true);
  });

  it("answers with the key the player pressed", async () => {
    const answer = ask(1); // PICK_ONE
    expect(prompt().hidden).toBe(false);
    press("f");
    expect(await answer).toBe("f".charCodeAt(0));
    expect(prompt().hidden).toBe(true);
    expect(messages()).toEqual(["f - 5 uncursed lembas wafers."]);
  });

  it("reports no selection when the player just dismisses it", async () => {
    for (const key of ["Enter", " "]) {
      const answer = ask(1);
      press(key);
      expect(await answer).toBe(0);
    }
  });

  it("passes the cancel through, so the core drops the prompt", async () => {
    const answer = ask(1);
    press("Escape");
    expect(await answer).toBe(27);
  });
});

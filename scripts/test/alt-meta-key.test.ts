// Alt- and Cmd-modified letters (vect-hack-cio). NetHack's Meta commands are
// the classic 8-bit fold — M(c) = 0x80 | c (keys.ts's meta()) — and Alt+c
// (chat), Alt+p (pray) etc. must arrive as that byte, not as the bare letter,
// which is a *different* command (c is close). The fold is only safe on the
// command path: yn_function's no-choices path and message_menu hand the raw
// code back to the bridge, whose compiled 'c' return converter throws for
// anything over 128 and wedges Asyncify (see non-ascii-key.test.ts), so while
// `prompting` is up an Alt-modified letter is dropped, not folded and not
// delivered bare. Cmd (metaKey) rides browser shortcuts the page can't always
// see; the one wrong answer is executing the bare letter, so it is dropped.
import { beforeEach, describe, expect, it } from "vitest";
import { ctrl, key, meta } from "../../src/modules/nethack/ui/keys";

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
}

const els = new Map<string, StubEl>();
type KeyEv = { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; preventDefault(): void };
let onKey: (e: KeyEv) => void;

(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!,
  createElement: () => new StubEl(),
  addEventListener: (_t: string, fn: typeof onKey) => (onKey = fn),
} as unknown as Document;

// Imported after the stub: TextHud looks its elements up while constructing.
const { TextHud } = await import("../../src/modules/nethack/ui/TextHud");

const press = (k: string, mods: Partial<KeyEv> = {}) =>
  onKey({ key: k, ...mods, preventDefault() {} });

describe("Alt/Meta-modified letters", () => {
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

  it("folds Alt+letter to the Meta byte on the command path", async () => {
    press("c", { altKey: true });
    expect(await drain(1)).toEqual([meta("c")]); // chat — not key('c'), which is close
  });

  it("leaves bare and Ctrl-modified letters alone", async () => {
    press("c");
    press("d", { ctrlKey: true });
    expect(await drain(2)).toEqual([key("c"), ctrl("d")]);
  });

  it("drops Alt+letter while a no-choices yn prompt is up", async () => {
    const answer = hud.handle({ name: "yn_function", query: "In what direction?", choices: "", def: 0 } as never);
    press("p", { altKey: true }); // neither answers as bare 'p' nor sends 0x80|p to the bridge
    press("x");
    expect(await answer).toBe(key("x"));
  });

  it("drops Alt+letter while a message_menu is waiting", async () => {
    const answer = hud.handle({ name: "message_menu", how: 1, text: "Eat what?" } as never);
    press("c", { altKey: true });
    press("k");
    expect(await answer).toBe(key("k"));
  });

  it("drops Cmd-modified letters instead of running the bare command", async () => {
    press("c", { metaKey: true });
    press("s");
    expect(await drain(1)).toEqual([key("s")]);
  });
});

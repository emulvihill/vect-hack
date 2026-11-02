// A non-ASCII keypress (vect-hack-0vd). yn_function's no-choices path and
// message_menu both hand the raw key straight back to the bridge (see
// remap.test.ts's header for why nothing else screens them), and the
// compiled shim's 'c' return converter (win/shim/winshim.c's setPointerValue,
// baked into targets/wasm/nethack.js) throws a TypeError for anything over
// 128 — which wedges Asyncify mid-call. TextHud.keyCode() is the one place a
// key becomes a code, so it is the one place to keep an accented or IME
// character from ever reaching that ceiling. Its other drop rule is pinned at
// the bottom of this file: a key *name* is only a name, never whatever
// Object.prototype happens to answer to.
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

/** What the engine actually received, in order. */
const drain = async (hud: InstanceType<typeof TextHud>, n: number) => {
  const got: number[] = [];
  const read = (hud as unknown as { readKey(): Promise<number> }).readKey.bind(hud);
  for (let i = 0; i < n; i++) got.push(await read());
  return got;
};

describe("non-ASCII keys", () => {
  let hud: InstanceType<typeof TextHud>;

  beforeEach(() => {
    els.clear();
    hud = new TextHud();
  });

  it("is dropped rather than queued", async () => {
    press("é"); // charCodeAt(0) === 233 — over the 128 the compiled shim allows
    press("k");
    expect(await drain(hud, 1)).toEqual([key("k")]); // only the ASCII key made it through
  });

  it("never queues a code over the shim's 'c' return ceiling", async () => {
    press("あ"); // an IME character (hiragana "a"), well past 128
    press("y");
    expect(await drain(hud, 1)).toEqual([key("y")]);
  });

  it("does not wedge yn_function's no-choices path", async () => {
    const answer = hud.handle(
      { name: "yn_function", query: "pick a fruit", choices: "", def: 0 } as never);
    press("é");
    press("y");
    expect(await answer).toBe(key("y"));
  });

  it("does not wedge message_menu", async () => {
    const answer = hud.handle({ name: "message_menu", how: 1, text: "Eat what?" } as never);
    press("é");
    press("f");
    expect(await answer).toBe(key("f"));
  });
});

describe("prototype-chain key names (vect-hack-avm)", () => {
  let hud: InstanceType<typeof TextHud>;

  beforeEach(() => {
    els.clear();
    hud = new TextHud();
  });

  it("never resolves a key name through the prototype chain", async () => {
    // Without an own-property guard, KEYMAP["toString"] is a function and
    // keyCode() would queue it where a number belongs — straight past the
    // <= 127 ceiling and into the shim's 'c' return converter.
    press("toString");
    press("constructor");
    press("hasOwnProperty");
    press("k");
    expect(await drain(hud, 1)).toEqual([key("k")]); // only the real key made it through
  });

  it("does not answer a prompt with a prototype method", async () => {
    const answer = hud.handle(
      { name: "yn_function", query: "pick a fruit", choices: "", def: 0 } as never);
    press("toString");
    press("y");
    expect(await answer).toBe(key("y"));
  });
});

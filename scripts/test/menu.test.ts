// The full NetHack menu (start_menu/add_menu/end_menu/select_menu) driven
// pointer-first (vect-hack-be3.4): renderMenu() grew clickable rows and a
// per-row quantity control, but PICK_NONE/PICK_ONE/PICK_ANY still resolve the
// same way regardless of how the player got there. Digit-prefix counting
// (classic NetHack: type a count, then the accelerator) is exercised here
// too, since it never had unit coverage of its own before this bead.
import { beforeEach, describe, expect, it } from "vitest";
import type { MenuItemData } from "../../src/modules/nethack/protocol";

/** Enough of an element for the message log, prompt line and overlay. */
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

/** Keydowns whose own key is a modifier — every name a keyboard can send on
 *  its own, not just the four TextHud used to name (vect-hack-ca5). */
const MODIFIERS = ["Shift", "Control", "Alt", "Meta", "CapsLock",
  "AltGraph", "NumLock", "ScrollLock", "Fn"];

/** A minimal fake DOM node: just enough of closest()/querySelector() for
 *  onMenuClick's own delegation logic, without a real HTML parser. */
class FakeEl {
  tagName: string;
  dataset: Record<string, string> = {};
  value = "";
  private cls: Set<string>;
  private parent: FakeEl | null = null;
  private kids: FakeEl[] = [];
  constructor(tag: string, cls: string[] = []) { this.tagName = tag.toUpperCase(); this.cls = new Set(cls); }
  add(...kids: FakeEl[]): this { for (const k of kids) { k.parent = this; this.kids.push(k); } return this; }
  private matches(sel: string): boolean {
    if (sel === "input") return this.tagName === "INPUT";
    if (sel === "input.mqty") return this.tagName === "INPUT" && this.cls.has("mqty");
    const dataAttr = /^\[data-(\w+)\]$/.exec(sel);
    return dataAttr ? this.dataset[dataAttr[1]!] !== undefined : false;
  }
  closest<T = FakeEl>(sel: string): T | null {
    for (let n: FakeEl | null = this; n; n = n.parent) if (n.matches(sel)) return n as unknown as T;
    return null;
  }
  querySelector<T = FakeEl>(sel: string): T | null {
    for (const k of this.kids) {
      if (k.matches(sel)) return k as unknown as T;
      const found = k.querySelector<T>(sel);
      if (found) return found;
    }
    return null;
  }
}

/** A clickable menu row shaped like renderMenu()'s output: a label plus a
 *  quantity input, both reachable from a data-i div via closest()/querySelector(). */
function fakeRow(i: number, qty = "") {
  const label = new FakeEl("span");
  const input = new FakeEl("input", ["mqty"]);
  input.value = qty;
  const row = new FakeEl("div", ["pmrow"]).add(label, input);
  row.dataset.i = String(i);
  return { row, label, input };
}

const fakeAct = (act: string) => { const el = new FakeEl("span"); el.dataset.act = act; return el; };

const item = (identifier: number, text: string, over: Partial<MenuItemData> = {}): MenuItemData =>
  ({ identifier, accelerator: "", groupAccel: "", attr: 0, color: 7, text, itemflags: 0, glyph: null, ...over });

describe("full menu", () => {
  let hud: InstanceType<typeof TextHud>;
  const WIN = 1;

  beforeEach(() => {
    els.clear();
    hud = new TextHud();
  });

  /** Wires start_menu, one add_menu per item and end_menu, then opens it
   *  with select_menu. */
  function open(items: MenuItemData[], how: number, prompt = "") {
    hud.handle({ name: "start_menu", win: WIN, mbehavior: 0 } as never);
    for (const it of items) hud.handle({ name: "add_menu", win: WIN, item: it } as never);
    hud.handle({ name: "end_menu", win: WIN, prompt } as never);
    return hud.handle({ name: "select_menu", win: WIN, how } as never) as Promise<unknown>;
  }

  const clickRow = (r: FakeEl) =>
    (hud as unknown as { onMenuClick(e: unknown): void }).onMenuClick({ target: r });

  /** Everything still sitting in the key queue: a keystroke the menu should
   *  have consumed shows up here as a live command byte instead. */
  const queued = () => {
    const keys = (hud as unknown as { keys: { next(wait: boolean): number | null } }).keys;
    const out: number[] = [];
    for (let k = keys.next(false); k !== null; k = keys.next(false)) out.push(k);
    return out;
  };

  it("PICK_NONE: any key dismisses with no picks", async () => {
    const answer = open([item(1, "a scroll")], 0);
    press("x");
    expect(await answer).toEqual({ picks: [] });
  });

  it("PICK_NONE: a bare modifier keydown is not the 'any key'", async () => {
    // vect-hack-ca5: the Shift of a capital arrives as its own keydown first.
    // Dismissing on it spends the menu, and the letter it belongs to then
    // lands on the command loop as a live command — "Z" turning from "cast a
    // spell" into a spellcast nobody asked for.
    const answer = open([item(1, "a scroll")], 0);
    const overlay = els.get("overlay")!;
    for (const mod of MODIFIERS) press(mod);
    expect(overlay.hidden).toBe(false); // still up, still waiting for a real key
    press("Z");
    expect(await answer).toEqual({ picks: [] });
    expect(queued()).toEqual([]); // the Z dismissed the menu; the game never saw it
  });

  it("PICK_NONE: Escape still cancels, distinct from a plain dismiss", async () => {
    const answer = open([item(1, "a scroll")], 0);
    press("Escape");
    expect(await answer).toBeNull();
  });

  it("PICK_ONE: pressing the accelerator picks that item and closes", async () => {
    const it1 = item(101, "a dagger");
    const answer = open([it1], 1);
    press("a"); // sole item, so runMenu assigns it "a"
    expect(await answer).toEqual({ picks: [{ identifier: 101, count: -1, itemflags: 0 }] });
  });

  it("PICK_ONE: Escape cancels with null", async () => {
    const answer = open([item(101, "a dagger")], 1);
    press("Escape");
    expect(await answer).toBeNull();
  });

  it("PICK_ANY: letters toggle selection; Enter collects everything selected", async () => {
    const answer = open([item(1, "food"), item(2, "a potion")], 2);
    press("a");
    press("b");
    press("a"); // toggle back off
    press("Enter");
    expect(await answer).toEqual({ picks: [{ identifier: 2, count: -1, itemflags: 0 }] });
  });

  it("PICK_ANY: Escape cancels regardless of any selection made", async () => {
    const answer = open([item(1, "food")], 2);
    press("a");
    press("Escape");
    expect(await answer).toBeNull();
  });

  it("headings get no accelerator and cannot be picked", async () => {
    const heading = item(0, "Weapons");
    const real = item(5, "a long sword");
    const answer = open([heading, real], 1);
    // The heading is skipped when handing out letters, so "a" lands on the
    // first real item, not the heading.
    press("a");
    expect(await answer).toEqual({ picks: [{ identifier: 5, count: -1, itemflags: 0 }] });
  });

  it("a stray select on a heading index is a no-op, not a crash", async () => {
    const answer = open([item(0, "Weapons"), item(5, "a long sword")], 2);
    (hud as unknown as { selectItem(i: number, c: number | null): void }).selectItem(0, null);
    press("Enter");
    expect(await answer).toEqual({ picks: [] }); // the stray call selected nothing
  });

  it("digit prefix sets an explicit count for the accelerator that follows", async () => {
    const answer = open([item(9, "5 daggers")], 2);
    press("3"); press("a");
    press("Enter");
    expect(await answer).toEqual({ picks: [{ identifier: 9, count: 3, itemflags: 0 }] });
  });

  it("leading zeros are ignored, same as wintty.c's AppendLongDigit", async () => {
    const answer = open([item(9, "5 daggers")], 2);
    press("0"); press("0"); press("5"); press("a");
    press("Enter");
    expect(await answer).toEqual({ picks: [{ identifier: 9, count: 5, itemflags: 0 }] });
  });

  it("re-pressing an already-selected accelerator without new digits deselects it", async () => {
    const answer = open([item(9, "5 daggers")], 2);
    press("3"); press("a"); // selected, count 3
    press("a");             // bare press: toggles off, drops the count
    press("Enter");
    expect(await answer).toEqual({ picks: [] });
  });

  it("a fresh count on an already-selected item updates it without deselecting", async () => {
    const answer = open([item(9, "5 daggers")], 2);
    press("3"); press("a");
    press("5"); press("a"); // still selected, count now 5
    press("Enter");
    expect(await answer).toEqual({ picks: [{ identifier: 9, count: 5, itemflags: 0 }] });
  });

  it("Escape mid-count only stops the count; the menu stays open", async () => {
    const answer = open([item(9, "5 daggers")], 2);
    press("3");
    press("Escape"); // stops the pending count, does not cancel the menu
    press("a");      // bare press now: plain toggle, no count
    press("Enter");
    expect(await answer).toEqual({ picks: [{ identifier: 9, count: -1, itemflags: 0 }] });
  });

  it("Escape with no count pending still cancels the whole menu", async () => {
    const answer = open([item(9, "5 daggers")], 2);
    press("Escape");
    expect(await answer).toBeNull();
  });

  it("clicking a row selects it, reading the count from its own quantity field", async () => {
    const answer = open([item(9, "5 daggers"), item(10, "a potion")], 2);
    const { label } = fakeRow(0, "4");
    clickRow(label);
    press("Enter");
    expect(await answer).toEqual({ picks: [{ identifier: 9, count: 4, itemflags: 0 }] });
  });

  it("clicking a row with no quantity typed picks the whole stack, like a bare letter", async () => {
    const answer = open([item(9, "5 daggers")], 2);
    const { label } = fakeRow(0);
    clickRow(label);
    press("Enter");
    expect(await answer).toEqual({ picks: [{ identifier: 9, count: -1, itemflags: 0 }] });
  });

  it("a fractional quantity is not a valid count, so the row picks the whole stack instead", async () => {
    const answer = open([item(9, "5 daggers")], 2);
    const { label } = fakeRow(0, "3.5");
    clickRow(label);
    press("Enter");
    expect(await answer).toEqual({ picks: [{ identifier: 9, count: -1, itemflags: 0 }] });
  });

  it("clicking the quantity input itself does not select the row", async () => {
    const answer = open([item(9, "5 daggers")], 2);
    const { input } = fakeRow(0, "4");
    clickRow(input);
    press("Enter"); // proves the click above selected nothing, not just that Escape wins
    expect(await answer).toEqual({ picks: [] });
  });

  it("clicking a row and typing digits converge on the same pick as the keyboard path", async () => {
    const viaClick = open([item(9, "5 daggers")], 2);
    clickRow(fakeRow(0, "2").label);
    press("Enter");

    els.clear();
    hud = new TextHud();
    const viaKeys = open([item(9, "5 daggers")], 2);
    press("2"); press("a");
    press("Enter");

    expect(await viaClick).toEqual(await viaKeys);
  });

  it("clicking the done control confirms a PICK_ANY selection", async () => {
    const answer = open([item(1, "food")], 2);
    press("a");
    (hud as unknown as { onMenuClick(e: unknown): void }).onMenuClick({ target: fakeAct("done") });
    expect(await answer).toEqual({ picks: [{ identifier: 1, count: -1, itemflags: 0 }] });
  });

  it("clicking the cancel control cancels like Escape", async () => {
    const answer = open([item(1, "food")], 2);
    press("a");
    (hud as unknown as { onMenuClick(e: unknown): void }).onMenuClick({ target: fakeAct("cancel") });
    expect(await answer).toBeNull();
  });

  it("clicking the dismiss control on a PICK_NONE menu behaves like any key", async () => {
    const answer = open([item(1, "a scroll")], 0);
    (hud as unknown as { onMenuClick(e: unknown): void }).onMenuClick({ target: fakeAct("dismiss") });
    expect(await answer).toEqual({ picks: [] });
  });

  it("auto accelerators wrap 'z' to 'A' instead of counting into punctuation", async () => {
    // wintty.c's end_menu (win/tty/wintty.c:2726) does `if (menu_ch++ == 'z')
    // menu_ch = 'A'`. Counting straight on handed item 27 '{', item 31 DEL and
    // beyond — characters no keyboard produces, so the tail of the 41-row
    // options menu could not be picked by key at all (vect-hack-814).
    const items = Array.from({ length: 27 }, (_, i) => item(i + 1, `item ${i + 1}`));
    const answer = open(items, 1);
    expect(items.map((it) => it.accelerator).join("")).toBe(
      "abcdefghijklmnopqrstuvwxyzA");
    press("A"); // the 27th item, the first past 'z'
    expect(await answer).toEqual({ picks: [{ identifier: 27, count: -1, itemflags: 0 }] });
  });

  it("hands out 'a'..'z' then 'A'..'Z', and nothing untypable after that", async () => {
    // This overlay does not paginate, so it really can run out of letters
    // where upstream's per-page reset never does: item 53 gets no accelerator
    // rather than a character the player cannot send.
    const items = Array.from({ length: 60 }, (_, i) => item(i + 1, `item ${i + 1}`));
    const answer = open(items, 2);
    const accels = items.map((it) => it.accelerator);
    expect(accels.slice(0, 52).join("")).toBe(
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(accels.slice(52)).toEqual(Array(8).fill(""));
    press("Z"); // the 52nd, the last letter there is
    press("Escape");
    expect(await answer).toBeNull();
    expect(accels.every((a) => a === "" || /^[a-zA-Z]$/.test(a))).toBe(true);
  });

  it("an item past the last letter is still clickable, just not typable", async () => {
    const items = Array.from({ length: 53 }, (_, i) => item(i + 1, `item ${i + 1}`));
    const answer = open(items, 2);
    clickRow(fakeRow(52).label); // the 53rd row, the one with no accelerator
    press("Enter");
    expect(await answer).toEqual({ picks: [{ identifier: 53, count: -1, itemflags: 0 }] });
  });

  it("renders headings without a data-i, so they render inert even though they're in the same list", () => {
    open([item(0, "Weapons"), item(5, "a long sword")], 2);
    const html = els.get("overlay")!.innerHTML;
    // The heading's own markup carries no data-i attribute at all...
    expect(html).toContain('<div class="mhead">Weapons</div>');
    // ...while the real item right after it does.
    expect(html).toContain('data-i="1"');
  });

  it("renders no quantity control for PICK_ONE, where a count is meaningless", () => {
    open([item(9, "5 daggers")], 1);
    expect(els.get("overlay")!.innerHTML).not.toContain("mqty");
  });

  it("renders a quantity control for PICK_ANY, where a count picks a partial stack", () => {
    open([item(9, "5 daggers")], 2);
    expect(els.get("overlay")!.innerHTML).toContain("mqty");
  });
});

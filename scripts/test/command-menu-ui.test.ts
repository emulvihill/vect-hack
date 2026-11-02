// The command menu's wiring (vect-hack-be3.7). The table itself is covered by
// command-menu.test.ts; what is worth driving here is the part with state —
// the button, the submenu reopen, and the teardown ordering that a submenu
// gets wrong if close() runs after the row it just fired.
//
// The DOM stub records listeners per type and can replay them, unlike the
// write-only stubs in the sibling files: every assertion here is about what
// happens when a listener fires.
import { beforeEach, describe, expect, it } from "vitest";
import { key } from "../../src/modules/nethack/ui/keys";
import { COMMAND_GROUPS } from "../../src/modules/nethack/ui/commandMenu";

type Listener = (e: never) => void;

class StubEl {
  innerHTML = "";
  hidden = true;
  scrollTop = 0;
  scrollHeight = 0;
  blurred = 0;
  children: StubEl[] = [];
  listeners = new Map<string, Set<Listener>>();
  // Real DOM semantics, unlike the plain field the sibling stubs use:
  // assigning textContent replaces every other child. The assertions here
  // read innerHTML, so a plain field would let a blanked element keep the
  // markup a test is checking has gone.
  #text = "";
  get textContent() { return this.#text; }
  set textContent(v: string) { this.#text = v; this.innerHTML = v; this.children = []; }
  get childElementCount() { return this.children.length; }
  get firstChild() {
    const c = this.children[0];
    return c ? { remove: () => void this.children.shift() } : null;
  }
  appendChild(c: StubEl) { this.children.push(c); return c; }
  blur() { this.blurred++; }
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

/** Row labels currently drawn into #overlay, in order. */
const rowLabels = (): string[] =>
  [...el("overlay").innerHTML.matchAll(/data-pi="\d+">([^<]*)</g)].map((m) => m[1]!);

/** Fire the delegated row-click handler for row `i`, the way a real click
 *  would after `closest("[data-pi]")` resolved. */
const clickRow = (i: number) =>
  el("overlay").emit("click", {
    target: { closest: (sel: string) => sel === "[data-pi]" ? { dataset: { pi: String(i) } } : null },
  });

describe("the command menu", () => {
  let hud: InstanceType<typeof TextHud>;

  beforeEach(() => {
    els.clear();
    hud = new TextHud();
  });

  it("opens from the button, one row per group", () => {
    el("cmdbtn").emit("click", {});
    expect(rowLabels()).toEqual(COMMAND_GROUPS.map((g) => `${g.label}...`));
  });

  it("blurs the button, so a later Space or Enter reaches the game", () => {
    el("cmdbtn").emit("click", {});
    expect(el("cmdbtn").blurred).toBe(1);
  });

  it("replaces the categories with a group's commands, plus a way back", () => {
    el("cmdbtn").emit("click", {});
    clickRow(0);
    expect(rowLabels()).toEqual([
      ...COMMAND_GROUPS[0]!.commands.map((c) => c.label), "‹ Back",
    ]);
    clickRow(COMMAND_GROUPS[0]!.commands.length); // the Back row
    expect(rowLabels()).toEqual(COMMAND_GROUPS.map((g) => `${g.label}...`));
  });

  it("keeps tracking the submenu, so Escape still closes it", () => {
    // The bug close-before-run fixes: the outgoing closure's teardown would
    // null out the submenu's own `actionMenu`, leaving rows on screen that
    // Escape no longer closes and an engine window no longer tears down.
    el("cmdbtn").emit("click", {});
    clickRow(0);
    expect((hud as unknown as { actionMenu: unknown }).actionMenu).not.toBeNull();
  });

  it("feeds the chosen command's key to the engine", async () => {
    el("cmdbtn").emit("click", {});
    clickRow(0);
    clickRow(0); // the first command of the first group
    expect(await hud.handle({ name: "nhgetch" } as never)).toBe(COMMAND_GROUPS[0]!.commands[0]!.code);
  });

  it("reaches the commands the be3 review found unreachable", async () => {
    const explore = COMMAND_GROUPS.findIndex((g) => g.label === "Explore");
    const down = COMMAND_GROUPS[explore]!.commands.findIndex((c) => c.label === "Go down stairs");
    el("cmdbtn").emit("click", {});
    clickRow(explore);
    clickRow(down);
    expect(await hud.handle({ name: "nhgetch" } as never)).toBe(key(">"));
  });

  it("declines while the engine has a question up, rather than stomping on it", () => {
    void hud.handle({ name: "yn_function", query: "Really quit?", choices: "yn", def: 0 } as never);
    el("cmdbtn").emit("click", {});
    expect((hud as unknown as { actionMenu: unknown }).actionMenu).toBeNull();
  });
});
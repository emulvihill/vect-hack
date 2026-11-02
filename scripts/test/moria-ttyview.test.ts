import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MORIA_FRAME_BYTES } from "../../src/modules/moria/protocol";

class StubEl {
  id = ""; textContent = ""; innerHTML = ""; removed = false;
  children: StubEl[] = []; classList = { add() {} };
  appendChild(c: StubEl) { this.children.push(c); return c; }
  remove() { this.removed = true; }
}

const els = new Map<string, StubEl>();
let keydown: ((e: KeyboardEvent) => void) | null = null;
const add = vi.fn((type: string, fn: (e: KeyboardEvent) => void) => { if (type === "keydown") keydown = fn; });
const remove = vi.fn((type: string, fn: (e: KeyboardEvent) => void) => {
  if (type === "keydown" && keydown === fn) keydown = null;
});
(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!,
  createElement: () => new StubEl(), addEventListener: add, removeEventListener: remove,
} as unknown as Document;

const { TtyView } = await import("../../src/modules/moria/ui/TtyView");
const press = (key: string, extra: Record<string, boolean> = {}) =>
  keydown!({ key, preventDefault: vi.fn(), ...extra } as unknown as KeyboardEvent);

describe("Moria TtyView", () => {
  beforeEach(() => { els.clear(); add.mockClear(); remove.mockClear(); keydown = null; vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("uses request context/mode, preserves NUL, and answers an empty poll", async () => {
    const view = new TtyView();
    expect(await view.nextKey(false, "poll", "original")).toBeNull();
    const waiting = view.nextKey(true, "outer-command", "roguelike");
    press("ArrowUp");
    await expect(waiting).resolves.toBe("k".charCodeAt(0));
    const nul = view.nextKey(true, "literal", "original");
    press("@", { ctrlKey: true });
    await expect(nul).resolves.toBe(0);
  });

  it("renders copied frames and notices behind one burst gate", () => {
    const view = new TtyView();
    const cells = new Uint8Array(MORIA_FRAME_BYTES).fill(32);
    cells.set(new TextEncoder().encode("Umoria"));
    view.handle({ name: "frame", cells, x: 0, y: 0 });
    cells[0] = 0x58;
    expect(els.get("stage")!.children[0]!.innerHTML).toBe("");
    vi.advanceTimersByTime(40);
    expect(els.get("stage")!.children[0]!.innerHTML).toContain(">U</span>moria");
    expect(els.get("stage")!.children[0]!.innerHTML).not.toContain(">X</span>moria");
    view.onNotice("hello");
    expect(els.get("messages")!.children[0]!.textContent).toBe("hello");
  });

  it("stores and removes its key listener on dispose", () => {
    const view = new TtyView();
    const cells = new Uint8Array(MORIA_FRAME_BYTES).fill(32);
    cells[0] = 0x40;
    view.handle({ name: "frame", cells, x: 0, y: 0 });
    expect(add).toHaveBeenCalledOnce();
    view.dispose(); view.dispose();
    vi.runAllTimers();
    expect(remove).toHaveBeenCalledOnce();
    expect(keydown).toBeNull();
    expect(els.get("stage")!.children[0]!.innerHTML).toBe("");
  });
});

// Pre-move pinning tests for the Backplane extraction (backplane design,
// "Testing gaps"): the two major TextHud paths that had no coverage before
// the code moves. Characterization, not TDD — these pass against today's
// behavior and must stay green through every wave.
//
// 1. getlin (vect-hack-1vf): submit and cancel through the #linein input.
//    Task 8's fallback table redesigns this reply path (a cancelled getlin
//    becomes the fallback's null), so the happy path is pinned first.
// 2. One representative status-line frame: STATUS_FMT assembly, decodeMixed's
//    \GXXXXNNNN -> "$" fold, and the blank-field skip.
import { describe, expect, it } from "vitest";

/** Enough of an element for the prompt line, status bar and getLine's input.
 *  textContent models the DOM link the prompt blanking rests on: assigning it
 *  replaces the element's markup and children, so what getLine wrote into
 *  innerHTML is really gone. Without that link a `toBe("")` on textContent
 *  compares this stub's own default against itself and cannot fail. */
class StubEl {
  innerHTML = "";
  hidden = true;
  value = "";
  scrollTop = 0;
  scrollHeight = 0;
  children: StubEl[] = [];
  onkeydown: ((e: { key: string; stopPropagation(): void }) => void) | null = null;
  private text = "";
  get textContent() { return this.text; }
  set textContent(v: string) { this.text = v; this.innerHTML = v; this.children.length = 0; }
  get childElementCount() { return this.children.length; }
  get firstChild() {
    const c = this.children[0];
    return c ? { remove: () => void this.children.shift() } : null;
  }
  appendChild(c: StubEl) { this.children.push(c); return c; }
  addEventListener() {}
  removeEventListener() {}
  blur() {}
  focus() {}
}

const els = new Map<string, StubEl>();
(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!,
  createElement: () => new StubEl(),
  addEventListener: () => {},
} as unknown as Document;

// Imported after the stub: TextHud looks its elements up while constructing.
const { TextHud } = await import("../../src/modules/nethack/ui/TextHud");

describe("getlin (vect-hack-1vf)", () => {
  it("submits the typed line on Enter and blanks the prompt", async () => {
    const hud = new TextHud();
    const p = hud.handle({ name: "getlin", query: "What do you wish for?" }) as Promise<string | null>;
    const input = els.get("linein")!;
    // The query and its <input> are live markup right now — which is what
    // makes the blank below an assertion and not a tautology.
    expect(els.get("prompt")!.innerHTML).toContain("What do you wish for?");
    input.value = "blessed +2 gray dragon scale mail";
    input.onkeydown!({ key: "Enter", stopPropagation() {} });
    await expect(p).resolves.toBe("blessed +2 gray dragon scale mail");
    expect(els.get("prompt")!.hidden).toBe(true);
    expect(els.get("prompt")!.innerHTML).toBe("");
  });

  it("cancels to null on Escape, discarding what was typed", async () => {
    const hud = new TextHud();
    const p = hud.handle({ name: "getlin", query: "Who are you?" }) as Promise<string | null>;
    const input = els.get("linein")!;
    input.value = "half-typed";
    input.onkeydown!({ key: "Escape", stopPropagation() {} });
    await expect(p).resolves.toBeNull();
    expect(els.get("prompt")!.hidden).toBe(true);
  });
});

describe("status line", () => {
  it("assembles one representative frame through STATUS_FMT and decodeMixed", () => {
    const hud = new TextHud();
    const upd = (fldidx: number, text: string) =>
      hud.handle({ name: "status_update", fldidx, text, condbits: 0, chg: 0, percent: 0, color: 0 });
    upd(0, "Eric the Stripling");   // BL_TITLE: "%s"
    upd(8, "  ");                   // BL_SCORE: blank -> contributes nothing
    upd(10, "\\Gdeadbeef:12");      // BL_GOLD: \G + 8 hex decodes to "$"
    upd(14, "7");                   // BL_AC: " AC:%s"
    upd(18, "14");                  // BL_HP: " HP:%s"
    upd(19, "16");                  // BL_HPMAX: "(%s)"
    upd(20, "Dlvl:1");              // BL_LEVELDESC: " %s"
    expect(els.get("status")!.textContent)
      .toBe("Eric the Stripling $:12 AC:7 HP:14(16) Dlvl:1");
  });
});

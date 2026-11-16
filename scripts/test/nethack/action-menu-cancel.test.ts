// Cancelling the action menu by clicking elsewhere (vect-hack-9wt). The menu
// closes on the outside *pointerdown*, but the browser still delivers the
// paired *click* — and VectorView's canvas click handler would run
// primaryAction on whatever cell it landed on, so the documented "click
// elsewhere to cancel" gesture could attack a monster. TextHud therefore
// remembers that a pointerdown was spent dismissing the menu, and the click
// side asks-and-clears via consumeOutsideDismissal(). The flag is one-shot
// and scoped to that gesture: the next pointerdown clears it, so a stale
// dismissal can never swallow a later, deliberate click.
import { beforeEach, describe, expect, it } from "vitest";
import { installStubDocument } from "./stub-dom";

const dom = installStubDocument();
const { els } = dom;

const pointerdown = (target: unknown) => dom.dispatch("pointerdown", { target });

// Imported after the stub: TextHud looks its elements up while constructing.
const { TextHud } = await import("../../../src/modules/nethack/ui/TextHud");

const settle = () => new Promise((r) => setTimeout(r, 1)); // outside-click listener registers on a 0ms timer

describe("action menu outside-click dismissal", () => {
  let hud: InstanceType<typeof TextHud>;
  beforeEach(() => {
    dom.reset();
    hud = new TextHud();
  });

  it("marks the gesture consumed exactly once when an outside pointerdown closes the menu", async () => {
    hud.showActionMenu([{ label: "kick", run: () => {} }]);
    await settle();
    pointerdown({}); // lands outside #overlay
    expect(els.get("overlay")!.hidden).toBe(true); // the menu did close
    expect(hud.consumeOutsideDismissal()).toBe(true); // the paired click must stand down
    expect(hud.consumeOutsideDismissal()).toBe(false); // one gesture, one veto
  });

  it("does not mark the gesture when Escape closes the menu", async () => {
    hud.showActionMenu([{ label: "kick", run: () => {} }]);
    await settle();
    dom.press("Escape");
    expect(els.get("overlay")!.hidden).toBe(true);
    expect(hud.consumeOutsideDismissal()).toBe(false);
  });

  it("clears an unconsumed dismissal at the next pointerdown", async () => {
    hud.showActionMenu([{ label: "kick", run: () => {} }]);
    await settle();
    pointerdown({}); // dismissal whose paired click never reached the canvas
    pointerdown({}); // a fresh gesture
    expect(hud.consumeOutsideDismissal()).toBe(false);
  });
});

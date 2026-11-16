import { beforeEach, describe, expect, it } from "vitest";
import type { ShimEvent } from "../../../src/modules/nethack/protocol";
import { installStubDocument } from "./stub-dom";

const dom = installStubDocument();
const { els } = dom;

// Imported after the stub: TextHud looks its elements up while constructing.
const { TextHud } = await import("../../../src/modules/nethack/ui/TextHud");

const press = (keyName: string) => dom.press(keyName);

describe("pass-through stand-on menu", () => {
  let hud: InstanceType<typeof TextHud>;
  beforeEach(() => {
    dom.reset();
    hud = new TextHud();
  });

  it("closes on any key and lets that key reach the game", async () => {
    hud.showActionMenu([{ label: "Pick up", run: () => {} }], { passthrough: true });
    const pending = hud.handle({ name: "nhgetch" } as ShimEvent) as Promise<number>;
    press("j");
    expect(els.get("overlay")!.hidden).toBe(true);
    expect(await pending).toBe("j".charCodeAt(0));
  });

  it("closes on Escape without leaking it to the game", async () => {
    hud.showActionMenu([{ label: "Pick up", run: () => {} }], { passthrough: true });
    press("Escape");
    expect(els.get("overlay")!.hidden).toBe(true);
    const pending = hud.handle({ name: "nhgetch" } as ShimEvent) as Promise<number>;
    press("j"); // the queue must be empty of any ESC — the next key is this one
    expect(await pending).toBe("j".charCodeAt(0));
  });

  it("leaves the menu up for a bare modifier keydown, and still closes on the key it's paired with", async () => {
    hud.showActionMenu([{ label: "Pick up", run: () => {} }], { passthrough: true });
    press("Shift"); // the Shift that starts a "<" arrives as its own keydown first
    expect(els.get("overlay")!.hidden).toBe(false);
    const pending = hud.handle({ name: "nhgetch" } as ShimEvent) as Promise<number>;
    press("j");
    expect(els.get("overlay")!.hidden).toBe(true);
    expect(await pending).toBe("j".charCodeAt(0));
  });

  it("refuses to auto-open while a real prompt is blocking on an answer", async () => {
    // yn_function, not getlin: getlin's #linein is a real <input> the stub
    // DOM doesn't model (no .focus()), but any prompting counts the same way
    // for busyWithPrompt — this is the shape the sibling tests use to stage
    // one (see action-menu-cancel.test.ts).
    const answer = hud.handle({ name: "yn_function", query: "Really quit?", choices: "yn", def: "n".charCodeAt(0) } as ShimEvent) as Promise<number>;
    hud.showActionMenu([{ label: "Pick up", run: () => {} }], { passthrough: true });
    expect(els.get("overlay")!.hidden).toBe(true);
    // Tear the prompt down cleanly so it doesn't leak into the next test.
    press("n");
    expect(await answer).toBe("n".charCodeAt(0));
  });

  it("still swallows keys behind a player-opened (modal) menu", async () => {
    hud.showActionMenu([{ label: "Kick", run: () => {} }]);
    press("j");
    expect(els.get("overlay")!.hidden).toBe(false);
    press("Escape");
    expect(els.get("overlay")!.hidden).toBe(true);
  });

  it("never replaces a menu that is already up", () => {
    let clicked = "";
    hud.showActionMenu([{ label: "Kick", run: () => { clicked = "kick"; } }]);
    hud.showActionMenu([{ label: "Pick up", run: () => {} }], { passthrough: true });
    expect(els.get("overlay")!.innerHTML).toContain("Kick");
    expect(els.get("overlay")!.innerHTML).not.toContain("Pick up");
    void clicked;
  });

  it("refuses to auto-open over a live transient overlay, leaving it to its own timer", () => {
    // display_nhwindow with blocking=false: showOverlay's non-blocking path.
    // Nothing is parked on a promise here, so busyWithPrompt alone wouldn't
    // catch this — the passthrough guard has to check overlayOwner too.
    (hud as unknown as { showOverlay(html: string, blocking: boolean): unknown })
      .showOverlay("<div>Welcome to NetHack!</div>", false);
    const overlayHtml = els.get("overlay")!.innerHTML;
    expect(els.get("overlay")!.hidden).toBe(false);

    hud.showActionMenu([{ label: "Pick up", run: () => {} }], { passthrough: true });
    expect(els.get("overlay")!.innerHTML).toBe(overlayHtml); // untouched
  });

  it("reports every message through onMessage", () => {
    const seen: string[] = [];
    hud.onMessage = (t) => seen.push(t);
    hud.message("You see here a long sword.");
    expect(seen).toEqual(["You see here a long sword."]);
  });
});

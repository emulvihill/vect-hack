// TtyView redraw scheduling (vect-hack-yzk). Angband's update_maps()
// (ui-display.c:1418) calls Term_fresh() once per changed square, so one town
// step reaches us as 28-71 text+flush pairs, each its own postMessage and so
// its own main-thread task. A queueMicrotask gate — DebugView's — cannot
// coalesce across tasks, so the whole 80x24 grid was rebuilt (gridToHtml) and
// re-parsed (innerHTML) once per message: 40.4 ms a step measured, ~2-3 ms
// with both behind one render per burst. The animation frame is raced with a
// timer because rAF stalls in hidden panes and headless runs (vect-hack-r05),
// where a rAF-only gate would never paint at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AngbandEvent } from "../../src/modules/angband/protocol";

/** Counts the expensive half of a redraw: the seam is the grid module, so the
 *  count is of real gridToHtml calls, not of DOM writes that could still be
 *  hiding one string build per event behind a single innerHTML assignment. */
const seam = vi.hoisted(() => ({ builds: 0 }));
vi.mock("../../src/modules/angband/grid", async (importOriginal) => {
  const grid = await importOriginal<typeof import("../../src/modules/angband/grid")>();
  return {
    ...grid,
    gridToHtml: (g: Parameters<typeof grid.gridToHtml>[0]) => {
      seam.builds++;
      return grid.gridToHtml(g);
    },
  };
});

/** Enough of an element for the stage and the map pre. */
class StubEl {
  id = "";
  textContent = "";
  innerHTML = "";
  children: StubEl[] = [];
  classList = { add() {} };
  appendChild(c: StubEl) { this.children.push(c); return c; }
}

const els = new Map<string, StubEl>();
(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!,
  createElement: () => new StubEl(),
  addEventListener: () => {},
} as unknown as Document;

// Imported after the stubs: the constructor grabs #stage and binds keydown.
const { TtyView } = await import("../../src/modules/angband/ui/TtyView");

const cell = (x: number, ch: string): AngbandEvent =>
  ({ name: "text", x, y: 1, attr: 1, rgb: 0xffffff, text: ch });
const $map = () => els.get("stage")!.children[0]!;

describe("TtyView redraw scheduling", () => {
  beforeEach(() => {
    els.clear();
    seam.builds = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).requestAnimationFrame;
    delete (globalThis as Record<string, unknown>).cancelAnimationFrame;
  });

  it("rebuilds the grid once for a burst of events, not once per event", async () => {
    const view = new TtyView();
    for (let x = 0; x < 50; x++) {
      view.handle(cell(x, "#"));
      await vi.advanceTimersByTimeAsync(0); // each event arrives as its own task
    }
    await vi.runAllTimersAsync();

    expect(seam.builds).toBe(1);
    expect($map().innerHTML).toContain("#".repeat(50));
  });

  it("renders on the animation frame and drops the fallback timer", async () => {
    let frame: FrameRequestCallback | null = null;
    (globalThis as Record<string, unknown>).requestAnimationFrame =
      (cb: FrameRequestCallback) => { frame = cb; return 7; };
    (globalThis as Record<string, unknown>).cancelAnimationFrame = () => {};

    const view = new TtyView();
    view.handle(cell(0, "@"));
    expect(seam.builds).toBe(0); // nothing rebuilt on the event itself
    frame!(0); // the frame wins the race
    await vi.runAllTimersAsync();

    expect(seam.builds).toBe(1); // the losing timer must not render a second time
    expect($map().innerHTML).toContain("@");
  });

  it("still renders when the animation frame never arrives (hidden pane)", async () => {
    let cancels = 0;
    (globalThis as Record<string, unknown>).requestAnimationFrame = () => 7; // stalled
    (globalThis as Record<string, unknown>).cancelAnimationFrame = () => { cancels++; };

    const view = new TtyView();
    view.handle(cell(0, "@"));
    await vi.runAllTimersAsync();

    expect(seam.builds).toBe(1);
    expect(cancels).toBe(1); // the timer won, so the pending frame is dropped
    expect($map().innerHTML).toContain("@");
  });

  it("schedules again for the next burst", async () => {
    const view = new TtyView();
    view.handle(cell(0, "a"));
    await vi.runAllTimersAsync();
    view.handle(cell(1, "b"));
    await vi.runAllTimersAsync();

    expect(seam.builds).toBe(2);
    expect($map().innerHTML).toContain("ab");
  });
});

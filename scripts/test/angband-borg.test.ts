// BorgPlayer is a pure input decorator, so it can be pinned without an
// engine: feed it the tty events a real boot produces and assert the keys it
// answers with. The engine-level counterpart is test-angband-borg.mjs.
import { describe, expect, it, vi } from "vitest";
import { BorgPlayer } from "../../src/modules/angband/ui/BorgPlayer";
import type { AngbandEvent } from "../../src/modules/angband/protocol";
import type { AngbandHandler } from "../../src/modules/angband/session";
import { KeyQueue } from "../../src/backplane/keyQueue";

const CTRL_Z = 0x1a, KC_ENTER = 0x9c;
const chr = (c: string) => c.codePointAt(0);

function harness() {
  const events: AngbandEvent[] = [];
  const notices: string[] = [];
  const view: AngbandHandler = {
    onReady: vi.fn(),
    onNotice: (text) => { notices.push(text); },
    handle: (ev) => { events.push(ev); },
    nextKey: () => { throw new Error("the decorator must answer input itself"); },
  };
  const borg = new BorgPlayer(view);
  const show = (text: string, y = 0) =>
    borg.handle({ name: "text", x: 0, y, attr: 0, rgb: 0xffffff, text });
  return { borg, view, events, notices, show };
}

describe("BorgPlayer", () => {
  it("passes every event and notice through to the real view", () => {
    const { borg, events, notices, view } = harness();
    borg.handle({ name: "level", width: 40, height: 20 });
    borg.onNotice("storage is off");
    borg.onReady();

    expect(events).toEqual([{ name: "level", width: 40, height: 20 }]);
    expect(notices).toEqual(["storage is off"]);
    expect(view.onReady).toHaveBeenCalled();
  });

  it("answers a non-blocking poll immediately with no key", () => {
    const { borg } = harness();
    // TERM_XTRA_FLUSH drains by polling until it gets exactly this; a key
    // here would feed a phantom press and the drain would never end.
    expect(borg.nextKey(false, false)).toBeNull();
    expect(borg.nextKey(false, true)).toBeNull();
  });

  it("quick-starts a character at the birth screen", () => {
    const { borg, show } = harness();
    show("Please select your character traits from the menus below:");
    expect(borg.nextKey(true, false)).toEqual({ code: chr("@"), mods: 0 });
  });

  it("presses Enter through the splash and the name prompts", () => {
    const { borg, show } = harness();
    show("[Press any key to continue]");
    expect(borg.nextKey(true, false)).toEqual({ code: KC_ENTER, mods: 0 });
  });

  it("sends Ctrl-Z at the first command wait", () => {
    const { borg } = harness();
    expect(borg.nextKey(true, true)).toEqual({ code: CTRL_Z, mods: 0 });
  });

  it("does not try to activate before a character exists", () => {
    const { borg, show } = harness();
    show("[Press any key to continue]");
    // Birth-time waits are cmd:false; ^Z there would hit the splash, not the
    // command loop, and the borg would never start.
    expect(borg.nextKey(true, false)).toEqual({ code: KC_ENTER, mods: 0 });
    expect(borg.nextKey(true, true)).toEqual({ code: CTRL_Z, mods: 0 });
  });

  it("answers the borg prompts by reading them, not by queueing keys", () => {
    // do_cmd_try_borg msg()s two warnings and signals EVENT_MESSAGE_FLUSH
    // BEFORE it asks get_check (cmd-misc.c:120-126). A queued Ctrl-Z,y,z
    // burst feeds `y` and `z` to those -more- prompts and the borg silently
    // never starts — observed against the real engine, hence this test.
    const { borg, show } = harness();
    expect(borg.nextKey(true, true)).toEqual({ code: CTRL_Z, mods: 0 });

    show("You are about to use the dangerous, unsupported, borg commands! -more-");
    expect(borg.nextKey(true, false)).toEqual({ code: KC_ENTER, mods: 0 });
    show("Your machine may crash, and your savefile may become corrupted! -more-");
    expect(borg.nextKey(true, false)).toEqual({ code: KC_ENTER, mods: 0 });

    show("Are you sure you want to use the borg commands? [y/n]");
    expect(borg.nextKey(true, false)).toEqual({ code: chr("y"), mods: 0 });

    show("Borg command (? for help): ");
    expect(borg.nextKey(true, false)).toEqual({ code: chr("z"), mods: 0 });
  });

  it("does not re-activate once the borg is running", () => {
    const { borg, show } = harness();
    borg.nextKey(true, true);
    show("Are you sure you want to use the borg commands? [y/n]");
    borg.nextKey(true, false);
    show("Borg command (? for help): ");
    expect(borg.nextKey(true, false)).toEqual({ code: chr("z"), mods: 0 });

    // A second ^Z would re-open the borg command prompt underneath a running
    // borg; a stale "Borg command" still on screen must not resend 'z'.
    borg.handle({ name: "clear" });
    for (let i = 0; i < 5; i++)
      expect(borg.nextKey(true, true)).toEqual({ code: KC_ENTER, mods: 0 });
  });

  it("clears a -more- the borg left standing rather than stalling", () => {
    const { borg, show } = harness();
    borg.nextKey(true, true);
    show("You have 3 Rations of Food (e). -more-");
    expect(borg.nextKey(true, false)).toEqual({ code: KC_ENTER, mods: 0 });
  });

  it("hands the native death menu and subsequent inspection to manual input", async () => {
    // Removing the handoff (or its latch) must resume the Enter/Information loop.
    const { borg, show, view } = harness();
    const keys = new KeyQueue<{ code: number; mods: number }>();
    view.nextKey = (wait) => keys.next(wait);
    show("Borg command (? for help): ");
    borg.nextKey(true, false);
    borg.handle({ name: "clear" });
    show("Information", 2);
    show("Examine items", 6);
    show("New Game", 9);
    show("Quit", 10);

    const pending = borg.nextKey(true, false);
    expect(pending).toBeInstanceOf(Promise);
    expect(borg.nextKey(false, false)).toBeNull();
    keys.push({ code: chr("i")!, mods: 0 });
    expect(await pending).toEqual({ code: chr("i"), mods: 0 });

    borg.handle({ name: "clear" });
    show("Human inventory");
    const inspection = borg.nextKey(true, false);
    expect(inspection).toBeInstanceOf(Promise);
    keys.push({ code: KC_ENTER, mods: 0 });
    expect(await inspection).toEqual({ code: KC_ENTER, mods: 0 });
  });

  it("keeps handling ordinary messages that mention death or a single menu word", () => {
    const { borg, show } = harness();
    show("You feel the death of the monster. Information -more-");
    expect(borg.nextKey(true, false)).toEqual({ code: KC_ENTER, mods: 0 });
  });
});

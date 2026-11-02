// Angband's quit_hook carries two outcomes, not one: upstream defines
// quit(NULL) as exit(EXIT_SUCCESS) and quit(str) as plog(str) +
// exit(EXIT_FAILURE) (external/angband/src/z-util.c:918). The front end passes
// NULL-ness across explicitly rather than encoding it as empty text
// (src/modules/angband/native/main-wasm.c), because quit("") is a failure the
// text alone cannot distinguish from a clean exit. Core faults take the
// failure path — create_needed_dirs alone quit_fmt()s five times
// (init.c:416-428) — so routing every quit to the Module's normal-exit
// message would paint an engine death as a clean goodbye.
import { describe, expect, it } from "vitest";
import { quitMessage, savedOnQuit } from "../../src/modules/angband/protocol";

describe("quitMessage", () => {
  it("classifies quit(NULL) as the Module's normal exit", () => {
    expect(quitMessage("", true, true)).toEqual({ type: "quit", saved: true });
  });

  it("keeps the wizard's quit-without-saving on the success path", () => {
    // do_cmd_wiz_quit_no_save (cmd-wizard.c:2151) — text, but deliberate.
    expect(quitMessage("user choice", false, true)).toEqual({ type: "quit", saved: true });
  });

  it("classifies quit(\"\") as a fatal, not a clean exit", () => {
    expect(quitMessage("", false, true)).toMatchObject({ type: "fatal" });
  });

  it("classifies quit_fmt's diagnostic text as a lifecycle fatal, verbatim", () => {
    expect(quitMessage("Cannot create '/lib/save'", false, true))
      .toEqual({ type: "fatal", message: "Cannot create '/lib/save'" });
  });

  it("reports an unsaved run so the view can say the run is gone", () => {
    expect(quitMessage("", true, false)).toEqual({ type: "quit", saved: false });
  });
});

describe("savedOnQuit", () => {
  it("passes a landed checkpoint through when the final flush lands too", async () => {
    expect(await savedOnQuit(true, () => Promise.resolve())).toBe(true);
  });

  it("keeps the quit message and demotes `saved` when the final flush is rejected", async () => {
    // PersistHandle.flush() throws on all three IDBFS failure modes
    // (src/backplane/persistFs.ts). Awaited bare on the quit path, that
    // rejection never reaches a catch: quitMessage is never called, nothing is
    // posted, and the player gets the worker's unhandledrejection `fatal`
    // instead of the end of their game.
    const landed = await savedOnQuit(true, () => Promise.reject(new Error("IDBFS failed")));
    expect(landed).toBe(false);
    expect(quitMessage("", true, landed)).toEqual({ type: "quit", saved: false });
  });

  it("flushes even when no checkpoint ever landed — the engine's own save is in there", async () => {
    let flushes = 0;
    expect(await savedOnQuit(false, async () => void flushes++)).toBe(false);
    expect(flushes).toBe(1);
  });
});

#!/usr/bin/env node
// The semantic overlay word decides whether the vector view shows the dungeon
// or hides the canvas behind Umoria's 80x24 screen, so a scope that leaks does
// not degrade the view — it replaces it, permanently, for the rest of the
// session.
//
// Upstream's full-screen displays are not balanced: inventoryExecuteCommand
// (ui_inventory.cpp) always calls terminalSaveScreen() but only calls
// terminalRestoreScreen() when the screen it ends on is not Blank. Our shim
// hangs the overlay scope on exactly that pair (ui_io_wasm.cpp), so every
// upstream path that skips its restore used to strand a scope. `e` with an
// empty equipment list is the shortest way to reach one: it prints a message,
// never switches the screen, and leaves through the Blank branch.
//
// The rule this pins is not "e must balance" — it is that the outer command
// request, where the dungeon is on screen and the cursor is on the hero, can
// never be reached with an overlay claimed. Any future unbalanced upstream
// path is caught by the same assertion.
//
// That assertion alone cannot tell an unbalanced screen from a balanced one:
// vectMoriaGameRunKeyInput() resets the stack unconditionally before the outer
// read, so the overlay word is NONE there whether the screen pushed a scope,
// stranded one, or never pushed at all (vect-hack-8r0). So every semantic state
// published WHILE the screen is up is sampled too — putQIO() flushes before
// each blocking read and after each screen change, so a claimed scope reaches
// the view there. A screen that claims no scope at all now fails by its own
// name, and the two halves together say what the gate's name promises: the
// display took the view, and the next command got it back.
// `e` with nothing equipped is exempt from the claim half and says so in the
// table below: measured, it publishes no semantic state at all while its scope
// is claimed, so there is no moment at which this gate could see it.
import assert from "node:assert/strict";
import { bootMoria, waitForExit } from "./moria-persist-play.mjs";
import { OVERLAY } from "../../src/modules/moria/mapRecords.ts";
import { STATE } from "../../src/modules/moria/mapRecords.ts";

const code = (ch) => ch.charCodeAt(0);
const key = (k) => ({ status: "key", key: k });

/** Screens a player opens from the command prompt, and the key that leaves
 *  each one. Every one of them must hand the dungeon back.
 *
 *  `claims` says whether the screen is expected to publish its overlay scope
 *  to the view while it is up. `e` with nothing equipped does not: it pushes a
 *  scope, prints one message, never switches the screen and returns straight to
 *  the outer command, so nothing the semantic reporter watches changes and no
 *  state is flushed while the scope is claimed (measured — the window is
 *  empty, not merely NONE). It is the stranded case the outer-command reset
 *  exists for, and the reset half is all this gate can check for it. */
const SCREENS = [
  { open: code("e"), label: "equipment list (nothing equipped)", claims: false },
  { open: code("i"), label: "inventory list", claims: true },
  { open: code("C"), label: "character sheet", claims: true },
];

const birth = [13, code("a"), code("m"), 27, code("a"), 13, 32];

const overlayNow = (session) => session.semanticStates.at(-1)?.words[STATE.OVERLAY];

function driver() {
  let birthAt = 0;
  let screenAt = 0;
  /** Set while the screen just opened is still up: the next command read is
   *  the one that must show a cleared overlay. */
  let leaving = false;
  let ending = false;
  /** First semanticStates index published after the screen key was sent. */
  let openedAt = 0;
  const seen = [];

  return {
    get seen() { return seen; },
    input: async (request, session) => {
      if (birthAt < birth.length) return key(birth[birthAt++]);
      if (request.context === "literal") {
        if (session.text.includes(" -more-")) return key(32);
        return key(27); // ESC leaves whatever screen is up
      }
      assert.equal(request.context, "outer-command", "live command was not an outer read");

      const overlay = overlayNow(session);
      if (leaving) {
        // Everything the view was told between the key that opened the screen
        // and this read. The last entry is this read's own state, published
        // after the reset; the ones before it are the screen while it was up.
        const whileUp = session.semanticStates.slice(openedAt)
          .map((state) => state.words[STATE.OVERLAY]);
        const screen = SCREENS[screenAt - 1];
        seen.push({ label: screen.label, claims: screen.claims, overlay, whileUp });
        leaving = false;
      }
      if (ending) return key(24); // source-owned Ctrl-X save-and-exit
      if (screenAt < SCREENS.length) {
        leaving = true;
        openedAt = session.semanticStates.length;
        return key(SCREENS[screenAt++].open);
      }
      ending = true;
      return key(24);
    },
  };
}

const play = driver();
const session = await bootMoria({ input: play.input });
await waitForExit(session);

let stranded = false;
let unclaimed = false;
for (const { label, claims, overlay, whileUp } of play.seen) {
  const claimed = !claims || whileUp.some((v) => v !== undefined && v !== OVERLAY.NONE);
  const cleared = overlay === OVERLAY.NONE;
  stranded ||= !cleared;
  unclaimed ||= !claimed;
  console.log(`  ${claimed && cleared ? "ok  " : "FAIL"} ${label}:`
    + ` overlay=${JSON.stringify(whileUp)} while up${claims ? "" : " (claim unobservable)"},`
    + ` ${overlay} at the next command`);
}
assert.equal(play.seen.length, SCREENS.length,
  `only ${play.seen.length} of ${SCREENS.length} screens were driven`);
if (unclaimed) {
  console.error(
    "FAIL: a full-screen display never claimed an overlay scope while it was on"
    + " screen. The vector view then keeps drawing the dungeon underneath a"
    + " terminal screen the player is actually reading — and this gate's"
    + " outer-command check cannot see it, because the outer read clears the"
    + " stack either way.");
  process.exit(1);
}
if (stranded) {
  console.error(
    "FAIL: a full-screen display left its overlay scope claimed. The vector view"
    + " hides the canvas whenever the overlay is not NONE, so the player is left"
    + " looking at the 80x24 text screen for the rest of the session.");
  process.exit(1);
}

console.log("OK: every full-screen Moria display hands the dungeon back to the vector view");
process.exit(0);

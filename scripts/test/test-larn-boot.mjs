// Smoke test: boot the Larn WASM module in node and prove the front end
// end-to-end — the welcome page renders into the grid, Enter advances past
// retcont(), the dungeon + status line arrive from drawscreen()/bot_linex(),
// and parse() completes a command round trip. Mold: test-angband-boot.mjs.
// npm runs every engine test under `timeout`; the timer below is only the
// friendlier message.
//
// Success sequence, driven from gatherKey (the engine's single blocking
// suspend point, the read(0,&b,1) that --wrap=read intercepts):
//   1. first blocking wait = retcont() (help.c:103) after welcome() printed
//      larn.help's first page: grid must show the intro -> answer '\n'
//      (retcont loops `while (ttgetch() != '\n')` — only LF advances).
//   2. next wait = parse() (main.c:668): drawscreen() has painted the cave
//      and bot_linex() the status line ("Spells:"/"AC:") -> press 'i'
//      (inventory, a command that repaints without moving the player).
//   3. inventory's more() prompt opens, then Space closes it; a fresh parse()
//      wait proves the command loop came back. Assert the shim's erase path
//      fired (wipe events are how CL_LINE/CL_DOWN reach the view), then press
//      S. This smoke deliberately has no /lib/home volume, so savegame()
//      fails: neither saveLanded nor quit(saved) may claim the game survived.
//
// This test also guards the two silent link tricks: if the makefile's object
// order stopped favouring the shim's lflush, no text ever reaches the grid
// (phase "intro" fails); if --wrap=read broke, gatherKey is never called
// (the 60s timer fires).
//
// The shim object itself is the shared bridge (src/modules/larn/shimBridge.ts):
// this file says only what it does with the event stream and the key wait.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import createLarnModule from "../../public/modules/larn/larn.js";
import { LarnGrid } from "../../src/modules/larn/grid.ts";
import { installLarnShim } from "../../src/modules/larn/shimBridge.ts";

const fail = (msg) => { throw new Error("FAIL: " + msg); };

if (!existsSync(new URL("../../public/modules/larn/larn.data", import.meta.url)))
  fail("public/modules/larn/larn.{js,wasm,data} missing — run scripts/build/build-larn-wasm.sh");

const grid = new LarnGrid();
let phase = "intro";
let polls = 0;
let wipes = 0;
let savesLanded = 0;
/** The key staged for the wait in progress; the shared bridge reads it back
 *  as keyCode()/keyMods(). */
let staged = null;

const press = (code, mods = 0) => {
  staged = { code: typeof code === "string" ? code.codePointAt(0) : code, mods };
  return 1;
};

installLarnShim({
  name: "scripts/test/test-larn-boot.mjs",
  // Every display callback arrives as one typed event stream from the shared
  // bridge (src/modules/larn/shimBridge.ts). This smoke reads the tty half and
  // ignores map/status/level/overlay/death — ignoring an event name costs
  // nothing, whereas the per-callback no-op stubs this file used to carry had
  // to be added by hand every time the shim grew a method (vect-hack-dwb).
  onEvent: (ev) => {
    if (ev.name === "text") grid.text(ev.x, ev.y, ev.rgb, ev.text);
    else if (ev.name === "wipe") { wipes++; grid.wipe(ev.x, ev.y, ev.n); }
    else if (ev.name === "curs") grid.curs(ev.x, ev.y);
    else if (ev.name === "clear") grid.clear();
  },
  saveLanded: () => { savesLanded++; },
  // This smoke has no volume and so no .larnopts: __wrap_readopts must find
  // savefilename already on its pinned path and refuse nothing.
  notice: (text) => fail("unexpected shim notice: " + text),
  quit: (saved) => {
    if (phase !== "failed-save")
      fail("engine exited before completing the boot sequence (phase: " + phase + ")");
    if (savesLanded !== 0)
      fail("failed S-save called saveLanded " + savesLanded + " time(s)");
    if (saved !== 0)
      fail("failed S-save reported saved=" + saved);
    console.log("OK: failed S-save neither landed nor reported saved");
    process.exit(0);
  },
  gatherKey: async (wait, cmd) => {
    if (++polls > 10000)
      fail(`10000 key waits without completing the boot sequence (phase=${phase})`);
    staged = null;
    if (!wait) return null; // non-blocking poll — phase 1 has no caller, but the reply shape holds
    // The __wrap_yylex discriminator (main-wasm.c): a read from parse()'s
    // command fetcher arrives with cmd=1, every prompt read (retcont's
    // ttgetch, more()'s pager wait) with cmd=0. The vector view's
    // gaze-relative movement arms only on cmd=1, so a drifted flag would
    // silently remap prompt answers or never remap at all.
    const expectCmd = { "intro": false, "enter-play": true, "inventory-more": false, "command": true };
    if (phase in expectCmd && cmd !== expectCmd[phase])
      fail(`blocking wait in phase ${phase} arrived with cmd=${cmd}, expected ${expectCmd[phase]}`);
    const text = grid.toText();
    if (phase === "intro") {
      if (!text.includes("Welcome to the game of Larn"))
        fail("welcome page (larn.help page 1) not on the grid:\n" + text);
      console.log("OK: welcome page readable in the tty grid");
      phase = "enter-play";
      press("\n"); // retcont() advances on LF alone
      return staged;
    }
    if (phase === "enter-play") {
      // parse()'s first wait: drawscreen() and bot_linex() have run.
      if (!text.includes("Spells:") || !text.includes("AC:"))
        fail("status line (bot_linex) missing after entering play:\n" + text);
      console.log("OK: Enter advanced the engine into play (dungeon + status line)");
      phase = "inventory-more";
      press("i"); // inventory: repaints without needing an open cell
      return staged;
    }
    if (phase === "inventory-more") {
      if (!text.includes("Elapsed time is"))
        fail("inventory pager did not open after i:\n" + text);
      phase = "command";
      press(" "); // more() specifically waits for a space
      return staged;
    }
    if (phase === "command") {
      // more() returned and parse() came back for another command.
      console.log("OK: parse() completed a command round trip");
      if (!wipes) fail("no wipe events arrived — CL_LINE/CL_DOWN decode is dead");
      console.log(`OK: erase path live (${wipes} wipe events)`);
      phase = "failed-save";
      press("S");
      return staged;
    }
    fail("unexpected smoke-test phase " + phase);
  },
});

// locateFile is not optional here: the --preload-file package resolves as the
// bare name "larn.data" unless a locateFile is supplied, so without this the
// boot dies on ENOENT for whatever cwd npm happened to use.
await createLarnModule({
  locateFile: (p) => fileURLToPath(new URL("../../public/modules/larn/" + p, import.meta.url)),
  print: () => {},
  printErr: () => {},
});

setTimeout(() => {
  fail("engine never reached the blocking key wait (phase: " + phase + ", polls: " + polls + ")");
}, 60000);

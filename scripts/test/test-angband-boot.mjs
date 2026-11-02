// Smoke test: boot the Angband WASM module in node and prove the front end
// end-to-end — the splash (screens/news.txt) renders into the grid, a
// keypress advances the engine, generates a character and level, and the
// semantic event tap reports one bounded map batch per frame. Mold:
// test-nethack-boot.mjs. npm runs every engine test under `timeout`; the timer
// below is only the friendlier message (a wedged Asyncify engine never
// yields, so in-file timers cannot be the real bound).
//
// Success sequence, driven from gatherKey (the engine's single blocking
// suspend point, Term_xtra(TERM_XTRA_EVENT, true)):
//   1. first blocking wait  = pause_line(Term): grid must show the news
//      splash ("Morgoth" quote) and its prompt -> answer Enter
//   2. '@' finishes birth with random choices; Enter accepts name/history.
//   3. in play, Ctrl-W enables wizard mode and Ctrl-A's Effects menu runs
//      Detect all nearby, exercising EVENT_ITEMLIST's full-sweep fallback.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import createAngbandModule from "../../public/modules/angband/angband.js";
import { AngbandGrid } from "../../src/modules/angband/grid.ts";

const KC_ENTER = 0x9c; // external/angband/src/ui-event.h:171
const ARROW_DOWN = 0x80, ARROW_UP = 0x83;
const GRID_STRIDE = 15;
const GRID_X = 0, GRID_Y = 1, GRID_FLAGS = 3;
const GRID_PLAYER = 1 << 0;

const fail = (msg) => { throw new Error("FAIL: " + msg); };

if (!existsSync(new URL("../../public/modules/angband/angband.data", import.meta.url)))
  fail("public/modules/angband/angband.{js,wasm,data} missing — run scripts/build/build-angband-wasm.sh");

const grid = new AngbandGrid();
let phase = "splash";
let birthTries = 0;
let polls = 0;
let current = { code: 0, mods: 0 };
let level = null;
let mapBatches = 0;
let mapsSinceFlush = 0;
let messages = 0;
let overlays = 0;
let sawFullPlayerFrame = false;
let detectionPending = false;
let debugMenuTries = 0;
let hiddenMenuTries = 0;

const press = (code, mods = 0) => {
  current = { code: typeof code === "string" ? code.codePointAt(0) : code, mods };
  return 1;
};

const accelerator = (text, label) => {
  for (const line of text.split("\n")) {
    if (!line.toLowerCase().includes(label.toLowerCase())) continue;
    const m = line.match(/^\s*([A-Za-z])(?:[).:]|\s+-)/) ?? line.match(/\[([A-Za-z])\]/);
    if (m) return m[1];
  }
  return null;
};

const visibleMenuKey = (text, label) => {
  const accel = accelerator(text, label);
  if (accel) return { code: accel, selected: true };
  const rows = text.split("\n");
  const y = rows.findIndex((line) => line.toLowerCase().includes(label.toLowerCase()));
  if (y < 0) return null;
  if (grid.cursor.y === y) return { code: KC_ENTER, selected: true };
  return { code: grid.cursor.y < y ? ARROW_DOWN : ARROW_UP, selected: false };
};

const finish = () => {
  if (!level) fail("semantic level callback absent");
  if (!mapBatches) fail("semantic map callbacks absent");
  if (!messages) fail("semantic message callbacks absent");
  if (!overlays) fail("semantic overlay callbacks absent");
  if (!sawFullPlayerFrame) fail("no full/current map frame with exactly one player record");
  console.log(`OK: semantic map tap batched ${mapBatches} callbacks for ${level.width}x${level.height}`);
  console.log("OK: EVENT_ITEMLIST promoted the next fresh to one full map batch");
  process.exit(0);
};

globalThis.VectAngband = {
  // Same call shapes the worker installs (src/modules/angband/worker.ts); cps is a
  // HEAPU32 view over the wchar_t run — UTF-32 code points.
  text: (x, y, _n, _attr, rgb, cps) => grid.text(x, y, rgb, String.fromCodePoint(...cps)),
  wipe: (x, y, n) => grid.wipe(x, y, n),
  curs: (x, y) => grid.curs(x, y),
  clear: () => grid.clear(),
  flush: () => {
    if (detectionPending)
      fail("the first fresh after Detect all nearby had no full map batch");
    mapsSinceFlush = 0;
  },
  mapBatch: (words) => {
    const records = new Int32Array(words);
    if (records.length % GRID_STRIDE)
      fail(`map batch length ${records.length} is not divisible by ${GRID_STRIDE}`);
    if (++mapsSinceFlush > 1) fail("more than one mapBatch arrived between successive flush callbacks");
    mapBatches++;
    let players = 0;
    for (let i = 0; i < records.length; i += GRID_STRIDE) {
      const x = records[i + GRID_X], y = records[i + GRID_Y];
      if (x < 0 || y < 0 || x >= 198 || y >= 66)
        fail(`out-of-cap map coordinate (${x},${y})`);
      if (level && (x >= level.width || y >= level.height))
        fail(`out-of-level map coordinate (${x},${y}) for ${level.width}x${level.height}`);
      if (records[i + GRID_FLAGS] & GRID_PLAYER) players++;
    }
    const full = level && records.length === level.width * level.height * GRID_STRIDE;
    if (detectionPending && !full)
      fail("the first mapBatch after Detect all nearby was not a full level sweep");
    if (full) {
      if (players !== 1) fail(`full/current map frame has ${players} player records, expected 1`);
      sawFullPlayerFrame = true;
      if (detectionPending) finish();
    }
  },
  level: (width, height) => {
    if (width <= 0 || height <= 0 || width > 198 || height > 66)
      fail(`invalid level bounds ${width}x${height}`);
    level = { width, height };
  },
  message: (text) => {
    messages++;
    // The nested menus restore through several freshes before the selected
    // command runs. Its first typed detection result is the observable point
    // after execution has started and before redraw_stuff emits ITEMLIST.
    if (phase === "await-detection-run" && /\b(?:detect|sense)\b/i.test(text))
      detectionPending = true;
  },
  overlay: () => { overlays++; },
  effect: () => {},
  keyCode: () => current.code,
  keyMods: () => current.mods,
  // Both quit outcomes fail this test, for different reasons: text means a
  // core fault took quit_fmt's failure path, and quit(NULL) (z-util.c:918)
  // means the engine exited before the birth screen it is supposed to reach.
  quit: (msg, wasNull) =>
    fail(wasNull ? "engine exited before the birth screen" : "engine died: " + msg),
  // This test mounts no volume, so a checkpoint would have nowhere to go —
  // and save_game_checked() before a character exists is exactly what the
  // cadence exists to avoid.
  checkpointDue: () => 0,
  checkpointLanded: () => {},
  gatherKey: async (wait, cmd) => {
    if (++polls > 10000)
      fail(`10000 event polls without completing semantic tap exercise (phase=${phase}, batches=${mapBatches})`);
    current = { code: 0, mods: 0 };
    if (!wait) return 0; // non-blocking poll (e.g. the TERM_XTRA_FLUSH drain)
    const text = grid.toText();
    if (phase === "splash") {
      if (!text.includes("Morgoth"))
        fail("splash text (screens/news.txt) not on the grid:\n" + text);
      if (!text.includes("Press any key"))
        fail("pause_line prompt missing from the splash:\n" + text);
      console.log("OK: splash screen readable in the tty grid");
      phase = "birth";
      current = { code: KC_ENTER, mods: 0 };
      return 1;
    }
    if (phase === "birth" && (text.includes("select your character traits") || text.includes("Human"))) {
      console.log("OK: keypress advanced the engine to the birth screen");
      phase = "birth-finish";
      return press("@");
    }
    if (phase === "birth") {
      if (++birthTries > 5) fail("no birth screen after " + birthTries + " Enter presses:\n" + text);
      return press(KC_ENTER);
    }
    if (phase === "birth-finish") {
      if (cmd || level) {
        phase = "wizard-enable";
        return press(23); // Ctrl-W
      }
      if (++birthTries > 16) fail("generated character never entered play; semantic level callback absent:\n" + text);
      return press(KC_ENTER);
    }
    if (phase === "wizard-enable") {
      phase = "wizard-confirm";
      return press("y");
    }
    if (phase === "wizard-confirm") {
      phase = "root-menu";
      return press(1); // Ctrl-A
    }
    if (phase === "root-menu") {
      // Ctrl-A first opens the "Debug Command:" prefix; Enter expands that
      // prefix into the visible command menu.
      const choice = visibleMenuKey(text, "Hidden");
      if (!choice && debugMenuTries++ < 2) return press(KC_ENTER);
      if (!choice) fail("Ctrl-A menu has no visible Hidden group:\n" + text);
      if (choice.selected) phase = "hidden-menu";
      return press(choice.code);
    }
    if (phase === "hidden-menu") {
      const choice = visibleMenuKey(text, "Debug mode commands");
      if (!choice && hiddenMenuTries++ < 20) return press(ARROW_DOWN);
      if (!choice) fail("Hidden menu never exposed a visible Debug mode commands row:\n" + text);
      if (choice.selected) phase = "effects-menu";
      return press(choice.code);
    }
    if (phase === "effects-menu") {
      const choice = visibleMenuKey(text, "Effects");
      if (!choice) fail("Debug menu has no visible Effects row:\n" + text);
      if (choice.selected) phase = "detect-menu";
      return press(choice.code);
    }
    if (phase === "detect-menu") {
      const choice = visibleMenuKey(text, "Detect all nearby");
      if (!choice) fail("Effects menu has no visible Detect all nearby row:\n" + text);
      if (choice.selected) {
        phase = "await-detection";
      }
      return press(choice.code);
    }
    if (phase === "await-detection") {
      if (text.includes("-more-")) return press(KC_ENTER);
      if (!text.includes("Are you sure you want to use the debug commands?"))
        fail("debug command safety confirmation was not visible:\n" + text);
      phase = "await-detection-run";
      return press("y");
    }
    if (phase === "await-detection-run") return press(0xe000); // command should redraw before this wait
    fail("unexpected smoke-test phase " + phase);
  },
};

// locateFile is not optional here: the --preload-file package resolves as the
// bare name "angband.data" unless a locateFile is supplied (the generated
// loader is literally `Module["locateFile"] ? locateFile(base, "") : base`),
// so without this the boot dies on ENOENT for whatever cwd npm happened to
// use. .wasm routes through locateFile too once it exists, which this
// directory form keeps correct.
await createAngbandModule({
  locateFile: (p) => fileURLToPath(new URL("../../public/modules/angband/" + p, import.meta.url)),
  print: () => {},
  printErr: () => {},
});

setTimeout(() => {
  fail("engine never reached the blocking key wait (phase: " + phase + ", polls: " + polls + ")");
}, 60000);

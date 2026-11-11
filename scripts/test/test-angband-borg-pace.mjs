// ?borg=<ms> pacing inside menus, headless. The borg's own pause is once per
// dungeon move; in the inventory and in a store it feeds inkey_hack a whole
// key sequence with no pause at all, so main-wasm.c stands in front of that
// hook and, before each key read under a saved screen, flushes the menu and
// sleeps the borg's own move pace.
//
// The pace arrives the way it does in the browser: borg.txt's factor, written
// by the same helper worker.ts uses, before the borg's ^Z reads the file.
// Three things only the engine can show:
//   - the wrapper took over the borg's hook (the pause counter moves — a fresh
//     character in town shops within seconds);
//   - every pause held a menu frame: the last overlay flushed before each
//     pause was a saved-screen one (a sleep before the flush would hold the
//     dungeon frame instead, and a one-key menu would never be seen);
//   - each pause really slept (the clock covers the completed pauses).
import "fake-indexeddb/auto";
import { existsSync } from "node:fs";
import { bootAngband, coreFile, fail, until } from "./angband-play.mjs";
import { applyBorgDelay } from "../../src/modules/angband/borgConfig.ts";
import { BorgPlayer } from "../../src/modules/angband/ui/BorgPlayer.ts";

const PACE_MS = 25;        // a perfect square: borg.txt carries its root, 5
const MIN_PAUSES = 10;

if (!existsSync(coreFile("angband.data")))
  fail("public/modules/angband/angband.{js,wasm,data} missing — run scripts/build/build-angband-wasm.sh");

const view = {
  onReady: () => {},
  onNotice: () => {},
  handle: () => {},
  nextKey: () => fail("the decorator must answer every key itself"),
};
const borg = new BorgPlayer(view);

let session = null;
let paced = false;
const pauses = () => session.mod.ccall("vect_angband_borg_menu_pauses", "number", [], []);

// Each overlay event is one TERM_XTRA_FRESH. Pauses that land between two of
// them held whatever the earlier one put on screen.
let last = { active: null, pauses: 0 };
let heldMenu = 0, heldDungeon = 0;
const onOverlay = (active) => {
  if (!session) return;
  const now = pauses();
  if (now > last.pauses) {
    if (last.active === true) heldMenu += now - last.pauses;
    else heldDungeon += now - last.pauses;
  }
  last = { active, pauses: now };
};

session = await bootAngband({
  keys: async (wait, cmd, ctx) => {
    // The first command wait is the one the decorator answers with ^Z: the
    // borg reads borg.txt as that command runs, so the factor lands in time.
    if (cmd && !paced) {
      applyBorgDelay(ctx.session.FS ?? fail("no FS at the first command wait"), PACE_MS);
      paced = true;
    }
    return (await borg.nextKey(wait, cmd)) ?? fail("no key for a blocking wait");
  },
  onEvent: (ev) => {
    if (ev.name === "overlay") onOverlay(ev.active);
    borg.handle(ev);
  },
  onPoll: () => {},
  // What worker.ts sets for ?borg=<ms>: arms the wrapper, zeroes delay_factor.
  bridge: { borgDelayMs: PACE_MS },
});

await until(() => pauses() > 0, 20000, "the borg to read a key inside a menu");
const start = Date.now(), from = pauses();
await until(() => pauses() - from >= MIN_PAUSES, 15000, `${MIN_PAUSES} more paced menu keys`);
const elapsed = Date.now() - start, count = pauses() - from;

// The counter moves before each sleep, so the window holds count - 1 whole ones.
if (elapsed < (count - 1) * PACE_MS)
  fail(`${count} menu keys counted in ${elapsed}ms — under ${PACE_MS}ms each, so they did not wait`);
if (heldDungeon)
  fail(`${heldDungeon} of ${heldMenu + heldDungeon} pauses held a dungeon frame, not the menu`);
if (!heldMenu) fail("no pause was ever seen holding a menu frame");

console.log(`OK: ${count} borg menu keys paced at ${PACE_MS}ms in ${elapsed}ms; `
  + `${heldMenu} pauses held a menu frame, none the dungeon`);
process.exit(0);

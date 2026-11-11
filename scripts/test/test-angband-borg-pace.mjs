// ?borg=<ms> pacing inside menus, headless. The borg's own pause is once per
// dungeon move; in the inventory and in a store it feeds inkey_hack a whole
// key sequence with no pause at all, so main-wasm.c stands in front of that
// hook and sleeps borgMenuDelayMs before each key read under a saved screen.
//
// Two things only the engine can show: that the wrapper actually took over
// the borg's hook (the pause counter moves — a fresh character in town shops
// within seconds), and that each counted pause really slept (the wall clock
// covers at least pauses × delay). A counter that moved without the sleep, or
// a sleep the counter never saw, fails one or the other.
import "fake-indexeddb/auto";
import { existsSync } from "node:fs";
import { bootAngband, fail, until } from "./angband-play.mjs";
import { BorgPlayer } from "../../src/modules/angband/ui/BorgPlayer.ts";

const MENU_DELAY_MS = 40;
const MIN_PAUSES = 10;

if (!existsSync(new URL("../../public/modules/angband/angband.data", import.meta.url)))
  fail("public/modules/angband/angband.{js,wasm,data} missing — run scripts/build/build-angband-wasm.sh");

const view = {
  onReady: () => {},
  onNotice: () => {},
  handle: () => {},
  nextKey: () => fail("the decorator must answer every key itself"),
};
const borg = new BorgPlayer(view);

const session = await bootAngband({
  keys: async (wait, cmd) => (await borg.nextKey(wait, cmd)) ?? fail("no key for a blocking wait"),
  onEvent: (ev) => borg.handle(ev),
  onPoll: () => {},
  // What worker.ts sets for ?borg=<ms>; the dungeon pace stays borg.txt's.
  bridge: { borgDelayMs: 0, borgMenuDelayMs: MENU_DELAY_MS },
});

const pauses = () => session.mod.ccall("vect_angband_borg_menu_pauses", "number", [], []);

await until(() => pauses() > 0, 90000, "the borg to read a key inside a menu");
const start = Date.now(), from = pauses();
await until(() => pauses() - from >= MIN_PAUSES, 60000, `${MIN_PAUSES} more paced menu keys`);
const elapsed = Date.now() - start, paced = pauses() - from;

if (elapsed < paced * MENU_DELAY_MS)
  fail(`${paced} menu keys counted in ${elapsed}ms — under ${MENU_DELAY_MS}ms each, so they did not wait`);

console.log(`OK: ${paced} borg menu keys paced at ${MENU_DELAY_MS}ms in ${elapsed}ms`);
process.exit(0);

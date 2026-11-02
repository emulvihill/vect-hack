// Deterministic postmortem regression: use the real birth/activation prompts,
// then retire through Q instead of waiting for a random combat death. Retiring
// sets is_dead and uses the same native death_screen as a killed character.
import "fake-indexeddb/auto";
import { bootAngband, CTRL_X, fail, KC_ENTER, until } from "./angband-play.mjs";
import { KC_ESCAPE } from "../../src/modules/angband/protocol.ts";
import { BorgPlayer } from "../../src/modules/angband/ui/BorgPlayer.ts";

let activated = false, retiring = false, quit = false;
let manualWaits = 0, requests = 0;
let manualResolve;
let manualText = "";
const borg = new BorgPlayer({
  onNotice: () => {},
  handle: () => {},
  nextKey: (wait) => {
    if (!wait) return null;
    manualWaits++;
    return new Promise((resolve) => { manualResolve = resolve; });
  },
});

const session = await bootAngband({
  onEvent: (ev) => borg.handle(ev),
  onQuit: () => { quit = true; },
  keys: async (wait, cmd, { text }) => {
    // A cap catches the old microtask Enter loop without relying on timers,
    // which that loop starves. Birth normally takes fewer than ten requests.
    if (++requests > 80) fail("Borg input loop never handed the death menu to the player");
    if (activated && cmd && !retiring) {
      retiring = true;
      return { code: "Q".codePointAt(0), mods: 0 };
    }
    if (text.includes("Do you really want to retire?"))
      return { code: "y".codePointAt(0), mods: 0 };
    if (text.includes("verify RETIRING THIS CHARACTER"))
      return { code: "@".codePointAt(0), mods: 0 };
    manualText = text;
    const key = await borg.nextKey(wait, cmd);
    // Activate the decorator at the real Borg prompt, then cancel the native
    // command so Q can deterministically exercise its postmortem input path.
    if (text.includes("Borg command") && key?.code === "z".codePointAt(0)) {
      activated = true;
      return { code: KC_ESCAPE, mods: 0 };
    }
    return key;
  },
});

await until(() => manualWaits === 1, 30000, "manual input at the native death menu");
if (!activated || !retiring || !manualText.includes("Examine items") || !manualText.includes("New Game"))
  fail("the manual wait did not come from native death_screen");
const deathText = session.grid.toText();
await new Promise((resolve) => setTimeout(resolve, 100));
if (manualWaits !== 1 || session.grid.toText() !== deathText || quit)
  fail("the tombstone did not remain stable while awaiting the player");

manualResolve({ code: "i".codePointAt(0), mods: 0 });
await until(() => manualWaits === 2, 10000, "manual character inspection");
if (manualText.includes("New Game")) fail("Information did not open the native inspection screen");
manualResolve({ code: KC_ENTER, mods: 0 });
// Information displays character, inventory and equipment in successive waits.
for (let i = 0; i < 5 && !manualText.includes("New Game"); i++) {
  const before = manualWaits;
  await until(() => manualWaits > before, 10000, "the next manual postmortem screen");
  if (!manualText.includes("New Game")) manualResolve({ code: KC_ENTER, mods: 0 });
}
if (!manualText.includes("New Game")) fail("inspection never returned to the native death menu");
manualResolve({ code: CTRL_X, mods: 0 });
await until(() => quit, 10000, "clean quit after manually leaving the death menu");
await session.close();
console.log(`OK: native Borg postmortem stayed on the tombstone, inspected manually, then quit (${manualWaits} manual waits)`);
process.exit(0);

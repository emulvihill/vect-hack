// The Larn status tap against the engine's own screen. Boots a real seeded
// game, lets the survivor bot play until the tap reports an inventory worth
// checking, then presses `i` — qshowstr() prints the item list AND "You have N
// mobuls left" (external/larn/main.c:361) — and checks the tap agrees with the
// text the player can read.
//
// Parity, not a fixture: a fixture would only prove the decoder matches
// whatever the encoder happens to emit. This proves both match Larn. The tap
// is the one place where game knowledge the bot is supposed to EARN could be
// handed to it instead, so it is the one place that gets an oracle outside
// our own code.
//
// The bot is here for its inventory, not its policy: a fresh Larn character
// carries exactly leather armor and a dagger (create.c:46-51), and a gate that
// only ever sees those two proves nothing about potions, scrolls, enchantment
// suffixes, or identification. SEED plus MAX_COMMANDS makes the run
// deterministic; the assertions never name an item, so the bot may change its
// mind about what to pick up without touching this file.
//
// One process, no child: unlike test-larn-seed.mjs this harness never needs to
// outlive the engine. It asserts inside the key wait and exits, which is the
// only way to stop a running Larn — __wrap_read ignores gatherKey's return and
// keeps feeding NUL keys, so a driver that simply stops answering spins.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import createLarnModule from "../../public/modules/larn/larn.js";
import { mountLarnStorage } from "../../src/modules/larn/persist.ts";
import { CONDITION_NAMES, ITEM_CLASS, decodeStatus } from "../../src/modules/larn/statusRecords.ts";
import { LarnGrid } from "../../src/modules/larn/grid.ts";
import { LarnBotPlayer } from "../../src/modules/larn/bot/LarnBotPlayer.ts";
import { installLarnShim } from "../../src/modules/larn/shimBridge.ts";

const CORE = (name) => fileURLToPath(new URL(`../../public/modules/larn/${name}`, import.meta.url));
const fail = (message) => { console.error("FAIL: " + message); process.exit(1); };
if (!existsSync(CORE("larn.data")))
  fail("public/modules/larn/larn.{js,wasm,data} missing — run npm run build:larn");

/** Deterministic through the gym seed hook (main-wasm.c __wrap_newgame). */
const SEED = 2;
/** Command budget before the run is declared too poor to prove anything. */
const MAX_COMMANDS = 2000;
/** An inventory worth pressing `i` over: enough slots that qshowstr()'s
 *  type-major order really differs from slot order (so a positional join would
 *  fail here), and both an unidentified potion and an unidentified scroll,
 *  whose names are where identification would leak. */
const MIN_ITEMS = 8;

/** botside() paints each condition at column 70, row i+1 (display.c:203-217). */
const COND_COL = 69;
/** levelname[] (data.c:176) as the status line prints it after "LV:". */
const DEPTH_BY_NAME = { H: 0, V1: 11, V2: 12, V3: 13 };

const grid = new LarnGrid();
const rows = () => grid.cells.map((row) => row.map((c) => c.ch).join(""));
const grab = () => rows().join("\n");

/** The bot's view: the tty grid is the oracle, so it is all this needs to be. */
const gridView = {
  onNotice: () => {},
  nextKey: () => null,
  handle: (ev) => {
    if (ev.name === "text") grid.text(ev.x, ev.y, ev.rgb, ev.text);
    else if (ev.name === "wipe") grid.wipe(ev.x, ev.y, ev.n);
    else if (ev.name === "curs") grid.curs(ev.x, ev.y);
    else if (ev.name === "clear") grid.clear();
  },
};

const bot = new LarnBotPlayer(gridView, 0); // no pacing: full speed
let status = null;
let statusPushes = 0;
let phase = "playing";
let snapBefore = "";        // the screen the status-line assertions read
let condBefore = [];        // its rows, for the column-70 condition strip
let tapped = null;          // the record current at the moment `i` was pressed
const pages = [];           // every inventory page: show3() pages at 22 lines

const hasClass = (s, k) => s.inventory.some((i) => i.itemClass === k);
const richEnough = (s) => s.inventory.length >= MIN_ITEMS
  && hasClass(s, ITEM_CLASS.POTION) && hasClass(s, ITEM_CLASS.SCROLL);

installLarnShim({
  name: "scripts/test/test-larn-status-tap.mjs",
  gymSeed: () => SEED,
  gymFast: () => 1,
  // Everything the shim draws goes to the bot; the status record is also
  // decoded here, because it is what this gate checks against the screen.
  // One copy serves both: decodeStatus reads and never writes.
  onEvent: (ev) => {
    if (ev.name === "status") {
      statusPushes++;
      status = decodeStatus(ev.record, ev.names);
    }
    bot.handle(ev);
  },
  saveLanded: () => {},
  notice: (text) => bot.onNotice(text),
  quit: () => fail(`the game ended after ${bot.model.commands} commands, before the tap could be checked`),
  gatherKey: async (wait, cmd) => {
    if (!wait) return null;

    if (phase === "pager") {
      // Back at a yylex command boundary: showstr() is done and t_endup() has
      // already restored the map, so everything the listing printed is in
      // `pages` and nowhere else.
      if (cmd) return check();
      pages.push(grab());
      return { code: 0x20 }; // more(): `while (ttgetch() != ' ')`
    }

    if (cmd && status && richEnough(status)) {
      // qshowstr()'s t_setup() clears or scrolls the screen to make room for
      // the item list, so the status line is gone once `i` has been answered.
      // Snapshot it here; the inventory and mobul assertions read `pages`.
      // ttgetch() lflush()es before every read, so `status` was recomputed
      // from this exact game state — including the gltime the mobul line
      // will print, since inventory is a nomove command (main.c:294-314).
      snapBefore = grab();
      condBefore = rows();
      tapped = status;
      phase = "pager";
      return { code: "i".charCodeAt(0) };
    }
    if (cmd && bot.model.commands >= MAX_COMMANDS) {
      fail(`seed ${SEED} never carried ${MIN_ITEMS} items including a potion and a scroll in `
        + `${MAX_COMMANDS} commands (last inventory: ${JSON.stringify(status?.inventory ?? [])}) `
        + `— pick a seed that gives a richer game`);
    }

    return bot.nextKey(true, cmd);
  },
});

/** Parse the two status rows bot_linex() prints (display.c:65-95). */
function readStatusLine(screen) {
  const top = /Spells:\s*(-?\d+)\(\s*(-?\d+)\)\s+AC:\s*(-?\d+)\s+WC:\s*(-?\d+)\s+Level\s*(-?\d+)\s+Exp:\s*(-?\d+)/.exec(screen);
  const bottom = /HP:\s*(-?\d+)\(\s*(-?\d+)\)\s+STR=(-?\d+)\s+INT=(-?\d+)\s+WIS=(-?\d+)\s+CON=(-?\d+)\s+DEX=(-?\d+)\s+CHA=(-?\d+)\s+LV:\s*(\?|H|V\d|\d+)\s+Gold:\s*(-?\d+)/.exec(screen);
  if (!top || !bottom) fail(`no Larn status line on the pre-inventory screen:\n${screen}`);
  const n = (s) => Number(s);
  const lv = bottom[9];
  return {
    spells: n(top[1]), spellmax: n(top[2]), ac: n(top[3]), wc: n(top[4]),
    xlevel: n(top[5]), experience: n(top[6]),
    hp: n(bottom[1]), hpmax: n(bottom[2]),
    str: n(bottom[3]), int: n(bottom[4]), wis: n(bottom[5]),
    con: n(bottom[6]), dex: n(bottom[7]), cha: n(bottom[8]),
    depth: lv === "?" ? null : (lv in DEPTH_BY_NAME ? DEPTH_BY_NAME[lv] : n(lv)),
    gold: n(bottom[10]),
  };
}

/** Join the printed list by SLOT LETTER: qshowstr() walks iven[] type-major
 *  (main.c:352-359) while the record is in slot order, so line position and
 *  slot index are different orderings of the same set. */
function readInventory(screen) {
  const byLetter = new Map();
  for (const line of screen.split("\n")) {
    const m = /^([a-z])\)\s\s+(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    if (byLetter.has(m[1])) fail(`the inventory printed slot ${m[1]}) twice:\n${screen}`);
    byLetter.set(m[1], m[2]);
  }
  return byLetter;
}

function check() {
  if (statusPushes === 0) fail("the status tap never fired");
  if (!tapped) fail("no status record was current when the inventory was opened");
  if (!snapBefore) fail("the run never reached the `i` key");
  // Only what qshowstr() itself printed. t_setup() clears just the lines the
  // listing needs (main.c:369-379), so stale text survives below each page —
  // including the message window's own "You pick up:" / "h)   a ruby", which
  // reads exactly like an inventory line. more() ends every page.
  const screen = pages.map((page) => {
    const lines = page.split("\n");
    const end = lines.findIndex((l) => l.includes("--- press "));
    return lines.slice(0, end === -1 ? lines.length : end).join("\n");
  }).join("\n");

  // 1. The scalars agree with the status line the player reads.
  const line = readStatusLine(snapBefore);
  for (const [field, seen] of Object.entries(line)) {
    if (tapped[field] !== seen)
      fail(`tap says ${field}=${tapped[field]}, the status line says ${seen}\n${snapBefore}`);
  }

  // 2. Presence, not counters: botside() paints a label at column 70 of row
  //    i+1 exactly when c[bot_data[i].typ] is set, and never the countdown.
  //    Checked in both directions — a bit the tap invents is as bad as one it
  //    drops, and a numeric condition would be a leak of the turns remaining.
  CONDITION_NAMES.forEach((name, i) => {
    const painted = (condBefore[i] ?? "").slice(COND_COL).trim() !== "";
    const claimed = tapped.conditions.includes(name);
    if (painted !== claimed)
      fail(`condition bit ${i} (${name}): tap says ${claimed}, the screen says ${painted}`);
  });
  for (const cond of tapped.conditions)
    if (typeof cond !== "string") fail(`condition ${String(cond)} is not a label`);

  // 3. The clock agrees with the two rounded values qshowstr() printed.
  const mob = /Elapsed time is (-?\d+)\.\s+You have (-?\d+) mobuls left/.exec(screen);
  if (!mob) fail(`the \`i\` command never printed the mobul line:\n${screen}`);
  if (tapped.mobulsElapsed !== Number(mob[1]) || tapped.mobulsLeft !== Number(mob[2])) {
    fail(`tap says ${tapped.mobulsElapsed} elapsed / ${tapped.mobulsLeft} left, `
      + `the screen says ${mob[1]} / ${mob[2]}`);
  }

  // 4. Every item the tap reports is an item the screen printed under the same
  //    name, and the screen printed no item the tap withheld. Identification
  //    rides on that equality: an unidentified potion or scroll has an empty
  //    potionname[]/scrollname[] entry (data.c:370), so show1() prints no
  //    " of ..." suffix and status_item_name() must not synthesize one.
  const onScreen = readInventory(screen);
  for (const item of tapped.inventory) {
    const printed = onScreen.get(item.letter);
    if (printed === undefined)
      fail(`tap reports slot ${item.letter}) "${item.name}", the screen printed no such slot:\n${screen}`);
    if (printed !== item.name)
      fail(`slot ${item.letter}): tap says "${item.name}", the screen says "${printed}"`);
  }
  for (const [letter, printed] of onScreen) {
    if (!tapped.inventory.some((i) => i.letter === letter))
      fail(`the screen printed slot ${letter}) "${printed}", the tap withheld it`);
  }
  // Both of the next two assertions restate the takeover condition where it is
  // actually depended on: if MIN_ITEMS or richEnough is ever loosened, the two
  // claims above stop being about anything and should say so out loud rather
  // than quietly passing on a two-item starting kit.
  const suffixable = tapped.inventory.filter(
    (i) => i.itemClass === ITEM_CLASS.POTION || i.itemClass === ITEM_CLASS.SCROLL);
  if (suffixable.length === 0) fail("no potion or scroll in the checked inventory");
  // qshowstr() prints type-major (main.c:352-359) and the record is slot-major;
  // a positional join would have passed on a listing that happened to agree.
  const printedOrder = [...onScreen.keys()].join("");
  const slotOrder = tapped.inventory.map((i) => i.letter).join("");
  if (printedOrder === slotOrder)
    fail(`the inventory printed in slot order (${slotOrder}); this run cannot tell a letter join from a positional one`);

  const known = suffixable.filter((i) => / of /.test(i.name)).length;
  console.log(`OK: Larn's status tap agrees with the screen (seed ${SEED}, `
    + `${bot.model.commands} commands, ${statusPushes} pushes, HP ${tapped.hp}/${tapped.hpmax}, `
    + `AC ${tapped.ac} WC ${tapped.wc} Lv ${tapped.xlevel} exp ${tapped.experience} gold ${tapped.gold}, `
    + `depth ${tapped.depth === null ? "?" : tapped.depth}, `
    + `${tapped.mobulsElapsed} mobuls elapsed / ${tapped.mobulsLeft} left, `
    + `conditions [${tapped.conditions.join(", ")}], `
    + `${suffixable.length} potion/scroll of which ${known} identified, `
    + `${tapped.inventory.length} items: `
    + tapped.inventory.map((i) => `${i.letter}) ${i.name}`).join("; ") + ")");
  process.exit(0);
}

/** Mount after the --preload-file package appends its own unpack to preRun,
 *  the shape scripts/dev/bot-gym-larn.mjs pins: /lib does not exist yet. */
createLarnModule({
  locateFile: CORE,
  arguments: [],
  print: () => {},
  printErr: (t) => console.warn("[larn stderr]", String(t)),
  preRun: [(m) => {
    m.addRunDependency("tap-mount");
    queueMicrotask(() => {
      mountLarnStorage(m, { locks: null });
      m.removeRunDependency("tap-mount");
    });
  }],
}).catch((e) => fail(String(e)));

// Fixed Int32 word layout shared by Larn's native status tap and its decoder.
//
// The C mirror lives in src/modules/larn/native/main-wasm.c (flush_status);
// the two must stay in lockstep, and scripts/test/larn-statusrecords.test.ts
// plus scripts/test/test-larn-status-tap.mjs are the guards.
//
// The projection is defined by WHAT THE SCREEN PRINTS, not by what the C
// state holds (spec: docs/specs/2026-08-18-bot-phase1a-larn-
// baseline-design.md). Three consequences are baked into this layout:
//   - Conditions are a presence bitmask, never their countdowns: botside()
//     (external/larn/display.c:202-222) prints the label "Haste Self", never
//     the turns left in c[HASTESELF].
//   - The clock is the two ROUNDED values qshowstr() prints
//     (external/larn/main.c:361) — (gltime + 99) / 100 + 1 elapsed and
//     (TIMELIMIT - gltime) / 100 left — never raw gltime, which is finer
//     than anything a player can read.
//   - DEPTH is DEPTH_UNKNOWN when TELEFLAG makes the status line print
//     "LV: ?" (external/larn/display.c:86-91). Exporting the true level
//     beside the flag would hand the bot the depth the screen is hiding.
//
// Where the screen prints a derived number, so does the tap: STR is the
// printed c[STRENGTH] + c[STREXTRA] (display.c:81-82), not c[STRENGTH]; WC is
// c[WCLASS] and XLEVEL is c[LEVEL], the two the status line labels "WC" and
// "Level" (display.c:75-79).
//
// ".ts" import extensions: the headless gym loads this straight from source.

/** Header word offsets. */
export const STATUS = {
  SPELLS: 0, SPELLMAX: 1, AC: 2, WC: 3, XLEVEL: 4, EXPERIENCE: 5, HP: 6, HPMAX: 7,
  STR: 8, INT: 9, WIS: 10, CON: 11, DEX: 12, CHA: 13, GOLD: 14, DEPTH: 15,
  MOBULS_ELAPSED: 16, MOBULS_LEFT: 17, FLAGS: 18, SLOTS: 19, NAME_BYTES: 20,
} as const;

/** Words before the first inventory slot. */
export const STATUS_HEADER = 21;

/** Per-slot word offsets, relative to STATUS_HEADER + i * SLOT_STRIDE. */
export const SLOT = { LETTER: 0, CLASS: 1 } as const;
export const SLOT_STRIDE = 2;

/** STATUS.DEPTH when the status line prints "LV: ?" instead of a level name. */
export const DEPTH_UNKNOWN = -1;

/** show3()'s own branching (external/larn/main.c:602-644), not a taxonomy we
 *  invented: potions and scrolls take an identification suffix, the PLAIN list
 *  (OLARNEYE, OBOOK, OSPIRITSCARAB, ODIAMOND, ORUBY, OCUBEofUNDEAD, OEMERALD,
 *  OCHEST, OCOOKIE, OSAPPHIRE, ONOTHEFT) prints bare, everything else prints
 *  an enchantment when it has one. Carrying more classes than the engine's own
 *  printer distinguishes would be inventing game knowledge the bot is supposed
 *  to learn. NONE is 0 so an empty slot word reads as "no item". */
export const ITEM_CLASS = { NONE: 0, POTION: 1, SCROLL: 2, PLAIN: 3, ENCHANTED: 4 } as const;

/** bot_data[] order in external/larn/display.c:183-199, lowercased. The C
 *  bitmask indexes this array positionally — bit i is bot_data[i] — so DO NOT
 *  reorder: a transposition mislabels a condition forever and nothing outside
 *  this file's test would catch it. (Upstream's label for bit 7 is the typo
 *  "Fire Resit"; we spell the condition it names.) */
export const CONDITION_NAMES = [
  "stealth", "undead pro", "spirit pro", "charm", "time stop", "hold monst",
  "giant str", "fire resist", "dexterity", "strength", "scare", "haste self",
  "cancel", "invisible", "protect 3", "protect 2", "wall-walk",
] as const;

export interface LarnItem {
  letter: string;
  itemClass: number;
  /** Exactly what show3() would print for this slot, identification honoured. */
  name: string;
}

export interface LarnStatus {
  spells: number; spellmax: number; ac: number; wc: number;
  xlevel: number; experience: number;
  hp: number; hpmax: number;
  str: number; int: number; wis: number; con: number; dex: number; cha: number;
  gold: number;
  /** null when the screen is hiding the level ("LV: ?"). */
  depth: number | null;
  mobulsElapsed: number;
  mobulsLeft: number;
  conditions: string[];
  inventory: LarnItem[];
}

/** Decode one pushed record. `names` is NAME_BYTES of NUL-terminated UTF-8,
 *  one string per occupied slot in slot order. */
export function decodeStatus(record: Int32Array, names: Uint8Array): LarnStatus {
  const text = new TextDecoder().decode(names);
  const parts = text.length ? text.split("\0") : [];
  const slots = record[STATUS.SLOTS] ?? 0;
  const inventory: LarnItem[] = [];
  for (let i = 0; i < slots; i++) {
    const base = STATUS_HEADER + i * SLOT_STRIDE;
    inventory.push({
      letter: String.fromCharCode(record[base + SLOT.LETTER] ?? 0),
      itemClass: record[base + SLOT.CLASS] ?? ITEM_CLASS.NONE,
      name: parts[i] ?? "",
    });
  }
  const flags = record[STATUS.FLAGS] ?? 0;
  const conditions: string[] = [];
  CONDITION_NAMES.forEach((n, i) => { if (flags & (1 << i)) conditions.push(n); });
  const depth = record[STATUS.DEPTH] ?? DEPTH_UNKNOWN;
  return {
    spells: record[STATUS.SPELLS] ?? 0, spellmax: record[STATUS.SPELLMAX] ?? 0,
    ac: record[STATUS.AC] ?? 0, wc: record[STATUS.WC] ?? 0,
    xlevel: record[STATUS.XLEVEL] ?? 0, experience: record[STATUS.EXPERIENCE] ?? 0,
    hp: record[STATUS.HP] ?? 0, hpmax: record[STATUS.HPMAX] ?? 0,
    str: record[STATUS.STR] ?? 0, int: record[STATUS.INT] ?? 0, wis: record[STATUS.WIS] ?? 0,
    con: record[STATUS.CON] ?? 0, dex: record[STATUS.DEX] ?? 0, cha: record[STATUS.CHA] ?? 0,
    gold: record[STATUS.GOLD] ?? 0,
    depth: depth === DEPTH_UNKNOWN ? null : depth,
    mobulsElapsed: record[STATUS.MOBULS_ELAPSED] ?? 0,
    mobulsLeft: record[STATUS.MOBULS_LEFT] ?? 0,
    conditions, inventory,
  };
}

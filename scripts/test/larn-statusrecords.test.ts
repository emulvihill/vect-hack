// The Int32 word layout shared between the Larn native status tap
// (src/modules/larn/native/main-wasm.c) and the TS decoder. Pins the header
// width, the field offsets, the condition-flag order, and the decoder's
// projection rules.
import { describe, expect, it } from "vitest";
import {
  CONDITION_NAMES, DEPTH_UNKNOWN, ITEM_CLASS, SLOT, SLOT_STRIDE, STATUS, STATUS_HEADER,
  decodeStatus,
} from "../../src/modules/larn/statusRecords";

/** Build a record the way C would, so the test exercises the real decoder. */
function record(fields: Partial<Record<keyof typeof STATUS, number>>, slots: number[][] = []) {
  const r = new Int32Array(STATUS_HEADER + slots.length * SLOT_STRIDE);
  for (const [k, v] of Object.entries(fields)) r[STATUS[k as keyof typeof STATUS]] = v as number;
  r[STATUS.SLOTS] = slots.length;
  slots.forEach((s, i) => {
    r[STATUS_HEADER + i * SLOT_STRIDE + SLOT.LETTER] = s[0]!;
    r[STATUS_HEADER + i * SLOT_STRIDE + SLOT.CLASS] = s[1]!;
  });
  return r;
}
const blob = (names: string[]) =>
  new TextEncoder().encode(names.map((n) => n + "\0").join(""));

describe("larn statusRecords layout", () => {
  it("pins the header width and offsets", () => {
    expect(STATUS_HEADER).toBe(21);
    expect(STATUS).toEqual({
      SPELLS: 0, SPELLMAX: 1, AC: 2, WC: 3, XLEVEL: 4, EXPERIENCE: 5, HP: 6, HPMAX: 7,
      STR: 8, INT: 9, WIS: 10, CON: 11, DEX: 12, CHA: 13, GOLD: 14, DEPTH: 15,
      MOBULS_ELAPSED: 16, MOBULS_LEFT: 17, FLAGS: 18, SLOTS: 19, NAME_BYTES: 20,
    });
    expect(SLOT).toEqual({ LETTER: 0, CLASS: 1 });
    expect(SLOT_STRIDE).toBe(2);
  });

  // Pinned whole, not sampled: the C side indexes this array positionally from
  // a bitmask (status_flag_id[] in main-wasm.c mirrors bot_data[] in
  // external/larn/display.c:183-199), so transposing any two entries would
  // mislabel those conditions forever and no test outside this file could
  // catch it. Spot-checking a few indices leaves the swaps between them open.
  it("pins the botside condition order", () => {
    expect(CONDITION_NAMES).toEqual([
      "stealth", "undead pro", "spirit pro", "charm", "time stop", "hold monst",
      "giant str", "fire resist", "dexterity", "strength", "scare", "haste self",
      "cancel", "invisible", "protect 3", "protect 2", "wall-walk",
    ]);
  });

  it("decodes scalars and the mobul clock", () => {
    const s = decodeStatus(record({ HP: 12, HPMAX: 19, AC: 3, GOLD: 240, DEPTH: 5,
      MOBULS_ELAPSED: 4, MOBULS_LEFT: 96 }), blob([]));
    expect(s.hp).toBe(12);
    expect(s.hpmax).toBe(19);
    expect(s.ac).toBe(3);
    expect(s.gold).toBe(240);
    expect(s.depth).toBe(5);
    expect(s.mobulsElapsed).toBe(4);
    expect(s.mobulsLeft).toBe(96);
  });

  it("reports a hidden depth rather than guessing one", () => {
    const s = decodeStatus(record({ DEPTH: DEPTH_UNKNOWN }), blob([]));
    expect(s.depth).toBeNull();
  });

  it("expands the flag bitmask to the labels the screen prints", () => {
    const s = decodeStatus(record({ FLAGS: (1 << 0) | (1 << 11) }), blob([]));
    expect(s.conditions).toEqual(["stealth", "haste self"]);
  });

  it("pairs each slot with its rendered name", () => {
    const s = decodeStatus(
      record({}, [["a".charCodeAt(0), ITEM_CLASS.POTION], ["b".charCodeAt(0), ITEM_CLASS.ENCHANTED]]),
      blob(["a magic potion", "a sword of slashing + 2"]),
    );
    expect(s.inventory).toEqual([
      { letter: "a", itemClass: ITEM_CLASS.POTION, name: "a magic potion" },
      { letter: "b", itemClass: ITEM_CLASS.ENCHANTED, name: "a sword of slashing + 2" },
    ]);
  });
});

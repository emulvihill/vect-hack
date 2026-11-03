// The wield probe (vect-hack-h9x.6, spec
// docs/specs/2026-08-28-larn-wield-by-measurement.md).
//
// The bot carries no weapon table. It wields a thing, reads the weapon class
// Larn prints on the bottom line, and keeps whichever measured highest — so
// what ranks the weapons is Larn, and the ranking is a number the player can
// see. These tests are about the state machine that makes that terminate,
// because the failure mode is not a wrong answer but an infinite probe loop:
// a bot that alternates between "try the next one" and "put the best back"
// spends its whole budget and caps.
import { describe, expect, it } from "vitest";
import { LarnBotModel } from "../../src/modules/larn/bot/model";
import { DEFAULT_TUNING, LarnBrain } from "../../src/modules/larn/bot/policy";
import { GRID, GRID_STRIDE, TERRAIN, TOP } from "../../src/modules/larn/mapRecords";
import { LARN_COLS, LARN_ROWS } from "../../src/modules/larn/classifier";
import { ITEM_CLASS, SLOT, SLOT_STRIDE, STATUS, STATUS_HEADER } from "../../src/modules/larn/statusRecords";

/** The shipped tuning with the probe ENABLED. The shipped default is 0 — the
 *  probe failed its pre-registered bar and does not ship
 *  (docs/reports/2026-08-28-larn-wield-by-measurement.md) — so a
 *  suite about the mechanism has to turn it on itself. Asserting against the
 *  shipped knob would be vect-hack-b5f.25's mistake: a suite that goes red the
 *  day somebody changes a policy decision it was never about. */
const probing = { wieldProbes: 40 };

/** An empty walled room with the hero in it and nothing else — the wield step
 *  declines while anything is visible, so every case here is a quiet room. */
function room(m: LarnBotModel, monsterAt?: [number, number]) {
  const r = new Int32Array(LARN_COLS * LARN_ROWS * GRID_STRIDE);
  let i = 0;
  for (let y = 0; y < LARN_ROWS; y++) for (let x = 0; x < LARN_COLS; x++) {
    r[i + GRID.X] = x; r[i + GRID.Y] = y;
    const edge = x === 0 || y === 0 || x === LARN_COLS - 1 || y === LARN_ROWS - 1;
    r[i + GRID.TERRAIN_CAT] = edge ? TERRAIN.WALL : TERRAIN.FLOOR;
    r[i + GRID.TERRAIN_CHAR] = 46; r[i + GRID.TERRAIN_COLOR] = 7;
    if (x === 5 && y === 5) r[i + GRID.TOP_CAT] = TOP.HERO;
    if (monsterAt && x === monsterAt[0] && y === monsterAt[1]) {
      r[i + GRID.TOP_CAT] = TOP.MONSTER; r[i + GRID.TOP_CHAR] = "B".charCodeAt(0); r[i + GRID.TOP_COLOR] = 2;
    }
    i += GRID_STRIDE;
  }
  m.observe({ name: "map", records: r });
}

interface Item { letter: string; name: string; itemClass?: number }

/** One status push. `wc` is Larn's own weapon class for whatever is in hand —
 *  the number the probe is reading. Names arrive as a NUL-separated blob, one
 *  per occupied slot in slot order, exactly as the tap sends them. */
function status(m: LarnBotModel, wc: number, items: Item[]) {
  const record = new Int32Array(STATUS_HEADER + items.length * SLOT_STRIDE);
  record[STATUS.HP] = 20; record[STATUS.HPMAX] = 20; record[STATUS.DEPTH] = 1;
  record[STATUS.XLEVEL] = 1; record[STATUS.WC] = wc; record[STATUS.SLOTS] = items.length;
  items.forEach((item, i) => {
    const base = STATUS_HEADER + i * SLOT_STRIDE;
    record[base + SLOT.LETTER] = item.letter.charCodeAt(0);
    record[base + SLOT.CLASS] = item.itemClass ?? ITEM_CLASS.PLAIN;
  });
  const names = new TextEncoder().encode(items.map((i) => i.name).join("\0") + (items.length ? "\0" : ""));
  m.observe({ name: "status", record, names });
}

const HELD = " (weapon in hand)";

describe("the wield probe", () => {
  it("probes each carried weapon once and settles on the one Larn scored highest", () => {
    const m = new LarnBotModel();
    const brain = new LarnBrain(probing);
    room(m);

    // Start: the dagger in hand at wc 3, a second weapon in the pack.
    status(m, 3, [{ letter: "a", name: "a dagger" + HELD }, { letter: "b", name: "a spear" }]);
    // The dagger has never been measured, so it is probed first — even though
    // it is already in hand. The measurement, not the assumption, is the point.
    let action = brain.decide(m);
    expect(action.intent).toBe("wield-probe");
    expect(String.fromCharCode(action.key.code)).toBe("w");
    expect(brain.promptContext(m).wieldLetter).toBe("a");

    // The engine wielded it and pushed a status: wc 3 is now recorded for the
    // dagger, and the spear is the next thing never measured.
    status(m, 3, [{ letter: "a", name: "a dagger" + HELD }, { letter: "b", name: "a spear" }]);
    action = brain.decide(m);
    expect(action.intent).toBe("wield-probe");
    expect(brain.promptContext(m).wieldLetter).toBe("b");

    // The spear measures higher, and it is in hand, so there is nothing left
    // to do: the probe is finished and the ladder moves on.
    status(m, 6, [{ letter: "a", name: "a dagger" }, { letter: "b", name: "a spear" + HELD }]);
    expect(brain.decide(m).intent).not.toMatch(/^wield/);
  });

  it("puts the best back when a probe measured worse", () => {
    const m = new LarnBotModel();
    const brain = new LarnBrain(probing);
    room(m);
    // Measure the spear at 6...
    status(m, 6, [{ letter: "a", name: "a dagger" }, { letter: "b", name: "a spear" + HELD }]);
    expect(brain.decide(m).intent).toBe("wield-probe");
    expect(brain.promptContext(m).wieldLetter).toBe("a"); // the unmeasured one
    // ...then the dagger at 3, which is worse.
    status(m, 3, [{ letter: "a", name: "a dagger" + HELD }, { letter: "b", name: "a spear" }]);
    let action = brain.decide(m);
    expect(action.intent).toBe("wield-probe");
    expect(brain.promptContext(m).wieldLetter).toBe("b"); // the spear is unmeasured

    // The spear is back in hand at 6 and both are measured, so there is
    // nothing to do.
    status(m, 6, [{ letter: "a", name: "a dagger" }, { letter: "b", name: "a spear" + HELD }]);
    expect(brain.decide(m).intent).not.toMatch(/^wield/);

    // Simulate the engine leaving the worse one in hand — Larn re-wields on
    // its own in places (a lance, a stolen weapon). The ladder must notice and
    // ask for the spear back, from the measurements it already has.
    status(m, 3, [{ letter: "a", name: "a dagger" + HELD }, { letter: "b", name: "a spear" }]);
    action = brain.decide(m);
    expect(action.intent).toBe("wield-best");
    expect(brain.promptContext(m).wieldLetter).toBe("b");
  });

  it("gives up on a weapon the engine will not put in the hero's hand", () => {
    // main.c:1032 — "But one arm is busy with your shield!" is a wield that
    // returns without setting c[WIELD], so the item never arrives. Without a
    // memory of that, "restore the best" asks for it every turn for ever and
    // the run caps. This is the loop guard, and it is the reason this file
    // exists.
    const m = new LarnBotModel();
    const brain = new LarnBrain(probing);
    room(m);
    const pack = [{ letter: "a", name: "a dagger" + HELD }, { letter: "b", name: "a two handed sword" }];
    status(m, 3, pack);
    expect(brain.decide(m).intent).toBe("wield-probe"); // measures the dagger

    status(m, 3, pack);
    expect(brain.promptContext(m).wieldLetter).toBe("a");
    const action = brain.decide(m);
    expect(action.intent).toBe("wield-probe");
    expect(brain.promptContext(m).wieldLetter).toBe("b"); // asks for the sword

    // The engine refused: the sword is still not in hand. It is struck off,
    // the dagger stays, and the ladder stops asking.
    status(m, 3, pack);
    expect(brain.decide(m).intent).not.toMatch(/^wield/);
    // ...and it stays stopped, which is the whole claim.
    status(m, 3, pack);
    expect(brain.decide(m).intent).not.toMatch(/^wield/);
  });

  it("never probes a potion or a scroll, which Larn refuses outright", () => {
    // ycwi(), main.c:1021-1025. The tap already labels exactly these two
    // classes, so the filter needs no name table — and a probe that spent a
    // turn buying "You can't wield item c!" would be a turn wasted every time
    // the hero picked up a scroll.
    const m = new LarnBotModel();
    const brain = new LarnBrain(probing);
    room(m);
    status(m, 3, [
      { letter: "a", name: "a dagger" + HELD },
      { letter: "b", name: "a magic potion", itemClass: ITEM_CLASS.POTION },
      { letter: "c", name: "a magic scroll", itemClass: ITEM_CLASS.SCROLL },
    ]);
    expect(brain.decide(m).intent).toBe("wield-probe");
    expect(brain.promptContext(m).wieldLetter).toBe("a");
    status(m, 3, [
      { letter: "a", name: "a dagger" + HELD },
      { letter: "b", name: "a magic potion", itemClass: ITEM_CLASS.POTION },
      { letter: "c", name: "a magic scroll", itemClass: ITEM_CLASS.SCROLL },
    ]);
    // The dagger is measured and in hand; the other two are not candidates.
    expect(brain.decide(m).intent).not.toMatch(/^wield/);
  });

  it("is off in the shipped policy, and off means not one command spent", () => {
    // The decision, pinned. Over 500 held-out seeds the probe moved neither
    // co-primary (dungeon depth median 2 -> 2, xlevel 2 -> 2) while spending
    // about 8 commands a game, so it ships at 0. This test is what makes the
    // control arm of that A/B honest as well: with the knob at 0 the new code
    // is provably inert, so the two arms differed by the probe and nothing
    // else. Turning it on again is a decision, not an edit.
    expect(DEFAULT_TUNING.wieldProbes).toBe(0);
    const m = new LarnBotModel();
    const brain = new LarnBrain();
    room(m);
    status(m, 3, [{ letter: "a", name: "a dagger" }, { letter: "b", name: "a spear" }]);
    expect(brain.decide(m).intent).not.toMatch(/^wield/);
    expect(brain.promptContext(m).wieldLetter).toBeNull();
  });

  it("does not swap weapons with a monster in sight", () => {
    // Swapping costs a turn, and a turn spent swapping beside a monster is a
    // free round for the monster. The same condition the rest step uses.
    const m = new LarnBotModel();
    const brain = new LarnBrain(probing);
    room(m, [12, 12]);
    status(m, 3, [{ letter: "a", name: "a dagger" + HELD }, { letter: "b", name: "a spear" }]);
    expect(brain.decide(m).intent).not.toMatch(/^wield/);
  });
});

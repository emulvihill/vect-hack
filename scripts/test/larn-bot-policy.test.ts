import { describe, expect, it } from "vitest";
import { LarnBotModel } from "../../src/modules/larn/bot/model";
import { LarnBrain, engage, passable, readyToDescend } from "../../src/modules/larn/bot/policy";
import { GRID, GRID_STRIDE, KIND_NAMES, TERRAIN, TOP } from "../../src/modules/larn/mapRecords";
import { LARN_COLS, LARN_ROWS } from "../../src/modules/larn/classifier";
import { ITEM_CLASS, SLOT, SLOT_STRIDE, STATUS, STATUS_HEADER } from "../../src/modules/larn/statusRecords";
import { claimId, confidenceOf, loadKb, type Claim, type Fact } from "../../src/bot/kb";
import metaFacts from "../../data/kb/meta/facts.json";
import larnFacts from "../../data/kb/larn/facts.json";
import larnPolicy from "../../data/kb/larn/policy.json";

/** An explicit empty KB with the shipped tuning, so the "empty tables change
 *  no decision" claim is independent of whatever facts eventually ship. */
const kb = () => loadKb({ meta: { facts: [] }, engine: { facts: [] }, policy: larnPolicy });

/** One learned fact, at a chosen confidence so a case can sit either side of
 *  the fact floor. The id is derived exactly as the applier derives it, so
 *  these facts compile through compileFacts into the keys the ladder asks
 *  with — a stub answer would prove nothing about the key. */
function learned(claim: Claim, confidence: number, value: number | null = null): Fact {
  return {
    id: claimId("larn", claim), claim, text: "", value, confidence,
    support: [{ trajectory: "r1", from: 0, to: 5 }], refute: [], retired: null,
    updated: "2026-08-19T00:00:00Z", seed: false,
  };
}
/** The shipped tuning, with learned facts of our own in the engine tier. */
const kbWith = (facts: Fact[]) => loadKb({ meta: { facts: [] }, engine: { facts }, policy: larnPolicy });
const BELOW_FLOOR = confidenceOf(0, 1); // 1/3 — under larnPolicy.factFloor
const ABOVE_FLOOR = confidenceOf(3, 0); // 0.8 — over it

type Paint = {
  hero: [number, number];
  monsters?: [number, number][];
  /** The glyph and color every painted monster carries; Larn's B by default. */
  monster?: { ch: string; color: number };
  /** Monsters with a glyph and colour each, for the cases that need two
   *  different beings adjacent at once. */
  beings?: [number, number, string, number][];
  /** Wall everything the hero and the monsters are not standing on: the
   *  cornered case, where declining a fight leaves nowhere to step. */
  pocket?: boolean;
  /** Extra cells a pocket keeps as floor, so a sealed region can be bigger
   *  than one cell. */
  floor?: [number, number][];
  unseenFrom?: number;
  /** Down stairs, each with the glyph Larn draws it as — the character an
   *  avoid-terrain fact keys on alongside the category. */
  down?: [number, number, string][];
  items?: [number, number, string][];
  /** Doors, each closed unless its third field says open. Larn draws a closed
   *  door "D" and an open one "O" (data.c objnamelist, header.h 19/20). */
  doors?: [number, number, boolean?][];
  trap?: [number, number];
};

/** Bordered floor room, everything seen unless unseenFrom is set. */
function paint(m: LarnBotModel, p: Paint) {
  const r = new Int32Array(LARN_COLS * LARN_ROWS * GRID_STRIDE);
  let i = 0;
  for (let y = 0; y < LARN_ROWS; y++) for (let x = 0; x < LARN_COLS; x++) {
    r[i + GRID.X] = x; r[i + GRID.Y] = y;
    const occupied = (x === p.hero[0] && y === p.hero[1])
      || (p.monsters ?? []).some(([mx, my]) => mx === x && my === y)
      || (p.beings ?? []).some(([mx, my]) => mx === x && my === y)
      || (p.floor ?? []).some(([fx, fy]) => fx === x && fy === y)
      || (p.down ?? []).some(([dx, dy]) => dx === x && dy === y)
      || (p.doors ?? []).some(([dx, dy]) => dx === x && dy === y)
      || (p.trap ? p.trap[0] === x && p.trap[1] === y : false);
    const edge = p.pocket ? !occupied
      : x === 0 || y === 0 || x === LARN_COLS - 1 || y === LARN_ROWS - 1;
    const unseen = p.unseenFrom !== undefined && x >= p.unseenFrom;
    r[i + GRID.TERRAIN_CAT] = unseen ? TERRAIN.UNSEEN : edge ? TERRAIN.WALL : TERRAIN.FLOOR;
    r[i + GRID.TERRAIN_CHAR] = 46; r[i + GRID.TERRAIN_COLOR] = 7;
    for (const [dx, dy, dch] of p.down ?? []) if (x === dx && y === dy) {
      r[i + GRID.TERRAIN_CAT] = TERRAIN.STAIRS; r[i + GRID.TERRAIN_KIND] = KIND_NAMES.indexOf("down");
      r[i + GRID.TERRAIN_CHAR] = dch.charCodeAt(0);
    }
    for (const [dx, dy, dopen] of p.doors ?? []) if (x === dx && y === dy) {
      r[i + GRID.TERRAIN_CAT] = dopen ? TERRAIN.DOOR_OPEN : TERRAIN.DOOR;
      r[i + GRID.TERRAIN_CHAR] = (dopen ? "O" : "D").charCodeAt(0);
    }
    if (p.trap && x === p.trap[0] && y === p.trap[1]) { r[i + GRID.TERRAIN_CAT] = TERRAIN.TRAP; r[i + GRID.TERRAIN_KIND] = KIND_NAMES.indexOf("trap"); }
    if (x === p.hero[0] && y === p.hero[1]) r[i + GRID.TOP_CAT] = TOP.HERO;
    for (const [mx, my] of p.monsters ?? []) if (x === mx && y === my) {
      r[i + GRID.TOP_CAT] = TOP.MONSTER;
      r[i + GRID.TOP_CHAR] = (p.monster?.ch ?? "B").charCodeAt(0);
      r[i + GRID.TOP_COLOR] = p.monster?.color ?? 2;
    }
    for (const [mx, my, mch, mcolor] of p.beings ?? []) if (x === mx && y === my) {
      r[i + GRID.TOP_CAT] = TOP.MONSTER;
      r[i + GRID.TOP_CHAR] = mch.charCodeAt(0);
      r[i + GRID.TOP_COLOR] = mcolor;
    }
    for (const [ix, iy, ich] of p.items ?? []) if (x === ix && y === iy) {
      r[i + GRID.TOP_CAT] = TOP.ITEM; r[i + GRID.TOP_CHAR] = ich.charCodeAt(0); r[i + GRID.TOP_COLOR] = 7;
    }
    i += GRID_STRIDE;
  }
  m.observe({ name: "map", records: r });
}
/** `slots` is the occupied inventory count the tap reports — what the
 *  pack-full latch clears against (src/modules/larn/bot/model.ts).
 *
 *  Every slot is a POTION, and deliberately: a potion is as full a pack slot as
 *  anything else, and it is one of the two classes Larn's wield() refuses
 *  (ycwi(), main.c:1021-1025), so the wield probe added by vect-hack-h9x.6
 *  never treats these as candidates. Without that these fixtures would be
 *  testing the loot step through a bot that first spends 26 turns trying each
 *  slot in its hand. The probe has its own suite, larn-bot-wield.test.ts. */
function status(m: LarnBotModel, hp: number, hpmax: number, depth = 1, xlevel = 1, slots = 0) {
  const record = new Int32Array(STATUS_HEADER + slots * SLOT_STRIDE);
  record[STATUS.HP] = hp; record[STATUS.HPMAX] = hpmax; record[STATUS.DEPTH] = depth;
  record[STATUS.XLEVEL] = xlevel; record[STATUS.SLOTS] = slots;
  for (let i = 0; i < slots; i++) {
    record[STATUS_HEADER + i * SLOT_STRIDE + SLOT.LETTER] = 97 + i;
    record[STATUS_HEADER + i * SLOT_STRIDE + SLOT.CLASS] = ITEM_CLASS.POTION;
  }
  m.observe({ name: "status", record, names: new Uint8Array(0) });
}
const ch = (a: { key: { code: number } }) => String.fromCharCode(a.key.code);

describe("shipped KB", () => {
  it("loads its facts through validation and hashes them deterministically", () => {
    const input = { meta: metaFacts, engine: larnFacts, policy: larnPolicy };
    const loaded = loadKb(input);
    expect(loaded.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(loadKb(input).hash).toBe(loaded.hash);
  });
});

describe("passable", () => {
  it("walks floor, doors, stairs, features and items; not walls, traps, monsters or the unseen", () => {
    const m = new LarnBotModel();
    paint(m, { hero: [5, 5], monsters: [[7, 7]], unseenFrom: 40, down: [[10, 10, "%"]], trap: [3, 3] });
    expect(passable(m, 6, 5, kb())).toBe(true);
    expect(passable(m, 10, 10, kb())).toBe(true);
    expect(passable(m, 0, 0, kb())).toBe(false);
    expect(passable(m, 3, 3, kb())).toBe(false);
    expect(passable(m, 7, 7, kb())).toBe(false);
    expect(passable(m, 50, 5, kb())).toBe(false);
    expect(passable(m, -1, 5, kb())).toBe(false);
  });

  it("routes around a terrain the KB has learned to avoid", () => {
    const m = new LarnBotModel();
    paint(m, { hero: [5, 5], down: [[10, 10, "V"]] });
    // Not dead wiring: a non-empty avoid set really does close a cell, while
    // the empty fixture allows it. The fact is compiled, not stubbed:
    // compileFacts writes "stairs:V", so this
    // only passes while passable() asks with the same key.
    const avoidShaft = kbWith([learned({ kind: "avoid-terrain", category: "stairs", ch: "V" }, ABOVE_FLOOR)]);
    expect(passable(m, 10, 10, kb())).toBe(true);
    expect(passable(m, 10, 10, avoidShaft)).toBe(false);
    expect(passable(m, 6, 5, avoidShaft)).toBe(true);
  });

  it("routes around terrain the KB names by category:ch, not by whole category", () => {
    // Larn draws the volcanic shaft "V" and an ordinary down staircase "%",
    // and the native tap gives both the "down" kind (main-wasm.c:449-454).
    // A fact keyed on the bare category would delete descent from the game.
    const m = new LarnBotModel();
    paint(m, { hero: [2, 1], down: [[4, 1, "V"], [2, 3, "%"]] });
    status(m, 20, 20);
    const avoidShaft = kbWith([learned({ kind: "avoid-terrain", category: "stairs", ch: "V" }, ABOVE_FLOOR)]);
    expect(passable(m, 4, 1, avoidShaft)).toBe(false);
    expect(passable(m, 2, 3, avoidShaft)).toBe(true);
    // The shaft is the NEARER staircase, and the ladder walks past it anyway:
    // this hero is level 1 and the readiness bar is 8 (vect-hack-h9x.5), so
    // the descent step does not target it and the "%" stairs to the southeast
    // win. Before that bar the seed bot walked east to the shaft and the
    // corpus lost half its games to it.
    expect(new LarnBrain(kb()).decide(m)).toMatchObject({ intent: "descend", key: { code: "n".charCodeAt(0) } });
    // A hero at or above the bar takes the nearer exit again — the bar is
    // readiness, not a ban, and the volcano is where the winning potion is.
    status(m, 20, 20, 1, 8);
    expect(new LarnBrain(kb()).decide(m)).toMatchObject({ intent: "descend", key: { code: "l".charCodeAt(0) } });
    // ...and knowing the shaft, the KB routes that ready hero away from it
    // again, by the "%" stairs. Readiness and learned avoidance are separate
    // gates and both still work.
    expect(new LarnBrain(avoidShaft).decide(m)).toMatchObject({ intent: "descend", key: { code: "n".charCodeAt(0) } });
  });

  it("crosses avoided terrain when it is the only way out, so no fact can seal a level", () => {
    // The invariant that makes learned avoidance safe to produce more of
    // (vect-hack-b5f.6). A learned fact removes a route while another exists;
    // it must never remove the last one, or a wrong fact is b5f.11's sealed
    // level under a new name — and the reflect loop is about to write more of
    // them. Step 6b asks walkable() rather than passable(), so the step that
    // fires when nothing else is reachable consults no knowledge at all.
    //
    // A pocket whose one exit is the shaft: hero at (5,5), the shaft at (6,5),
    // floor beyond it and the unseen frontier past x=8.
    const m = new LarnBotModel();
    paint(m, { hero: [5, 5], pocket: true, floor: [[7, 5]], down: [[6, 5, "V"]], unseenFrom: 8 });
    status(m, 20, 20);
    const avoidShaft = kbWith([learned({ kind: "avoid-terrain", category: "stairs", ch: "V" }, ABOVE_FLOOR)]);

    // Knowing nothing, the cell is simply walkable — the ladder steps onto it
    // to reach the frontier behind, which it tries before descending.
    expect(new LarnBrain(kb()).decide(m)).toMatchObject({ intent: "explore", key: { code: "l".charCodeAt(0) } });
    // Knowing the shaft, the ladder declines it as a route — and then takes it
    // anyway as the breach, because the alternative is standing still forever.
    expect(new LarnBrain(avoidShaft).decide(m)).toMatchObject({ intent: "breach", key: { code: "l".charCodeAt(0) } });
  });

  it("crosses an unready shaft when it is the only way out, so no readiness bar can seal a level", () => {
    // The same invariant as above, for the OTHER gate (vect-hack-h9x.5). A
    // readiness bar is a preference the ladder takes another way around while
    // there is one; it must never be the reason a hero stands still until the
    // command cap. Step 6b asks downExit() and not readyToDescend().
    //
    // A pocket whose one exit is the shaft, with nothing unseen behind it — so
    // there is no frontier to explore and descent is the only thing left.
    const m = new LarnBotModel();
    paint(m, { hero: [5, 5], pocket: true, down: [[6, 5, "V"]] });
    status(m, 20, 20, 1, 1); // level 1: far below the bar of 8

    // It is not a route (the descent step passed it over)...
    expect(readyToDescend(m, true, kb().tuning)).toBe(false);
    // ...and it is crossed anyway, because the alternative is a sealed level.
    expect(new LarnBrain(kb()).decide(m)).toMatchObject({ intent: "breach", key: { code: "l".charCodeAt(0) } });
  });
});

describe("LarnBrain", () => {
  it("attacks an adjacent monster by walking into it", () => {
    const m = new LarnBotModel(); paint(m, { hero: [5, 5], monsters: [[6, 6]] }); status(m, 20, 20);
    const a = new LarnBrain(kb()).decide(m);
    expect(a.intent).toBe("fight");
    expect(ch(a)).toBe("n"); // SE
  });
  it("rests when below half HP with nothing in view, but not while a monster is visible", () => {
    const m = new LarnBotModel(); paint(m, { hero: [5, 5] }); status(m, 5, 20);
    expect(new LarnBrain(kb()).decide(m)).toMatchObject({ intent: "rest", key: { code: 46 } }); // '.'
    const m2 = new LarnBotModel(); paint(m2, { hero: [5, 5], monsters: [[30, 10]], unseenFrom: 40 }); status(m2, 5, 20);
    expect(new LarnBrain(kb()).decide(m2).intent).not.toBe("rest");
  });
  it("rests strictly below half HP — the tuned fraction is the old doubling, for every integer pair", () => {
    // The rewrite was `hp * 2 < hpmax` -> `hp < hpmax * restBelowHpFraction`.
    // Doubling and halving only move a binary exponent, so both sides are
    // computed exactly and the predicates agree on every integer pair rather
    // than merely on the ones a run happens to hit. HP arrives as an Int32
    // status field, so sweeping the small pairs and probing the top of that
    // range covers the whole shape of the input, the hp * 2 === hpmax
    // boundary included.
    const f = larnPolicy.restBelowHpFraction;
    const differs = (hp: number, hpmax: number) => (hp < hpmax * f) !== (hp * 2 < hpmax);
    const mismatch: string[] = [];
    for (let hpmax = 1; hpmax <= 2000; hpmax++)
      for (let hp = 0; hp <= hpmax; hp++) if (differs(hp, hpmax)) mismatch.push(`${hp}/${hpmax}`);
    for (const hpmax of [2 ** 20, 2 ** 20 + 1, 2 ** 30, 2 ** 31 - 1])
      for (const hp of [0, (hpmax >> 1) - 1, hpmax >> 1, (hpmax >> 1) + 1, hpmax])
        if (differs(hp, hpmax)) mismatch.push(`${hp}/${hpmax}`);
    expect(mismatch).toEqual([]);
    // And the boundary through the real ladder: exactly half is not "weak".
    const half = new LarnBotModel(); paint(half, { hero: [5, 5] }); status(half, 10, 20);
    expect(new LarnBrain(kb()).decide(half).intent).not.toBe("rest");
    const under = new LarnBotModel(); paint(under, { hero: [5, 5] }); status(under, 9, 20);
    expect(new LarnBrain(kb()).decide(under).intent).toBe("rest");
  });
  it("walks to an item the KB values, ahead of frontier exploration", () => {
    // Pickup is automatic — lookforobject() runs on every move (main.c:291) —
    // so wanting an item is a routing decision and nothing more.
    const m = new LarnBotModel(); paint(m, { hero: [5, 5], items: [[8, 5, ")"]] }); status(m, 20, 20);
    const valued = kbWith([learned({ kind: "item-value", ch: ")" }, ABOVE_FLOOR, 0.8)]);
    const a = new LarnBrain(valued).decide(m);
    expect(a.intent).toBe("loot");
    expect(["l", "u", "n"]).toContain(ch(a)); // eastward, toward (8,5)
    // The empty fixture holds nothing, so the same room is just a done level.
    expect(new LarnBrain(kb()).decide(m).intent).not.toBe("loot");
  });
  it("stops routing to items it cannot carry, not just to the one it was refused", () => {
    // vect-hack-b5f.10. Larn's pickup is automatic (main.c:291), so wanting an
    // item is only ever a routing decision — and a full pack refuses EVERY
    // item, not the one cell that happened to prove it. A per-cell memory
    // would send the hero to the next valued item and buy the same refusal.
    const valued = kbWith([learned({ kind: "item-value", ch: ")" }, ABOVE_FLOOR, 0.8)]);
    const m = new LarnBotModel();
    paint(m, { hero: [5, 5], items: [[8, 5, ")"], [2, 5, ")"]] }); status(m, 20, 20, 1, 1, 26);
    const brain = new LarnBrain(valued);
    expect(brain.decide(m).intent).toBe("loot");
    m.keyAnswered(true);
    // The refusal came from somewhere else entirely; neither item below has
    // ever been stood on.
    m.observe({ name: "text", x: 0, y: 19, rgb: 0xffffff, text: "\nYou can't carry anything else" });
    paint(m, { hero: [5, 5], items: [[8, 5, ")"], [2, 5, ")"]] });
    expect(brain.decide(m).intent).not.toBe("loot");
  });
  it("keeps walking to gold with a full pack: gold never occupied a slot", () => {
    // Gold is the one valued cell a full pack cannot refuse. OGOLDPILE,
    // OMAXGOLD, OKGOLD and ODGOLD all dispatch to ogold() (object.c:46), which
    // adds to c[GOLD] and calls bottomgold() (object.c:1250) — no take(), no
    // prompt, no slot — so "the pack is full" says nothing about it. Larn
    // draws all four as "*" (data.c objnamelist; the "$" in that table is the
    // bank of Larn, which the exporter classifies as terrain, not an item).
    const valued = kbWith([
      learned({ kind: "item-value", ch: "*" }, ABOVE_FLOOR, 0.9),
      learned({ kind: "item-value", ch: ")" }, ABOVE_FLOOR, 0.8),
    ]);
    const refusal = "\nYou can't carry anything else";

    const gold = new LarnBotModel();
    paint(gold, { hero: [5, 5], items: [[8, 5, "*"]] }); status(gold, 20, 20, 1, 1, 26);
    gold.observe({ name: "text", x: 0, y: 19, rgb: 0xffffff, text: refusal });
    paint(gold, { hero: [5, 5], items: [[8, 5, "*"]] });
    const a = new LarnBrain(valued).decide(gold);
    expect(a.intent).toBe("loot");
    expect(["l", "u", "n"]).toContain(ch(a)); // eastward, toward (8,5)

    // The control, on the same geometry and the same refusal: a weapon IS
    // taken through take(), so a full pack is exactly the fact that stops the
    // walk. Without this half the case above would pass on a brain that had
    // simply forgotten the refusal.
    const pack = new LarnBotModel();
    paint(pack, { hero: [5, 5], items: [[8, 5, ")"]] }); status(pack, 20, 20, 1, 1, 26);
    pack.observe({ name: "text", x: 0, y: 19, rgb: 0xffffff, text: refusal });
    paint(pack, { hero: [5, 5], items: [[8, 5, ")"]] });
    expect(new LarnBrain(valued).decide(pack).intent).not.toBe("loot");
  });

  it("does not re-route to a valued item Larn refused to pick up", () => {
    // global.c:481 prints "You can't carry anything else" when take() finds no
    // free pack slot. The prompt table has already answered "t" by then, so the
    // refusal lands in the text the brain reads at the next command boundary.
    // Without a memory of it the loot step oscillates: nextStep() never counts
    // the hero's own cell, so standing on the item is not what stops the
    // routing — the hero walks off and is sent straight back (vect-hack-b5f.2.1).
    const valued = kbWith([learned({ kind: "item-value", ch: ")" }, ABOVE_FLOOR, 0.8)]);
    const refusal = "\nYou can't carry anything else";

    const m = new LarnBotModel();
    paint(m, { hero: [5, 5], items: [[6, 5, ")"]] }); status(m, 20, 20, 1, 1, 26);
    const brain = new LarnBrain(valued);
    expect(brain.decide(m)).toMatchObject({ intent: "loot", key: { code: "l".charCodeAt(0) } });
    m.keyAnswered(true);
    // Arrived: the hero glyph covers the item, Larn refuses the pickup.
    paint(m, { hero: [6, 5] });
    m.observe({ name: "text", x: 0, y: 19, rgb: 0xffffff, text: refusal });
    expect(brain.decide(m).intent).not.toBe("loot");
    m.keyAnswered(true);
    // Stepped off. The item is on the map again and still valued — and must
    // not be a target, or these two cells are the rest of the game.
    paint(m, { hero: [5, 5], items: [[6, 5, ")"]] });
    expect(brain.decide(m).intent).not.toBe("loot");

    // The control: the same three frames without the refusal do loot it back,
    // so the case above is the message doing the work and not the geometry.
    const m2 = new LarnBotModel();
    paint(m2, { hero: [5, 5], items: [[6, 5, ")"]] }); status(m2, 20, 20, 1, 1, 26);
    const brain2 = new LarnBrain(valued);
    brain2.decide(m2); m2.keyAnswered(true);
    paint(m2, { hero: [6, 5] });
    brain2.decide(m2); m2.keyAnswered(true);
    paint(m2, { hero: [5, 5], items: [[6, 5, ")"]] });
    expect(brain2.decide(m2).intent).toBe("loot");
  });
  it("carries the full pack down the stairs: a level change does not restore looting", () => {
    // The refused CELL was one map's geometry; a full PACK is not. The hero
    // takes it down the stairs, so the ladder that stopped routing to items
    // must stay stopped until the engine's own slot count says otherwise —
    // vect-hack-b5f.10, where every arrival at an item bought one refusal.
    const valued = kbWith([learned({ kind: "item-value", ch: ")" }, ABOVE_FLOOR, 0.8)]);
    const m = new LarnBotModel();
    paint(m, { hero: [6, 5] }); status(m, 20, 20, 1, 1, 26);
    const brain = new LarnBrain(valued);
    m.observe({ name: "text", x: 0, y: 19, rgb: 0xffffff, text: "\nYou can't carry anything else" });
    brain.decide(m); m.keyAnswered(true);
    paint(m, { hero: [5, 5], items: [[6, 5, ")"]] });
    expect(brain.decide(m).intent).not.toBe("loot");
    m.observe({ name: "level", width: LARN_COLS, height: LARN_ROWS });
    paint(m, { hero: [5, 5], items: [[6, 5, ")"]] });
    expect(brain.decide(m).intent).not.toBe("loot");
    // One slot fewer — dropped, read, stolen or destroyed — and the same
    // geometry is worth walking to again. Without this the ladder would never
    // loot again for the rest of the game.
    status(m, 20, 20, 1, 1, 25);
    paint(m, { hero: [5, 5], items: [[6, 5, ")"]] });
    expect(brain.decide(m).intent).toBe("loot");
  });
  it("capacity, not a threshold, decides whether to swing", () => {
    // engage() is the whole of vect-hack-b5f.3. Phase 1b compared a learned
    // threat to a constant, so a table of honest 1.0s read as "never fight"
    // and 74 of 100 runs never swung
    // (docs/reports/2026-08-21-larn-1b-ab.md). The comparison is
    // now against what the hero can absorb.
    const t = larnPolicy;
    // Nothing learned: fight, exactly as a bot with no knowledge always did.
    expect(engage(null, 20, 20, 1, t)).toBe(true);
    expect(engage(null, 1, 20, 1, t)).toBe(true);
    // A healthy hero fights ANY threat in 0..1. This is the property the
    // regression violated, and it is why capacity is not clamped to 1: with a
    // ceiling of exactly 1, `threat < capacity` is false at threat 1.0 and the
    // whole failure comes back under a new formula.
    expect(engage(1, 20, 20, 1, t)).toBe(true);
    expect(engage(1, 10, 10, 1, t)).toBe(true);
    // Hurt: the same claim now vetoes, and a mild one still does not.
    expect(engage(0.9, 8, 20, 1, t)).toBe(false);
    expect(engage(0.3, 8, 20, 1, t)).toBe(true);
    // Experience raises capacity: the level-9 hero takes the fight the
    // level-1 hero at the same HP declines.
    expect(engage(0.9, 10, 20, 1, t)).toBe(false);
    expect(engage(0.9, 10, 20, 9, t)).toBe(true);
    // Before the first status record there is no hero to judge. Fight, which
    // is what the bot did before it learned anything.
    expect(engage(0.9, 0, 0, 0, t)).toBe(true);
  });
  it("a declined monster produces a retreat, not a fall-through", () => {
    // 1b's sharpest number: 78 runs in EACH arm were attacked, and of those 53
    // never swung back under the KB against 8 in the control. The treatment
    // stood in fights and did something unrelated. Declining must now cost a
    // step away.
    const m = new LarnBotModel();
    paint(m, { hero: [5, 5], monsters: [[6, 5]], monster: { ch: "D", color: 1 }, unseenFrom: 40 });
    status(m, 4, 20, 11);
    const deadly = kbWith([learned({ kind: "threat", ch: "D", color: 1, depth: 11 }, ABOVE_FLOOR, 0.9)]);
    const a = new LarnBrain(deadly).decide(m);
    expect(a.intent).toBe("disengage");
    // Away from the monster at (6,5), never toward it.
    expect(["h", "y", "b"]).toContain(ch(a));
  });
  it("cornered means fight: a declined monster with nowhere to go is attacked", () => {
    // The wall defect (policy.ts passable(): a being is impassable). A monster
    // the ladder will not attack and cannot walk around is a permanent block
    // across a corridor, which is where 1b's depth loss came from. Being hit
    // for free is strictly worse than swinging.
    const m = new LarnBotModel();
    // A one-cell pocket: walls all round except the monster's cell.
    paint(m, { hero: [1, 1], monsters: [[2, 1]], monster: { ch: "D", color: 1 }, pocket: true });
    status(m, 4, 20, 11);
    const deadly = kbWith([learned({ kind: "threat", ch: "D", color: 1, depth: 11 }, ABOVE_FLOOR, 0.9)]);
    const a = new LarnBrain(deadly).decide(m);
    expect(a.intent).toBe("fight");
    expect(ch(a)).toBe("l"); // east, into the monster
  });
  it("retreat is bounded: after disengageLimit steps the ladder fights anyway", () => {
    // Larn's monsters move. An unbounded retreat is a livelock with extra
    // steps (vect-hack-b5f.5), so the counter is a safeguard, not a nicety.
    const deadly = kbWith([learned({ kind: "threat", ch: "D", color: 1, depth: 11 }, ABOVE_FLOOR, 0.9)]);
    const brain = new LarnBrain(deadly);
    const intents: string[] = [];
    for (let i = 0; i < larnPolicy.disengageLimit + 1; i++) {
      // The monster keeps pace: adjacent every turn, the hero never moves.
      const m = new LarnBotModel();
      paint(m, { hero: [5, 5], monsters: [[6, 5]], monster: { ch: "D", color: 1 }, unseenFrom: 40 });
      status(m, 4, 20, 11);
      intents.push(brain.decide(m).intent);
    }
    expect(intents.slice(0, larnPolicy.disengageLimit)).toEqual(
      Array(larnPolicy.disengageLimit).fill("disengage"));
    expect(intents[larnPolicy.disengageLimit]).toBe("fight");
  });
  it("fights the least dangerous engageable neighbour rather than declining to the group", () => {
    // Declining to a group is how a bot gets surrounded. Ordering must not
    // disturb the empty-KB identity, so the rank of an unknown threat is 0 and
    // ties keep DIRS order.
    const m = new LarnBotModel();
    // 'D' east (deadly), 'B' west (mild).
    paint(m, { hero: [5, 5], unseenFrom: 40, beings: [[6, 5, "D", 1], [4, 5, "B", 2]] });
    status(m, 4, 20, 11);
    const kbTwo = kbWith([
      learned({ kind: "threat", ch: "D", color: 1, depth: 11 }, ABOVE_FLOOR, 0.9),
      learned({ kind: "threat", ch: "B", color: 2, depth: 11 }, ABOVE_FLOOR, 0.1),
    ]);
    const a = new LarnBrain(kbTwo).decide(m);
    expect(a.intent).toBe("fight");
    expect(ch(a)).toBe("h"); // west, at the B
  });
  it("breaches a monster that seals the level rather than circling forever", () => {
    // vect-hack-b5f.5: seed 565999359 ran 24000 commands on depth 1 at full HP,
    // oscillating between two cells. passable() treats a being as impassable —
    // it must, walking into one is an attack — so three monsters in the only
    // corridors left 20 of 1139 cells reachable and neither explore nor
    // descend could cross. Here: a sealed pocket whose one exit is a monster.
    const m = new LarnBotModel();
    paint(m, { hero: [2, 2], pocket: true, floor: [[3, 2], [4, 2]], monsters: [[3, 2]] });
    status(m, 20, 20);
    // Nothing to explore (the pocket is fully seen) and no stairs anywhere, so
    // without a breach step the ladder reaches wander and circles.
    const a = new LarnBrain(kb()).decide(m);
    expect(a.intent).toBe("fight");
    expect(ch(a)).toBe("l"); // east, into the monster: already adjacent
  });
  it("routes to a sealing monster from across the pocket", () => {
    const m = new LarnBotModel();
    paint(m, {
      hero: [2, 2], pocket: true,
      floor: [[3, 2], [4, 2], [5, 2], [6, 2]], monsters: [[5, 2]],
    });
    status(m, 20, 20);
    const a = new LarnBrain(kb()).decide(m);
    expect(a.intent).toBe("breach");
    expect(ch(a)).toBe("l"); // east, toward the monster at (5,2)
  });
  it("does not breach toward a monster this hero would decline", () => {
    // The breach step and the disengage step must not form a loop: routing
    // back to a monster step 1 will decline is an oscillation that
    // disengageLimit cannot end, because that counter resets whenever the hero
    // steps out of reach — which is what a retreat does.
    const m = new LarnBotModel();
    paint(m, {
      hero: [2, 2], pocket: true,
      floor: [[3, 2], [4, 2], [5, 2], [6, 2]], beings: [[5, 2, "D", 1]],
    });
    status(m, 3, 20, 11);
    const deadly = kbWith([learned({ kind: "threat", ch: "D", color: 1, depth: 11 }, ABOVE_FLOOR, 0.9)]);
    expect(new LarnBrain(deadly).decide(m).intent).not.toBe("breach");
    // The same pocket with a hero in shape for the fight does breach.
    const well = new LarnBotModel();
    paint(well, {
      hero: [2, 2], pocket: true,
      floor: [[3, 2], [4, 2], [5, 2], [6, 2]], beings: [[5, 2, "D", 1]],
    });
    status(well, 20, 20, 11);
    expect(new LarnBrain(deadly).decide(well).intent).toBe("breach");
  });
  it("crosses a known trap when the trap is what seals the level", () => {
    // The other half of vect-hack-b5f.5, and a different mechanism from the
    // monster seal: passable() also refuses a known trap, so a trap in the only
    // corridor closes a level the same way. Held-out seed 238386701 reached the
    // 24000-command cap with 2 of 1139 cells reachable, bounded by 13 walls and
    // one trap.
    const m = new LarnBotModel();
    paint(m, { hero: [2, 2], pocket: true, floor: [[3, 2]], trap: [3, 2], down: [[4, 2, "%"]] });
    status(m, 20, 20);
    const a = new LarnBrain(kb()).decide(m);
    expect(a.intent).toBe("breach");
    expect(ch(a)).toBe("l"); // east, onto the trap and toward the stairs
  });
  it("prefers any open route over the trap that would also reach the stairs", () => {
    // The relaxation is a last resort, not a shortcut: with a clear way round,
    // the ordinary descend step must win and the trap must stay unstepped.
    const m = new LarnBotModel();
    paint(m, {
      hero: [2, 2], pocket: true, trap: [3, 2],
      floor: [[2, 3], [3, 3], [4, 3], [4, 2]], down: [[4, 2, "%"]],
    });
    status(m, 20, 20);
    const a = new LarnBrain(kb()).decide(m);
    expect(a.intent).toBe("descend");
    expect(["j", "n"]).toContain(ch(a)); // south, round the trap
  });
  it("an all-below-floor KB reproduces the empty-KB decisions", () => {
    // One mid-game model, three KBs: nothing, facts too weak to compile, and
    // the same facts believed. The first two must decide identically — that
    // is the inertness claim — and the third must not, or the comparison is
    // vacuous and would hold however the seams were wired.
    const m = new LarnBotModel();
    paint(m, {
      hero: [5, 5], unseenFrom: 40, items: [[8, 5, ")"]],
      down: [[10, 10, "V"]], monsters: [[30, 10]], monster: { ch: "D", color: 1 },
    });
    status(m, 20, 20, 11);
    const claims: Claim[] = [
      { kind: "threat", ch: "D", color: 1, depth: 11 },
      { kind: "avoid-terrain", category: "stairs", ch: "V" },
      { kind: "item-value", ch: ")" },
    ];
    const values = [0.9, null, 0.8];
    const at = (confidence: number) => kbWith(claims.map((c, i) => learned(c, confidence, values[i]!)));
    const empty = new LarnBrain(kb()).decide(m);
    expect(new LarnBrain(at(BELOW_FLOOR)).decide(m)).toEqual(empty);
    expect(new LarnBrain(at(ABOVE_FLOOR)).decide(m)).not.toEqual(empty);
  });
  it("explores toward the frontier when healthy", () => {
    const m = new LarnBotModel(); paint(m, { hero: [5, 5], unseenFrom: 40 }); status(m, 20, 20);
    const a = new LarnBrain(kb()).decide(m);
    expect(a.intent).toBe("explore");
    expect(["l", "u", "n"]).toContain(ch(a)); // eastward, toward x >= 40
  });
  it("heads for the down stairs once there is nothing left to explore", () => {
    const m = new LarnBotModel(); paint(m, { hero: [5, 5], down: [[20, 8, "%"]] }); status(m, 20, 20);
    const a = new LarnBrain(kb()).decide(m);
    expect(a.intent).toBe("descend");
    expect(["l", "u", "n"]).toContain(ch(a)); // (5,5) -> (20,8): E, NE and SE all start a 15-step path
  });
  it("steps off and back when it is already standing on the stairs it wants", () => {
    const m = new LarnBotModel(); paint(m, { hero: [20, 8], down: [[20, 8, "%"]] }); status(m, 20, 20);
    const a = new LarnBrain(kb()).decide(m);
    expect(a.intent).toBe("shuffle");
  });
  it("wanders when the level is explored and has no down stairs, and stands still when boxed in", () => {
    const m = new LarnBotModel(); paint(m, { hero: [5, 5] }); status(m, 20, 20);
    expect(new LarnBrain(kb()).decide(m).intent).toBe("wander");
    const boxed = new LarnBotModel();
    // A hero with walls on all eight sides: paint then overwrite the neighbours.
    paint(boxed, { hero: [5, 5] }); status(boxed, 20, 20);
    const neighbours: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    for (const [dx, dy] of neighbours)
      boxed.map.set(5 + dx, 5 + dy, { category: "wall", ch: "#", color: 7 });
    expect(new LarnBrain(kb()).decide(boxed)).toMatchObject({ intent: "wait", key: { code: 46 } });
  });
  it("blocks a step cell after three moves that did not move the hero", () => {
    const m = new LarnBotModel(); paint(m, { hero: [5, 5], unseenFrom: 40 }); status(m, 20, 20);
    const brain = new LarnBrain(kb());
    const first = brain.decide(m);
    brain.decide(m); brain.decide(m); brain.decide(m); // hero never moved: the aimed cell is now blocked
    const after = brain.decide(m);
    expect(after.intent).toBe("explore");
    expect(ch(after)).not.toBe(ch(first));
  });
  /** One route out of a sealed room, so exploring has exactly one first step:
   *  the hero at (5,5), the doorway cell (6,5) painted as `gate`, floor at
   *  (7,5) and everything from x=8 unseen. Nothing here ever moves the hero —
   *  these cases ask what the ladder does when the engine refuses the step. */
  const corridor = (gate: "door" | "door-open" | "floor") => {
    const m = new LarnBotModel();
    paint(m, {
      hero: [5, 5], pocket: true, floor: [[6, 5], [7, 5]], unseenFrom: 8,
      doors: gate === "floor" ? [] : [[6, 5, gate === "door-open"]],
    });
    status(m, 20, 20);
    return m;
  };
  it("does not blame a closed door for a step the engine refused, and still blames anything else", () => {
    // Larn's closed door opens on a die roll: external/larn/object.c
    // OCLOSEDDOOR fails on `rnd(11) < 7` — 6 times in 11 — prints nothing in
    // the ordinary case and shoves the hero back to lastpx/lastpy. On success
    // it writes item[x][y] = OOPENDOOR, so the MAP CELL is the only signal of
    // which happened. `blocked` is a claim that a cell is impassable terrain
    // and a die roll is not terrain, so a cell that still shows a closed door
    // is retried instead (vect-hack-b5f.11).
    const closed = new LarnBrain(kb());
    const door = corridor("door");
    const first = closed.decide(door);
    expect(first.intent).toBe("explore");
    for (let i = 0; i < 9; i++) {
      const again = closed.decide(door);
      expect(again.intent).toBe("explore");
      expect(ch(again)).toBe(ch(first));
    }
    // The same geometry with the doorway painted as plain floor: a step that
    // does not move the hero is terrain, it latches at stuckLimit exactly as
    // before, and the only route out of the room closes.
    const solid = new LarnBrain(kb());
    const plain = corridor("floor");
    expect(solid.decide(plain).intent).toBe("explore");
    solid.decide(plain); solid.decide(plain);
    expect(solid.decide(plain).intent).toBe("wait");
  });
  it("latches on an open door, because an open door has no roll left to fail", () => {
    // The exemption is the CLOSED state, not the word "door". Larn only rolls
    // in the OCLOSEDDOOR case; a hero that cannot enter an OOPENDOOR cell is
    // being stopped by something the ladder should route around.
    const brain = new LarnBrain(kb());
    const m = corridor("door-open");
    expect(brain.decide(m).intent).toBe("explore");
    brain.decide(m); brain.decide(m);
    expect(brain.decide(m).intent).toBe("wait");
  });
  it("a closed door does not reset the stuck counter: three other failures still latch", () => {
    // The exemption is that a closed door counts for NOTHING. Neither half is
    // free: latching would seal a door on a die roll (the case above), and
    // resetting would forgive every OTHER cell's evidence, because `stuck` is
    // one counter for the whole brain and not one per cell. The two cases
    // above cannot tell those apart — they never mix the two refusals.
    //
    // One room, one monster, and nothing that ever moves the hero. Two ways
    // out of (5,5): east through the closed door at (6,5) into a corridor and
    // a small room, and south through plain floor at (5,6) the long way round
    // to the same frontier. The monster steps between the corridor cell (7,5),
    // which seals the door route so the only frontier left is the southern
    // one, and the room cell (8,4), which opens the shorter route back up. So
    // the aimed cell alternates floor, door, floor, door, floor — three
    // refusals that are terrain and two that are a die roll.
    const m = new LarnBotModel();
    const frame = (monster: [number, number]) => {
      paint(m, {
        hero: [5, 5], pocket: true, unseenFrom: 10, doors: [[6, 5]], monsters: [monster],
        floor: [[7, 5], [8, 4], [8, 5], [8, 6], [9, 4], [9, 5], [9, 6],
          [5, 6], [5, 7], [6, 7], [7, 7], [8, 7], [9, 7]],
      });
      status(m, 20, 20);
    };
    const brain = new LarnBrain(kb());
    // stuckLimit is 3, so the third floor refusal is the one that latches —
    // and the two door refusals in between must not have moved the counter in
    // either direction for it to arrive there.
    for (const [monster, key] of [
      [[7, 5], "j"], [[8, 4], "l"], [[7, 5], "j"],
      [[8, 4], "l"], [[7, 5], "j"], [[8, 4], "l"],
    ] as [[number, number], string][]) {
      frame(monster);
      const a = brain.decide(m);
      expect(a.intent).toBe("explore");
      expect(ch(a)).toBe(key);
    }
    // (5,6) is blocked now — the southern gate, which is where all three
    // terrain refusals were aimed. With the monster back on (7,5) the door
    // leads nowhere and the south route is gone, so there is no frontier left
    // to walk to and the ladder falls through to the breach step: east, to the
    // doorway beside the monster. A brain that let the door reset the counter
    // would still be walking south here.
    frame([7, 5]);
    const after = brain.decide(m);
    expect(after.intent).toBe("breach");
    expect(ch(after)).toBe("l");
  });
  it("forgets the block list on a level change, where the hero keeps its coordinates", () => {
    const m = new LarnBotModel(); paint(m, { hero: [5, 5], unseenFrom: 40 }); status(m, 20, 20);
    const brain = new LarnBrain(kb());
    const first = brain.decide(m);
    brain.decide(m); brain.decide(m); brain.decide(m); // a cell is blocked now
    expect(ch(brain.decide(m))).not.toBe(ch(first));
    // Descend: positionplayer keeps (5,5), so the engine's own level event is
    // the only signal that the block list is stale. It clears the map, so
    // repaint the same geometry after it.
    m.observe({ name: "level", width: LARN_COLS, height: LARN_ROWS });
    paint(m, { hero: [5, 5], unseenFrom: 40 });
    expect(ch(brain.decide(m))).toBe(ch(first));
  });
});

describe("loadKb narrows the fact document it validates", () => {
  const doc = (facts: unknown[]) => ({ facts });

  // The defect this pins: TypeScript reads a JSON import's claim.kind as
  // `string`, so the repo typechecked only while data/kb was empty and every
  // non-empty KB broke three import sites at once. The narrowing lives at the
  // read boundary, so the cast sits next to the checks that earn it.
  it("rejects a fact whose claim kind compiles into nothing", () => {
    const bogus = {
      id: "larn/avoid-terain/stairs:V", // the typo is in the KIND below
      claim: { kind: "avoid-terain", category: "stairs", ch: "V" },
      text: "", value: 10, confidence: 0.9,
      support: [{ trajectory: "r1", from: 0, to: 5 }], refute: [], retired: null,
      updated: "2026-08-24T00:00:00Z", seed: false,
    };
    expect(() => loadKb({ meta: doc([]), engine: doc([bogus]), policy: larnPolicy }))
      .toThrow(/claim kind "avoid-terain"/);
  });

  it("accepts every kind the compiler reads", () => {
    const facts = [
      learned({ kind: "threat", ch: "D", color: 1, depth: 11 }, 0.9, 1),
      learned({ kind: "avoid-terrain", category: "stairs", ch: "V" }, 0.9, 10),
      learned({ kind: "item-value", ch: ")" }, 0.9, 0.8),
      learned({ kind: "note", topic: "descent-pacing" }, 0.9),
    ];
    const kb = loadKb({ meta: doc([]), engine: doc(facts), policy: larnPolicy });
    expect(kb.threat("D", 1, 11)).toBe(1);
    expect(kb.avoidTerrain("stairs:V", 10)).toBe(true);
    expect(kb.avoidTerrain("stairs:V", 11)).toBe(false);
  });
});

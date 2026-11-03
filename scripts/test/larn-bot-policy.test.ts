import { describe, expect, it } from "vitest";
import { LarnBotModel } from "../../src/modules/larn/bot/model";
import { DEFAULT_TUNING, LarnBrain, passable, readyToDescend, resolveTuning } from "../../src/modules/larn/bot/policy";
import { GRID, GRID_STRIDE, KIND_NAMES, TERRAIN, TOP } from "../../src/modules/larn/mapRecords";
import { LARN_COLS, LARN_ROWS } from "../../src/modules/larn/classifier";
import { ITEM_CLASS, SLOT, SLOT_STRIDE, STATUS, STATUS_HEADER } from "../../src/modules/larn/statusRecords";
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
  /** Down stairs, each with the glyph Larn draws it as — the only thing that
   *  tells the volcanic shaft "V" from an ordinary staircase. */
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

describe("passable", () => {
  it("walks floor, doors, stairs, features and items; not walls, traps, monsters or the unseen", () => {
    const m = new LarnBotModel();
    paint(m, { hero: [5, 5], monsters: [[7, 7]], unseenFrom: 40, down: [[10, 10, "%"]], trap: [3, 3] });
    expect(passable(m, 6, 5)).toBe(true);
    expect(passable(m, 10, 10)).toBe(true);
    expect(passable(m, 0, 0)).toBe(false);
    expect(passable(m, 3, 3)).toBe(false);
    expect(passable(m, 7, 7)).toBe(false);
    expect(passable(m, 50, 5)).toBe(false);
    expect(passable(m, -1, 5)).toBe(false);
  });

  it("walks past an unready shaft to the ordinary stairs, and takes it once ready", () => {
    // Larn draws the volcanic shaft "V" and an ordinary down staircase "%",
    // and the native tap gives both the "down" kind (main-wasm.c:449-454), so
    // the glyph is the only thing readiness can tell them apart by.
    const m = new LarnBotModel();
    paint(m, { hero: [2, 1], down: [[4, 1, "V"], [2, 3, "%"]] });
    status(m, 20, 20);
    // The shaft is the NEARER staircase, and the ladder walks past it anyway:
    // this hero is level 1 and the readiness bar is 8 (vect-hack-h9x.5), so
    // the descent step does not target it and the "%" stairs to the southeast
    // win. Before that bar the seed bot walked east to the shaft and the
    // corpus lost half its games to it.
    expect(new LarnBrain().decide(m)).toMatchObject({ intent: "descend", key: { code: "n".charCodeAt(0) } });
    // A hero at or above the bar takes the nearer exit again — the bar is
    // readiness, not a ban, and the volcano is where the winning potion is.
    status(m, 20, 20, 1, 8);
    expect(new LarnBrain().decide(m)).toMatchObject({ intent: "descend", key: { code: "l".charCodeAt(0) } });
  });

  it("crosses an unready shaft when it is the only way out, so no readiness bar can seal a level", () => {
    // vect-hack-h9x.5. A readiness bar is a preference the ladder takes
    // another way around while there is one; it must never be the reason a
    // hero stands still until the command cap. Step 5b asks downExit() and not
    // readyToDescend().
    //
    // A pocket whose one exit is the shaft, with nothing unseen behind it — so
    // there is no frontier to explore and descent is the only thing left.
    const m = new LarnBotModel();
    paint(m, { hero: [5, 5], pocket: true, down: [[6, 5, "V"]] });
    status(m, 20, 20, 1, 1); // level 1: far below the bar of 8

    // It is not a route (the descent step passed it over)...
    expect(readyToDescend(m, true, DEFAULT_TUNING)).toBe(false);
    // ...and it is crossed anyway, because the alternative is a sealed level.
    expect(new LarnBrain().decide(m)).toMatchObject({ intent: "breach", key: { code: "l".charCodeAt(0) } });
  });
});

describe("LarnBrain", () => {
  it("attacks an adjacent monster by walking into it", () => {
    const m = new LarnBotModel(); paint(m, { hero: [5, 5], monsters: [[6, 6]] }); status(m, 20, 20);
    const a = new LarnBrain().decide(m);
    expect(a.intent).toBe("fight");
    expect(ch(a)).toBe("n"); // SE
  });
  it("rests when below half HP with nothing in view, but not while a monster is visible", () => {
    const m = new LarnBotModel(); paint(m, { hero: [5, 5] }); status(m, 5, 20);
    expect(new LarnBrain().decide(m)).toMatchObject({ intent: "rest", key: { code: 46 } }); // '.'
    const m2 = new LarnBotModel(); paint(m2, { hero: [5, 5], monsters: [[30, 10]], unseenFrom: 40 }); status(m2, 5, 20);
    expect(new LarnBrain().decide(m2).intent).not.toBe("rest");
  });
  it("rests strictly below half HP — the tuned fraction is the old doubling, for every integer pair", () => {
    // The rewrite was `hp * 2 < hpmax` -> `hp < hpmax * restBelowHpFraction`.
    // Doubling and halving only move a binary exponent, so both sides are
    // computed exactly and the predicates agree on every integer pair rather
    // than merely on the ones a run happens to hit. HP arrives as an Int32
    // status field, so sweeping the small pairs and probing the top of that
    // range covers the whole shape of the input, the hp * 2 === hpmax
    // boundary included.
    const f = DEFAULT_TUNING.restBelowHpFraction;
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
    expect(new LarnBrain().decide(half).intent).not.toBe("rest");
    const under = new LarnBotModel(); paint(under, { hero: [5, 5] }); status(under, 9, 20);
    expect(new LarnBrain().decide(under).intent).toBe("rest");
  });
  it("fights the first adjacent being in DIRS order, hurt or not", () => {
    // DIRS runs N, NE, E, SE, S, SW, W, NW, so with a being east and another
    // west the east one is attacked — at 4 of 20 HP as at full health, because
    // declining a fight Larn's monsters will follow only buys them free hits.
    const m = new LarnBotModel();
    paint(m, { hero: [5, 5], unseenFrom: 40, beings: [[6, 5, "D", 1], [4, 5, "B", 2]] });
    status(m, 4, 20, 11);
    const a = new LarnBrain().decide(m);
    expect(a.intent).toBe("fight");
    expect(ch(a)).toBe("l"); // east, at the D
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
    const a = new LarnBrain().decide(m);
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
    const a = new LarnBrain().decide(m);
    expect(a.intent).toBe("breach");
    expect(ch(a)).toBe("l"); // east, toward the monster at (5,2)
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
    const a = new LarnBrain().decide(m);
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
    const a = new LarnBrain().decide(m);
    expect(a.intent).toBe("descend");
    expect(["j", "n"]).toContain(ch(a)); // south, round the trap
  });
  it("explores toward the frontier when healthy", () => {
    const m = new LarnBotModel(); paint(m, { hero: [5, 5], unseenFrom: 40 }); status(m, 20, 20);
    const a = new LarnBrain().decide(m);
    expect(a.intent).toBe("explore");
    expect(["l", "u", "n"]).toContain(ch(a)); // eastward, toward x >= 40
  });
  it("heads for the down stairs once there is nothing left to explore", () => {
    const m = new LarnBotModel(); paint(m, { hero: [5, 5], down: [[20, 8, "%"]] }); status(m, 20, 20);
    const a = new LarnBrain().decide(m);
    expect(a.intent).toBe("descend");
    expect(["l", "u", "n"]).toContain(ch(a)); // (5,5) -> (20,8): E, NE and SE all start a 15-step path
  });
  it("never routes to an item: pickup is whatever exploring walks over", () => {
    // lookforobject() runs on every move (main.c:291) and the prompt table
    // answers "t", so items are collected on the way and nothing walks to one.
    // A fully seen room with no stairs and an item in it is a done level.
    const m = new LarnBotModel(); paint(m, { hero: [5, 5], items: [[8, 5, ")"]] }); status(m, 20, 20);
    expect(new LarnBrain().decide(m).intent).toBe("wander");
  });
  it("steps off and back when it is already standing on the stairs it wants", () => {
    const m = new LarnBotModel(); paint(m, { hero: [20, 8], down: [[20, 8, "%"]] }); status(m, 20, 20);
    const a = new LarnBrain().decide(m);
    expect(a.intent).toBe("shuffle");
  });
  it("wanders when the level is explored and has no down stairs, and stands still when boxed in", () => {
    const m = new LarnBotModel(); paint(m, { hero: [5, 5] }); status(m, 20, 20);
    expect(new LarnBrain().decide(m).intent).toBe("wander");
    const boxed = new LarnBotModel();
    // A hero with walls on all eight sides: paint then overwrite the neighbours.
    paint(boxed, { hero: [5, 5] }); status(boxed, 20, 20);
    const neighbours: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    for (const [dx, dy] of neighbours)
      boxed.map.set(5 + dx, 5 + dy, { category: "wall", ch: "#", color: 7 });
    expect(new LarnBrain().decide(boxed)).toMatchObject({ intent: "wait", key: { code: 46 } });
  });
  it("blocks a step cell after three moves that did not move the hero", () => {
    const m = new LarnBotModel(); paint(m, { hero: [5, 5], unseenFrom: 40 }); status(m, 20, 20);
    const brain = new LarnBrain();
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
    const closed = new LarnBrain();
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
    const solid = new LarnBrain();
    const plain = corridor("floor");
    expect(solid.decide(plain).intent).toBe("explore");
    solid.decide(plain); solid.decide(plain);
    expect(solid.decide(plain).intent).toBe("wait");
  });
  it("latches on an open door, because an open door has no roll left to fail", () => {
    // The exemption is the CLOSED state, not the word "door". Larn only rolls
    // in the OCLOSEDDOOR case; a hero that cannot enter an OOPENDOOR cell is
    // being stopped by something the ladder should route around.
    const brain = new LarnBrain();
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
    const brain = new LarnBrain();
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
    const brain = new LarnBrain();
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

describe("tuning", () => {
  it("merges an override over the defaults, and the brain plays it", () => {
    expect(resolveTuning({})).toEqual(DEFAULT_TUNING);
    expect(resolveTuning({ restLimit: 300, castAtRange: true })).toEqual(
      { ...DEFAULT_TUNING, restLimit: 300, castAtRange: true });
    // The same weak hero rests under the defaults and not with the bar at 0.
    const m = new LarnBotModel(); paint(m, { hero: [5, 5] }); status(m, 5, 20);
    expect(new LarnBrain().decide(m).intent).toBe("rest");
    expect(new LarnBrain({ restBelowHpFraction: 0 }).decide(m).intent).not.toBe("rest");
  });

  it("refuses a knob it does not have, a value of the wrong type, and anything not an object", () => {
    // A misspelt knob must not play the defaults under the arm's name.
    expect(() => resolveTuning({ restLimt: 300 })).toThrow(/unknown tuning knob "restLimt"/);
    expect(() => resolveTuning({ factFloor: 0.6 })).toThrow(/unknown tuning knob "factFloor"/);
    expect(() => resolveTuning({ castAtRange: "yes" })).toThrow(/"castAtRange" must be a boolean/);
    expect(() => resolveTuning({ restLimit: "300" })).toThrow(/"restLimit" must be a number/);
    expect(() => resolveTuning([])).toThrow(/must be a JSON object/);
    expect(() => resolveTuning(null)).toThrow(/must be a JSON object/);
    // Inherited properties are not knobs.
    expect(() => resolveTuning({ toString: 1 })).toThrow(/unknown tuning knob "toString"/);
  });
});

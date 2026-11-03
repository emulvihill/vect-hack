// Casting magic missile at range (vect-hack-h9x.4).
//
// The hero has known this spell since character creation (create.c:42) and had
// never cast it in any run ever played. Three things here are worth a test and
// the rest is arithmetic:
//
//   1. WHAT IT SHOOTS AT. godirect() travels a straight line from the caster
//      (monster.c:37), so only a being on one of the eight rays with clear
//      going in between is reachable. Getting this wrong wastes the run's only
//      charge on a wall.
//   2. THE THREE SPELL-CODE BYTES. cast() reads them back to back with nothing
//      printed between (monster.c:251-260), so the text-matching prompt table
//      cannot answer the second and third. They ride on the action, and the
//      queue is cleared at every command boundary.
//   3. THE DIRECTION PROMPT HAS NO ESCAPE. dirsub() loops over the eight vi
//      keys with no default and no ESC case (monster.c:1006-1041), so an
//      unanswerable direction hangs the engine, not the bot.
import { describe, expect, it } from "vitest";
import { LarnBotModel } from "../../src/modules/larn/bot/model";
import { DEFAULT_TUNING, LarnBrain, rayTarget } from "../../src/modules/larn/bot/policy";
import { LarnBotPlayer } from "../../src/modules/larn/bot/LarnBotPlayer";
import { GRID, GRID_STRIDE, TERRAIN, TOP } from "../../src/modules/larn/mapRecords";
import { LARN_COLS, LARN_ROWS } from "../../src/modules/larn/classifier";
import { STATUS, STATUS_HEADER } from "../../src/modules/larn/statusRecords";
/** The shipped tuning with casting ENABLED. It ships off until measured, so a
 *  suite about the mechanism turns it on itself (the b5f.25 lesson). */
const casting = { castAtRange: true };

const HERO: [number, number] = [10, 8];

/** A walled room with the hero at (10,8), beings where asked, and optional
 *  walls to break a line of sight. */
function room(m: LarnBotModel, beings: [number, number][] = [], walls: [number, number][] = []) {
  const r = new Int32Array(LARN_COLS * LARN_ROWS * GRID_STRIDE);
  let i = 0;
  for (let y = 0; y < LARN_ROWS; y++) for (let x = 0; x < LARN_COLS; x++) {
    r[i + GRID.X] = x; r[i + GRID.Y] = y;
    const edge = x === 0 || y === 0 || x === LARN_COLS - 1 || y === LARN_ROWS - 1;
    const wall = edge || walls.some(([wx, wy]) => wx === x && wy === y);
    r[i + GRID.TERRAIN_CAT] = wall ? TERRAIN.WALL : TERRAIN.FLOOR;
    r[i + GRID.TERRAIN_CHAR] = 46; r[i + GRID.TERRAIN_COLOR] = 7;
    if (x === HERO[0] && y === HERO[1]) r[i + GRID.TOP_CAT] = TOP.HERO;
    for (const [bx, by] of beings) if (bx === x && by === y) {
      r[i + GRID.TOP_CAT] = TOP.MONSTER; r[i + GRID.TOP_CHAR] = "A".charCodeAt(0); r[i + GRID.TOP_COLOR] = 2;
    }
    i += GRID_STRIDE;
  }
  m.observe({ name: "map", records: r });
}

/** The same room with one door on the ray. Larn draws a closed door "D" and an
 *  open one "O" (data.c objnamelist, header.h 19/20). */
function roomWithDoor(m: LarnBotModel, beings: [number, number][], door: [number, number], open: boolean) {
  const r = new Int32Array(LARN_COLS * LARN_ROWS * GRID_STRIDE);
  let i = 0;
  for (let y = 0; y < LARN_ROWS; y++) for (let x = 0; x < LARN_COLS; x++) {
    r[i + GRID.X] = x; r[i + GRID.Y] = y;
    const edge = x === 0 || y === 0 || x === LARN_COLS - 1 || y === LARN_ROWS - 1;
    r[i + GRID.TERRAIN_CAT] = edge ? TERRAIN.WALL : TERRAIN.FLOOR;
    r[i + GRID.TERRAIN_CHAR] = 46; r[i + GRID.TERRAIN_COLOR] = 7;
    if (x === door[0] && y === door[1]) {
      r[i + GRID.TERRAIN_CAT] = open ? TERRAIN.DOOR_OPEN : TERRAIN.DOOR;
      r[i + GRID.TERRAIN_CHAR] = (open ? "O" : "D").charCodeAt(0);
    }
    if (x === HERO[0] && y === HERO[1]) r[i + GRID.TOP_CAT] = TOP.HERO;
    for (const [bx, by] of beings) if (bx === x && by === y) {
      r[i + GRID.TOP_CAT] = TOP.MONSTER; r[i + GRID.TOP_CHAR] = "A".charCodeAt(0); r[i + GRID.TOP_COLOR] = 2;
    }
    i += GRID_STRIDE;
  }
  m.observe({ name: "map", records: r });
}

/** `spells` is c[SPELLS] — the engine's own charge count, republished on every
 *  bottomline(). Nothing in the bot models regeneration. */
function status(m: LarnBotModel, spells: number, hp = 20) {
  const record = new Int32Array(STATUS_HEADER);
  record[STATUS.HP] = hp; record[STATUS.HPMAX] = 20; record[STATUS.DEPTH] = 1;
  record[STATUS.XLEVEL] = 1; record[STATUS.SPELLS] = spells; record[STATUS.SPELLMAX] = 1;
  m.observe({ name: "status", record, names: new Uint8Array(0) });
}

const chars = (keys: { code: number }[]) => keys.map((k) => String.fromCharCode(k.code)).join("");

describe("rayTarget", () => {
  it("finds a being on a ray with clear going, and ignores one off it", () => {
    const m = new LarnBotModel();
    // Due east, four cells away.
    room(m, [[14, 8]]);
    expect(rayTarget(m)?.compass).toBe(2); // east
    // One cell off the ray is not on any ray at all.
    room(m, [[14, 9]]);
    expect(rayTarget(m)).toBeNull();
    // Due south-east IS a ray: Larn's missiles fly diagonally.
    room(m, [[14, 12]]);
    expect(rayTarget(m)?.compass).toBe(3);
  });

  it("will not shoot through a wall", () => {
    const m = new LarnBotModel();
    room(m, [[14, 8]], [[12, 8]]);
    expect(rayTarget(m)).toBeNull();
  });

  it("will not shoot through a CLOSED door, which walkable() allows", () => {
    // The one case the first 30 games of real casting caught: a closed door is
    // walkable, because the ladder opens it, but it is not transparent and
    // godirect() stops the missile there. "Your missiles hit the door" was two
    // of the first five hits recorded.
    const m = new LarnBotModel();
    roomWithDoor(m, [[14, 8]], [12, 8], false);
    expect(rayTarget(m)).toBeNull();
    // An OPEN door is clear going and the shot is on.
    roomWithDoor(m, [[14, 8]], [12, 8], true);
    expect(rayTarget(m)?.compass).toBe(2);
  });

  it("takes the nearest of several", () => {
    const m = new LarnBotModel();
    room(m, [[14, 8], [10, 5]]); // east 4, north 3
    expect(rayTarget(m)?.compass).toBe(0); // north
  });

  it("ignores an adjacent being, which is the fight step's", () => {
    // Spending the run's one charge on something already in melee buys a turn
    // of being hit for damage the dagger was going to do anyway.
    const m = new LarnBotModel();
    room(m, [[11, 8]]);
    expect(rayTarget(m)).toBeNull();
    // ...but a second one further down the same ray is still a target.
    room(m, [[13, 8]]);
    expect(rayTarget(m)?.compass).toBe(2);
  });
});

describe("the cast step", () => {
  it("opens with a missile and hands over the three spell-code bytes", () => {
    const m = new LarnBotModel();
    room(m, [[14, 8]]);
    status(m, 1);
    const action = new LarnBrain(casting).decide(m);
    expect(action.intent).toBe("cast");
    expect(String.fromCharCode(action.key.code)).toBe("c");
    // spelcode[1] is "mle" (data.c:421). The bytes ride on the action because
    // cast() prints nothing between the three reads.
    expect(chars(action.follow ?? [])).toBe("mle");
  });

  it("will not cast with no charge, because cast() reads nothing in that state", () => {
    // monster.c:245-248 prints "You don't have any spells!" and returns WITHOUT
    // consuming the three code bytes. A queued "mle" would then answer whatever
    // asked next, and nothing downstream would say why.
    const m = new LarnBotModel();
    room(m, [[14, 8]]);
    status(m, 0);
    expect(new LarnBrain(casting).decide(m).intent).not.toBe("cast");
  });

  it("is off in the shipped policy", () => {
    expect(DEFAULT_TUNING.castAtRange).toBe(false);
    const m = new LarnBotModel();
    room(m, [[14, 8]]);
    status(m, 1);
    expect(new LarnBrain().decide(m).intent).not.toBe("cast");
  });

  it("answers the direction prompt with the direction it aimed", () => {
    const m = new LarnBotModel();
    room(m, [[10, 5]]); // due north
    status(m, 1);
    const brain = new LarnBrain(casting);
    expect(brain.decide(m).intent).toBe("cast");
    // movementKey(0) is "k" — north in Larn's vi keys, which is exactly the
    // vocabulary dirsub() accepts.
    expect(String.fromCharCode(brain.promptContext(m).castDirection.code)).toBe("k");
  });

  it("always offers SOME direction, because dirsub has no escape", () => {
    // monster.c:1006-1041 loops `for (i = 0;;) switch (ttgetch())` over the
    // eight vi keys with no default and no ESC case. A context that could
    // answer "nothing" would hang the engine while the driver kept feeding it.
    const m = new LarnBotModel();
    room(m); // nothing to shoot; nothing was ever aimed
    status(m, 1);
    const ctx = new LarnBrain(casting).promptContext(m);
    expect("hjklyubn").toContain(String.fromCharCode(ctx.castDirection.code));
  });
});

describe("the follow-key queue", () => {
  const stubView = () => ({ onNotice: () => {}, handle: () => {}, nextKey: async () => null });

  it("drains the spell code into the nested reads, then falls back to the table", async () => {
    const bot = new LarnBotPlayer(stubView(), 0, casting);
    bot.handle({ name: "map", records: mapWith([[14, 8]]) });
    bot.handle({ name: "status", record: statusRecord(1), names: new Uint8Array(0) });

    // The command boundary casts.
    expect(String.fromCharCode((await bot.nextKey(true, true))!.code)).toBe("c");
    // The three nested reads get the code, in order, with no text between them
    // for a prompt rule to have matched.
    expect(String.fromCharCode((await bot.nextKey(true, false))!.code)).toBe("m");
    expect(String.fromCharCode((await bot.nextKey(true, false))!.code)).toBe("l");
    expect(String.fromCharCode((await bot.nextKey(true, false))!.code)).toBe("e");
    // The queue is spent: the next nested read goes to the prompt table, which
    // has no text and cancels.
    bot.handle({ name: "text", x: 0, y: 20, rgb: 0, text: "Do you (o) try to open it, or (i) ignore it? " });
    expect(String.fromCharCode((await bot.nextKey(true, false))!.code)).toBe("o");
  });

  it("clears the queue at a command boundary, so a stale byte cannot answer a prompt", async () => {
    // The safety property. If a cast ever queued bytes the engine did not read
    // — the no-charge path is the one that could — the next COMMAND drops them
    // rather than letting "m" answer someone else's question.
    const bot = new LarnBotPlayer(stubView(), 0, casting);
    bot.handle({ name: "map", records: mapWith([[14, 8]]) });
    bot.handle({ name: "status", record: statusRecord(1), names: new Uint8Array(0) });
    expect(String.fromCharCode((await bot.nextKey(true, true))!.code)).toBe("c");
    expect(String.fromCharCode((await bot.nextKey(true, false))!.code)).toBe("m");

    // The charge is spent — cast() decrements c[SPELLS] before it reads
    // (monster.c:250) — so the next command boundary will not cast again, and
    // what is being observed is the clear rather than a refill.
    bot.handle({ name: "status", record: statusRecord(0), names: new Uint8Array(0) });
    // A command boundary arrives with "le" still owed.
    await bot.nextKey(true, true);
    bot.handle({ name: "text", x: 0, y: 20, rgb: 0, text: "Do you (o) try to open it, or (i) ignore it? " });
    const answer = await bot.nextKey(true, false);
    expect(String.fromCharCode(answer!.code)).toBe("o");
  });
});

/** Map records for a room with the hero at HERO and beings where asked. */
function mapWith(beings: [number, number][]): Int32Array {
  const m = new LarnBotModel();
  room(m, beings);
  const r = new Int32Array(LARN_COLS * LARN_ROWS * GRID_STRIDE);
  let i = 0;
  for (let y = 0; y < LARN_ROWS; y++) for (let x = 0; x < LARN_COLS; x++) {
    r[i + GRID.X] = x; r[i + GRID.Y] = y;
    const edge = x === 0 || y === 0 || x === LARN_COLS - 1 || y === LARN_ROWS - 1;
    r[i + GRID.TERRAIN_CAT] = edge ? TERRAIN.WALL : TERRAIN.FLOOR;
    r[i + GRID.TERRAIN_CHAR] = 46; r[i + GRID.TERRAIN_COLOR] = 7;
    if (x === HERO[0] && y === HERO[1]) r[i + GRID.TOP_CAT] = TOP.HERO;
    for (const [bx, by] of beings) if (bx === x && by === y) {
      r[i + GRID.TOP_CAT] = TOP.MONSTER; r[i + GRID.TOP_CHAR] = "A".charCodeAt(0); r[i + GRID.TOP_COLOR] = 2;
    }
    i += GRID_STRIDE;
  }
  return r;
}

function statusRecord(spells: number): Int32Array {
  const record = new Int32Array(STATUS_HEADER);
  record[STATUS.HP] = 20; record[STATUS.HPMAX] = 20; record[STATUS.DEPTH] = 1;
  record[STATUS.XLEVEL] = 1; record[STATUS.SPELLS] = spells; record[STATUS.SPELLMAX] = 1;
  return record;
}

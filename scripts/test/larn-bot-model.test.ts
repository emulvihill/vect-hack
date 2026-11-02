import { describe, expect, it } from "vitest";
import { LarnBotModel, causeOfDeath, levelDepth, scoreOf } from "../../src/modules/larn/bot/model";
import { SLOT, SLOT_STRIDE, STATUS, STATUS_HEADER } from "../../src/modules/larn/statusRecords";
import { GRID, GRID_STRIDE, TERRAIN, TOP } from "../../src/modules/larn/mapRecords";
import { LARN_COLS, LARN_ROWS } from "../../src/modules/larn/classifier";

/** A full 67x17 batch: floor everywhere, walls on the border, the hero at
 *  `hero`, an optional monster, unseen at x >= seenTo. */
function batch(opts: { hero: [number, number]; monster?: [number, number]; seenTo?: number }) {
  const r = new Int32Array(LARN_COLS * LARN_ROWS * GRID_STRIDE);
  let i = 0;
  for (let y = 0; y < LARN_ROWS; y++) for (let x = 0; x < LARN_COLS; x++) {
    r[i + GRID.X] = x; r[i + GRID.Y] = y;
    const edge = x === 0 || y === 0 || x === LARN_COLS - 1 || y === LARN_ROWS - 1;
    const unseen = x >= (opts.seenTo ?? LARN_COLS);
    r[i + GRID.TERRAIN_CAT] = unseen ? TERRAIN.UNSEEN : edge ? TERRAIN.WALL : TERRAIN.FLOOR;
    r[i + GRID.TERRAIN_CHAR] = unseen ? 32 : edge ? 35 : 46;
    r[i + GRID.TERRAIN_COLOR] = 7;
    if (x === opts.hero[0] && y === opts.hero[1]) r[i + GRID.TOP_CAT] = TOP.HERO;
    if (opts.monster && x === opts.monster[0] && y === opts.monster[1]) {
      r[i + GRID.TOP_CAT] = TOP.MONSTER; r[i + GRID.TOP_CHAR] = 66; r[i + GRID.TOP_COLOR] = 2;
    }
    i += GRID_STRIDE;
  }
  return r;
}

/** One status push, the fields a test names and zeros elsewhere. */
function status(m: LarnBotModel, fields: Partial<Record<keyof typeof STATUS, number>>) {
  const record = new Int32Array(STATUS_HEADER);
  for (const [k, v] of Object.entries(fields)) record[STATUS[k as keyof typeof STATUS]] = v!;
  m.observe({ name: "status", record, names: new Uint8Array(0) });
}

describe("levelDepth", () => {
  it("maps Larn's level names to a depth", () => {
    expect(levelDepth("H")).toBe(0);
    expect(levelDepth("1")).toBe(1);
    expect(levelDepth("10")).toBe(10);
    expect(levelDepth("V2")).toBe(12);
    expect(levelDepth("?")).toBe(-1);
  });
});

describe("causeOfDeath", () => {
  it("reads diedsub()'s score line", () => {
    expect(causeOfDeath("Score: 0, Diff: 0,  player killed by a gnome on  1")).toBe("killed by a gnome");
    expect(causeOfDeath("Score: 12, Diff: 2,  player fell into a bottomless pit on 10")).toBe("fell into a bottomless pit");
    expect(causeOfDeath("Score: 9000, Diff: 0,  player a winner")).toBe("a winner");
    expect(causeOfDeath("Welcome to the game of Larn")).toBe("");
  });
});

describe("LarnBotModel", () => {
  it("classifies map batches into the semantic grid and tracks the hero; level clears it", () => {
    const m = new LarnBotModel();
    m.observe({ name: "map", records: batch({ hero: [5, 5], monster: [6, 5], seenTo: 40 }) });
    expect(m.map.hero).toEqual({ x: 5, y: 5 });
    expect(m.map.at(6, 5).category).toBe("being");
    expect(m.map.at(1, 1).category).toBe("floor");
    expect(m.map.at(0, 0).category).toBe("wall");
    expect(m.map.at(50, 5).category).toBe("unseen");
    m.observe({ name: "level", width: 67, height: 17 });
    expect(m.map.hero).toBeNull();
    expect(m.map.at(1, 1).category).toBe("unseen");
  });

  it("collects text since the last key for the prompt table, and resets it per key", () => {
    const m = new LarnBotModel();
    m.observe({ name: "text", x: 0, y: 20, rgb: 0, text: "Do you (c) climb down" });
    m.observe({ name: "text", x: 21, y: 20, rgb: 0, text: ", or (i) ignore it? " });
    expect(m.textSinceLastKey).toBe("Do you (c) climb down, or (i) ignore it? ");
    m.keyAnswered(false);
    expect(m.textSinceLastKey).toBe("");
    expect(m.commands).toBe(0);
    m.keyAnswered(true);
    expect(m.commands).toBe(1);
  });

  it("reads messages from rows 19-23, the overlay flag, and game over with cause and win", () => {
    const m = new LarnBotModel();
    m.observe({ name: "text", x: 0, y: 19, rgb: 0, text: "You have found some gold!" });
    m.observe({ name: "text", x: 0, y: 21, rgb: 0, text: "  a gnome hits you  " });
    expect(m.messages()).toEqual(["You have found some gold!", "a gnome hits you"]);
    m.observe({ name: "overlay", active: true });
    expect(m.overlay).toBe(true);
    m.observe({ name: "clear" });
    m.observe({ name: "text", x: 0, y: 0, rgb: 0, text: "Score: 5, Diff: 0,  player a winner" });
    m.onQuit();
    expect(m.gameOver).toBe(true);
    expect(m.scoreLine()).toBe("Score: 5, Diff: 0,  player a winner");
    expect(m.won()).toBe(true);
  });

  it("keeps the message rows across died()'s screen clear, and prefers live ones", () => {
    const m = new LarnBotModel();
    m.observe({ name: "text", x: 0, y: 19, rgb: 0, text: "The gnome hits you." });
    m.observe({ name: "text", x: 0, y: 21, rgb: 0, text: "  You feel weaker  " });
    m.observe({ name: "clear" });
    m.observe({ name: "text", x: 0, y: 0, rgb: 0, text: "Score: 0, Diff: 0,  player killed by a gnome on  1" });
    expect(m.messages()).toEqual([]);
    expect(m.snapshot().lastMessages).toEqual(["The gnome hits you.", "You feel weaker"]);
    expect(m.snapshot().cause).toBe("killed by a gnome");
    m.observe({ name: "text", x: 0, y: 20, rgb: 0, text: "The scoreboard is empty." });
    expect(m.snapshot().lastMessages).toEqual(["The scoreboard is empty."]);
  });

  it("snapshot() is the RunSnapshot half of a summary, Larn detail in details", () => {
    const m = new LarnBotModel();
    status(m, { HP: 17, HPMAX: 31, XLEVEL: 4, GOLD: 250, DEPTH: 3, MOBULS_ELAPSED: 2, MOBULS_LEFT: 98 });
    m.keyAnswered(true); m.keyAnswered(true);
    m.observe({ name: "clear" });
    m.observe({ name: "text", x: 0, y: 0, rgb: 0, text: "Score: 1043, Diff: 0,  player killed by an orc on  3" });
    m.observe({ name: "text", x: 0, y: 19, rgb: 0, text: "You die..." });
    expect(m.snapshot()).toEqual({
      depth: 3, xlevel: 4, hp: 17, hpmax: 31, commands: 2, score: 1043,
      cause: "killed by an orc", lastMessages: ["You die..."],
      details: {
        larn: {
          dungeonDepth: 3, volcanoDepth: 0,
          gold: 250, mobulsElapsed: 2, mobulsLeft: 98, conditions: [], inventory: [],
        },
      },
    });
  });

  it("keeps the dungeon chain and the volcano chain apart", () => {
    // The town's volcanic shaft drops a level-1 character straight to internal
    // 11 (create.c:396-410), so the largest level number a run ever showed
    // cannot say whether it walked the route to the Eye or fell down a hole.
    // A hero who takes two staircases and THEN rides the shaft has done both,
    // and both are recorded.
    const m = new LarnBotModel();
    status(m, { DEPTH: 1 });
    status(m, { DEPTH: 2 });
    status(m, { DEPTH: 11 });
    status(m, { DEPTH: 12 });
    expect(m.maxDepth).toBe(12);
    expect(m.maxDungeonDepth).toBe(2);
    expect(m.maxVolcanoDepth).toBe(12);

    // A pure shaft ride walked no dungeon level at all, and says so.
    const rider = new LarnBotModel();
    status(rider, { DEPTH: 0 });
    status(rider, { DEPTH: 11 });
    expect(rider.maxDepth).toBe(11);
    expect(rider.maxDungeonDepth).toBe(0);
    expect(rider.maxVolcanoDepth).toBe(11);
  });
});

describe("model state from the status tap", () => {
  it("reads the score diedsub() prints", () => {
    expect(scoreOf("Score: 1043, Diff: 0,  killed by a gnome on 3")).toBe(1043);
    expect(scoreOf("Score: -12, Diff: 1,  a winner")).toBe(-12);
    expect(scoreOf("nothing like a score line")).toBe(0);
  });

  it("takes hp, depth and the clock from the status event, not the tty", () => {
    const m = new LarnBotModel();
    status(m, { HP: 7, HPMAX: 21, XLEVEL: 3, GOLD: 55, DEPTH: 4, MOBULS_LEFT: 88 });
    expect(m.hp).toBe(7);
    expect(m.hpmax).toBe(21);
    expect(m.xlevel).toBe(3);
    expect(m.gold).toBe(55);
    expect(m.depth).toBe(4);
    expect(m.maxDepth).toBe(4);
    expect(m.status?.mobulsLeft).toBe(88);
  });

  it("keeps the deepest level when the screen hides the current one", () => {
    const m = new LarnBotModel();
    status(m, { DEPTH: 6 });
    status(m, { DEPTH: -1 });
    expect(m.depth).toBeNull();
    expect(m.maxDepth).toBe(6);
  });

  it("counts a level epoch the status line cannot hide", () => {
    const m = new LarnBotModel();
    expect(m.levelEpoch).toBe(0);
    m.observe({ name: "level", width: 67, height: 17 });
    expect(m.levelEpoch).toBe(1);
  });
});

/** One status push carrying `slots` occupied inventory slots at `xlevel`. */
function packOf(m: LarnBotModel, slots: number, xlevel = 1) {
  const record = new Int32Array(STATUS_HEADER + slots * SLOT_STRIDE);
  record[STATUS.SLOTS] = slots;
  record[STATUS.XLEVEL] = xlevel;
  for (let i = 0; i < slots; i++) record[STATUS_HEADER + i * SLOT_STRIDE + SLOT.LETTER] = 97 + i;
  m.observe({ name: "status", record, names: new Uint8Array(0) });
}
const REFUSAL = "\nYou can't carry anything else";

describe("the pack-full latch", () => {
  it("latches on Larn's own refusal and clears only when the tap reports a smaller pack", () => {
    // The engine is the authority on carrying capacity, not a model of ours:
    // take() prints this line when it finds no free slot (global.c:481), and
    // the status tap's own slot count is what says room appeared again —
    // dropping, reading, theft or a rusted item, all the same signal.
    const m = new LarnBotModel();
    packOf(m, 26);
    expect(m.packFull).toBe(false);
    m.observe({ name: "text", x: 0, y: 19, rgb: 0xffffff, text: REFUSAL });
    expect(m.packFull).toBe(true);
    // A pack of the same size is not room: the latch holds across a status
    // push, a spent prompt and a whole level.
    packOf(m, 26);
    m.keyAnswered(false);
    m.observe({ name: "level", width: 67, height: 17 });
    expect(m.packFull).toBe(true);
    // One slot fewer is the engine saying the pack can take something again.
    packOf(m, 25);
    expect(m.packFull).toBe(false);
  });

  it("clears the latch when the hero's experience level moves, because Larn's capacity does", () => {
    // take()'s limit is 15 + (c[LEVEL] >> 1), capped at 26
    // (external/larn/global.c) — the pack the engine refused at level 3 is not
    // the pack it would refuse at level 5. Copying that formula in here would
    // be a second implementation of a game rule, free to drift; asking the
    // engine again costs one "take", one refusal, and re-latches.
    //
    // This is not hypothetical: seed 1185260916 is refused at level 3 with 16
    // items and reaches level 6, and before this bug was fixed it carried 18.
    // A latch that watched only the slot count would decline everything it
    // could now carry for the rest of the game.
    const m = new LarnBotModel();
    packOf(m, 16, 3);
    m.observe({ name: "text", x: 0, y: 19, rgb: 0xffffff, text: REFUSAL });
    expect(m.packFull).toBe(true);
    packOf(m, 16, 3);
    expect(m.packFull).toBe(true);
    packOf(m, 16, 4);
    expect(m.packFull).toBe(false);
    // loselevel() runs the other way (object.c's electrified door among
    // others), and the same reasoning applies: the answer may have changed.
    m.observe({ name: "text", x: 0, y: 19, rgb: 0xffffff, text: REFUSAL });
    expect(m.packFull).toBe(true);
    packOf(m, 16, 3);
    expect(m.packFull).toBe(false);
  });

  it("does not latch on a refusal it has no pack count to un-latch against", () => {
    // The latch clears by comparing slot counts, so latching before the first
    // status record would be a latch with no way out — a livelock of its own.
    const m = new LarnBotModel();
    m.observe({ name: "text", x: 0, y: 19, rgb: 0xffffff, text: REFUSAL });
    expect(m.packFull).toBe(false);
  });
});

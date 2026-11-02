import { describe, expect, it } from "vitest";
import { LarnBotPlayer } from "../../src/modules/larn/bot/LarnBotPlayer";
import { LarnRecorder } from "../../src/modules/larn/bot/recorder";
import type { LarnEvent } from "../../src/modules/larn/protocol";
import type { LarnHandler } from "../../src/modules/larn/session";
import { GRID, GRID_STRIDE, TERRAIN, TOP } from "../../src/modules/larn/mapRecords";
import { LARN_COLS, LARN_ROWS } from "../../src/modules/larn/classifier";
import { loadKb } from "../../src/bot/kb";
import { SLOT_STRIDE, STATUS, STATUS_HEADER } from "../../src/modules/larn/statusRecords";
import metaFacts from "../../data/kb/meta/facts.json";
import larnFacts from "../../data/kb/larn/facts.json";
import larnPolicy from "../../data/kb/larn/policy.json";

/** The shipped seed KB, as the hosts hand it to the bot. */
const kb = () => loadKb({ meta: metaFacts, engine: larnFacts, policy: larnPolicy });

function stubView() {
  const seen: LarnEvent[] = [];
  const notices: string[] = [];
  let ready = 0;
  const view: LarnHandler = {
    onReady: () => { ready++; },
    onNotice: (t) => notices.push(t),
    handle: (ev) => { seen.push(ev); },
    nextKey: () => { throw new Error("the view must never be asked for a key"); },
  };
  return { view, seen, notices, readyCount: () => ready };
}

function roomWithHero(x: number, y: number) {
  const r = new Int32Array(LARN_COLS * LARN_ROWS * GRID_STRIDE);
  let i = 0;
  for (let yy = 0; yy < LARN_ROWS; yy++) for (let xx = 0; xx < LARN_COLS; xx++) {
    r[i + GRID.X] = xx; r[i + GRID.Y] = yy;
    const edge = xx === 0 || yy === 0 || xx === LARN_COLS - 1 || yy === LARN_ROWS - 1;
    r[i + GRID.TERRAIN_CAT] = edge ? TERRAIN.WALL : TERRAIN.FLOOR; r[i + GRID.TERRAIN_CHAR] = 46; r[i + GRID.TERRAIN_COLOR] = 7;
    if (xx === x && yy === y) r[i + GRID.TOP_CAT] = TOP.HERO;
    i += GRID_STRIDE;
  }
  return r;
}

describe("LarnBotPlayer", () => {
  it("forwards display events, ready and notices to the view and feeds its model", () => {
    const { view, seen, notices, readyCount } = stubView();
    const bot = new LarnBotPlayer(view, kb(), 0);
    bot.onReady();
    bot.onNotice("Saving is off");
    bot.handle({ name: "text", x: 0, y: 19, rgb: 0, text: "hello" });
    expect(readyCount()).toBe(1);
    expect(notices).toEqual(["Saving is off"]);
    expect(seen.map((e) => e.name)).toEqual(["text"]);
    expect(bot.model.textSinceLastKey).toBe("hello");
  });

  it("answers a poll with no key, a prompt from the prompt table, and a command from the brain", async () => {
    const { view } = stubView();
    const bot = new LarnBotPlayer(view, kb(), 0);
    expect(await bot.nextKey(false, false)).toBeNull();
    bot.handle({ name: "text", x: 0, y: 20, rgb: 0, text: "Do you (o) try to open it, or (i) ignore it? " });
    expect(await bot.nextKey(true, false)).toEqual({ code: "o".charCodeAt(0), mods: 0 });
    expect(bot.model.textSinceLastKey).toBe("");
    bot.handle({ name: "map", records: roomWithHero(5, 5) });
    const key = await bot.nextKey(true, true);
    expect(key).not.toBeNull();
    expect("hjklyubn.".includes(String.fromCharCode(key!.code))).toBe(true);
    expect(bot.model.commands).toBe(1);
  });

  it("hands the prompt table the shaft bar the ladder computed, not a default", async () => {
    // The other half of the b5f.10 wiring lesson, for vect-hack-h9x.5: the
    // prompt table and the readiness rule can each be right while the player
    // passes a constant between them. A hero at experience level 1 is far
    // below the bar of 8, so "(c) climb down" must come back as the ignore.
    const { view } = stubView();
    const bot = new LarnBotPlayer(view, kb(), 0);
    bot.handle({ name: "map", records: roomWithHero(5, 5) });
    bot.handle({ name: "text", x: 0, y: 20, rgb: 0, text: "Do you (c) climb down, or (i) ignore it? " });
    expect(await bot.nextKey(true, false)).toEqual({ code: "i".charCodeAt(0), mods: 0 });
  });

  it("answers an item prompt from the pack state its own model latched", async () => {
    // The prompt table is pure; the pack state is the model's. This is the
    // wiring between them, and nothing else in the suite covers it: the two
    // halves can each be right while the player still hands the table a
    // default (vect-hack-b5f.10).
    const { view } = stubView();
    const bot = new LarnBotPlayer(view, kb(), 0);
    const scroll = "You have found a magic scrollDo you (r) read it, (t) take it, or (i) ignore it? ";
    const record = new Int32Array(STATUS_HEADER + 26 * SLOT_STRIDE);
    record[STATUS.SLOTS] = 26;
    bot.handle({ name: "status", record, names: new Uint8Array(0) });
    bot.handle({ name: "text", x: 0, y: 20, rgb: 0, text: scroll });
    expect(await bot.nextKey(true, false)).toEqual({ code: "t".charCodeAt(0), mods: 0 });
    bot.handle({ name: "text", x: 0, y: 21, rgb: 0, text: "\nYou can't carry anything else" });
    bot.handle({ name: "text", x: 0, y: 20, rgb: 0, text: scroll });
    expect(await bot.nextKey(true, false)).toEqual({ code: "i".charCodeAt(0), mods: 0 });
  });

  it("marks the model game over on quit", () => {
    const { view } = stubView();
    const bot = new LarnBotPlayer(view, kb(), 0);
    bot.onQuit();
    expect(bot.model.gameOver).toBe(true);
  });
});

describe("LarnRecorder", () => {
  it("records every event and every key answer as trajectory lines around the wrapped handler", async () => {
    const lines: string[] = [];
    const inner: LarnHandler = {
      onNotice: () => {},
      handle: () => {},
      nextKey: (wait, cmd) => (wait && cmd ? { code: 104, mods: 0 } : null),
    };
    const rec = new LarnRecorder(inner, (l) => lines.push(l));
    rec.handle({ name: "curs", x: 1, y: 2 });
    rec.handle({ name: "map", records: new Int32Array([1, 2, 3]) });
    expect(await rec.nextKey(true, true)).toEqual({ code: 104, mods: 0 });
    expect(await rec.nextKey(false, false)).toBeNull();
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { i: 0, name: "curs", ev: { name: "curs", x: 1, y: 2 }, reply: null },
      { i: 1, name: "map", ev: { name: "map", records: [1, 2, 3] }, reply: null },
      { i: 2, name: "getKey", ev: { wait: true, cmd: true }, reply: { code: 104, mods: 0 } },
      { i: 3, name: "getKey", ev: { wait: false, cmd: false }, reply: null },
    ]);
    expect(rec.log.counts.get("getKey")).toBe(2);
  });
});

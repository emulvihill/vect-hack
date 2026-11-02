// Real-engine regression for Larn's source-pinned map tap: moving/redrawing
// while blind advances only the known hero and never publishes newly live
// map state. The engine is deterministic at every asserted boundary.
import "fake-indexeddb/auto";
import { existsSync } from "node:fs";
import { GRID, GRID_STRIDE, TERRAIN, TOP } from "../../src/modules/larn/mapRecords.ts";
import { bootLarn, fail, park, until } from "./larn-play.mjs";

if (!existsSync(new URL("../../public/modules/larn/larn.data", import.meta.url)))
  fail("public/modules/larn/larn.{js,wasm,data} missing — run scripts/build/build-larn-wasm.sh");

const DIRECTIONS = [
  { key: "j", dx: 0, dy: 1 }, { key: "l", dx: 1, dy: 0 },
  { key: "k", dx: 0, dy: -1 }, { key: "h", dx: -1, dy: 0 },
  { key: "n", dx: 1, dy: 1 }, { key: "u", dx: 1, dy: -1 },
  { key: "b", dx: -1, dy: 1 }, { key: "y", dx: -1, dy: -1 },
];
const LARN_COLS = 67;
const LARN_ROWS = 17;
// Native IDs from external/larn/header.h; expectations are the public map
// contract, not values derived from the shim's terrain_identity table.
const TRAP_FIXTURES = [
  ...[9, 66, 74, 75].map((item) => ({ item, words: [7, 94, 1, 21, 0, 0, 0], glyph: "^", label: "a trap" })),
  ...[78, 67, 73, 76, 0].map((item) => ({ item, words: [1, 32, 7, 0, 0, 0, 0], glyph: " ", label: "floor" })),
  { item: 4, words: [6, 80, 5, 15, 0, 0, 0], glyph: "P", label: "a pit" },
];

const recordsByPosition = (records) => {
  if (!(records instanceof Int32Array) || records.length % GRID_STRIDE)
    fail("missing or malformed Larn map batch");
  const result = new Map();
  for (let offset = 0; offset < records.length; offset += GRID_STRIDE) {
    const record = new Int32Array(records.subarray(offset, offset + GRID_STRIDE));
    result.set(`${record[GRID.X]},${record[GRID.Y]}`, record);
  }
  return result;
};

const applied = new Map();
let appliedHero = null;
const apply = (records) => {
  for (const [key, record] of recordsByPosition(records)) {
    applied.set(key, record);
    if (record[GRID.TOP_CAT] === TOP.HERO)
      appliedHero = { x: record[GRID.X], y: record[GRID.Y] };
  }
};

let phase = "seed-traps";
let trapCells;
let historyFloor = 0;
let expected;
const session = await bootLarn({
  play: ({ grid: tty, lastMap, level, press, session: live }) => {
    if (phase === "done") return park();

    if (phase === "seed-traps") {
      const floors = [...recordsByPosition(lastMap).values()].filter((record) =>
        record[GRID.TERRAIN_CAT] === TERRAIN.FLOOR && record[GRID.TOP_CAT] === TOP.NONE);
      if (floors.length < TRAP_FIXTURES.length) fail("not enough empty cells for trap fixtures");
      trapCells = TRAP_FIXTURES.map((fixture, index) => ({ ...fixture,
        x: floors[index][GRID.X], y: floors[index][GRID.Y] }));
      for (const { item, x, y } of trapCells) {
        live.callNative("vect_larn_test_put_trap", null,
          ["number", "number", "number"], [x, y, item]);
        const planted = live.callNative("vect_larn_test_item_at", "number",
          ["number", "number"], [x, y]);
        if (planted !== item) fail(`trap fixture ${item} at ${x},${y} read back as ${planted}`);
      }
      historyFloor = live.mapHistory.length;
      phase = "verify-traps";
      return press(12);
    }

    if (phase === "verify-traps") {
      const batches = live.mapHistory.slice(historyFloor);
      if (batches.length !== 1 || batches[0].length !== LARN_COLS * LARN_ROWS * GRID_STRIDE)
        fail("trap fixture Ctrl-L did not publish one full map batch");
      const map = recordsByPosition(batches[0]);
      for (const { item, x, y, words, glyph, label } of trapCells) {
        const record = map.get(`${x},${y}`);
        if (!record || JSON.stringify([...record].slice(2)) !== JSON.stringify(words))
          fail(`trap fixture ${item} published ${JSON.stringify(record && [...record].slice(2))}, expected ${JSON.stringify(words)}`);
        if (tty.cells[y][x].ch !== glyph)
          fail(`trap fixture ${item} drew ${JSON.stringify(tty.cells[y][x].ch)}, expected ${JSON.stringify(glyph)}`);
        const answer = live.callNative("vect_larn_describe", "string",
          ["number", "number"], [x, y]);
        if (answer !== label)
          fail(`trap fixture ${item} described as ${JSON.stringify(answer)}, expected ${JSON.stringify(label)}`);
        live.callNative("vect_larn_test_put_trap", null,
          ["number", "number", "number"], [x, y, 0]);
      }
      phase = "seed-underlay";
      return press(12);
    }

    if (phase === "seed-underlay") {
      if (!level || lastMap.length !== level.width * level.height * GRID_STRIDE)
        fail("initial Larn map was not a full semantic batch");
      apply(lastMap);
      // Seed a source item under @, then force a non-blind Ctrl-L redraw.
      // The public batch still contains @; the native shadow must retain the
      // source item so blind departure restores it instead of empty floor.
      live.callNative("vect_larn_test_put_gold_under_hero", null, [], []);
      historyFloor = live.mapHistory.length;
      phase = "move";
      return press(12); // Ctrl-L, main.c's explicit drawscreen command
    }

    if (phase === "move") {
      const redraws = live.mapHistory.slice(historyFloor);
      if (redraws.length !== 1 || redraws[0].length !== LARN_COLS * LARN_ROWS * GRID_STRIDE)
        fail(`Ctrl-L produced map batches of ${redraws.map((b) => b.length / GRID_STRIDE)}`);
      apply(redraws[0]);
      const map = recordsByPosition(redraws[0]);
      const hero = [...map.values()].find((record) => record[GRID.TOP_CAT] === TOP.HERO);
      if (!hero) fail("redrawn Larn map has no semantic hero");
      const x = hero[GRID.X];
      const y = hero[GRID.Y];
      // Look HUD (spec 2026-08-18): a read-only native query. The hero's own
      // cell answers, an out-of-range cell does not, and a cell the map has
      // actually drawn as empty floor is named "floor".
      const describe = (dx, dy) =>
        live.callNative("vect_larn_describe", "string", ["number", "number"], [dx, dy]);
      if (describe(x, y) !== "you")
        fail("vect_larn_describe did not name the hero's own cell");
      if (describe(-1, -1)) fail("vect_larn_describe answered an out-of-range cell");

      const openNeighbours = DIRECTIONS.filter(({ dx, dy }) => {
        const target = map.get(`${x + dx},${y + dy}`);
        return target && target[GRID.TERRAIN_CAT] === TERRAIN.FLOOR
          && target[GRID.TOP_CAT] === TOP.NONE;
      });
      if (!openNeighbours.length) fail(`no empty visible neighbor beside Larn hero at ${x},${y}`);
      // Which one is decided by the describer as well as by the record, so
      // the harness never walks the hero into a cell the engine would not
      // name. That also folds the "an open neighbour is named floor"
      // assertion into the choice instead of restating it a line later.
      const direction = openNeighbours.find(({ dx, dy }) => describe(x + dx, y + dy) === "floor");
      if (!direction)
        fail(`vect_larn_describe named no open neighbour of ${x},${y} as floor `
          + `(tried ${openNeighbours.map(({ dx, dy }) => `${x + dx},${y + dy}`).join(" ")})`);
      // The neighbour check above only catches an argument swap at the ccall
      // boundary — an internal item[y][x] transposition usually still reads
      // floor. A cell whose own terrain the batch pins to something other
      // than floor flips a transposition, the same way a wall would — but
      // this fixture is Larn's town (level 0), which this real engine draws
      // with zero OWALL cells (confirmed against a live boot: 1131 floor, 2
      // stairs, 6 feature, 0 wall), so a literal wall probe never fires here.
      // Any non-floor terrain serves the same statistical purpose: floor is
      // 99%+ of the grid, so a transposed probe landing on one of the
      // handful of named cells by chance is exactly as unlikely as landing
      // on a specific wall would be on a level that has them.
      const namedRecord = [...map.values()]
        .find((record) => record[GRID.TERRAIN_CAT] !== TERRAIN.FLOOR && record[GRID.TERRAIN_CAT] !== TERRAIN.UNSEEN);
      if (!namedRecord) fail("no non-floor terrain cell in the redrawn Larn map to probe");
      const namedAnswer = describe(namedRecord[GRID.X], namedRecord[GRID.Y]);
      if (!namedAnswer || namedAnswer === "floor" || namedAnswer === "you")
        fail(`vect_larn_describe did not name a batch-pinned terrain cell distinctly: ${JSON.stringify(namedAnswer)}`);
      if (describe(LARN_COLS, LARN_ROWS))
        fail("vect_larn_describe answered a cell past the upper bound");
      const nx = x + direction.dx;
      const ny = y + direction.dy;
      // Every inventory restoration redraw covers row zero, whether t_endup
      // chooses its short draws() path or a full drawscreen(). Make one cell
      // there differ from the shadow so the later no-leak assertion cannot
      // disappear merely because the moved hero spawned below that region.
      const hiddenKey = "0,0";
      const hiddenRecord = map.get(hiddenKey);
      if (!hiddenRecord || hiddenRecord[GRID.TOP_CAT] === TOP.HERO)
        fail("row-zero redraw fixture is missing or unexpectedly contains the hero");
      if (hiddenRecord[GRID.TERRAIN_CAT] === TERRAIN.UNSEEN)
        fail("row-zero redraw fixture was already unseen before the native hide mutation");
      expected = { oldKey: `${x},${y}`, newKey: `${nx},${ny}`, x, y, nx, ny,
        newRecord: map.get(`${nx},${ny}`), hiddenKey, hiddenRecord };

      // Each call persistently clears one live know[][] cell. Hide both the
      // movement target (so the two-record delta cannot query live state)
      // and row zero (so the later redraw assertion is independently
      // non-vacuous); clearing know does not block movement.
      live.callNative("vect_larn_test_set_blind", null,
        ["number", "number", "number"], [500, nx, ny]);
      live.callNative("vect_larn_test_set_blind", null,
        ["number", "number", "number"], [500, 0, 0]);
      historyFloor = live.mapHistory.length;
      phase = "verify-move";
      return press(direction.key);
    }

    if (phase === "verify-move") {
      // Look HUD (spec 2026-08-18): the map tap deliberately withholds live
      // item/mitem/know state while blind (see the dirty guard); the vacated
      // cell must go equally quiet, or the describer becomes a
      // blindness-defeating radar.
      if (live.callNative("vect_larn_describe", "string", ["number", "number"], [expected.x, expected.y]))
        fail("vect_larn_describe answered the vacated cell while blind");

      const batches = live.mapHistory.slice(historyFloor);
      if (batches.length !== 1)
        fail(`blind move published ${batches.length} batches, including an intermediate live map`);
      const records = batches[0];
      if (records.length !== GRID_STRIDE * 2)
        fail(`blind move published ${records.length / GRID_STRIDE} cells instead of an old/new delta`);
      const delta = recordsByPosition(records);
      const oldRecord = delta.get(expected.oldKey);
      const newRecord = delta.get(expected.newKey);
      if (delta.size !== 2 || !oldRecord || !newRecord)
        fail(`blind delta addressed ${JSON.stringify([...delta.keys()])}`);
      if (oldRecord[GRID.TOP_CAT] !== TOP.ITEM || oldRecord[GRID.TOP_CHAR] === 0)
        fail(`blind departure did not restore the known gold beneath the old hero cell: ${JSON.stringify([...oldRecord])}`);
      if (newRecord[GRID.TOP_CAT] !== TOP.HERO)
        fail("blind move did not publish the semantic hero at its new coordinate");
      for (const word of [GRID.TERRAIN_CAT, GRID.TERRAIN_CHAR, GRID.TERRAIN_COLOR, GRID.TERRAIN_KIND])
        if (newRecord[word] !== expected.newRecord[word])
          fail(`blind move leaked live target word ${word}`);

      apply(records);
      if (JSON.stringify(appliedHero) !== JSON.stringify({ x: expected.nx, y: expected.ny }))
        fail(`applied semantic hero stayed stale at ${JSON.stringify(appliedHero)}`);
      if (applied.get(expected.oldKey)[GRID.TOP_CAT] !== TOP.ITEM)
        fail("applied semantic map did not restore the old hero's item underlay");

      // Close a real inventory while still blind. Upstream calls partial
      // draws(); the semantic adapter must replay cached records, never turn
      // that redraw into a full live-map leak.
      historyFloor = live.mapHistory.length;
      phase = "inventory-more";
      return press("i");
    }

    if (phase === "inventory-more") {
      if (!tty.toText().includes("Elapsed time is"))
        fail("blind inventory did not reach its pager");
      phase = "verify-redraw";
      return press(" ");
    }

    if (phase === "verify-redraw") {
      const batches = live.mapHistory.slice(historyFloor);
      if (batches.length !== 1)
        fail(`blind inventory close published ${batches.length} semantic batches`);
      const replayedHidden = recordsByPosition(batches[0]).get(expected.hiddenKey);
      if (!replayedHidden)
        fail(`blind inventory redraw omitted guaranteed cell ${expected.hiddenKey}`);
      if (JSON.stringify([...replayedHidden]) !== JSON.stringify([...expected.hiddenRecord]))
        fail(`blind inventory redraw leaked live state at ${expected.hiddenKey}`);
      apply(batches[0]);
      if (JSON.stringify(appliedHero) !== JSON.stringify({ x: expected.nx, y: expected.ny }))
        fail("blind cached redraw moved or erased the semantic hero");
      phase = "done";
      return park();
    }

    fail(`unknown Larn map-contract phase ${phase}`);
  },
});

await until(() => phase === "done", 30000, "blind movement and cached redraw contracts");
session.release();
session.FS.filesystems.IDBFS.quit();
console.log(`OK: visible/hidden trap and pit contracts held; blind hero/cache contract held (${expected.oldKey} -> ${expected.newKey}), including item underlay and cached redraw`);

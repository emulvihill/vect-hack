#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GRID, GRID_STRIDE, MORIA_MAX_COLS, MORIA_MAX_ROWS, STATE, STATE_STRIDE,
  TERRAIN, TOP,
} from "../../src/modules/moria/mapRecords.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const outDir = mkdtempSync(join(tmpdir(), "vect-moria-semantic-"));
const harness = join(outDir, "moria-semantic-harness");

execFileSync("c++", [
  "-std=c++14",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-DMORIA_SEMANTIC_HOST_TEST",
  `-I${join(ROOT, "src/modules/moria/native")}`,
  `-I${join(ROOT, "external/umoria/src")}`,
  join(ROOT, "scripts/test/moria-semantic-harness.cpp"),
  join(ROOT, "src/modules/moria/native/semantic-wasm.cpp"),
  join(ROOT, "external/umoria/src/rng.cpp"),
  "-o",
  harness,
], { cwd: ROOT, stdio: "inherit" });

execFileSync(harness, [], { cwd: ROOT, stdio: "inherit" });

// The host harness above pins every privacy edge against the exact production
// sanitizer/cache. This second half keeps the built artifact honest: the real
// fixed-seed game must actually publish that ABI while entering town, moving,
// and shutting down through its source exit path.
const publicModuleUrl = new URL("../../public/modules/moria/", import.meta.url);
const artifactPath = (name) => fileURLToPath(new URL(name, publicModuleUrl));
for (const extension of ["js", "wasm", "data"]) {
  const path = artifactPath(`moria.${extension}`);
  assert.ok(existsSync(path) && statSync(path).isFile() && statSync(path).size > 0,
    `public/modules/moria/moria.${extension} is missing or empty — run npm run build:moria`);
}

const createMoriaModule = (await import(
  `${new URL("moria.js", publicModuleUrl).href}?semantic-map=${Date.now()}`
)).default;
const birthKeys = [
  13, // splash
  "a".charCodeAt(0), // race
  "m".charCodeAt(0), // sex
  27, // accept rolled stats
  "a".charCodeAt(0), // class
  13, // empty name -> source fallback X
  32, // enter town
];
const frames = [];
const mapBatches = [];
const states = [];
const sourceMessages = [];
const shadow = new Map();
let birthAt = 0;
let liveStep = 0;
let initialMapCount = 0;
let initialTurn = null;
let moveTarget = null;
let droppedAt = null;
let shutdown = false;
let mapCountAtShutdown = null;
let beforeExitCalls = 0;

function assertLiveCallback(name) {
  assert.equal(shutdown, false, `${name} arrived after terminal shutdown`);
}

function applyMap(words, reset) {
  assert.equal(words.length % GRID_STRIDE, 0, "live map batch ended in a partial record");
  const state = currentState();
  assert.ok(words.length > 0 && words.length <= state.width * state.height * GRID_STRIDE,
    "live map batch exceeded active semantic bounds");
  if (reset) shadow.clear();
  const coordinates = new Set();
  for (let offset = 0; offset < words.length; offset += GRID_STRIDE) {
    const record = words.slice(offset, offset + GRID_STRIDE);
    assert.ok(record[GRID.X] >= 0 && record[GRID.X] < state.width
      && record[GRID.Y] >= 0 && record[GRID.Y] < state.height,
    `live map record crossed active bounds: ${record[GRID.X]},${record[GRID.Y]}`);
    const key = `${record[GRID.X]},${record[GRID.Y]}`;
    assert.equal(coordinates.has(key), false, `live map batch repeated ${key}`);
    coordinates.add(key);
    shadow.set(key, record);
  }
}

function currentState() {
  const state = states.at(-1);
  assert.ok(state, "real engine reached town without structured semantic state");
  return state;
}

function chooseOpenDirection(state) {
  const candidates = [
    { dx: 0, dy: -1, key: "8" }, { dx: 1, dy: -1, key: "9" },
    { dx: 1, dy: 0, key: "6" }, { dx: 1, dy: 1, key: "3" },
    { dx: 0, dy: 1, key: "2" }, { dx: -1, dy: 1, key: "1" },
    { dx: -1, dy: 0, key: "4" }, { dx: -1, dy: -1, key: "7" },
  ];
  const direction = candidates.find(({ dx, dy }) => {
    const x = state.hero.x + dx;
    const y = state.hero.y + dy;
    const record = shadow.get(`${x},${y}`);
    return record && (record[GRID.TERRAIN_CAT] === TERRAIN.FLOOR
      || record[GRID.TERRAIN_CAT] === TERRAIN.CORRIDOR)
      && record[GRID.TOP_CAT] === TOP.NONE;
  });
  assert.ok(direction, `fixed-seed semantic town has no open neighbor around ${JSON.stringify(state.hero)}`);
  return {
    key: direction.key.charCodeAt(0),
    x: state.hero.x + direction.dx,
    y: state.hero.y + direction.dy,
  };
}

function assertInitialTown() {
  const state = currentState();
  assert.ok(state.width > 0 && state.width <= MORIA_MAX_COLS,
    `invalid live semantic width ${state.width}`);
  assert.ok(state.height > 0 && state.height <= MORIA_MAX_ROWS,
    `invalid live semantic height ${state.height}`);
  assert.ok(state.hero && state.hero.x >= 0 && state.hero.x < state.width
    && state.hero.y >= 0 && state.hero.y < state.height,
  `invalid live semantic hero ${JSON.stringify(state.hero)}`);
  assert.ok(state.panel.top >= 0 && state.panel.top <= state.panel.bottom
    && state.panel.bottom < state.height && state.panel.left >= 0
    && state.panel.left <= state.panel.right && state.panel.right < state.width,
  `invalid live semantic panel ${JSON.stringify(state.panel)}`);
  assert.ok(Number.isInteger(state.depth) && Number.isInteger(state.turn),
    "live semantic depth/turn were not integers");

  const full = mapBatches.find(({ reset }) => reset);
  assert.ok(full, "real fixed-seed town omitted its initial reset map batch");
  assert.equal(full.words.length, state.width * state.height * GRID_STRIDE,
    "initial live map batch was not exactly width*height records");
  assert.equal(shadow.size, state.width * state.height,
    "initial live map did not populate every active coordinate");
  const publicRecords = [...shadow.values()];
  assert.ok(publicRecords.some((record) => record[GRID.TOP_CAT] === TOP.HERO),
    "initial live map omitted the semantic hero record");
  assert.ok(publicRecords.some((record) => record[GRID.TERRAIN_CAT] !== TERRAIN.UNSEEN),
    "initial live map omitted every visible terrain record");
  initialMapCount = mapBatches.length;
  initialTurn = state.turn;
  droppedAt = { ...state.hero };
}

const module = await createMoriaModule({
  locateFile: artifactPath,
  print: () => {},
  printErr: (text) => console.warn("[moria stderr]", text),
  terminalFlush: (cells) => {
    const copy = Uint8Array.from(cells);
    assert.equal(copy.length, 80 * 24, "real semantic run emitted a malformed terminal frame");
    frames.push(copy);
  },
  terminalBell: () => {},
  semanticMap: (words, reset) => {
    assertLiveCallback("semanticMap");
    const copy = Int32Array.from(words);
    mapBatches.push({ words: copy, reset: Boolean(reset) });
    applyMap(copy, reset);
  },
  semanticState: (words, playerName) => {
    assertLiveCallback("semanticState");
    const copy = Int32Array.from(words);
    assert.equal(copy.length, STATE_STRIDE, "real engine emitted malformed semantic state");
    const width = copy[STATE.WIDTH];
    const height = copy[STATE.HEIGHT];
    const heroX = copy[STATE.HERO_X];
    const heroY = copy[STATE.HERO_Y];
    states.push({
      width, height,
      panel: {
        top: copy[STATE.PANEL_TOP], bottom: copy[STATE.PANEL_BOTTOM],
        left: copy[STATE.PANEL_LEFT], right: copy[STATE.PANEL_RIGHT],
      },
      hero: heroX >= 0 && heroY >= 0 ? { x: heroX, y: heroY } : null,
      depth: copy[STATE.DEPTH], turn: copy[STATE.TURN], playerName,
    });
  },
  semanticMessage: (message) => {
    assertLiveCallback("semanticMessage");
    sourceMessages.push(String(message));
  },
  getKeyInput: async (request) => {
    if (!request.blocking) return { status: "none" };
    if (birthAt < birthKeys.length) {
      assert.equal(request.context, "literal", "fixed birth input was command-mapped");
      return { status: "key", key: birthKeys[birthAt++] };
    }
    const text = Buffer.from(frames.at(-1) ?? []).toString("latin1");
    if (request.context === "literal" && text.includes(" -more-")) {
      return { status: "key", key: 32 };
    }
    if (request.context === "literal" && liveStep === 1) {
      if (/Drop all/i.test(text)) return { status: "key", key: "y".charCodeAt(0) };
      if (/Drop/i.test(text)) return { status: "key", key: "a".charCodeAt(0) };
    }
    if (request.context === "literal" && liveStep === 3
      && /Rank\s+Points\s+Name|press any key to continue/i.test(text)) {
      return { status: "key", key: 27 };
    }
    assert.equal(request.context, "outer-command",
      `live map path entered an unexpected literal prompt:\n${text
        .match(/.{1,80}/gs)?.filter((row) => row.trim()).join("\n")}`);
    if (liveStep === 0) {
      assertInitialTown();
      liveStep = 1;
      // Put a source-real ordinary object on the hero tile. The hero correctly
      // retains top priority until the following movement exposes the item.
      return { status: "key", key: "d".charCodeAt(0) };
    }
    if (liveStep === 1) {
      const state = currentState();
      moveTarget = chooseOpenDirection(state);
      liveStep = 2;
      return { status: "key", key: moveTarget.key };
    }
    if (liveStep === 2) {
      const state = currentState();
      assert.deepEqual(state.hero, { x: moveTarget.x, y: moveTarget.y },
        "live semantic hero did not move to the selected open cell");
      assert.equal(shadow.get(`${droppedAt.x},${droppedAt.y}`)?.[GRID.TOP_CAT], TOP.ITEM,
        "live source drop/move path did not publish a visible item occupant");
      const diffs = mapBatches.slice(initialMapCount).filter(({ reset }) => !reset);
      assert.ok(diffs.length > 0, "live movement emitted no semantic diff batch");
      const changedCoordinates = new Set();
      for (const { words } of diffs) {
        assert.ok(words.length > 0 && words.length < state.width * state.height * GRID_STRIDE,
          "live movement emitted an empty or disguised full-sweep diff");
        for (let offset = 0; offset < words.length; offset += GRID_STRIDE) {
          changedCoordinates.add(`${words[offset + GRID.X]},${words[offset + GRID.Y]}`);
        }
      }
      assert.ok(changedCoordinates.has(`${droppedAt.x},${droppedAt.y}`)
        && changedCoordinates.has(`${moveTarget.x},${moveTarget.y}`),
      "live movement diff omitted the vacated or entered coordinate");
      assert.ok(state.turn > initialTurn,
        `live semantic turn did not advance after movement (${initialTurn} -> ${state.turn})`);
      assert.ok(sourceMessages.some((message) => /dropped/i.test(message)),
        "live source drop command emitted no semantic source message");

      // Look HUD (spec 2026-08-18): a read-only query through the sanitized
      // native seam, made while the source is parked on this very input.
      const describe = (x, y) =>
        module.ccall("moria_describe", "string", ["number", "number"], [x, y]);
      assert.equal(describe(state.hero.x, state.hero.y), "you",
        "moria_describe did not name the hero's own tile");
      // A scalar (x, y) probe is vacuous if the spawn happens to land on a
      // diagonal; the transposed reading only proves anything when it names a
      // genuinely different cell.
      if (state.hero.x !== state.hero.y)
        assert.notEqual(describe(state.hero.y, state.hero.x), "you",
          "moria_describe named the transposed cell as the hero — an x/y swap would pass this test blind");
      assert.ok(!describe(-1, -1), "moria_describe answered an out-of-range tile");

      const named = describe(droppedAt.x, droppedAt.y);
      assert.ok(named && !/^(a room floor|a corridor floor|a granite wall)$/.test(named),
        `moria_describe fell back to terrain where the drop left an item: ${JSON.stringify(named)}`);
      assert.ok(!describe(state.width, state.height),
        "moria_describe answered a tile past the upper bound");
      // "Never name what the map conceals" cannot be pinned here with a real
      // TERRAIN.UNSEEN cell: this birth happens in daytime, and Umoria's town
      // is fully lit in daytime — isNighTime()/lightTown()
      // (external/umoria/src/dungeon_generate.cpp) only leave TILE_DARK_FLOOR
      // tiles unlit at night. Instrumented directly, every one of this fixed
      // seed's 1452 town cells publishes a real terrain category, none
      // UNSEEN, so there is no fog-of-war cell in this daytime scene to
      // probe. That exact property is pinned against the real sanitizer
      // instead, in the host-test harness: moria-semantic-harness.cpp's
      // checkDescribeContract() asks about (12, 0), the cell the diff test
      // just above it retracts to field_mark=false while it still carries a
      // live TV_POTION1 treasure_id, and requires moria_describe to answer
      // nothing.
      assert.ok(shadow.size > 0 && [...shadow.values()].every((record) =>
        record[GRID.TERRAIN_CAT] !== TERRAIN.UNSEEN),
      "live Moria town unexpectedly has an unseen cell — wire the concealment probe here instead of relying on the host harness");

      liveStep = 3;
      return { status: "key", key: 24 }; // source Ctrl-X save-and-exit
    }
    assert.fail(`unexpected real semantic input at live step ${liveStep}`);
  },
  beforeExit: async (status, outcome) => {
    beforeExitCalls += 1;
    assert.equal(status, 0, "real semantic path changed controlled exit status");
    assert.equal(outcome, 1, "real semantic path did not exit through Ctrl-X save");
    shutdown = true;
    mapCountAtShutdown = mapBatches.length;
  },
});

const callerExitCode = process.exitCode;
let timeout;
const result = await Promise.race([
  Promise.resolve().then(() => module.ccall(
    "moria_start", "number", ["number", "boolean"], [1, false], { async: true },
  )).then(
    (value) => ({ kind: "resolved", value }),
    (error) => ({ kind: "rejected", error }),
  ),
  new Promise((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), 30_000);
  }),
]);
clearTimeout(timeout);
process.exitCode = callerExitCode;
assert.notEqual(result.kind, "timeout", "real semantic map path did not reach controlled exit");
if (result.kind === "rejected") throw result.error;
assert.equal(result.value, undefined, "real semantic map path returned natively");
assert.equal(liveStep, 3, "real semantic map path exited before its live movement assertion");
assert.equal(beforeExitCalls, 1, "real semantic map path omitted or duplicated beforeExit");
await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
assert.equal(mapBatches.length, mapCountAtShutdown,
  "semantic map callback emitted after terminal shutdown");

console.log("OK: real fixed-seed Moria emitted full town, live bounded diff/state, and no post-shutdown map");

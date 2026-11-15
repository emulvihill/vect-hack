// Shared real-engine driver for the Moria persistence gates. It uses the same
// Module options and persistence lifecycle as worker.ts, but keeps assertions
// in Node where fake-indexeddb and real Web Locks can model page reloads/tabs.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import createMoriaModule from "../../public/modules/moria/moria.js";
import { entries } from "../../src/backplane/saveBlob.ts";
import { createMoriaCheckpoint } from "../../src/modules/moria/checkpoint.ts";
import { GRID, GRID_STRIDE, STATE, STATE_STRIDE } from "../../src/modules/moria/mapRecords.ts";
import { mountMoriaStorage } from "../../src/modules/moria/persist.ts";
import { MoriaPersistenceLifecycle } from "../../src/modules/moria/persistenceLifecycle.ts";

export const COLS = 80;
export const ROWS = 24;
const FRAME_BYTES = COLS * ROWS;
const FIXED_SEED = 1;
const EXIT_TIMEOUT_MS = 30_000;
const publicModuleUrl = new URL("../../public/modules/moria/", import.meta.url);
const artifactPath = (name) => fileURLToPath(new URL(name, publicModuleUrl));
const parked = new Promise(() => {});

for (const extension of ["js", "wasm", "data"]) {
  const path = artifactPath(`moria.${extension}`);
  assert.ok(existsSync(path) && statSync(path).isFile() && statSync(path).size > 0,
    `public/modules/moria/moria.${extension} is missing or empty — run npm run build:moria`);
}

export function park() { return parked; }

export async function bootMoria({
  input,
  roguelike = false,
  locks,
  beforeMount,
  checkpointOptions,
  startEngine = true,
} = {}) {
  if (startEngine)
    assert.equal(typeof input, "function", "bootMoria requires an input driver");
  const frames = [];
  const requests = [];
  const semanticMaps = [];
  const semanticStates = [];
  const semanticMessages = [];
  const semanticShadow = new Map();
  const checkpointInvariants = [];
  let persist;
  let session;
  let quitState = null;
  let beforeExitCalls = 0;
  let checkpointCommandCalls = 0;
  let checkpointAttempts = 0;
  let checkpointLandings = 0;
  let latestName = null;
  const dependencyCounts = [];
  const lifecycle = new MoriaPersistenceLifecycle(
    () => persist,
    createMoriaCheckpoint(checkpointOptions),
  );

  const options = {
    noInitialRun: true,
    locateFile: artifactPath,
    print: () => {},
    printErr: (text) => console.warn("[moria stderr]", text),
    monitorRunDependencies: (count) => dependencyCounts.push(count),
    preRun: [(mod) => {
      beforeMount?.(mod);
      persist = mountMoriaStorage(mod, { locks });
    }],
    terminalFlush: (cells, y, x) => {
      const frame = Uint8Array.from(cells);
      assert.equal(frame.byteLength, FRAME_BYTES, "Moria emitted a non-80x24 frame");
      assert.ok(Number.isInteger(y) && y >= 0 && y < ROWS, `invalid Moria cursor row ${y}`);
      assert.ok(Number.isInteger(x) && x >= 0 && x < COLS, `invalid Moria cursor column ${x}`);
      frames.push(frame);
      const name = frameText(frame).match(/Name\s*:\s*([^\s]+)/)?.[1];
      if (name) latestName = name;
    },
    terminalBell: () => {},
    semanticMap: (words, reset) => {
      const copy = Int32Array.from(words);
      assert.equal(copy.length % GRID_STRIDE, 0,
        "Moria persistence driver received a partial semantic map record");
      if (reset) semanticShadow.clear();
      for (let offset = 0; offset < copy.length; offset += GRID_STRIDE) {
        const record = copy.slice(offset, offset + GRID_STRIDE);
        semanticShadow.set(`${record[GRID.X]},${record[GRID.Y]}`, record);
      }
      semanticMaps.push({ records: copy, reset: Boolean(reset) });
    },
    semanticState: (words, playerName) => {
      const copy = Int32Array.from(words);
      assert.equal(copy.length, STATE_STRIDE,
        "Moria persistence driver received malformed semantic state");
      semanticStates.push({ words: copy, playerName: String(playerName) });
    },
    semanticMessage: (message) => semanticMessages.push(String(message)),
    getKeyInput: async (request) => {
      requests.push({ ...request });
      assert.ok(requests.length < 5_000, "Moria persistence driver exceeded 5,000 key requests");
      if (!request.blocking) return { status: "none" };
      assert.ok(session, "Moria requested input before the real session was constructed");
      const reply = await input(request, session);
      assert.ok(reply && reply.status === "key" && Number.isInteger(reply.key),
        `Moria driver did not answer ${request.context} with a key`);
      return reply;
    },
    checkpointCommand: () => {
      checkpointCommandCalls += 1;
      return lifecycle.checkpointCommand();
    },
    checkpointLanded: async () => {
      checkpointAttempts += 1;
      const landed = await lifecycle.checkpointLanded();
      if (landed) checkpointLandings += 1;
      return landed;
    },
    checkpointRecoveryPath: () => lifecycle.checkpointRecoveryPath(),
    checkpointInvariant: (name, value) => {
      assert.equal(typeof name, "string", "Moria checkpoint invariant omitted its name");
      assert.ok(Number.isInteger(value), `Moria checkpoint invariant ${name} was not an integer`);
      checkpointInvariants.push({ name, value });
    },
    beforeExit: async (status, outcome) => {
      beforeExitCalls += 1;
      assert.equal(status, 0, "controlled Moria exit changed status");
      assert.ok(outcome === 0 || outcome === 1 || outcome === 2,
        `controlled Moria exit reported unknown outcome ${outcome}`);
      quitState = await lifecycle.beforeExit(outcome);
    },
  };

  const mod = await createMoriaModule(options);
  assert.ok(persist, "Moria preRun did not create a persistence handle");
  await persist.ready;
  session = {
    module: mod,
    FS: mod.FS,
    persist,
    lifecycle,
    frames,
    requests,
    semanticMaps,
    semanticStates,
    semanticMessages,
    checkpointInvariants,
    dependencyCounts,
    get frame() { return frames.at(-1); },
    get text() { return frameText(frames.at(-1)); },
    get characterName() { return latestName; },
    get quitState() { return quitState; },
    get beforeExitCalls() { return beforeExitCalls; },
    get checkpointCommandCalls() { return checkpointCommandCalls; },
    get checkpointAttempts() { return checkpointAttempts; },
    get checkpointLandings() { return checkpointLandings; },
    get semanticSnapshot() {
      return captureSemanticSnapshot(semanticStates, semanticShadow);
    },
    start: null,
  };

  if (startEngine) {
    const callerExitCode = process.exitCode;
    session.start = Promise.resolve().then(() => mod.ccall(
      "moria_start", "number", ["number", "boolean"],
      [FIXED_SEED, roguelike], { async: true },
    )).finally(() => { process.exitCode = callerExitCode; });
  }
  return session;
}

export async function waitForExit(session, timeoutMs = EXIT_TIMEOUT_MS) {
  let timeout;
  const result = await Promise.race([
    session.start.then(
      (value) => ({ kind: "resolved", value }),
      (error) => ({ kind: "rejected", error }),
    ),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ]);
  clearTimeout(timeout);
  assert.notEqual(result.kind, "timeout", `Moria did not reach controlled exit in ${timeoutMs}ms`);
  if (result.kind === "rejected") throw result.error;
  assert.equal(result.value, undefined, "Moria returned natively instead of controlled exit");
  assert.equal(session.beforeExitCalls, 1, "Moria omitted or duplicated the pre-exit hook");
  return session.quitState;
}

export function createAndSave({ roguelike = false, beforeSave } = {}) {
  const birth = [
    13, // splash
    code("a"), // race
    code("m"), // sex
    27, // accept stats
    code("a"), // class
    13, // empty name -> exact X fallback
    32, // enter dungeon
  ];
  let birthAt = 0;
  let direction = null;
  let snapshot = null;
  let moved = false;
  let ending = false;

  return {
    get snapshot() { return snapshot; },
    get moved() { return moved; },
    input: async (request, session) => {
      if (birthAt < birth.length) {
        assert.equal(request.context, "literal", "character birth used command-mapped input");
        return key(birth[birthAt++]);
      }
      if (request.context === "literal") {
        if (session.text.includes(" -more-")) return key(32);
        if (ending) return key(27);
        assert.fail(`unexpected new-game literal prompt:\n${visibleText(session.text)}`);
      }
      assert.equal(request.context, "outer-command", "live command was not an outer read");
      if (!direction) {
        direction = chooseOpenDirection(session.frame, roguelike);
        return key(code(direction.key));
      }
      moved = session.frame[direction.target] === code("@");
      assert.equal(moved, true, "fixed-seed open-cell command did not move the player");
      snapshot = captureSnapshot(session, request);
      await beforeSave?.(session);
      ending = true;
      return key(24); // source-owned Ctrl-X save-and-exit
    },
  };
}

export function restoreAndPark() {
  let opening = true;
  let sawBirth = false;
  let snapshot = null;
  let resolveOuter;
  const reachedOuter = new Promise((resolve) => { resolveOuter = resolve; });
  return {
    reachedOuter,
    get sawBirth() { return sawBirth; },
    get snapshot() { return snapshot; },
    input: async (request, session) => {
      sawBirth ||= birthScreen(session.text);
      if (request.context === "outer-command") {
        snapshot = captureSnapshot(session, request);
        resolveOuter();
        return park();
      }
      assert.equal(request.context, "literal", "restore emitted an unknown input context");
      if (opening) {
        opening = false;
        return key(13);
      }
      if (session.text.includes(" -more-")) return key(32);
      if (/character description.*character name/i.test(session.text)) return key(13);
      if (/press any key|continue/i.test(session.text)) return key(32);
      assert.fail(`unexpected restore literal prompt:\n${visibleText(session.text)}`);
    },
  };
}

export function restoreMoveAndSave({ beforeSave } = {}) {
  let opening = true;
  let sawBirth = false;
  let restored = null;
  let direction = null;
  let moved = false;
  let ending = false;
  return {
    get sawBirth() { return sawBirth; },
    get restored() { return restored; },
    get moved() { return moved; },
    input: async (request, session) => {
      sawBirth ||= birthScreen(session.text);
      if (request.context === "literal") {
        if (opening) {
          opening = false;
          return key(13);
        }
        if (session.text.includes(" -more-")) return key(32);
        if (/character description.*character name/i.test(session.text)) return key(13);
        if (ending) return key(27);
        if (/press any key|continue/i.test(session.text)) return key(32);
        assert.fail(`unexpected restore/save literal prompt:\n${visibleText(session.text)}`);
      }
      assert.equal(request.context, "outer-command", "restored command was not an outer read");
      if (!restored) {
        restored = captureSnapshot(session, request);
        direction = chooseOpenDirection(session.frame, restored.roguelike);
        return key(code(direction.key));
      }
      moved = session.frame[direction.target] === code("@");
      assert.equal(moved, true, "restored open-cell command did not move the player");
      await beforeSave?.(session);
      ending = true;
      return key(24);
    },
  };
}

export function closeIdbfs(session) {
  session.FS.filesystems.IDBFS.quit();
}

export function bytesEqual(a, b) {
  return Boolean(a && b) && a.byteLength === b.byteLength
    && a.every((value, i) => value === b[i]);
}

/**
 * Every file the durable volume holds under `prefix`, keyed by its name and
 * read straight out of IndexedDB.
 *
 * IndexedDB is the only substrate two Emscripten heaps share. A session's own
 * MEMFS is unreachable to every other module instance, so reading one engine's
 * memory to find out what another engine did is an assertion no behaviour
 * could falsify (vect-hack-azf). Reading only: nothing here
 * writes, so an inspection can never repair the damage it is looking for.
 */
export async function readDurableFiles(root, prefix = "") {
  const db = await promised(indexedDB.open(root));
  try {
    const store = db.transaction("FILE_DATA", "readonly").objectStore("FILE_DATA");
    const [keys, values] = await Promise.all([
      promised(store.getAllKeys()), promised(store.getAll()),
    ]);
    const base = prefix ? `${root}/${prefix}/` : `${root}/`;
    const files = new Map();
    keys.forEach((key, i) => {
      // Directory entries carry a mode and no contents.
      if (typeof key !== "string" || !key.startsWith(base) || !values[i]?.contents) return;
      files.set(key.slice(base.length), Uint8Array.from(values[i].contents));
    });
    return files;
  } finally {
    db.close();
  }
}

function promised(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function listFiles(fs, root, prefix = "") {
  const here = prefix ? `${root}/${prefix}` : root;
  const out = [];
  for (const name of entries(fs, here)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.stat(`${root}/${relative}`);
    if (fs.isDir(stat.mode)) out.push(...listFiles(fs, root, relative));
    else if (fs.isFile(stat.mode)) out.push(relative);
  }
  return out;
}

export function captureSnapshot(session, request) {
  const frame = session.frame;
  const hero = frame.indexOf(code("@"));
  assert.ok(hero >= 0, "outer Moria frame omitted the player");
  const semantic = session.semanticSnapshot;
  const name = session.characterName ?? semantic.playerName;
  assert.ok(name, `Moria never reported the character name:\n${visibleText(session.text)}`);
  const panel = [];
  for (let row = 1; row <= 22; row++) {
    panel.push(...frame.subarray(row * COLS + 13, row * COLS + 79));
  }
  return {
    name,
    hero: { row: Math.floor(hero / COLS), col: hero % COLS },
    fingerprint: Buffer.from(panel).toString("base64"),
    roguelike: request.roguelike,
    semantic,
  };
}

export function chooseOpenDirection(frame, roguelike) {
  const hero = frame.indexOf(code("@"));
  assert.ok(hero >= 0, "live Moria frame omitted the player");
  const row = Math.floor(hero / COLS);
  const col = hero % COLS;
  const candidates = [
    { dy: -1, dx: 0, original: "8", rogue: "k" },
    { dy: 1, dx: 0, original: "2", rogue: "j" },
    { dy: 0, dx: -1, original: "4", rogue: "h" },
    { dy: 0, dx: 1, original: "6", rogue: "l" },
    { dy: -1, dx: -1, original: "7", rogue: "y" },
    { dy: -1, dx: 1, original: "9", rogue: "u" },
    { dy: 1, dx: -1, original: "1", rogue: "b" },
    { dy: 1, dx: 1, original: "3", rogue: "n" },
  ];
  const direction = candidates.find(({ dy, dx }) => {
    const y = row + dy;
    const x = col + dx;
    return y >= 1 && y <= 22 && x >= 13 && x < 79 && frame[y * COLS + x] === code(".");
  });
  assert.ok(direction, `fixed-seed town has no open neighbor around ${row},${col}`);
  return {
    key: roguelike ? direction.rogue : direction.original,
    target: hero + direction.dy * COLS + direction.dx,
  };
}

function frameText(frame) {
  return frame ? Buffer.from(frame).toString("latin1") : "";
}

function visibleText(text) {
  return text.match(/.{1,80}/gs)?.filter((row) => row.trim()).join("\n") ?? text;
}

function birthScreen(text) {
  return /choose a race|choose a class|your sex|reroll/i.test(text);
}

function captureSemanticSnapshot(states, shadow) {
  const current = states.at(-1);
  assert.ok(current, "outer Moria frame omitted structured semantic state");
  const words = current.words;
  const ordered = [...shadow.values()].sort((a, b) =>
    a[GRID.Y] - b[GRID.Y] || a[GRID.X] - b[GRID.X]);
  const records = new Int32Array(ordered.length * GRID_STRIDE);
  ordered.forEach((record, index) => records.set(record, index * GRID_STRIDE));
  return {
    playerName: current.playerName,
    state: Buffer.from(words.buffer, words.byteOffset, words.byteLength).toString("base64"),
    map: Buffer.from(records.buffer, records.byteOffset, records.byteLength).toString("base64"),
    width: words[STATE.WIDTH],
    height: words[STATE.HEIGHT],
    panel: {
      top: words[STATE.PANEL_TOP],
      bottom: words[STATE.PANEL_BOTTOM],
      left: words[STATE.PANEL_LEFT],
      right: words[STATE.PANEL_RIGHT],
    },
    hero: { x: words[STATE.HERO_X], y: words[STATE.HERO_Y] },
    depth: words[STATE.DEPTH],
    turn: words[STATE.TURN],
  };
}

function code(character) { return character.charCodeAt(0); }
function key(keyCode) { return { status: "key", key: keyCode }; }

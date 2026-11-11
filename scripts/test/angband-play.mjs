// Shared driver for the Angband engine tests that need a *character*, not
// just a boot: it answers the splash, finishes birth with random choices, and
// then hands every command-level key wait to the caller's `play` callback.
//
// The same phase machine drives a restored game, where none of those screens
// appear — which is exactly what test-angband-save-restore.mjs asserts. It
// reports `sawBirth` so a test can prove the engine did NOT roll a new
// character, rather than merely reaching play somehow.
import { fileURLToPath } from "node:url";
import createAngbandModule from "../../public/modules/angband/angband.js";
import { AngbandGrid } from "../../src/modules/angband/grid.ts";
import { mountAngbandStorage } from "../../src/modules/angband/persist.ts";

export const KC_ENTER = 0x9c; // external/angband/src/ui-event.h:171
export const CTRL_X = 24;     // save and exit
export const GRID_STRIDE = 15;
export const GRID_FLAGS = 3;
export const GRID_PLAYER = 1 << 0;

export const fail = (msg) => { throw new Error("FAIL: " + msg); };
export const coreFile = (p) => fileURLToPath(new URL("../../public/modules/angband/" + p, import.meta.url));

/** Angband's left sidebar: name, race, class, title. Two snapshots that agree
 * here are the same character — a restored game that silently rolled a new
 * one would not match. Column 13 is where the map viewport starts. */
export const sidebar = (grid) =>
  grid.toText().split("\n").slice(0, 9)
    .map((line) => line.slice(0, 13).trimEnd())
    .filter(Boolean).join("|");

/**
 * Boot one Angband module against the real IDBFS volume and drive it to play.
 *
 * `play({ text, grid, press, level, session })` is called for every blocking,
 * command-level key wait once a character exists; it returns what gatherKey
 * should (1 with a key staged, 0 for none). `checkpoint` is the cadence the
 * native side polls — omit it and no checkpoint is ever due.
 */
// `bridge` adds fields to globalThis.VectAngband the way worker.ts does for a
// page flag (borgDelayMs, borgMenuDelayMs for ?borg=<ms>).
export async function bootAngband({ play, checkpoint, onQuit, onEvent, keys, onPoll, bridge } = {}) {
  const grid = new AngbandGrid();
  let persist;
  let phase = "opening";
  let level = null;
  let polls = 0, opening = 0;
  let sawBirth = false;
  let current = { code: 0, mods: 0 };

  const press = (code, mods = 0) => {
    current = { code: typeof code === "string" ? code.codePointAt(0) : code, mods };
    return 1;
  };

  const session = {
    grid,
    // undefined until the engine reports a checkpoint attempt; 0 or 1 after.
    // test-angband-autosave.mjs waits on "defined" and then judges the value,
    // so a reported failure fails by its own name rather than as a timeout.
    lastCheckpointOk: undefined,
    get persist() { return persist; },
    get level() { return level; },
    get sawBirth() { return sawBirth; },
    FS: null,
    press,
    close: async () => {
      await persist.flush();
      persist.release();
      session.FS.filesystems.IDBFS.quit();
    },
  };

  // The same translation worker.ts performs, for the subset these tests need:
  // a decorator under test must see AngbandEvents, not raw C callbacks.
  const emit = onEvent ?? (() => {});

  globalThis.VectAngband = {
    text: (x, y, _n, attr, rgb, cps) => {
      const text = String.fromCodePoint(...cps);
      grid.text(x, y, rgb, text);
      emit({ name: "text", x, y, attr, rgb, text });
    },
    wipe: (x, y, n) => { grid.wipe(x, y, n); emit({ name: "wipe", x, y, n }); },
    curs: (x, y) => { grid.curs(x, y); emit({ name: "curs", x, y }); },
    clear: () => { grid.clear(); emit({ name: "clear" }); },
    flush: () => emit({ name: "flush" }),
    mapBatch: (words) => emit({ name: "map", records: new Int32Array(words) }),
    level: (width, height) => { level = { width, height }; emit({ name: "level", width, height }); },
    message: (text, messageType) => emit({ name: "message", text, messageType }),
    overlay: (active) => emit({ name: "overlay", active: active !== 0 }),
    effect: () => {},
    keyCode: () => current.code,
    keyMods: () => current.mods,
    checkpointDue: () => (checkpoint?.due() ? 1 : 0),
    checkpointLanded: (ok) => {
      if (ok) checkpoint?.landed();
      session.lastCheckpointOk = ok;
    },
    quit: (msg, wasNull) => {
      if (!wasNull) fail("engine died: " + msg);
      onQuit?.();
    },
    gatherKey: async (wait, cmd) => {
      if (++polls > 200000) fail(`200000 key polls without finishing (phase=${phase})`);
      current = { code: 0, mods: 0 };
      if (!wait) { onPoll?.(); return 0; } // non-blocking poll (TERM_XTRA_FLUSH drain)
      const text = grid.toText();

      // `keys` takes over every blocking wait, birth included — that is the
      // shape a real decorator has, and the only way to test one end to end.
      if (keys) {
        if (text.includes("select your character traits") || text.includes("Human"))
          sawBirth = true;
        if (level && cmd) { phase = "play"; checkpoint?.command(); }
        const key = await keys(wait, cmd, { text, grid, level, session });
        return key ? press(key.code, key.mods) : 0;
      }

      // In play: a command-level wait with a generated level under us.
      if (level && cmd) {
        phase = "play";
        if (checkpoint) checkpoint.command();
        return play({ text, grid, press, level, session });
      }
      if (text.includes("select your character traits") || text.includes("Human")) {
        sawBirth = true;
        return press("@"); // finish birth with random choices
      }
      // Everything before that — the news splash, the name/history prompts,
      // and on a restored game the "Press any key" alone — wants Enter.
      if (++opening > 40) fail(`never reached play (phase=${phase}):\n` + text);
      return press(KC_ENTER);
    },
    ...bridge,
  };

  const opts = {
    locateFile: coreFile,
    print: () => {},
    printErr: (text) => console.warn("[angband stderr]", text),
    preRun: [(mod) => { persist = mountAngbandStorage(mod); }],
  };
  await createAngbandModule(opts);
  session.FS = opts.FS;
  session.mod = opts; // MODULARIZE attaches exports to the options object
  await persist.ready;
  if (!persist.persistent) fail(`session did not own storage: ${persist.reason?.detail}`);
  return session;
}

/** Leave the engine suspended at its key wait, forever. Answering with a
 * junk keycode instead would spin: the engine re-asks on a microtask, which
 * starves node's timer queue, so every setTimeout in the test — including
 * until()'s — stops running. Never resolving is what "parked" should mean. */
export const park = () => new Promise(() => {});

/** Resolves once `check()` returns truthy, or fails after `ms`. The engine
 * answers on microtasks through Asyncify, so polling is the only way to wait
 * on a state the driver reaches asynchronously. */
export async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const got = check();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fail(`timed out after ${ms}ms waiting for ${what}`);
}

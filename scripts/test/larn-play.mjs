// Shared real-engine driver for Larn tests that need a proven parse/yylex()
// boundary, not just a dungeon-looking status line. Larn's makeplayer() has
// no birth questions: the only new-game gate is welcome's retcont() newline.
import { fileURLToPath } from "node:url";
import createLarnModule from "../../public/modules/larn/larn.js";
import { LarnGrid } from "../../src/modules/larn/grid.ts";
import { mountLarnStorage } from "../../src/modules/larn/persist.ts";
import { installLarnShim } from "../../src/modules/larn/shimBridge.ts";

export const fail = (message) => { throw new Error("FAIL: " + message); };
export const coreFile = (name) => fileURLToPath(new URL(`../../public/modules/larn/${name}`, import.meta.url));

export const park = () => new Promise(() => {});

export async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const got = check();
    if (got) return got;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return fail(`timed out after ${ms}ms waiting for ${what}`);
}

/**
 * Boot a Larn module over its real IDBFS volume and hand its command loop to
 * `play`. `lastMap` is a copied Int32Array, never a live wasm heap view.
 *
 * The startup handshake is deliberately source-pinned. Repeatedly offer `i`:
 * lookforobject() consumes it to decline its direct ttgetch() prompts, while
 * parse()->yylex() consumes it as inventory (main.c:765). qshowstr() prints
 * "Elapsed time is" immediately before more() (main.c:343-362); only then
 * send space. When showstr() returns, its parse() return leaves nomove set,
 * so the next wait is a new parse()->yylex() boundary (main.c:294-314).
 * The driver does not use overlay state as command-boundary evidence: the
 * inventory text plus its pager round-trip proves the exact source path.
 * Production still exposes small cl_up()-painted inventories as overlays.
 *
 * A fresh session hands that boundary to `play`. A restored session acquires
 * it, sends '.', then acquires it again; postRestoreMap accepts only batches
 * emitted after that parsed dot, excluding restoregame()'s pre-load flush.
 */
export async function bootLarn({ onQuit, play } = {}) {
  const grid = new LarnGrid();
  let persist;
  let level = null;
  let lastMap = null;
  let postRestoreMap = null;
  let sawBirth = false;
  let birthAdvanced = false;
  let phase = "unstarted";
  let handshakeState = "send-inventory";
  let restoredDotSent = false;
  let restoreMapFloor = 0;
  let mapBatches = 0;
  const mapHistory = [];
  let polls = 0;
  const textHistory = [];
  const notices = [];
  /** The key `press` staged for this wait; the shared bridge reads it back
   *  as keyCode()/keyMods(). `press` keeps returning 1 because every caller's
   *  `play` callback returns it straight through (test-larn-save-restore.mjs
   *  and friends). */
  let staged = null;
  const press = (code, mods = 0) => {
    staged = { code: typeof code === "string" ? code.codePointAt(0) : code, mods };
    return 1;
  };

  const session = {
    grid,
    get persist() { return persist; },
    get level() { return level; },
    get lastMap() { return lastMap; },
    get postRestoreMap() { return postRestoreMap; },
    get sawBirth() { return sawBirth; },
    get saveLandings() { return saveLandings; },
    get textHistory() { return textHistory.join(""); },
    get notices() { return notices; },
    get mapHistory() { return mapHistory; },
    callNative: (name, returnType, argTypes, args) => {
      if (typeof opts.ccall !== "function")
        fail("Larn Emscripten module did not expose ccall");
      return opts.ccall(name, returnType, argTypes, args);
    },
    FS: null,
    release: () => persist?.release(),
  };
  let saveLandings = 0;

  installLarnShim({
    name: "scripts/test/larn-play.mjs",
    onEvent: (ev) => {
      if (ev.name === "text") {
        textHistory.push(ev.text);
        grid.text(ev.x, ev.y, ev.rgb, ev.text);
        if (ev.text.includes("Welcome to the game of Larn")) sawBirth = true;
      } else if (ev.name === "wipe") grid.wipe(ev.x, ev.y, ev.n);
      else if (ev.name === "curs") grid.curs(ev.x, ev.y);
      else if (ev.name === "clear") grid.clear();
      else if (ev.name === "map") {
        lastMap = ev.records;
        mapHistory.push(lastMap);
        mapBatches++;
        if (restoredDotSent && mapBatches > restoreMapFloor)
          postRestoreMap = lastMap;
      } else if (ev.name === "level") level = { width: ev.width, height: ev.height };
      // flush, status, overlay and death are deliberately unread: these
      // harnesses assert persistence and the map, not the rest of the screen.
      // Ignoring an event name is not a stub — the bridge answers the shim.
    },
    saveLanded: () => { saveLandings++; },
    notice: (text) => { notices.push(text); },
    quit: (saved) => { onQuit?.(saved); },
    gatherKey: async (wait, cmd) => {
      staged = null;
      // `play` may return a promise that never resolves (this file's own
      // `park`), which is how test-larn-autosave.mjs leaves an engine hanging
      // in its Asyncify key wait. Awaiting the handshake keeps that.
      const answered = await handshake(wait, cmd);
      return answered ? staged : null;
    },
  });

  /** The startup handshake: 1 when `press` staged a key for this wait, 0 when
   *  there is none. Body unchanged — it is the source-pinned sequence the
   *  header above describes. */
  async function handshake(wait, _cmd) {
    if (++polls > 10000)
      fail(`10000 key waits without reaching the requested Larn play state`);
    if (!wait) return 0;

    if (sawBirth && !birthAdvanced) {
      birthAdvanced = true;
      return press("\n");
    }
    const text = grid.toText();
    if (phase === "unstarted")
      phase = sawBirth ? "fresh-acquire" : "restore-before-dot-acquire";

    if (phase === "fresh-ready" || phase === "restore-ready")
      return play?.({ grid, lastMap, level, press, session, postRestoreMap }) ?? 0;

    if (handshakeState === "send-inventory") {
      if (text.includes("Elapsed time is")) {
        handshakeState = "pager-closing";
        return press(" ");
      }
      // Either decline a lookforobject() prompt or, at yylex(), open the
      // inventory whose pager proves this acquire round reached parse().
      return press("i");
    }
    if (handshakeState !== "pager-closing")
      fail(`unknown Larn command-boundary handshake state ${handshakeState}`);

    // qshowstr()->more() consumed the preceding space through ttgetch().
    // This wait is the yylex() boundary proven by the inventory roundtrip.
    if (phase === "fresh-acquire") {
      phase = "fresh-ready";
      return play?.({ grid, lastMap, level, press, session, postRestoreMap }) ?? 0;
    }
    if (phase === "restore-before-dot-acquire") {
      phase = "restore-after-dot-acquire";
      handshakeState = "send-inventory";
      restoredDotSent = true;
      restoreMapFloor = mapBatches;
      return press(".");
    }
    if (phase !== "restore-after-dot-acquire")
      fail(`unknown Larn startup phase ${phase}`);
    if (!postRestoreMap)
      fail("restored dot command completed without a following Larn map batch");
    phase = "restore-ready";
    return play?.({ grid, lastMap, level, press, session, postRestoreMap }) ?? 0;
  }

  const opts = {
    locateFile: coreFile,
    print: () => {},
    printErr: (text) => console.warn("[larn stderr]", text),
    preRun: [(mod) => { persist = mountLarnStorage(mod); }],
  };
  await createLarnModule(opts);
  session.FS = opts.FS;
  await persist.ready;
  if (!persist.persistent)
    fail(`session did not own storage: ${persist.reason?.detail}`);
  return session;
}

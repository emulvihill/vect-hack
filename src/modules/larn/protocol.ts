// Typed protocol between the Larn engine worker and the main thread —
// the src/modules/angband/protocol.ts mold applied to the Larn Module
// (phase 1 of the Larn Module plan; spike: docs/specs/larn-spike.md).
//
// Display events are one-way worker->main: Larn's term hooks draw and never
// wait for the UI. The single blocking request/reply is the key wait
// ("getKey"/"key"), mirroring the engine's one suspend point, the
// read(0, &b, 1) the shim intercepts (spike §7). Phase 1 carries only the
// tty-text events the shim emits; map/level/overlay are phase 2; effect is
// still deferred.
import type { LifecycleToMain } from "../../backplane/session";
import type { SaveExportReply, SaveExportRequest } from "../../backplane/saveExport";
import type { DescribeReply, DescribeRequest } from "../../backplane/describe";

// Storage state crosses on quit so the main-thread session never promises
// durability the worker's mounted Larn volume does not have. It no longer
// crosses on ready: the "this tab cannot save" warning is the Backplane's
// `sessionOnly` banner now, not a message-strip line (vect-hack-dem).

/** ESCAPE keycode — ASCII ESC, the single byte Larn reads for cancel
 *  (spike §7: every Larn input is one byte; no termcap arrow sequences).
 *  Also the cancel-shaped fallback reply for a failed getKey dispatch. */
export const KC_ESCAPE = 27;

/** The shift/run modifier bit in LarnKey.mods. Informational: the byte in
 *  `code` already carries the case (uppercase = run, spike §7); mods lets
 *  the worker branch without decoding ASCII. */
export const KC_MOD_SHIFT = 0x02;

export type LarnEvent =
  /** A run of characters at (x, y). rgb is the 0xRRGGBB color the shim
   *  resolves from Larn's term attribute; text is the literal run. */
  | { name: "text"; x: number; y: number; rgb: number; text: string }
  /** n cells erased from (x, y): CL_LINE/CL_DOWN (clr_eol/clr_eos) decoded
   *  by the shim's lflush(). Same shape as Angband's wipe. */
  | { name: "wipe"; x: number; y: number; n: number }
  | { name: "curs"; x: number; y: number }
  | { name: "clear" }
  /** The engine finished a frame (lflush). */
  | { name: "flush" }
  /** A packed, rendered map batch from larn_map_info (main-wasm.c). records is
   *  the per-cell Int32 array (GRID_STRIDE words each); visibility + chars are
   *  already resolved in C, so the classifier is a thin decoder. */
  | { name: "map"; records: Int32Array }
  /** A packed public status record from flush_status (main-wasm.c): the
   *  scalars the status line prints, the botside conditions as presence bits,
   *  the rounded mobul clock, and the inventory as show3() would render it.
   *  Decoded by src/modules/larn/statusRecords.ts. */
  | { name: "status"; record: Int32Array; names: Uint8Array }
  /** A new dungeon level (getlevel). The view clears + recentres. width/height
   *  are MAXX/MAXY (67/17). */
  | { name: "level"; width: number; height: number }
  /** A full-screen tty screen is active (welcome, help, inventory, store, save
   *  prompt). The view renders the full tty grid over/instead of the 3D map.
   *  Mirrors Angband's overlay event. */
  | { name: "overlay"; active: boolean }
  /** The engine entered died() (main-wasm.c's __wrap_died): `ch` is the map
   *  glyph of the being the epitaph names, or "" when the epitaph names none
   *  — a trap, poison, a win, a quit, or a being the player never saw. No
   *  view reads this; it exists so the recorded trajectory carries the join
   *  between the death message and the map, which the run digest cannot
   *  make for itself (vect-hack-b5f.4).
   *
   *  It is not a game-over signal. died() returns when life protection spends
   *  a charge, and it withdraws the glyph with a second event carrying "" —
   *  so a reader must take the last one, and must decide for itself whether
   *  the run ended (src/modules/larn/bot/digest.ts does both). */
  | { name: "death"; ch: string };

/** A Larn key: a single ASCII byte plus a modifier mask. code is always
 *  one byte (spike §7); mods carries shift for run / uppercase, matching
 *  the Angband split. code 0 = no key (only legal as a non-blocking
 *  getKey reply). */
export interface LarnKey { code: number; mods: number }

export interface LarnStorageState {
  persistent: boolean;
  reason: string | null;
}

/** A terminal Larn run is safe only after both halves of an explicit S-save:
 * native savegame(savefilename) succeeded, then its volume flush completed.
 * Checkpoints recover an abruptly closed tab, but died() deletes them on
 * every terminal path, so they must not make death, win, or quick quit report
 * `saved: true`. */
export function savedOnQuit(saveFlushed: boolean, nativeSaveSucceeded: number): boolean {
  return saveFlushed && nativeSaveSucceeded !== 0;
}

export type LarnWorkerToMain =
  /** Boot finished. It used to carry the storage state so the session could
   *  announce "Saving is off — <developer sentence>" in the message strip;
   *  that warning is now the Backplane's `sessionOnly` banner and the strip
   *  never sees the developer sentence at all (vect-hack-dem). */
  | { type: "ready" }
  | { type: "event"; ev: LarnEvent }
  /** Blocking key request; wait=false must be answered immediately
   * (code 0 = none), wait=true may be held until a key exists. */
  | { type: "getKey"; id: number; wait: boolean; cmd: boolean }
  /** The engine's own game-end reporting a normal end (quit() at
   *  global.c:375, or died(x) at scores.c:593): Module vocabulary,
   *  deliberately not lifecycle `fatal`. Larn's quit()/died() take no
   *  message string — unlike Angband's quit(str) there is no NULL/text
   *  split to classify, so the worker posts `quit` directly. `saved` reports
   *  whether an explicit S-save both wrote and reached the volume, so the
   *  view can tell "your game is safe" from "this run is gone". */
  | ({ type: "quit"; saved: boolean } & LarnStorageState)
  | { type: "released" }
  /** The volume packed for the player to keep (src/backplane/saveExport.ts). */
  | SaveExportReply
  /** The engine's own name for one map cell (src/backplane/describe.ts). */
  | DescribeReply
  | LifecycleToMain;

export type LarnMainToWorker =
  | { type: "key"; id: number; code: number; mods: number }
  | SaveExportRequest
  | DescribeRequest
  | { type: "release" };

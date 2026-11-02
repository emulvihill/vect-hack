// Typed protocol between the Angband engine worker and the main thread —
// the src/modules/nethack/protocol.ts mold applied to the Angband Module (spike phase of
// vect-hack-3vk; design: docs/specs/2026-08-02-vect-platform-design.md).
//
// Display events are one-way worker->main: Angband's term hooks draw and
// never wait for the UI. The single blocking request/reply is the key wait
// ("getKey"/"key"), mirroring the engine's one suspend point,
// Term_xtra(TERM_XTRA_EVENT, wait=true). What crosses the Backplane in the
// productized Module is the semantic map/event stream beside the unchanged raw
// tty stream; Phase 3 classifies packed map records into Cell/Category/Kind.
import type { LifecycleToMain } from "../../backplane/session";
import type { SaveExportReply, SaveExportRequest } from "../../backplane/saveExport";
import type { DescribeReply, DescribeRequest } from "../../backplane/describe";

// Storage state crosses on quit so the main-thread session never promises
// durability the worker's mounted Angband volume does not have. It no longer
// crosses on ready: the "this tab cannot save" warning is the Backplane's
// `sessionOnly` banner now, not a message-strip line (vect-hack-dem).

/** ESCAPE keycode (external/angband/src/ui-event.h:175) — also the
 *  cancel-shaped fallback reply for a failed getKey dispatch. */
export const KC_ESCAPE = 0xe000;

export type AngbandEvent =
  /** A run of characters at (x, y). attr is Angband's raw attribute index;
   * rgb is angband_color_table[attr] folded to 0xRRGGBB in main-wasm.c's
   * rgb_from_attr — not worker-side. */
  | { name: "text"; x: number; y: number; attr: number; rgb: number; text: string }
  | { name: "wipe"; x: number; y: number; n: number }
  | { name: "curs"; x: number; y: number }
  | { name: "clear" }
  /** TERM_XTRA_FRESH: the engine finished a frame. */
  | { name: "flush" }
  | { name: "map"; records: Int32Array }
  | { name: "level"; width: number; height: number }
  | { name: "message"; text: string; messageType: number }
  | { name: "overlay"; active: boolean }
  | { name: "effect"; x: number; y: number; ch: string; color: number; rgb: number; beam: boolean };

/** An Angband keycode_t + modifier mask (external/angband/src/ui-event.h).
 * code 0 = no key (only legal as a reply to a non-blocking getKey). */
export interface AngbandKey { code: number; mods: number }

export interface AngbandStorageState {
  persistent: boolean;
  reason: string | null;
}

export type AngbandWorkerToMain =
  /** Boot finished. It used to carry the storage state so the session could
   *  announce "Saving is off — <developer sentence>" in the message strip;
   *  that warning is now the Backplane's `sessionOnly` banner and the strip
   *  never sees the developer sentence at all (vect-hack-dem). */
  | { type: "ready" }
  | { type: "event"; ev: AngbandEvent }
  /** Blocking key request; wait=false must be answered immediately
   * (code 0 = none), wait=true may be held until a key exists. */
  | { type: "getKey"; id: number; wait: boolean; cmd: boolean }
  /** The engine's own quit_hook reporting a normal end (death, retirement,
   * the play_game() return): Module vocabulary, deliberately not lifecycle
   * `fatal`. `saved` reports whether the last checkpoint reached the volume,
   * so the view can tell "your game is safe" from "this run is gone". */
  | ({ type: "quit"; saved: boolean } & AngbandStorageState)
  | { type: "released" }
  /** The volume packed for the player to keep (src/backplane/saveExport.ts). */
  | SaveExportReply
  /** The engine's own name for one map cell (src/backplane/describe.ts). */
  | DescribeReply
  | LifecycleToMain;

/** One quit_hook call classified into the protocol. Upstream splits the hook
 *  by its argument: quit(NULL) is exit(EXIT_SUCCESS), quit(str) is plog(str)
 *  + exit(EXIT_FAILURE) (external/angband/src/z-util.c:919), so the native
 *  side reports NULL-ness separately (`wasNull`) rather than leaving it to
 *  read as "" — a quit(str) whose str happens to be empty is a fault, not a
 *  clean exit, and the two are indistinguishable from the text alone.
 *
 *  Text otherwise IS an engine death carrying its own diagnostic — core
 *  faults get here through quit_fmt (create_needed_dirs alone, init.c:416-428)
 *  — and stays a lifecycle `fatal`. The one exception is an exact allowlist:
 *  "user choice" is do_cmd_wiz_quit_no_save (cmd-wizard.c:2151), a deliberate
 *  player action on the success path despite carrying text. */
export function quitMessage(
  message: string, wasNull: boolean, saved: boolean,
): { type: "quit"; saved: boolean } | { type: "fatal"; message: string } {
  if (wasNull || message === "user choice") return { type: "quit", saved };
  // quit("") is still the failure path; it just has nothing to say for itself.
  return { type: "fatal", message: message || "the engine quit without a reason" };
}

/** What `saved` really is once the quit path's own last flush has run.
 *  PersistHandle.flush() throws on every IDBFS failure (src/backplane/persistFs.ts),
 *  and an unguarded rejection on the quit path costs the player the whole quit
 *  message — the worker's unhandledrejection handler turns it into a bare
 *  `fatal` instead. A run whose volume never reached IndexedDB is not a saved
 *  run, so the failure lands in `saved` and the message still goes out. */
export async function savedOnQuit(saved: boolean, flush: () => Promise<void>): Promise<boolean> {
  // mountVolume already logs the reason; the quit message is what is left to do.
  try { await flush(); return saved; } catch { return false; }
}

export type AngbandMainToWorker =
  | { type: "key"; id: number; code: number; mods: number }
  | SaveExportRequest
  | DescribeRequest
  /** ?borg pacing, applied to user/borg.txt before activation (borgConfig.ts).
   *  Sent on every borg run — the file persists, so an unsent value would
   *  mean inheriting the last run's pace, not running at the default. */
  | { type: "borgDelay"; ms: number }
  | { type: "release" };

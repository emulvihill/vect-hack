// Typed protocol between the NetHack worker (WASM engine + shim decode) and
// the main thread (UI). Every shim call is request/reply: the engine is
// suspended (Asyncify) until the reply arrives, so ordering is strict.
import type { LifecycleToMain } from "../../backplane/session";
import type { SaveExportReply, SaveExportRequest } from "../../backplane/saveExport";
import type { DescribeReply, DescribeRequest } from "../../backplane/describe";

/** Decoded glyph cell, produced worker-side from the C glyph_info struct. */
export interface GlyphCell {
  glyph: number;      // display entity id (stable key for 3D representation)
  ch: string;         // classic ASCII representation (ttychar)
  color: number;      // CLR_* index 0-15
  glyphflags: number; // MG_* bits (pet, pile, ...)
}

export interface MenuItemData {
  identifier: number; // raw 32-bit anything value; 0 = non-selectable heading
  accelerator: string;
  groupAccel: string;
  attr: number;
  color: number;
  text: string;
  itemflags: number;
  glyph: GlyphCell | null;
}

/** Windowport events. `name` mirrors the shim function (sans prefix). */
export type ShimEvent =
  | { name: "init_nhwindows" }
  | { name: "askname" }
  | { name: "exit_nhwindows"; text: string }
  | { name: "create_nhwindow"; wintype: number }
  | { name: "clear_nhwindow"; win: number }
  | { name: "display_nhwindow"; win: number; blocking: boolean }
  | { name: "destroy_nhwindow"; win: number }
  | { name: "curs"; win: number; x: number; y: number }
  | { name: "putstr"; win: number; attr: number; text: string }
  | { name: "start_menu"; win: number; mbehavior: number }
  | { name: "add_menu"; win: number; item: MenuItemData }
  | { name: "end_menu"; win: number; prompt: string }
  | { name: "select_menu"; win: number; how: number }
  /** A one-item menu on the message line; the reply is the key pressed. */
  | { name: "message_menu"; how: number; text: string }
  | { name: "print_glyph"; win: number; x: number; y: number; cell: GlyphCell; bg: GlyphCell | null }
  | { name: "raw_print"; text: string; bold: boolean }
  | { name: "nhgetch" }
  | { name: "nh_poskey" }
  | { name: "yn_function"; query: string; choices: string; def: number }
  | { name: "getlin"; query: string }
  | { name: "get_ext_cmd"; commands: ExtCmd[] }
  | { name: "getmsghistory"; init: boolean }
  | { name: "putmsghistory"; text: string; restoring: boolean }
  | { name: "status_init" }
  | { name: "status_enablefield"; fieldidx: number; nm: string; fmt: string; enable: boolean }
  | { name: "status_update"; fldidx: number; text: string | null; condbits: number; chg: number; percent: number; color: number }
  | { name: "cliparound"; x: number; y: number }
  | { name: "delay_output" }
  | { name: "nhbell" }
  | { name: "other"; shim: string; args: unknown[] };

/** Extended command; the reply to get_ext_cmd is an index into this list (-1 = cancel). */
export interface ExtCmd {
  name: string;
  desc: string;
}

export type SelectMenuReply = { picks: { identifier: number; count: number; itemflags: number }[] };

export type WorkerToMain =
  | { type: "ready"; constants: Record<string, Record<string, number | string>> }
  | { type: "call"; id: number; ev: ShimEvent }
  /** The volume packed for the player to keep (src/backplane/saveExport.ts). */
  | SaveExportReply
  /** The engine's own name for one map cell (src/backplane/describe.ts). */
  | DescribeReply
  /** notice (out-of-band player message) + fatal — the Backplane lifecycle
   *  every Module's worker->main union must include. */
  | LifecycleToMain;

export type MainToWorker =
  | { type: "reply"; id: number; value: number | string | boolean | SelectMenuReply | null }
  | SaveExportRequest
  | DescribeRequest;

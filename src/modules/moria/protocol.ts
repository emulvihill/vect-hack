import type { LifecycleToMain } from "../../backplane/session";
import type { SaveExportReply, SaveExportRequest } from "../../backplane/saveExport";
import type { DescribeReply, DescribeRequest } from "../../backplane/describe";
import type { MoriaSemanticEvent } from "./semanticProtocol";

export const MORIA_COLS = 80;
export const MORIA_ROWS = 24;
export const MORIA_FRAME_BYTES = MORIA_COLS * MORIA_ROWS;
export const KC_ESCAPE = 27;

export type MoriaKeyMode = "original" | "roguelike";
export type MoriaInputContext = "outer-command" | "literal" | "poll";

export type MoriaInputResult =
  | { status: "key"; key: number }
  | { status: "none" };

export interface MoriaStorageState {
  persistent: boolean;
  reason: string | null;
}

export type MoriaEvent =
  | { name: "frame"; cells: Uint8Array; x: number; y: number }
  | { name: "bell" }
  | MoriaSemanticEvent;

export type MoriaWorkerToMain =
  /** Boot finished. It used to carry the storage state so the session could
   *  announce "Saving is off — <developer sentence>" in the message strip;
   *  that warning is now the Backplane's `sessionOnly` banner and the strip
   *  never sees the developer sentence at all (vect-hack-dem). */
  | { type: "ready" }
  | { type: "event"; ev: MoriaEvent }
  | {
    type: "getKey";
    id: number;
    wait: boolean;
    context: MoriaInputContext;
    mode: MoriaKeyMode;
    delayMicroseconds: number;
  }
  | ({ type: "quit"; saved: boolean } & MoriaStorageState)
  | { type: "released" }
  | SaveExportReply
  /** The engine's own name for one map cell (src/backplane/describe.ts). */
  | DescribeReply
  | LifecycleToMain;

export type MoriaMainToWorker =
  | { type: "key"; id: number; result: MoriaInputResult }
  | SaveExportRequest
  | DescribeRequest
  | { type: "release" };

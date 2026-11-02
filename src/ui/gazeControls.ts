// The shared gaze-key adapter: which physical chord means which camera-relative
// action, per camera mode, and the one place that turns a chord into either a
// local camera action (applied here) or a compass move (encoded by the caller).
//
// Every vector Module arms this ONLY while its engine has a command request
// parked (the Angband commandInput pattern): a prompt must always see the
// unremapped key, and which reads are commands is each Module's own seam —
// Angband's Term_xtra cmd flag, Moria's "outer-command" context, Larn's
// __wrap_yylex discriminator. What a move means to an engine is not shared
// either: each Module encodes {direction, run} with its own movementKey.
// NetHack predates this adapter and layers rebindable actions on top
// (src/modules/nethack/ui/moveKeys.ts); its tables are the mold these copy.
import { chord, resolve, STEP, type GazeAction } from "./gaze";

/** First person: arrows turn, the numpad cluster moves, Clear faces north.
 *  Shift rides along on a turn — there is no sideways arrow to run in first
 *  person, and an unbound shifted chord would fall through to a Module's
 *  shift-blind absolute lookup instead (vect-hack-029). */
export const FIRST_PERSON_BINDINGS: Record<string, GazeAction> = {
  "ArrowUp": "move-fwd", "Shift+ArrowUp": "run-fwd",
  "ArrowDown": "move-back", "Shift+ArrowDown": "run-back",
  "ArrowLeft": "turn-left", "Shift+ArrowLeft": "turn-left",
  "ArrowRight": "turn-right", "Shift+ArrowRight": "turn-right",
  "Home": "move-fwd-left", "Shift+Home": "run-fwd-left",
  "PageUp": "move-fwd-right", "Shift+PageUp": "run-fwd-right",
  "End": "move-back-left", "Shift+End": "run-back-left",
  "PageDown": "move-back-right", "Shift+PageDown": "run-back-right",
  "Clear": "reset-facing",
};

/** Orbital: every direction key is a screen-relative move and none is a turn —
 *  the pointer owns orbital turning, so left/right walk instead. The
 *  NumLock-off numpad emits exactly these named keys (Numpad8 is ArrowUp,
 *  Numpad7 Home, Numpad5 Clear, ...), so one entry serves the pad and the main
 *  cluster both. */
export const ORBITAL_BINDINGS: Record<string, GazeAction> = {
  ...FIRST_PERSON_BINDINGS,
  "ArrowLeft": "move-left", "Shift+ArrowLeft": "run-left",
  "ArrowRight": "move-right", "Shift+ArrowRight": "run-right",
};

type ChordEvent = Pick<KeyboardEvent,
  "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

/** The camera surface the adapter needs — DungeonRenderer satisfies it. */
export interface GazeCamera {
  mode: "orbital" | "first";
  heading: number;
  turn(delta: number): void;
  resetFacing(): void;
}

export type GazeKeyOutcome =
  | { kind: "camera" }                              // turn/reset applied; feed the engine nothing
  | { kind: "move"; direction: number; run: boolean } // encode with the Module's movementKey
  | null;                                           // unbound: the Module's plain key map decides

/** Resolve one chord against the camera. Turns and resets are applied to the
 *  camera here — they answer no engine request and consume no game time — and
 *  a move comes back as a compass eighth for the caller to encode. */
export function gazeKey(e: ChordEvent, camera: GazeCamera): GazeKeyOutcome {
  const bindings = camera.mode === "first" ? FIRST_PERSON_BINDINGS : ORBITAL_BINDINGS;
  const result = resolve(bindings[chord(e)], camera.heading);
  switch (result?.kind) {
    case "turn": camera.turn(result.delta); return { kind: "camera" };
    case "reset": camera.resetFacing(); return { kind: "camera" };
    case "key": return { kind: "move", direction: result.direction, run: result.run };
    default: return null;
  }
}

export { STEP as TURN_STEP };

// Gaze-relative movement, in two layers that are deliberately separable.
//
// Layer 1 (DEFAULT_BINDINGS, ORBITAL_BINDINGS) is which physical key means what
// — plain data, per camera mode. Orbital: all-moves, no turns. First person:
// arrows turn, numpad-cluster moves. Layer 2 (resolve) is what an action means
// to NetHack, which is not a preference: rebinding "north" to walk south is not
// something a player should be able to ask for.
//
// Layer 2 has two entry points, both pure, both keyed on the same Action names:
// resolve() reads the camera's heading for the eight gaze-relative moves, and
// resolveTarget() reads a target's direction from the hero for the pointer/menu
// actions (src/modules/nethack/ui/pointerActions.ts) — attack, open, kick,
// chat, apply. An action means one thing to NetHack whether it arrives from a
// key, a click, or a menu row; only which direction it resolves against differs.
import {
  STEP as TURN_STEP, compass, dirTo, resolve as resolveGaze,
} from "../../../ui/gaze";
import { DIRECTIONS, ctrl, key, meta } from "./keys";

export { TURN_STEP, compass, dirTo };

/**
 * Every action name there is. The array is the source of truth and the type
 * below is derived from it, not the other way round — a hand-copied string
 * list (an override schema's validator, say) would drift the moment an
 * action was added here and nowhere else; deriving the type instead makes
 * that impossible (vect-hack-be3.5).
 */
export const CAMERA_ACTIONS = [
  "move-fwd", "move-back", "move-left", "move-right",
  "move-fwd-left", "move-fwd-right", "move-back-left", "move-back-right",
  "run-fwd", "run-back", "run-left", "run-right",
  "run-fwd-left", "run-fwd-right", "run-back-left", "run-back-right",
  "turn-left", "turn-right",
  "reset-facing",
] as const;

/** Pointer/menu actions (vect-hack-be3.3): resolved against a target's
 *  direction from the hero (resolveTarget/dirTo below), not the camera. No
 *  key path resolves these — resolve() has no target to aim them at — which
 *  is why a stored keybinding may only name a CAMERA_ACTIONS entry
 *  (keyBindings.ts's parseOverride). */
export const POINTER_ACTIONS = [
  "attack", "open", "close", "kick", "chat", "apply", "search", "untrap",
] as const;

export const ACTIONS = [...CAMERA_ACTIONS, ...POINTER_ACTIONS] as const;

export type Action = typeof ACTIONS[number];

export type Resolved =
  | { kind: "key"; code: number }      // feed this to the engine
  | { kind: "keys"; codes: number[] }  // feed these, in order
  | { kind: "turn"; delta: number }    // swing the camera, feed nothing
  | { kind: "reset" }                  // face north-up, feed nothing
  | null;                              // unbound: fall through to KEYMAP

/**
 * Layer 1. Keys are named by `chord()`, so this is exactly the format a saved
 * config would use. Nothing here is a letter — every NetHack command still
 * reaches the engine untouched.
 */
export const DEFAULT_BINDINGS: Record<string, Action> = {
  "ArrowUp": "move-fwd", "Shift+ArrowUp": "run-fwd",
  "ArrowDown": "move-back", "Shift+ArrowDown": "run-back",
  // Shift rides along on a turn: there is no sideways arrow to run in first
  // person, and an unbound shifted chord would fall through to KEYMAP's
  // shift-blind absolute lookup instead (vect-hack-029).
  "ArrowLeft": "turn-left", "Shift+ArrowLeft": "turn-left",
  "ArrowRight": "turn-right", "Shift+ArrowRight": "turn-right",
  "Home": "move-fwd-left", "Shift+Home": "run-fwd-left",
  "PageUp": "move-fwd-right", "Shift+PageUp": "run-fwd-right",
  "End": "move-back-left", "Shift+End": "run-back-left",
  "PageDown": "move-back-right", "Shift+PageDown": "run-back-right",
  "Clear": "reset-facing",
};

/**
 * Layer 1 for the orbital camera: every direction key is a screen-relative
 * move and none is a turn — the pointer owns orbital turning, so left/right
 * walk instead. The NumLock-off numpad emits exactly these named keys
 * (Numpad8 is ArrowUp, Numpad7 Home, Numpad5 Clear, ...), so one entry
 * serves the pad and the main cluster both; with NumLock on the pad types
 * digits, which no table binds — they stay NetHack count prefixes.
 */
export const ORBITAL_BINDINGS: Record<string, Action> = {
  "ArrowUp": "move-fwd", "Shift+ArrowUp": "run-fwd",
  "ArrowDown": "move-back", "Shift+ArrowDown": "run-back",
  "ArrowLeft": "move-left", "Shift+ArrowLeft": "run-left",
  "ArrowRight": "move-right", "Shift+ArrowRight": "run-right",
  "Home": "move-fwd-left", "Shift+Home": "run-fwd-left",
  "PageUp": "move-fwd-right", "Shift+PageUp": "run-fwd-right",
  "End": "move-back-left", "Shift+End": "run-back-left",
  "PageDown": "move-back-right", "Shift+PageDown": "run-back-right",
  "Clear": "reset-facing",
};

/**
 * Layer 2, camera side. Pure: applying a turn is the caller's job. Only the
 * eight gaze-relative actions resolve here — the pointer/menu actions below
 * are target-relative instead (resolveTarget), and fall through to the
 * explicit `default: return null` rather than being misread as a movement,
 * which is why the movement cases are spelled out instead of "everything
 * that isn't turn-left/turn-right".
 */
export function resolve(action: Action | undefined, yaw: number): Resolved {
  const result = resolveGaze(action, yaw);
  if (result?.kind !== "key") return result;
  const ch = DIRECTIONS[result.direction]!;
  return { kind: "key", code: key(result.run ? ch.toUpperCase() : ch) };
}

/**
 * Layer 2, pointer/menu side. `dir` is relative to the target (dirTo above),
 * not the camera (compass). Open, close, kick, chat and untrap all end in
 * NetHack's own getdir() prompt (src/cmd.c), so the verb and the direction
 * travel as two keystrokes — exactly what a keyboard player sends by hand
 * answering "In what direction?" — while attack has no separate verb at
 * all: the movement key alone is the classic way to hit an adjacent monster,
 * and NetHack semantics (the peaceful/pet attack confirmation) decide from
 * there. Apply needs neither a direction nor pathfinding to be sent — it
 * hands off to the engine's own item prompt exactly as if 'a' had been
 * typed. Search needs neither, for a different reason: it acts on every
 * neighbour at once.
 */
export function resolveTarget(action: Action, dir: number | null): Resolved {
  switch (action) {
    case "apply":
      return { kind: "key", code: key("a") };
    case "search":
      // 's' sweeps every neighbour at once, so there is no direction to send
      // (src/cmd.c's dosearch). It is offered on a specific wall anyway
      // (pointerActions.ts) because the wall is what makes a player suspect a
      // hidden door — the adjacency is the player's reason, not NetHack's.
      return { kind: "key", code: key("s") };
    case "attack":
      return dir === null ? null : { kind: "key", code: key(DIRECTIONS[dir]!) };
    case "open": case "close": case "kick": case "chat": case "untrap": {
      if (dir === null) return null;
      // Compiled-in default keys (src/cmd.c): 'o' open, 'c' close, C('d')
      // kick, M('c') chat, M('u') untrap. The two Meta folds are >= 128,
      // which the shim's 'c' return converter would refuse — safe here for
      // the reason the converter is never reached: a verb byte is read by
      // the command loop (rhack), and only the plain ASCII direction letter
      // after it ever lands on the getdir() yn_function.
      const verb = action === "open" ? key("o")
        : action === "close" ? key("c")
        : action === "kick" ? ctrl("d")
        : action === "chat" ? meta("c")
        : meta("u"); // untrap
      return { kind: "keys", codes: [verb, key(DIRECTIONS[dir]!)] };
    }
    default: return null; // camera-relative actions don't resolve here
  }
}

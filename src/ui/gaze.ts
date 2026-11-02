/** Pure camera-relative direction arithmetic shared by game Modules. */
export const STEP = Math.PI / 4;

/** Adjacent cell deltas, clockwise from north. */
export const STEP_OF = [
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
] as const;

export type GazeAction =
  | "move-fwd" | "move-back" | "move-left" | "move-right"
  | "move-fwd-left" | "move-fwd-right" | "move-back-left" | "move-back-right"
  | "run-fwd" | "run-back" | "run-left" | "run-right"
  | "run-fwd-left" | "run-fwd-right" | "run-back-left" | "run-back-right"
  | "turn-left" | "turn-right" | "reset-facing";

export type GazeResult =
  | { kind: "key"; direction: number; run: boolean }
  | { kind: "turn"; delta: number }
  | { kind: "reset" }
  | null;

/** Which clockwise compass eighth a camera yaw faces. */
export const compass = (yaw: number): number => Math.round(-yaw / STEP) & 7;

/** Which adjacent compass direction a cell delta names. */
export function dirTo(dx: number, dy: number): number | null {
  const direction = STEP_OF.findIndex(([x, y]) => x === dx && y === dy);
  return direction < 0 ? null : direction;
}

const OFFSET: Record<Exclude<GazeAction, "turn-left" | "turn-right" | "reset-facing">, number> = {
  "move-fwd": 0, "run-fwd": 0, "move-fwd-right": 1, "run-fwd-right": 1,
  "move-right": 2, "run-right": 2, "move-back-right": 3, "run-back-right": 3,
  "move-back": 4, "run-back": 4, "move-back-left": 5, "run-back-left": 5,
  "move-left": 6, "run-left": 6, "move-fwd-left": 7, "run-fwd-left": 7,
};

/** Resolve a gaze-relative action without choosing any game's key encoding. */
export function resolve(action: GazeAction | string | undefined, yaw: number): GazeResult {
  switch (action) {
    case "turn-left": return { kind: "turn", delta: STEP };
    case "turn-right": return { kind: "turn", delta: -STEP };
    case "reset-facing": return { kind: "reset" };
    case "move-fwd": case "move-back": case "move-left": case "move-right":
    case "move-fwd-left": case "move-fwd-right":
    case "move-back-left": case "move-back-right":
    case "run-fwd": case "run-back": case "run-left": case "run-right":
    case "run-fwd-left": case "run-fwd-right":
    case "run-back-left": case "run-back-right":
      return {
        kind: "key",
        direction: (compass(yaw) + OFFSET[action]) & 7,
        run: action.startsWith("run-"),
      };
    default: return null;
  }
}

type ChordEvent = Pick<KeyboardEvent,
  "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

/** Serialize a browser chord in one stable order for binding lookup. */
export function chord(e: ChordEvent): string {
  let out = "";
  if (e.ctrlKey) out += "Ctrl+";
  if (e.altKey) out += "Alt+";
  if (e.metaKey) out += "Meta+";
  if (e.shiftKey && e.key.length > 1) out += "Shift+";
  return out + e.key;
}

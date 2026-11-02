// Cadence policy for Angband's engine-native checkpoints. It owns no filesystem
// and makes no engine calls: it only answers "is a checkpoint due?". Angband
// saves through save_game_checked(), which writes a full save file and cannot
// be interrupted by Asyncify unwinds. The native side asks through EM_JS, so
// due() must be synchronous and throw-free.
//
// Unlike NetHack's checkpoint.ts, the first checkpoint is not free. Angband's
// birth screens issue commands before a character exists, and save_game_checked()
// would fail or write garbage. A failed save leaves the cadence due so the next
// safe input boundary retries; landed() is called by the caller only on success.

export const DEFAULT_COMMANDS = 100;
export const DEFAULT_MIN_INTERVAL_MS = 20_000;

export interface AngbandCheckpointOptions {
  commands?: number;       // default DEFAULT_COMMANDS
  minIntervalMs?: number;  // default DEFAULT_MIN_INTERVAL_MS
  now?(): number;          // default Date.now
}

export interface AngbandCheckpoint {
  /** Count one player command; call only for cmd:true key requests. */
  command(): void;
  /** True when a checkpoint should be taken. Synchronous: C asks through EM_JS. */
  due(): boolean;
  /** A checkpoint landed: reset the counter and stamp the clock. */
  landed(): void;
}

export function createAngbandCheckpoint(options?: AngbandCheckpointOptions): AngbandCheckpoint {
  const commandsPerCheckpoint = options?.commands ?? DEFAULT_COMMANDS;
  const minIntervalMs = options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const now = options?.now ?? Date.now;

  let commands = 0;
  let lastMs = now();

  return {
    command: () => void commands++,
    due: () => commands >= commandsPerCheckpoint && now() - lastMs >= minIntervalMs,
    landed: () => { commands = 0; lastMs = now(); },
  };
}

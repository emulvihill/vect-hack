// Cadence for Moria's turn-tail checkpoints. Native owns the source-pinned
// definition of a completed outer command; this object only counts each call
// and requires both the command and wall-clock thresholds.

export const DEFAULT_COMMANDS = 100;
export const DEFAULT_MIN_INTERVAL_MS = 20_000;

export interface MoriaCheckpointOptions {
  commands?: number;
  minIntervalMs?: number;
  now?(): number;
}

export interface MoriaCheckpoint {
  command(): void;
  due(): boolean;
  landed(): void;
}

export function createMoriaCheckpoint(options: MoriaCheckpointOptions = {}): MoriaCheckpoint {
  const commandsPerCheckpoint = options.commands ?? DEFAULT_COMMANDS;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let commands = 0;
  let lastMs = now();

  return {
    command: () => { commands += 1; },
    due: () => commands >= commandsPerCheckpoint && now() - lastMs >= minIntervalMs,
    landed: () => {
      commands = 0;
      lastMs = now();
    },
  };
}

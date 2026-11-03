// What one headless game leaves behind (RunSummary -> summary.json) and how
// a batch of them is tallied (scoreboard.csv, the stats line). Game-free:
// a Module's world model produces the RunSnapshot half (Larn:
// src/modules/larn/bot/model.ts snapshot()); the gym scripts supply the meta
// and do the file I/O. The columns are the same for every engine so one
// scoreboard can hold Larn, Moria, Angband and NetHack rows side by side.
//
// ".ts" import extension rule applies to this directory (see trajectory.ts).

/** died/won: the engine ended the game. capped: the command budget ran out.
 *  timeout: the orchestrator killed the child. fatal: the engine or the
 *  harness threw. running: a progress snapshot from a game still going. */
export type Outcome = "died" | "won" | "capped" | "timeout" | "fatal" | "running";

/** The game-state half of a summary; a Module's model produces it. */
export interface RunSnapshot {
  /** Deepest level reached. The primary metric for every engine. */
  depth: number;
  xlevel: number;
  hp: number;
  hpmax: number;
  /** Command-boundary answers — the bot's own moves, not every keypress. */
  commands: number;
  /** The engine's own score. Continuous, so it moves before a win rate does. */
  score: number;
  /** The engine's epitaph ("killed by a gnome", "a winner"), or "". */
  cause: string;
  lastMessages: string[];
  /** Per-game detail, keyed by game name. Reaches summary.json, never the CSV:
   *  the scoreboard stays comparable across Larn, Moria, Angband and NetHack. */
  details?: Record<string, unknown>;
}

export interface RunMeta {
  game: string;
  id: string;
  startedAt: string;
  endedAt: string;
  outcome: Outcome;
  /** The engine seed this game was played on; 0 means "seeded from the clock".
   *  Run metadata, not game state — a game does not observe its own seed. */
  seed: number;
  /** The tuning override this game was played under (the gym's --tuning), or
   *  {} for the bot's shipped knobs. Run metadata like the seed — a run cannot
   *  be assigned to a sweep arm afterwards unless it says so itself. Optional
   *  here, always present on the summary. */
  tuning?: Record<string, unknown>;
  /** The engine's last stderr lines. */
  stderr?: string[];
  /** For fatal: the error text. */
  error?: string;
}

export interface RunSummary extends RunSnapshot {
  game: string;
  id: string;
  startedAt: string;
  endedAt: string;
  outcome: Outcome;
  seed: number;
  /** The tuning override this game played under; {} for the shipped knobs.
   *  summary.json only — it is deliberately not a scoreboard column, because
   *  the CSV is shared across every engine's rows. */
  tuning: Record<string, unknown>;
  /** Trajectory lines recorded. */
  events: number;
  stderr: string[];
  error: string;
}

export function emptySummary(meta: RunMeta): RunSummary {
  return {
    game: meta.game, id: meta.id, startedAt: meta.startedAt, endedAt: meta.endedAt,
    outcome: meta.outcome, seed: meta.seed, tuning: meta.tuning ?? {},
    depth: 0, xlevel: 0, hp: 0, hpmax: 0, commands: 0, score: 0, events: 0, cause: "",
    lastMessages: [], details: {}, stderr: meta.stderr ?? [], error: meta.error ?? "",
  };
}

export function buildRunSummary(meta: RunMeta, snapshot: RunSnapshot, log: { events: number }): RunSummary {
  return { ...emptySummary(meta), ...snapshot, events: log.events };
}

/** The seed for game `index` of a batch launched with master seed `master`.
 *  Deterministic and collision-free over any realistic batch: consecutive
 *  indices must not produce correlated dungeons, so this mixes rather than
 *  adds. Always positive — 0 means "seed from the clock" to the engine hook. */
export function childSeed(master: number, index: number): number {
  let x = (BigInt(master >>> 0) * 0x9e3779b1n + BigInt(index + 1) * 0x85ebca6bn) & 0xffffffffn;
  x ^= x >> 15n; x = (x * 0x2545f491n) & 0xffffffffn;
  x ^= x >> 13n;
  return Number(x & 0x7fffffffn) || 1;
}

export const SCOREBOARD_COLUMNS = [
  "game", "id", "startedAt", "endedAt", "outcome", "seed", "depth", "xlevel", "hp", "hpmax",
  "commands", "score", "events", "cause",
] as const;
export const SCOREBOARD_HEADER = SCOREBOARD_COLUMNS.join(",");

export function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function scoreboardRow(s: RunSummary): string {
  return SCOREBOARD_COLUMNS.map((c) => csvField(String(s[c]))).join(",");
}

export interface Stats {
  games: number;
  outcomes: Record<string, number>;
  /** won / games; 0 with no games. */
  winRate: number;
  depthMedian: number;
  depthMax: number;
  commandsMedian: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarizeScoreboard(rows: Pick<RunSummary, "outcome" | "depth" | "commands">[]): Stats {
  const outcomes: Record<string, number> = {};
  for (const r of rows) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  return {
    games: rows.length,
    outcomes,
    winRate: rows.length ? (outcomes.won ?? 0) / rows.length : 0,
    depthMedian: median(rows.map((r) => r.depth)),
    depthMax: rows.reduce((m, r) => Math.max(m, r.depth), 0),
    commandsMedian: median(rows.map((r) => r.commands)),
  };
}

export function formatSummary(stats: Stats): string {
  const hist = Object.entries(stats.outcomes).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  return `${stats.games} games — ${hist} · win rate ${Math.round(stats.winRate * 100)}% · depth median ${stats.depthMedian}, max ${stats.depthMax} · commands median ${stats.commandsMedian}`;
}

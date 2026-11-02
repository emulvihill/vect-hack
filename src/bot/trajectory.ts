// The experience buffer's raw material (self-teaching bot spec, L4
// "Experience buffer"): every event an engine showed the bot and every reply
// the bot gave, one JSON line each, in order. Game-free — a Module's bot
// records its own event vocabulary through a thin decorator (Larn:
// src/modules/larn/bot/recorder.ts). The gym streams the lines to disk.
//
// ".ts" import extension rule applies to this directory: the headless gym
// loads it straight from source under node (see AGENTS.md, src/bot/).

/** JSON.stringify replacer: typed arrays (Larn's packed map records) become
 *  plain arrays, so a line can be replayed by anything that reads JSON. */
const plainArrays = (_key: string, value: unknown) =>
  ArrayBuffer.isView(value) && !(value instanceof DataView)
    ? Array.from(value as unknown as ArrayLike<number>)
    : value;

export class TrajectoryLog {
  /** Lines written so far; also the sequence number of the next one. */
  events = 0;
  /** Per-name counts, for cheap run statistics. */
  counts = new Map<string, number>();

  private sink: (line: string) => void;

  constructor(sink: (line: string) => void) {
    this.sink = sink;
  }

  record(name: string, ev: unknown, reply: unknown): void {
    const i = this.events++;
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    this.sink(JSON.stringify({ i, name, ev, reply: reply ?? null }, plainArrays));
  }
}

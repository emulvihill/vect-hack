// The trajectory log's line format and per-name counts, pinned without an
// engine: the gym replays these lines, so their shape is a contract.
import { describe, expect, it } from "vitest";
import { TrajectoryLog } from "../../src/bot/trajectory";

describe("TrajectoryLog", () => {
  it("writes one JSON line per record with a sequence number, name, event and reply (null for none)", () => {
    const lines: string[] = [];
    const log = new TrajectoryLog((l) => lines.push(l));
    log.record("text", { x: 1, y: 2, text: "hi" }, undefined);
    log.record("getKey", { wait: true, cmd: true }, { code: 104, mods: 0 });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { i: 0, name: "text", ev: { x: 1, y: 2, text: "hi" }, reply: null },
      { i: 1, name: "getKey", ev: { wait: true, cmd: true }, reply: { code: 104, mods: 0 } },
    ]);
    expect(log.events).toBe(2);
  });

  it("counts records by name", () => {
    const log = new TrajectoryLog(() => {});
    log.record("map", {}, null);
    log.record("map", {}, null);
    log.record("flush", {}, null);
    expect(log.counts.get("map")).toBe(2);
    expect(log.counts.get("flush")).toBe(1);
    expect(log.counts.get("nope")).toBeUndefined();
  });

  it("serializes typed arrays as plain arrays, so a map batch replays", () => {
    const lines: string[] = [];
    const log = new TrajectoryLog((l) => lines.push(l));
    log.record("map", { records: new Int32Array([3, 0, 1, 46]) }, null);
    expect(JSON.parse(lines[0]!).ev.records).toEqual([3, 0, 1, 46]);
  });
});

import { describe, expect, it } from "vitest";
import {
  createMoriaSemanticReporter,
  type MoriaSemanticEvent,
} from "../../src/modules/moria/semanticReporter";
import {
  GRID,
  GRID_STRIDE,
  OVERLAY,
  STATE,
  STATE_STRIDE,
  TERRAIN,
} from "../../src/modules/moria/mapRecords";

function stateWords(width = 3, height = 2): Int32Array {
  const words = new Int32Array(STATE_STRIDE);
  words[STATE.WIDTH] = width;
  words[STATE.HEIGHT] = height;
  words[STATE.PANEL_TOP] = 0;
  words[STATE.PANEL_BOTTOM] = height - 1;
  words[STATE.PANEL_LEFT] = 0;
  words[STATE.PANEL_RIGHT] = width - 1;
  words[STATE.HERO_X] = Math.min(1, width - 1);
  words[STATE.HERO_Y] = Math.min(1, height - 1);
  words[STATE.DEPTH] = 7;
  words[STATE.TURN] = 12345;
  words[STATE.PLAYER_LEVEL] = 9;
  words[STATE.EXPERIENCE] = 3210;
  words[STATE.GOLD] = 456;
  words[STATE.HP] = 17;
  words[STATE.MAX_HP] = 23;
  words[STATE.MANA] = 5;
  words[STATE.MAX_MANA] = 8;
  words[STATE.AC] = 11;
  words[STATE.BLIND] = 1;
  words[STATE.CONFUSED] = 1;
  words[STATE.POISONED] = 1;
  words[STATE.RESTING] = 1;
  words[STATE.OVERLAY] = OVERLAY.INVENTORY;
  return words;
}

function mapRecord(x: number, y: number): number[] {
  const words = new Int32Array(GRID_STRIDE);
  words[GRID.X] = x;
  words[GRID.Y] = y;
  words[GRID.TERRAIN_CAT] = TERRAIN.FLOOR;
  words[GRID.TERRAIN_KIND] = 1;
  words[GRID.TERRAIN_CHAR] = 46;
  return [...words];
}

describe("createMoriaSemanticReporter", () => {
  it("decodes the exact 25-word structured state independently from map events", () => {
    const events: MoriaSemanticEvent[] = [];
    const reporter = createMoriaSemanticReporter((event) => events.push(event));
    reporter.semanticState(stateWords(), "Public Hero");

    expect(events).toEqual([{
      name: "state",
      state: {
        width: 3, height: 2,
        panel: { top: 0, bottom: 1, left: 0, right: 2 },
        hero: { x: 1, y: 1 },
        depth: 7, turn: 12345, playerName: "Public Hero", playerLevel: 9,
        experience: 3210, gold: 456, hp: 17, maxHp: 23,
        mana: 5, maxMana: 8, ac: 11,
        blind: true, hallucinating: false, confused: true, afraid: false,
        poisoned: true, resting: true, overlay: OVERLAY.INVENTORY,
      },
    }]);
  });

  it("reads each positional word from its own slot, not a same-valued neighbour", () => {
    // The 25-word record is decoded positionally, and the fixture above gives
    // four flags the value 1 and two the value 0, hero x == y, and panel
    // top == left — so a decoder that swapped two words inside one of those
    // groups produced the identical object and no test noticed (vect-hack-8r0).
    // One flag set at a time, with an asymmetric hero and panel, makes every
    // such swap visible.
    const flags = {
      blind: STATE.BLIND,
      hallucinating: STATE.HALLUCINATING,
      confused: STATE.CONFUSED,
      afraid: STATE.AFRAID,
      poisoned: STATE.POISONED,
      resting: STATE.RESTING,
    } as const;
    for (const [name, offset] of Object.entries(flags)) {
      const words = new Int32Array(STATE_STRIDE);
      words[STATE.WIDTH] = 5;
      words[STATE.HEIGHT] = 4;
      words[STATE.PANEL_TOP] = 1;
      words[STATE.PANEL_BOTTOM] = 3;
      words[STATE.PANEL_LEFT] = 2;
      words[STATE.PANEL_RIGHT] = 4;
      words[STATE.HERO_X] = 3;
      words[STATE.HERO_Y] = 0;
      words[offset] = 1;

      const events: MoriaSemanticEvent[] = [];
      createMoriaSemanticReporter((event) => events.push(event))
        .semanticState(words, `only ${name}`);
      const event = events[0]!;
      if (event.name !== "state") throw new Error("expected a state event");
      const state = event.state;
      const set = Object.keys(flags).filter((f) => state[f as keyof typeof flags]);
      expect(set).toEqual([name]);
      expect(state.hero).toEqual({ x: 3, y: 0 });
      expect(state.panel).toEqual({ top: 1, bottom: 3, left: 2, right: 4 });
    }
  });

  it("copies WASM-backed map words synchronously and transfers only that copy", () => {
    const posted: Array<{ event: MoriaSemanticEvent; transfer: Transferable[] }> = [];
    const reporter = createMoriaSemanticReporter((event, transfer = []) => {
      posted.push({ event, transfer });
    });
    reporter.semanticState(stateWords(1, 1), "A");
    const source = Int32Array.from(mapRecord(0, 0));
    reporter.semanticMap(source, true);
    source.fill(99);

    const map = posted[1]!.event;
    expect(map).toMatchObject({ name: "map", reset: true });
    if (map.name !== "map") throw new Error("expected map event");
    expect([...map.records]).toEqual(mapRecord(0, 0));
    expect(map.records).not.toBe(source);
    expect(posted[1]!.transfer).toEqual([map.records.buffer]);
    expect(posted[0]!.transfer).toEqual([]);
  });

  // vect-hack-8r0: this used to be named "... without invoking a WASM export"
  // and carried a `const noExport = vi.fn()` that was passed to nothing, so
  // `expect(noExport).not.toHaveBeenCalled()` was true by construction. The
  // reporter is built from the post callback alone — there is no seam through
  // which any export could reach such a mock — so the claim is a property of
  // createMoriaSemanticReporter's signature, which tsc pins, not of anything
  // this test could observe. The ordering half was, and stays, live.
  it("preserves native state-map-message ordering", () => {
    const events: MoriaSemanticEvent[] = [];
    const reporter = createMoriaSemanticReporter((event) => events.push(event));
    reporter.semanticState(stateWords(1, 1), "A");
    reporter.semanticMap(Int32Array.from(mapRecord(0, 0)), true);
    reporter.semanticMessage("You hit the orc.");
    expect(events.map(({ name }) => name)).toEqual(["state", "map", "message"]);
    expect(events[2]).toEqual({ name: "message", text: "You hit the orc." });
  });

  it("requires reset batches to be complete, unique, and inside active dimensions", () => {
    const reporter = createMoriaSemanticReporter(() => {});
    expect(() => reporter.semanticMap(Int32Array.from(mapRecord(0, 0)), true))
      .toThrowError("before structured state");
    reporter.semanticState(stateWords(), "A");
    expect(() => reporter.semanticMap(Int32Array.from(mapRecord(0, 0)), true))
      .toThrowError("complete active grid");
    const repeated = Int32Array.from([
      ...mapRecord(0, 0), ...mapRecord(1, 0), ...mapRecord(2, 0),
      ...mapRecord(0, 1), ...mapRecord(1, 1), ...mapRecord(1, 1),
    ]);
    expect(() => reporter.semanticMap(repeated, true)).toThrowError("duplicate coordinate");
    const outside = Int32Array.from([
      ...mapRecord(0, 0), ...mapRecord(1, 0), ...mapRecord(2, 0),
      ...mapRecord(0, 1), ...mapRecord(1, 1), ...mapRecord(3, 1),
    ]);
    expect(() => reporter.semanticMap(outside, true)).toThrowError("outside active Moria bounds");
    const full = Int32Array.from([
      ...mapRecord(0, 0), ...mapRecord(1, 0), ...mapRecord(2, 0),
      ...mapRecord(0, 1), ...mapRecord(1, 1), ...mapRecord(2, 1),
    ]);
    expect(() => reporter.semanticMap(full, true)).not.toThrow();
  });

  it("accepts a bounded unique diff and rejects empty, oversized, malformed, and duplicate diffs", () => {
    const reporter = createMoriaSemanticReporter(() => {});
    reporter.semanticState(stateWords(), "A");
    expect(() => reporter.semanticMap(Int32Array.from([
      ...mapRecord(0, 0), ...mapRecord(2, 1),
    ]), false)).not.toThrow();
    expect(() => reporter.semanticMap(new Int32Array(), false)).toThrowError("empty Moria map batch");
    expect(() => reporter.semanticMap(new Int32Array(GRID_STRIDE - 1), false))
      .toThrowError("whole packed records");
    expect(() => reporter.semanticMap(Int32Array.from([
      ...mapRecord(0, 0), ...mapRecord(0, 0),
    ]), false)).toThrowError("duplicate coordinate");
    expect(() => reporter.semanticMap(Int32Array.from(Array.from(
      { length: 7 }, (_, i) => mapRecord(i % 3, Math.floor(i / 3)),
    ).flat()), false)).toThrowError("exceeds active Moria grid");
  });

  it("rejects malformed structured state and accepts the zero-dimension startup state", () => {
    const reporter = createMoriaSemanticReporter(() => {});
    expect(() => reporter.semanticState(new Int32Array(STATE_STRIDE - 1), "A"))
      .toThrowError("25 words");
    const badBoolean = stateWords();
    badBoolean[STATE.BLIND] = 2;
    expect(() => reporter.semanticState(badBoolean, "A")).toThrowError("boolean flag");
    const badOverlay = stateWords();
    badOverlay[STATE.OVERLAY] = 10;
    expect(() => reporter.semanticState(badOverlay, "A")).toThrowError("overlay");
    const startup = new Int32Array(STATE_STRIDE);
    startup[STATE.HERO_X] = -1;
    startup[STATE.HERO_Y] = -1;
    expect(() => reporter.semanticState(startup, "")).not.toThrow();
  });
});

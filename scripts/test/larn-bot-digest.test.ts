// The Larn run digest: the small public projection of one finished game that
// reflection is allowed to see (spec: 2026-08-19-bot-phase1b-larn-reflect-
// design.md, "The digest").
//
// The fixtures here are deliberately built the way the gym's trajectory file
// holds them, not the way the worker posts them: TrajectoryLog's `plainArrays`
// replacer turns every typed array into a plain one on the way to disk, so a
// builder that hands `ev.records` straight to the classifier decodes nothing
// and silently produces an empty digest. Every record below is a plain array.
//
// The synthetic cases below are not enough on their own, and were not: they
// passed while two real defects stood (vect-hack-b5f.2.2). The recorded runs
// under fixtures/reflect/batch/ are the backstop — see the second describe.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DIGEST_LIMITS, runGrounds } from "../../src/bot/digest";
import { buildLarnDigest } from "../../src/modules/larn/bot/digest";
import { GRID, GRID_STRIDE, KIND_NAMES, TERRAIN, TOP } from "../../src/modules/larn/mapRecords";
import { STATUS, STATUS_HEADER } from "../../src/modules/larn/statusRecords";
import { emptySummary, type RunSummary } from "../../src/bot/scoreboard";

interface Line { name: string; ev: unknown; reply: unknown }

/** One cell as larn_map_info packs it, in the 9-word GRID layout. */
interface CellSpec {
  x: number; y: number;
  cat?: number; ch?: string; color?: number; kind?: string;
  top?: number; topCh?: string; topColor?: number;
}

function mapLine(cells: CellSpec[]): Line {
  const r = new Int32Array(cells.length * GRID_STRIDE);
  cells.forEach((c, i) => {
    const o = i * GRID_STRIDE;
    r[o + GRID.X] = c.x;
    r[o + GRID.Y] = c.y;
    r[o + GRID.TERRAIN_CAT] = c.cat ?? TERRAIN.FLOOR;
    r[o + GRID.TERRAIN_CHAR] = (c.ch ?? ".").codePointAt(0)!;
    r[o + GRID.TERRAIN_COLOR] = c.color ?? 7;
    r[o + GRID.TERRAIN_KIND] = KIND_NAMES.indexOf(c.kind ?? "");
    r[o + GRID.TOP_CAT] = c.top ?? TOP.NONE;
    r[o + GRID.TOP_CHAR] = (c.topCh ?? " ").codePointAt(0)!;
    r[o + GRID.TOP_COLOR] = c.topColor ?? 7;
  });
  return { name: "map", ev: { records: Array.from(r) }, reply: null };
}

/** One status push: the named fields at their STATUS offsets, zeros elsewhere
 *  (SLOTS 0, NAME_BYTES 0, so the name blob is empty). */
function statusLine(fields: Partial<Record<keyof typeof STATUS, number>>): Line {
  const record = new Int32Array(STATUS_HEADER);
  for (const [k, v] of Object.entries(fields)) record[STATUS[k as keyof typeof STATUS]] = v!;
  return { name: "status", ev: { record: Array.from(record), names: [] }, reply: null };
}

/** A command boundary: the engine asked for a command and the bot answered. */
const cmdLine = (): Line => ({ name: "getKey", ev: { wait: true, cmd: true }, reply: { code: 62, mods: 0 } });
/** A nested prompt answer — a key, but not a command. */
const promptLine = (): Line => ({ name: "getKey", ev: { wait: true, cmd: false }, reply: { code: 99, mods: 0 } });
/** A poll the engine never blocks on; the bot answers nothing. */
const pollLine = (): Line => ({ name: "getKey", ev: { wait: false, cmd: false }, reply: null });
const levelLine = (): Line => ({ name: "level", ev: { width: 67, height: 17 }, reply: null });

function summaryOf(over: Partial<RunSummary> = {}): RunSummary {
  const base = emptySummary({
    game: "larn", id: "t0", startedAt: "2026-08-19T00:00:00.000Z",
    endedAt: "2026-08-19T00:01:00.000Z", outcome: "died", seed: 4242,
  });
  return { ...base, ...over };
}

/** The town's volcanic shaft: hero on it, a demon lord next door. */
const shaftCells: CellSpec[] = [
  { x: 5, y: 5, cat: TERRAIN.STAIRS, ch: "V", kind: "down", color: 4, top: TOP.HERO },
  { x: 6, y: 5, top: TOP.MONSTER, topCh: "D", topColor: 1 },
];

describe("buildLarnDigest", () => {
  it("records the descent with the exit character the hero stood on", () => {
    // The order Larn actually produces: the move command lands the hero on the
    // shaft, the frame drawing them there arrives, and the engine's own "climb
    // down" prompt follows — so the exit is never the cell the last COMMAND
    // boundary saw, and there need be no command boundary after the descent.
    const lines: Line[] = [
      statusLine({ DEPTH: 0, XLEVEL: 1, HP: 12, HPMAX: 12 }),
      mapLine([{ x: 4, y: 5, cat: TERRAIN.FLOOR, ch: ".", top: TOP.HERO }]),
      pollLine(),
      cmdLine(),        // the move east, from the floor onto the shaft
      mapLine(shaftCells),
      promptLine(),     // "Do you (c) climb down, or (i) ignore it?"
      levelLine(),
      mapLine([{ x: 10, y: 10, cat: TERRAIN.FLOOR, ch: ".", top: TOP.HERO }]),
      statusLine({ DEPTH: 11, XLEVEL: 1, HP: 9, HPMAX: 12 }),
    ];

    const d = buildLarnDigest(lines, summaryOf({ depth: 11 }));

    // The category comes with the character: "stairs:V" is the key the avoid
    // table is read by, and a descent that named only the glyph left the
    // reflect prompt unable to offer the claim at all (vect-hack-b5f.6).
    expect(d.descents).toEqual([
      { category: "stairs", ch: "V", kind: "down", fromDepth: 0, toDepth: 11, xlevel: 1, hp: 9, hpmax: 12, atCommand: 1 },
    ]);
  });

  it("reports what the screen drew under a fall the hero did not choose", () => {
    // A trap door the hero never discovered draws floor and drops them. The
    // category has to be that floor, not the trap underneath: it is what the
    // player saw, and it is what keeps an unchosen fall out of the claim keys
    // the reflect prompt offers (src/bot/digest.ts, AVOIDABLE_CATEGORIES).
    const lines: Line[] = [
      statusLine({ DEPTH: 1, XLEVEL: 1, HP: 12, HPMAX: 12 }),
      mapLine([{ x: 5, y: 5, cat: TERRAIN.FLOOR, ch: ".", top: TOP.HERO }]),
      cmdLine(),
      levelLine(),
      mapLine([{ x: 10, y: 10, cat: TERRAIN.FLOOR, ch: ".", top: TOP.HERO }]),
      statusLine({ DEPTH: 2, XLEVEL: 1, HP: 9, HPMAX: 12 }),
    ];

    expect(buildLarnDigest(lines, summaryOf({ depth: 2 })).descents).toEqual([
      { category: "floor", ch: ".", kind: "", fromDepth: 1, toDepth: 2, xlevel: 1, hp: 9, hpmax: 12, atCommand: 1 },
    ]);
  });

  // vect-hack-b5f.17. Both numbers exist so a death and an exit can be read
  // against what the hero could take. The trap is that Larn's own death drives
  // hp to zero or below on the very status line that reports the new depth —
  // recorded run 0002 descends and dies four commands in — so a builder that
  // copied the current reading would publish "-16 of 10" as the capacity a
  // choice was made with, and a threshold built from it would be nonsense.
  it("reports the last LIVING hit points, for the death and for the exit", () => {
    const lines: Line[] = [
      statusLine({ DEPTH: 0, XLEVEL: 1, HP: 10, HPMAX: 10 }),
      mapLine(shaftCells),
      cmdLine(),
      levelLine(),
      mapLine([{ x: 10, y: 10, cat: TERRAIN.FLOOR, ch: ".", top: TOP.HERO }]),
      // The drop and the death arrive together: this line says depth 11 and
      // hp -16 at once.
      statusLine({ DEPTH: 11, XLEVEL: 1, HP: -16, HPMAX: 10 }),
    ];

    const d = buildLarnDigest(lines, summaryOf({ depth: 11, hp: -16, hpmax: 10 }));

    expect(d.hpBeforeDeath).toBe(10);
    expect(d.hp).toBe(-16);            // the end-of-game number is still reported
    expect(d.descents[0]!.hp).toBe(10);
    expect(d.descents[0]!.hpmax).toBe(10);
  });

  it("carries the adjacent being and the terrain the hero stood on", () => {
    const lines: Line[] = [
      statusLine({ DEPTH: 0, XLEVEL: 1 }),
      mapLine(shaftCells),
      cmdLine(),
      levelLine(),
      mapLine([{ x: 10, y: 10, cat: TERRAIN.FLOOR, ch: ".", top: TOP.HERO }]),
      statusLine({ DEPTH: 11, XLEVEL: 1 }),
      cmdLine(),
    ];

    const d = buildLarnDigest(lines, summaryOf());

    expect(d.finalAdjacent).toEqual([{ ch: "D", color: 1, atCommand: 0 }]);
    expect(d.finalTerrain).toEqual([
      { category: "stairs", ch: "V", kind: "down", atCommand: 0 },
      { category: "floor", ch: ".", kind: "", atCommand: 1 },
    ]);
  });

  it("keeps at most DIGEST_LIMITS entries, dropping the oldest", () => {
    const lines: Line[] = [];
    for (let i = 0; i < 25; i++) {
      // level, map, status is the order the engine posts them in.
      lines.push(levelLine());
      lines.push(mapLine([
        { x: 5, y: 5, cat: TERRAIN.STAIRS, ch: "%", kind: "down", top: TOP.HERO },
        { x: 6, y: 5, top: TOP.MONSTER, topCh: "D", topColor: 1 },
      ]));
      lines.push(statusLine({ DEPTH: 1 + (i % 2), XLEVEL: 1 }));
      lines.push(cmdLine());
    }
    const messages = Array.from({ length: 15 }, (_, i) => `message ${i}`);

    const d = buildLarnDigest(lines, summaryOf({ lastMessages: messages }));

    expect(d.finalTerrain).toHaveLength(DIGEST_LIMITS.terrain);
    expect(d.finalTerrain[0]!.atCommand).toBe(25 - DIGEST_LIMITS.terrain);
    expect(d.finalTerrain[d.finalTerrain.length - 1]!.atCommand).toBe(24);
    expect(d.finalAdjacent).toHaveLength(DIGEST_LIMITS.adjacent);
    expect(d.finalAdjacent[d.finalAdjacent.length - 1]!.atCommand).toBe(24);
    // 24 depth changes over 25 levels, capped to the last 20.
    expect(d.descents).toHaveLength(DIGEST_LIMITS.descents);
    expect(d.descents[d.descents.length - 1]!.atCommand).toBe(24);
    expect(d.descents.every((x) => x.ch === "%" && x.kind === "down")).toBe(true);
    expect(d.lastMessages).toEqual(messages.slice(-DIGEST_LIMITS.messages));
  });

  it("takes its scalars from the summary", () => {
    const d = buildLarnDigest([], summaryOf({
      outcome: "died", cause: "killed by a lama", seed: 99,
      depth: 11, xlevel: 3, hp: 0, hpmax: 14, commands: 22,
      lastMessages: ["The lama hits you."],
      details: { larn: { gold: 40, mobulsElapsed: 7 } },
    }));

    expect(d).toMatchObject({
      game: "larn", seed: 99, outcome: "died", cause: "killed by a lama",
      depth: 11, xlevel: 3, hp: 0, hpmax: 14, commands: 22, mobulsElapsed: 7,
      lastMessages: ["The lama hits you."],
    });
  });

  // The killer join (vect-hack-b5f.4). `cause` names the killer in prose and
  // `finalAdjacent` lists glyphs; nothing tied the two, so a reflecting model
  // read adjacency as causation. __wrap_died supplies the tie, and everything
  // below is about refusing to publish it when the screen did not back it up.
  describe("the killer", () => {
    const deathLine = (ch: string): Line => ({ name: "death", ev: { ch }, reply: null });
    /** A `D` and a `B` both beside the hero: the case the bug got wrong. */
    const crowdedCells: CellSpec[] = [
      { x: 5, y: 5, cat: TERRAIN.FLOOR, ch: ".", top: TOP.HERO },
      { x: 6, y: 5, top: TOP.MONSTER, topCh: "D", topColor: 1 },
      { x: 4, y: 5, top: TOP.MONSTER, topCh: "B", topColor: 1 },
    ];
    const crowded = (tail: Line[]): Line[] => [
      statusLine({ DEPTH: 11, XLEVEL: 1 }),
      mapLine(crowdedCells),
      cmdLine(),
      ...tail,
    ];

    it("names the being the engine says struck, not the one that stood nearby", () => {
      const d = buildLarnDigest(crowded([deathLine("D")]), summaryOf({ cause: "killed by a platinum dragon" }));
      // capacity is null here because the fixture's status line carries no HP
      // fields: no living reading was ever shown, and inventing one is what
      // the capacity suite below forbids.
      expect(d.killer).toEqual({ ch: "D", color: 1, atCommand: 0, capacity: null });
      // The bystander is still reported — it was on the screen — but it is no
      // longer indistinguishable from the killer.
      expect(d.finalAdjacent.map((a) => a.ch).sort()).toEqual(["B", "D"]);
    });

    it("names nobody when the death was not a being's doing", () => {
      // An arrow trap: the epitaph says "shot by an arrow" and __wrap_died
      // sends "". A bat standing beside the corpse killed nothing.
      const d = buildLarnDigest(crowded([deathLine("")]), summaryOf({ cause: "shot by an arrow" }));
      expect(d.killer).toBeNull();
    });

    it("names nobody when the killer was never drawn beside the hero", () => {
      // The engine knows what struck; the screen did not show it there. A
      // glyph the player never saw is outside what the digest may report.
      const d = buildLarnDigest(crowded([deathLine("n")]), summaryOf({ cause: "killed by a spirit naga" }));
      expect(d.killer).toBeNull();
    });

    it("takes the last death event: life protection withdraws the one before", () => {
      // died() returns when a charge is spent, and __wrap_died sends "" on the
      // way out. The hero then died to something else entirely.
      const d = buildLarnDigest(
        crowded([deathLine("B"), deathLine(""), mapLine(crowdedCells), cmdLine(), deathLine("D")]),
        summaryOf({ cause: "killed by a platinum dragon" }),
      );
      expect(d.killer).toEqual({ ch: "D", color: 1, atCommand: 1, capacity: null });
    });

    it("names nobody when the run did not end in a death", () => {
      // The withdrawal is one event in a stream that can be cut short. A run
      // the harness capped has no killer whatever the last event said, so an
      // interrupted withdrawal cannot promote an averted death into one.
      const d = buildLarnDigest(crowded([deathLine("D")]), summaryOf({ outcome: "capped", cause: "" }));
      expect(d.killer).toBeNull();
    });

    it("names nobody for a trajectory recorded before the engine reported it", () => {
      const d = buildLarnDigest(crowded([]), summaryOf({ cause: "killed by a platinum dragon" }));
      expect(d.killer).toBeNull();
    });
  });

  // The capacity the killer beat (vect-hack-b5f.20). A threat's value is
  // measured from the run, and the instant it is sampled at decides what the
  // table converges to. The last living reading before the fatal blow is the
  // wrong instant: nearly every Larn melee death is a multi-blow grind, so a
  // being that beat a full-health hero down 10→7→3→dead would read 0.3 —
  // "finished a hero already lost" — and the threat channel would converge
  // low, the mirror image of 1b's all-1.0 table. The right number is the most
  // the hero was seen holding while THIS being stood beside them, within its
  // final engagement: adjacency with gaps of at most two commands, reset on a
  // level change because the beings on the new level are different
  // individuals. Each case below fails on one wrong instant, so a refactor
  // that quietly changes the choice fails here by name.
  describe("the capacity the killer beat", () => {
    const deathLine = (ch: string): Line => ({ name: "death", ev: { ch }, reply: null });
    const heroWithD: CellSpec[] = [
      { x: 5, y: 5, cat: TERRAIN.FLOOR, ch: ".", top: TOP.HERO },
      { x: 6, y: 5, top: TOP.MONSTER, topCh: "D", topColor: 1 },
    ];
    const heroAlone: CellSpec[] = [{ x: 5, y: 5, cat: TERRAIN.FLOOR, ch: ".", top: TOP.HERO }];
    /** A map batch is a delta, not a frame: the D stays on the grid until a
     *  batch overwrites its cell, so "the being left" has to be drawn. */
    const dGone: CellSpec[] = [{ x: 6, y: 5, cat: TERRAIN.FLOOR, ch: "." }];

    it("reports the capacity the fight began with, not the reading before the fatal blow", () => {
      const lines: Line[] = [
        statusLine({ DEPTH: 1, XLEVEL: 1, HP: 10, HPMAX: 10 }),
        mapLine(heroWithD),
        cmdLine(),
        statusLine({ DEPTH: 1, XLEVEL: 1, HP: 7, HPMAX: 10 }),
        mapLine(heroWithD),
        cmdLine(),
        statusLine({ DEPTH: 1, XLEVEL: 1, HP: 3, HPMAX: 10 }),
        mapLine(heroWithD),
        deathLine("D"),
      ];

      const d = buildLarnDigest(lines, summaryOf({ hp: -2, hpmax: 10 }));

      expect(d.killer?.capacity).toEqual({ hp: 10, hpmax: 10 });
      // The last living reading is still reported — it says how the run ended
      // — but it is not what the killer is measured against.
      expect(d.hpBeforeDeath).toBe(3);
      expect(runGrounds(d).killedAtCapacity).toBe(1);
    });

    it("measures the final engagement, not an earlier meeting with the same glyph", () => {
      // A D stood beside a healthy hero and wandered off; three commands
      // later — hurt by something else in between — the hero met another D
      // and died to it. Same glyph, different fight: the capacity is the one
      // the fatal engagement began with, or a harmless early pass-by ratchets
      // a bar no death ever reached.
      const lines: Line[] = [
        statusLine({ DEPTH: 1, XLEVEL: 1, HP: 10, HPMAX: 10 }),
        mapLine(heroWithD),
        cmdLine(),
        mapLine(dGone),
        cmdLine(),
        mapLine(dGone),
        cmdLine(),
        mapLine(dGone),
        cmdLine(),
        statusLine({ DEPTH: 1, XLEVEL: 1, HP: 4, HPMAX: 10 }),
        mapLine(heroWithD),
        deathLine("D"),
      ];

      const d = buildLarnDigest(lines, summaryOf({ hp: -1, hpmax: 10 }));

      expect(d.killer?.capacity).toEqual({ hp: 4, hpmax: 10 });
    });

    it("keeps one fight together across a step the being took to follow", () => {
      // The hero backs off a cell and the being pursues: one frame shows it
      // out of reach and the next shows it adjacent again. A streak that
      // breaks there restarts the measurement at the mid-fight reading — the
      // exact degeneration this measurement exists to fix — so an absence of
      // at most two commands is the same engagement.
      const lines: Line[] = [
        statusLine({ DEPTH: 1, XLEVEL: 1, HP: 10, HPMAX: 10 }),
        mapLine(heroWithD),
        cmdLine(),
        mapLine(dGone),
        cmdLine(),
        statusLine({ DEPTH: 1, XLEVEL: 1, HP: 7, HPMAX: 10 }),
        mapLine(heroWithD),
        cmdLine(),
        statusLine({ DEPTH: 1, XLEVEL: 1, HP: 3, HPMAX: 10 }),
        mapLine(heroWithD),
        deathLine("D"),
      ];

      const d = buildLarnDigest(lines, summaryOf({ hp: -2, hpmax: 10 }));

      expect(d.killer?.capacity).toEqual({ hp: 10, hpmax: 10 });
    });

    it("takes the peak of the engagement, not its first reading", () => {
      // A hero who drinks a potion mid-fight and still dies was beaten at the
      // healed capacity: the being finished a 9-hp hero, and a measurement
      // pinned to the fight's first reading would certify it as one that only
      // kills the nearly-dead.
      const lines: Line[] = [
        statusLine({ DEPTH: 1, XLEVEL: 1, HP: 4, HPMAX: 12 }),
        mapLine(heroWithD),
        cmdLine(),
        statusLine({ DEPTH: 1, XLEVEL: 1, HP: 9, HPMAX: 12 }),
        mapLine(heroWithD),
        deathLine("D"),
      ];

      const d = buildLarnDigest(lines, summaryOf({ hp: 0, hpmax: 12 }));

      expect(d.killer?.capacity).toEqual({ hp: 9, hpmax: 12 });
    });

    it("starts fresh on a level change: the beings there are different individuals", () => {
      // A D was adjacent in town at full health; the hero descended and met
      // another D within the two-command window. Without the reset the town
      // meeting rides into the new fight and a 3-hp death certifies a
      // full-health kill.
      const lines: Line[] = [
        statusLine({ DEPTH: 0, XLEVEL: 1, HP: 10, HPMAX: 10 }),
        mapLine(heroWithD),
        cmdLine(),
        levelLine(),
        mapLine(heroAlone),
        statusLine({ DEPTH: 1, XLEVEL: 1, HP: 3, HPMAX: 10 }),
        cmdLine(),
        mapLine(heroWithD),
        deathLine("D"),
      ];

      const d = buildLarnDigest(lines, summaryOf({ hp: -4, hpmax: 10 }));

      expect(d.killer?.capacity).toEqual({ hp: 3, hpmax: 10 });
    });

    it("reports no capacity when the screen never showed a living reading", () => {
      const lines: Line[] = [
        mapLine(heroWithD),
        deathLine("D"),
      ];

      const d = buildLarnDigest(lines, summaryOf({ hp: -1, hpmax: 10 }));

      expect(d.killer).not.toBeNull();
      expect(d.killer?.capacity).toBeNull();
      expect(runGrounds(d).killedAtCapacity).toBeNull();
    });
  });

  it("records no descent when the depth never changed", () => {
    const lines: Line[] = [
      statusLine({ DEPTH: 0, XLEVEL: 1 }),
      mapLine(shaftCells),
      cmdLine(),
      cmdLine(),
      statusLine({ DEPTH: 0, XLEVEL: 1 }),
      cmdLine(),
    ];

    expect(buildLarnDigest(lines, summaryOf()).descents).toEqual([]);
  });
});

// Three real recorded games. A hand-built event list encodes what the author
// believes the engine does; these encode what it did. Both defects in
// vect-hack-b5f.2.2 were invisible to the synthetic cases above and obvious
// here, so this block is the one that must not be deleted for being slow.
const BATCH = new URL("./fixtures/reflect/batch/", import.meta.url);

function recordedRun(id: string): { lines: Line[]; summary: RunSummary } {
  const dir = new URL(`${id}/`, BATCH);
  const gz = readFileSync(new URL("trajectory.jsonl.gz", dir));
  const lines = gunzipSync(gz).toString("utf8").trim().split("\n").map((l) => JSON.parse(l) as Line);
  return { lines, summary: JSON.parse(readFileSync(new URL("summary.json", dir), "utf8")) as RunSummary };
}

describe("buildLarnDigest over recorded Larn runs", () => {
  // Run 0001 walked off the bank ("$") onto the dungeon entrance ("E") and the
  // prompt fired before the next command was ever asked for: reading the exit
  // off the last command boundary names the bank.
  it("names the exit the hero left by, not the cell the last command saw", () => {
    const { lines, summary } = recordedRun("larn-20260820T185838Z-93207-0001");

    expect(buildLarnDigest(lines, summary).descents).toEqual([
      { category: "stairs", ch: "E", kind: "down", fromDepth: 0, toDepth: 1, xlevel: 1, hp: 10, hpmax: 10, atCommand: 9 },
    ]);
  });

  // Run 0002 is the phase's central case in miniature: a level-1 character
  // takes the town's volcanic shaft and is dead at depth 11 four commands in.
  // The game never asks for another command, so a boundary-triggered detector
  // records nothing at all — and this is precisely the run that demonstrates
  // the fact the reflect loop exists to learn.
  it("records a descent that is the last thing a run ever did", () => {
    const { lines, summary } = recordedRun("larn-20260820T185838Z-93207-0002");
    const d = buildLarnDigest(lines, summary);

    expect(summary.outcome).toBe("died");
    expect(summary.commands).toBe(4);
    expect(d.descents).toEqual([
      { category: "stairs", ch: "V", kind: "down", fromDepth: 0, toDepth: 11, xlevel: 1, hp: 10, hpmax: 10, atCommand: 4 },
    ]);
  });

  // Run 0003 took the shaft too, then declined the shaft back up on the level
  // below — an exit the hero stood on and did not use must not become a
  // descent, or the count of shaft trips is wrong in both directions.
  it("records the shaft taken and not the one declined", () => {
    const { lines, summary } = recordedRun("larn-20260820T185838Z-93207-0003");

    expect(buildLarnDigest(lines, summary).descents).toEqual([
      { category: "stairs", ch: "V", kind: "down", fromDepth: 0, toDepth: 11, xlevel: 1, hp: 10, hpmax: 10, atCommand: 12 },
    ]);
  });

  // The three runs together are the whole argument for sampling per frame.
  // 0002 gains its killer, which no command boundary could have seen; 0003
  // gains nothing, because nothing was ever there. A change that filled the
  // field with noise would pass the first of these and fail the second.
  it("sees the killer standing beside the corpse, in a frame no command followed", () => {
    const { lines, summary } = recordedRun("larn-20260820T185838Z-93207-0002");
    const d = buildLarnDigest(lines, summary);

    expect(summary.cause).toBe("killed by a xvart");
    expect(d.finalAdjacent).toEqual([{ ch: "x", color: 1, atCommand: 4 }]);
    // The same frames carry the terrain half: the run's last known ground is
    // the shaft it left by, not the town floor its last command stood on.
    expect(d.finalTerrain[d.finalTerrain.length - 1]).toEqual({
      category: "stairs", ch: "V", kind: "down", atCommand: 4,
    });
  });

  it("records nothing adjacent when the killer never came close", () => {
    const { lines, summary } = recordedRun("larn-20260820T185838Z-93207-0003");
    const d = buildLarnDigest(lines, summary);

    // "The platinum dragon flattens you with his psionics!" — killed from
    // range, so an empty list is the honest answer and not a missed sighting.
    expect(summary.cause).toBe("killed by a platinum dragon");
    expect(d.finalAdjacent).toEqual([]);
  });

  it("records the beings a fighting run really did stand next to", () => {
    const { lines, summary } = recordedRun("larn-20260820T185838Z-93207-0001");
    const d = buildLarnDigest(lines, summary);

    expect(summary.lastMessages).toContain("You hit the hobgoblin");
    expect(d.finalAdjacent).toEqual([
      { ch: "H", color: 1, atCommand: 50 },
      { ch: "H", color: 1, atCommand: 51 },
    ]);
  });

  it("decodes the recorded map records, which reach it as plain arrays", () => {
    const { lines, summary } = recordedRun("larn-20260820T185838Z-93207-0003");
    const d = buildLarnDigest(lines, summary);

    // A builder that skipped the typed-array revival sees an empty grid, so
    // every list below would be empty and every assertion above still passes
    // vacuously except the descents.
    expect(Array.isArray((lines.find((l) => l.name === "map")!.ev as { records: unknown }).records)).toBe(true);
    expect(d.finalTerrain.length).toBeGreaterThan(0);
    expect(d.finalTerrain.every((t) => t.ch.length > 0)).toBe(true);
    expect(d.mobulsElapsed).toBe(2);
  });
});

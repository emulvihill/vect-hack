// The Larn bot's world model, built solely from observed LarnEvents: the tty
// surface (LarnGrid), the semantic grid (map batches through LarnClassifier),
// the typed status record the native tap pushes, the text of the prompt the
// engine is currently asking, and game over. Pure TypeScript, no DOM — the
// same model serves the browser ?bot and the headless gym.
//
// The status tap is the single source of truth for hp, depth, gold and the
// rest: nothing here re-reads tty rows 17/18 for them. What is still parsed
// from the screen is what the tap does not carry — the message rows and
// diedsub()'s score line (scores.c). Nothing here knows a monster.
//
// ".ts" import extensions: the headless gym loads this straight from source.
import type { LarnEvent } from "../protocol.ts";
import { CellGrid } from "../../../backplane/cell.ts";
import { LARN_COLS, LARN_ROWS, LarnClassifier } from "../classifier.ts";
import { LarnGrid } from "../grid.ts";
import { decodeStatus, type LarnStatus } from "../statusRecords.ts";
import type { RunSnapshot } from "../../../bot/scoreboard.ts";

/** Rows of Larn's scrolling message region (main-wasm.c scrline 19..23). */
export const MESSAGE_ROWS: readonly [number, number] = [19, 23];

/** Larn's own refusal when take() finds no free pack slot
 *  (external/larn/global.c:481). It is the whole carrying-capacity model the
 *  bot has, on purpose: the engine already answers the question, and a
 *  weight/slot model of ours could only disagree with it. */
const PACK_FULL = /can't carry anything else/i;

/** Everything the tap reports that take()'s answer depends on. */
const packStateOf = (s: LarnStatus) => `${s.inventory.length}:${s.xlevel}`;

/** The first volcano level, internal 11 = "V1" (data.c levelname[]). Levels
 *  0-10 are the town and the dungeon chain; the Eye is at 10, the bottom of
 *  the ordinary route. */
export const VOLCANO_FIRST = 11;

/** levelname[] in data.c: " H", " 1".." 9", "10", "V1".."V3". */
export function levelDepth(name: string): number {
  if (name === "H") return 0;
  const v = /^V([1-3])$/.exec(name);
  if (v) return 10 + Number(v[1]);
  const n = /^(\d{1,2})$/.exec(name);
  return n ? Number(n[1]) : -1;
}

/** diedsub() prints `Score: %ld, Diff: %ld,  %s ` then `killed by a %s`
 *  or a whydead[] entry, then ` on %s` (the level name) except for a win. */
export function causeOfDeath(scoreLine: string): string {
  const m = /^Score:\s*-?\d+,\s*Diff:\s*-?\d+,\s+\S+\s+(.+?)(?:\s+on\s+\S+)?\s*$/.exec(scoreLine.trim());
  return m ? m[1]! : "";
}

/** diedsub() prints `Score: %ld, Diff: %ld,  ...`. The score is the game's own
 *  continuous measure of a run — the metric that can still show improvement
 *  while the win rate is zero, which is why it is kept rather than skipped. */
export function scoreOf(scoreLine: string): number {
  const m = /^Score:\s*(-?\d+),/.exec(scoreLine.trim());
  return m ? Number(m[1]) : 0;
}

export class LarnBotModel {
  tty = new LarnGrid();
  map = new CellGrid(LARN_COLS, LARN_ROWS);
  /** The last public status record; null before the first frame. */
  status: LarnStatus | null = null;
  /** null while the screen hides the level ("LV: ?"). */
  depth: number | null = null;
  maxDepth = 0;
  /** The deepest level reached in each of Larn's two chains, kept apart
   *  because they are not the same journey. The town's volcanic shaft drops
   *  straight to internal 11 (create.c:396-410), bypassing the dungeon
   *  entirely, so a rider who dies on command 19 posts `maxDepth` 11 and a
   *  hero who fought down five staircases posts 5. Pooling them produced the
   *  batch median of 5 that describes neither population
   *  (docs/specs/2026-08-28-larn-bench-design.md). Internal 0-10
   *  is the dungeon chain, 11-13 is V1-V3. */
  maxDungeonDepth = 0;
  maxVolcanoDepth = 0;
  /** Bumped on every `level` event. The policy watches this rather than a
   *  level *name*: the status line hides the level under TELEFLAG, and a
   *  teleport is precisely when stale map geometry must be dropped. */
  levelEpoch = 0;
  xlevel = 0;
  hp = 0;
  hpmax = 0;
  gold = 0;
  overlay = false;
  commands = 0;
  gameOver = false;
  /** The engine has refused a pickup for want of a slot and has not since
   *  reported a smaller pack. Latched, not per-prompt: take() prints the
   *  refusal once and the next item asks the same question, so a state that
   *  expired with the message would answer "take" again every time
   *  (vect-hack-b5f.10). It survives a level change — the hero carries the
   *  pack down the stairs. */
  packFull = false;
  /** The pack the engine refused, as "<occupied slots>:<experience level>",
   *  or "" before any refusal.
   *
   *  Both halves come from the status tap, and both can make the answer
   *  different: an item can leave the pack (dropped, read, stolen, rusted),
   *  and take()'s own limit is 15 + (c[LEVEL] >> 1) capped at 26
   *  (external/larn/global.c), so a level gained is a slot gained every other
   *  time. That formula is deliberately NOT copied here — it is a game rule,
   *  and a second copy of one drifts. When the state it depends on moves, the
   *  latch clears and the engine is asked again; a pack that is still full
   *  answers with one more refusal and re-latches. */
  private packFullState = "";
  textSinceLastKey = "";
  /** The message rows as they stood before the last `clear`: died() wipes
   *  the screen before printing the score line, so a summary taken after
   *  death would otherwise carry no messages. */
  private lastSeenMessages: string[] = [];

  private classifier = new LarnClassifier();

  observe(ev: LarnEvent): void {
    switch (ev.name) {
      case "text":
        this.tty.text(ev.x, ev.y, ev.rgb, ev.text);
        this.textSinceLastKey += ev.text;
        // Read off the accumulated text, not this fragment: lprcat writes the
        // line in one call today, but a split would otherwise lose the match.
        // Before the first status record there is no slot count to clear the
        // latch against, and a latch with no way out is a livelock of its own.
        if (!this.packFull && this.status !== null && PACK_FULL.test(this.textSinceLastKey)) {
          this.packFull = true;
          this.packFullState = packStateOf(this.status);
        }
        return;
      case "wipe": this.tty.wipe(ev.x, ev.y, ev.n); return;
      case "curs": this.tty.curs(ev.x, ev.y); return;
      case "clear": {
        const m = this.messages();
        if (m.length) this.lastSeenMessages = m;
        this.tty.clear();
        return;
      }
      case "flush": return;
      // The killer's glyph is about the run, not about the world the bot is
      // still playing in: nothing here can act on it. The run digest
      // reads the event off the trajectory itself (bot/digest.ts).
      case "death": return;
      case "map":
        for (const { x, y, cell } of this.classifier.classify(ev.records)) this.map.set(x, y, cell);
        return;
      case "level": this.map.clear(); this.levelEpoch++; return;
      case "overlay": this.overlay = ev.active; return;
      case "status": {
        const s = decodeStatus(ev.record, ev.names);
        this.status = s;
        this.hp = s.hp; this.hpmax = s.hpmax;
        this.xlevel = s.xlevel; this.gold = s.gold;
        this.depth = s.depth;
        if (s.depth !== null) {
          if (s.depth > this.maxDepth) this.maxDepth = s.depth;
          if (s.depth >= VOLCANO_FIRST) {
            if (s.depth > this.maxVolcanoDepth) this.maxVolcanoDepth = s.depth;
          } else if (s.depth > this.maxDungeonDepth) this.maxDungeonDepth = s.depth;
        }
        if (this.packFull && packStateOf(s) !== this.packFullState) this.packFull = false;
        return;
      }
    }
  }

  /** The bot answered a key: the prompt text is spent; a command counts. */
  keyAnswered(cmd: boolean): void {
    this.textSinceLastKey = "";
    if (cmd) this.commands++;
  }

  onQuit(): void { this.gameOver = true; }

  row(y: number): string { return this.tty.cells[y]!.map((c) => c.ch).join(""); }

  messages(): string[] {
    const out: string[] = [];
    for (let y = MESSAGE_ROWS[0]; y <= MESSAGE_ROWS[1]; y++) {
      const t = this.row(y).trim();
      if (t) out.push(t);
    }
    return out;
  }

  /** died() clears the screen first, so the epitaph is row 0. */
  scoreLine(): string { return this.row(0).trim(); }

  won(): boolean { return causeOfDeath(this.scoreLine()) === "a winner"; }

  snapshot(): RunSnapshot {
    return {
      depth: this.maxDepth, xlevel: this.xlevel, hp: this.hp, hpmax: this.hpmax,
      commands: this.commands, cause: causeOfDeath(this.scoreLine()),
      score: scoreOf(this.scoreLine()),
      lastMessages: (this.messages().length ? this.messages() : this.lastSeenMessages).slice(-10),
      details: {
        larn: {
          // The bench's co-primary depth metric reads these, never `depth`.
          dungeonDepth: this.maxDungeonDepth,
          volcanoDepth: this.maxVolcanoDepth,
          gold: this.gold,
          mobulsElapsed: this.status?.mobulsElapsed ?? 0,
          mobulsLeft: this.status?.mobulsLeft ?? 0,
          conditions: this.status?.conditions ?? [],
          inventory: this.status?.inventory ?? [],
        },
      },
    };
  }
}

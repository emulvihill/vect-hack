// The bot's decision-making: pure functions over a BotModel. decide() is a
// priority ladder - first matching need wins - and movement is BFS over the
// explored grid with NetHack's no-diagonal-through-doorways rule.
import { TERRAIN_CATEGORIES, isHostile, type Category } from "../../../backplane/cell";
import { NETHACK_COLS as COLNO, NETHACK_ROWS as ROWNO } from "../classifier";
import { CLR } from "../../../backplane/colors";
import type { BotModel } from "./model";

export interface BotAction {
  keys: number[];
  /** When keys starts with '#': the extended command get_ext_cmd should pick. */
  extCmd?: string;
  intent: string;
}

export interface Step { x: number; y: number; dir: string; door: boolean }

export const k = (ch: string) => ch.charCodeAt(0);
const CTRL_D = 4;

/** yubn-hjkl order matters only in that it is stable; ties break consistently. */
const DIRS = [
  { dx: -1, dy: 0, ch: "h" }, { dx: 1, dy: 0, ch: "l" },
  { dx: 0, dy: -1, ch: "k" }, { dx: 0, dy: 1, ch: "j" },
  { dx: -1, dy: -1, ch: "y" }, { dx: 1, dy: -1, ch: "u" },
  { dx: -1, dy: 1, ch: "b" }, { dx: 1, dy: 1, ch: "n" },
];

const NO_GO: Category[] = ["wall", "water", "lava", "trap"];

export function passable(model: BotModel, x: number, y: number): boolean {
  if (x < 0 || x >= COLNO || y < 0 || y >= ROWNO) return false;
  if (!model.explored[y * COLNO + x]) return false;
  const c = model.map.at(x, y);
  if (c.hero) return true;
  if (c.category === "item") return true;     // items sit on floor
  if (c.category === "being") return false;   // walk-into is handled as fight
  if (!TERRAIN_CATEGORIES.has(c.category)) return false;
  return !NO_GO.includes(c.category);
}

function isDoorway(model: BotModel, x: number, y: number): boolean {
  const t = model.map.at(x, y).category;
  return t === "door" || t === "door-open";
}

export function isFrontier(model: BotModel, x: number, y: number): boolean {
  if (!passable(model, x, y)) return false;
  for (const d of DIRS) {
    const nx = x + d.dx, ny = y + d.dy;
    if (nx < 0 || nx >= COLNO || ny < 0 || ny >= ROWNO) continue;
    if (!model.explored[ny * COLNO + nx]) return true;
  }
  return false;
}

const posKey = (x: number, y: number) => y * COLNO + x;

/** BFS from the hero; returns the FIRST step toward the nearest target cell. */
export function nextStep(
  model: BotModel,
  isTarget: (x: number, y: number) => boolean,
  blocked: Set<number>,
): Step | null {
  const hero = model.map.hero;
  if (!hero) return null;
  const prev = new Int32Array(COLNO * ROWNO).fill(-1);
  const start = posKey(hero.x, hero.y);
  prev[start] = start;
  const queue = [start];
  let found = -1;
  while (queue.length) {
    const cur = queue.shift()!;
    const cx = cur % COLNO, cy = (cur / COLNO) | 0;
    if (cur !== start && isTarget(cx, cy)) { found = cur; break; }
    for (const d of DIRS) {
      const nx = cx + d.dx, ny = cy + d.dy;
      const nk = posKey(nx, ny);
      if (nx < 0 || nx >= COLNO || ny < 0 || ny >= ROWNO) continue;
      if (prev[nk] !== -1 || blocked.has(nk)) continue;
      if (!passable(model, nx, ny)) continue;
      // NetHack forbids diagonal movement into or out of a doorway.
      const diagonal = d.dx !== 0 && d.dy !== 0;
      if (diagonal && (isDoorway(model, cx, cy) || isDoorway(model, nx, ny))) continue;
      prev[nk] = cur;
      queue.push(nk);
    }
  }
  if (found === -1) return null;
  let cur = found;
  while (prev[cur] !== start) cur = prev[cur]!;
  const x = cur % COLNO, y = (cur / COLNO) | 0;
  const dir = DIRS.find((d) => d.dx === x - hero.x && d.dy === y - hero.y)!;
  return { x, y, dir: dir.ch, door: model.map.at(x, y).category === "door" };
}

/** BFS distance sweep from the hero over passable, explored cells (same
 *  adjacency rules as nextStep); returns the posKey of the last cell visited
 *  - the farthest reachable one, by BFS layer - or null when the hero can't
 *  move anywhere. Used to give a camping search a fresh vantage point. */
export function farthestPassable(model: BotModel, hero: { x: number; y: number }): number | null {
  const start = posKey(hero.x, hero.y);
  const seen = new Uint8Array(COLNO * ROWNO);
  seen[start] = 1;
  let layer = [start];
  let farthest = -1;
  while (layer.length) {
    const next: number[] = [];
    for (const cur of layer) {
      farthest = cur;
      const cx = cur % COLNO, cy = (cur / COLNO) | 0;
      for (const d of DIRS) {
        const nx = cx + d.dx, ny = cy + d.dy;
        if (nx < 0 || nx >= COLNO || ny < 0 || ny >= ROWNO) continue;
        const nk = posKey(nx, ny);
        if (seen[nk] || !passable(model, nx, ny)) continue;
        const diagonal = d.dx !== 0 && d.dy !== 0;
        if (diagonal && (isDoorway(model, cx, cy) || isDoorway(model, nx, ny))) continue;
        seen[nk] = 1;
        next.push(nk);
      }
    }
    layer = next;
  }
  return farthest === start ? null : farthest;
}

/** The engine's step-onto-loot announcements at the pinned release: one object
 *  is `You("%s here %s.", verb, ...)` with verb "see" or, blind, "feel"
 *  (invent.c look_here); a pile past pile_limit collapses to
 *  `There("is %s object here.", "an"|"another")` or
 *  `There("are %s%s objects here.", "two"|"a few"|"several"|"many", " more"|"")`
 *  (invent.c, and the traditional-menu twin at pickup.c). The literal noun
 *  "object" is what keeps terrain out: dfeature and trap lines share the
 *  "There is ... here." shape ("There is a fountain here.") but dfeature_at()
 *  never names one. "You see|feel no objects here." is the empty-tile line. */
export function lootHereMessage(text: string): boolean {
  return /^You (see|feel) here /.test(text)
    || /^There (is an(other)? object|are (two|a few|several|many)( more)? objects) here\./.test(text);
}

const PRAY_COOLDOWN = 900; // decisions, not turns; time is off by default
const SEARCH_WANDER_THRESHOLD = 10; // consecutive no-op searches before wandering

const MOVE_INTENTS = new Set(["explore", "descend", "open", "kick", "wander"]);

export class BotBrain {
  private sincePray = PRAY_COOLDOWN + 1;
  private noFood = false;
  private lastHunger = "";
  private lastPos = -1;
  private lastIntent = "";
  private lastStep = -1; // posKey of the cell the last movement aimed at
  private stuck = 0;
  private blocked = new Set<number>();
  private looted = -1; // posKey where we last picked up, to not loop on it
  private searchStreak = 0; // consecutive searches at the same position
  private wanderTarget = -1; // posKey of a rotate-away-from-camping target, or -1

  decide(model: BotModel): BotAction {
    this.sincePray++;
    const hero = model.map.hero;
    const here = hero ? posKey(hero.x, hero.y) : -1;

    // Level change / teleport: the old block list is another level's geometry.
    if (this.lastPos !== -1 && here !== -1 && dist(this.lastPos, here) > 3) {
      this.blocked.clear();
      this.stuck = 0;
      this.searchStreak = 0;
      this.wanderTarget = -1;
    }
    // Anti-stuck: a movement intent that didn't move (boulder, unseen
    // obstacle, peaceful in the way) marks the cell it aimed at as blocked,
    // so the next path routes around it. Doors get more attempts (~12) than
    // plain cells (3) since locked doors need multiple kicks to break.
    if (MOVE_INTENTS.has(this.lastIntent)) {
      if (here === this.lastPos) {
        if (++this.stuck >= 3 && this.lastStep !== -1) {
          const stepX = this.lastStep % COLNO, stepY = (this.lastStep / COLNO) | 0;
          const isDoor = model.map.at(stepX, stepY).category === "door";
          const threshold = isDoor ? 12 : 3;
          if (this.stuck >= threshold) {
            this.blocked.add(this.lastStep);
            this.stuck = 0;
          }
        }
      } else {
        this.stuck = 0;
      }
    }
    // Search streak: consecutive no-op searches at the same spot; any other
    // intent (including a wander already in progress) resets it.
    if (this.lastIntent === "search" && here === this.lastPos) this.searchStreak++;
    else if (this.lastIntent !== "search" && this.lastIntent !== "wander") this.searchStreak = 0;
    if (this.lastHunger !== model.hunger) { this.noFood = false; this.lastHunger = model.hunger; }
    if (/don't have anything to eat/i.test(model.lastMessage())) this.noFood = true;
    this.lastPos = here;

    const action = this.pick(model, hero);
    this.lastIntent = action.intent;
    return action;
  }

  private pick(model: BotModel, hero: { x: number; y: number } | null): BotAction {
    this.lastStep = -1;
    if (model.gameOver || !hero) return { keys: [27], intent: "idle" }; // ESC

    // 1. Emergency: low HP or starving with nothing to eat.
    const lowHp = model.hpmax > 0 && model.hp <= Math.max(Math.ceil(model.hpmax / 7), 3);
    const starving = /Weak|Fainting/.test(model.hunger) && this.noFood;
    if ((lowHp || starving) && this.sincePray > PRAY_COOLDOWN) {
      this.sincePray = 0;
      return { keys: [k("#")], extCmd: "pray", intent: "pray" };
    }
    // 2. Fight an adjacent hostile (never a floating eye: passive damage).
    for (const d of DIRS) {
      const c = model.map.at(hero.x + d.dx, hero.y + d.dy);
      if (isHostile(c)) {
        if (c.ch === "e" && c.color === CLR.BLUE) {
          this.blocked.add(posKey(hero.x + d.dx, hero.y + d.dy));
          continue;
        }
        return { keys: [k(d.ch)], intent: "fight" };
      }
    }
    // 3. Eat from inventory when hungry.
    if (model.hunger !== "" && !/Satiated/.test(model.hunger) && !this.noFood) {
      return { keys: [k("e")], intent: "eat" };
    }
    // 4. Loot when the engine just announced an item underfoot.
    const here = posKey(hero.x, hero.y);
    if (here !== this.looted && lootHereMessage(model.lastMessage())) {
      this.looted = here;
      return { keys: [k(",")], intent: "loot" };
    }
    // 5. Explore toward the frontier; doors get opened (or kicked when locked).
    const step = nextStep(model, (x, y) => isFrontier(model, x, y), this.blocked);
    if (step) return this.walk(model, step, "explore");
    // 6. Descend. Prefer the remembered position over a live '>' scan - an
    // item or monster sitting on the stairs hides the glyph, and once the
    // hero has walked past it may never redraw.
    if (model.map.under?.ch === ">") return { keys: [k(">")], intent: "descend" };
    if (model.stairsDown) {
      const { x: sx, y: sy } = model.stairsDown;
      const down = nextStep(model, (x, y) => x === sx && y === sy, this.blocked);
      if (down) return this.walk(model, down, "descend");
    } else {
      const down = nextStep(model, (x, y) => model.map.at(x, y).ch === ">", this.blocked);
      if (down) return this.walk(model, down, "descend");
    }
    // 7. Search for hidden passages - but don't camp on a dead tile. After
    // enough consecutive searches with no movement, wander to the farthest
    // reachable cell and search again from there.
    if (this.wanderTarget !== -1 && here === this.wanderTarget) {
      this.wanderTarget = -1;
      this.searchStreak = 0;
    }
    if (this.wanderTarget !== -1) {
      const step = nextStep(model, (x, y) => posKey(x, y) === this.wanderTarget, this.blocked);
      if (step) return this.walk(model, step, "wander");
      this.wanderTarget = -1; // route gone; fall through to searching in place
      this.searchStreak = 0;
    } else if (this.searchStreak >= SEARCH_WANDER_THRESHOLD) {
      const target = farthestPassable(model, hero);
      if (target !== null && target !== here) {
        this.wanderTarget = target;
        const step = nextStep(model, (x, y) => posKey(x, y) === target, this.blocked);
        if (step) return this.walk(model, step, "wander");
      }
      this.searchStreak = 0; // nowhere better to go; keep searching here
    }
    return { keys: [k("s")], intent: "search" };
  }

  private walk(model: BotModel, step: Step, intent: string): BotAction {
    this.lastStep = posKey(step.x, step.y);
    if (step.door) {
      if (/door is locked/i.test(model.lastMessage()))
        return { keys: [CTRL_D, k(step.dir)], intent: "kick" };
      return { keys: [k("o"), k(step.dir)], intent: "open" };
    }
    return { keys: [k(step.dir)], intent };
  }
}

function dist(a: number, b: number): number {
  const ax = a % COLNO, ay = (a / COLNO) | 0, bx = b % COLNO, by = (b / COLNO) | 0;
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

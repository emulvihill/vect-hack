// Pointer-driven contextual actions (vect-hack-be3.3). The pointer is an
// action device only — no click ever means "walk here" (be3.2 declined
// click-to-move) — so a click can act on a target unambiguously. Both tiers
// below are table entries over moveKeys.ts's Action layer: a later target
// (door -> open, item -> pick up, fountain -> quaff) is a new row here, never
// a new branch at the call site in VectorView.
//
// That prediction held: be3.7 added close, search, untrap and a wider kick as
// rows, and one PRIMARY_TABLE entry, with no change at the call site. The
// verbs it could NOT add are the stand-on ones (pick up, quaff, the stairs) —
// NetHack requires the hero to be on the cell, and reaching one by pointer
// would mean walking there, which be3.2 declined. Those live in
// commandMenu.ts instead.
import { isHostile, type Cell, type CellGrid } from "../../../backplane/cell";
import { dirTo, type Action } from "./moveKeys";
import { key } from "./keys";

/** The subset of Action a menu row can offer; movement/turn never show up
 *  here, so ACTION_LABEL below doesn't have to cover them. */
export type MenuAction = Extract<Action,
  "attack" | "open" | "close" | "kick" | "chat" | "apply" | "search" | "untrap">;

/**
 * What's under the pointer, resolved against the hero. `dir` is null for
 * anything outside the eight neighbours — pointer actions never pathfind, so
 * a target out of reach simply has no direction to act in.
 */
export interface PointerTarget {
  dir: number | null;
  cell: Cell;
  isHero: boolean;
  isPet: boolean;
  isHostile: boolean;
}

/** Build a target from a map cell; null off the map, on an empty cell, or
 *  before the first hero position is known. */
export function targetAt(map: CellGrid, x: number, y: number): PointerTarget | null {
  const hero = map.hero;
  if (!hero) return null;
  const cell = map.at(x, y);
  if (cell.category === "unseen") return null;
  return {
    dir: dirTo(x - hero.x, y - hero.y),
    cell,
    isHero: x === hero.x && y === hero.y,
    isPet: cell.pet === true,
    isHostile: isHostile(cell),
  };
}

/** One row of the primary-action table: does this rule fit the target, and
 *  if so which single verb does the click become? First match wins, so a
 *  later target (door -> open, item -> pick up, fountain -> quaff) is a row
 *  appended here, never a new branch at a call site. */
interface PrimaryRule { applies(t: PointerTarget): boolean; action: Action }

/** Hostile monster -> attack and closed door -> open. Neither may match a
 *  peaceful monster or the hero's own pet — isHostile already excludes both.
 *  First match wins. */
const PRIMARY_TABLE: readonly PrimaryRule[] = [
  { applies: (t) => t.cell.category === "being" && t.isHostile, action: "attack" },
  // The row be3.3's design reserved by name. A closed door has exactly one
  // verb a player ever wants first, and getting it wrong costs a turn, not a
  // life — unlike a click on a monster.
  { applies: (t) => t.cell.category === "door", action: "open" },
];

/**
 * Left click: the one obvious verb for the target, or nothing. Never fires
 * for a target out of the eight neighbours, since pointer actions do not
 * pathfind (declined alongside click-to-move, be3.2).
 */
export function primaryAction(t: PointerTarget): Action | undefined {
  if (t.dir === null) return undefined;
  return PRIMARY_TABLE.find((r) => r.applies(t))?.action;
}

/** One row of the full-menu table: does this rule fit the target, and if so
 *  which verbs does the menu offer, in order. */
interface MenuRule { applies(t: PointerTarget): boolean; actions(t: PointerTarget): MenuAction[] }

// First match wins, so order is meaningful: the monster row comes first
// because a monster standing in a doorway is a monster, not a door.
//
// A door/wall/trap Category can only come from a terrain cell (the
// Classifier owns that split), so a bare Category test cannot be reached by
// a being or an item and needs no group test in front of it.
//
// Everything here is adjacency-relative, which is what lets applicableActions
// keep its single `dir === null` gate. The verbs that need no neighbour —
// inventory, pick up, the stairs, save — are not cell actions at all: they
// live in the command menu (src/modules/nethack/ui/commandMenu.ts,
// vect-hack-be3.7), because NetHack's own versions are stand-on verbs and the
// hero's cell draws as "@", so this layer cannot even see what is underneath.
// The day a row here wants a verb that needs no direction, that gate has to
// move into the rows. The hero's own cell never reaches that gate at all: VectorView
// branches on `isHero` first and builds its menu from heroActions below.
const MENU_TABLE: readonly MenuRule[] = [
  {
    // Pets keep "attack" off the list even though adjacency would otherwise
    // let it through — the one case with solid data stays off the button,
    // not just off the one-click default. Non-pet monsters still offer it:
    // NetHack has no way to tell this layer whether they're peaceful (see
    // isHostile), and the engine's own attack confirmation is what actually
    // guards them. A pet is not offered a kick either, for the same reason
    // it is not offered an attack.
    applies: (t) => t.cell.category === "being" && !t.isHero,
    actions: (t) => t.isPet ? ["chat"] : ["attack", "chat", "kick"],
  },
  { applies: (t) => t.cell.category === "door", actions: () => ["open", "kick", "apply"] },
  { applies: (t) => t.cell.category === "door-open", actions: () => ["close", "kick", "apply"] },
  // A wall is where a player suspects a hidden door, so this is where the
  // search command is worth surfacing — even though 's' itself sweeps every
  // neighbour at once and takes no direction (moveKeys.resolveTarget).
  { applies: (t) => t.cell.category === "wall", actions: () => ["search"] },
  { applies: (t) => t.cell.category === "trap", actions: () => ["untrap"] },
  // Kick reaches the classic "kick it and see" targets: chests and boulders
  // (objects), sinks, fountains and thrones (features). It stays off floor,
  // corridor, stairs, water and lava, where a kick only ever costs a turn.
  {
    applies: (t) => t.cell.category === "item" || t.cell.category === "feature",
    actions: () => ["kick"],
  },
];

/** Right click: every action that applies to the target, in menu order. */
export function applicableActions(t: PointerTarget): MenuAction[] {
  if (t.dir === null) return [];
  return MENU_TABLE.find((r) => r.applies(t))?.actions(t) ?? [];
}

/** Menu row text. Lives with the table that decides when an action shows,
 *  not scattered at the call site. Kick is no longer door-specific, so its
 *  label no longer names one. */
export const ACTION_LABEL: Record<MenuAction, string> = {
  attack: "Attack", chat: "Chat", open: "Open door", close: "Close door",
  kick: "Kick", apply: "Apply...", search: "Search here", untrap: "Untrap",
};

/** One row of the hero's stand-on menu. Plain {label, code} like
 *  commandMenu.ts's rows, not an Action: an Action exists so one verb
 *  resolves identically from a key, a click or a menu row against a
 *  direction, and these have no direction and no rebinding story (be3.7). */
export interface HeroCommand { label: string; code: number }

/**
 * The stand-on menu for the hero's own cell — the verbs MENU_TABLE cannot
 * offer because they require standing on the target, which the pointer
 * cannot arrange (be3.2 declined click-to-move). `under` is the CellGrid's
 * stash of the Cell the `@` covered; stairs rows appear only when it proves a
 * staircase, and only the matching one — the codes are the compiled-in
 * defaults from external/NetHack's src/cmd.c, same as commandMenu.ts.
 */
export function heroActions(under: Cell | null): HeroCommand[] {
  const rows: HeroCommand[] = [
    { label: "Pick up", code: key(",") },
    { label: "Look here", code: key(":") },
  ];
  if (under?.ch === "<") rows.push({ label: "Go up stairs", code: key("<") });
  if (under?.ch === ">") rows.push({ label: "Go down stairs", code: key(">") });
  return rows;
}

/**
 * The engine's own step-onto-loot announcements (do.c/pickup.c at the pinned
 * NetHack revision): the detection mechanism for auto-opening the stand-on
 * menu. Deliberately narrow — feature announcements ("There is a staircase
 * up here.") do not auto-open, and the blind "You feel here" variant is out
 * of scope (spec). String-matching is safe to pin against because
 * build-nethack-wasm.sh refuses any other NetHack release; this function's tests are
 * the tripwire if the pin ever moves.
 */
export function itemHereMessage(text: string): boolean {
  return /^You see here /.test(text)
    || /^There are (several|many) objects here\./.test(text);
}

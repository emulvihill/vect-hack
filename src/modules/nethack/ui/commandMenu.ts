// The commands that need no target (vect-hack-be3.7): the other half of
// "playable without memorizing classic keybindings". The pointer's cell menus
// (pointerActions.ts) can only ever offer verbs that act on a neighbour, and
// NetHack's everyday commands mostly do not — inventory, pick up, the stairs
// and save either take no target at all or require the hero to be standing on
// one, which the pointer cannot arrange (be3.2 declined click-to-move).
//
// This is plain data, deliberately not part of moveKeys.ts's Action layer. An
// Action exists so one verb resolves identically from a key, a click or a menu
// row *against a direction*; none of these has a direction, and none has a
// rebinding story, so adding twenty-eight of them would inflate ACTIONS and
// the be3.5 binding table for nothing.
//
// Every letter below is the compiled-in default from external/NetHack's
// src/cmd.c command list, checked there rather than recalled. Directional
// verbs (open, close, kick, untrap, chat) are deliberately absent: they end in
// getdir(), and a menu with no target has no answer for it.
import { ctrl, key, meta } from "./keys";

export interface Command {
  label: string;
  /** The single key NetHack reads for this command. */
  code: number;
}

export interface CommandGroup {
  label: string;
  commands: readonly Command[];
}

/** Grouped so no submenu is longer than a glance; the order within a group is
 *  roughly how often a turn needs it. */
export const COMMAND_GROUPS: readonly CommandGroup[] = [
  {
    label: "Items",
    commands: [
      { label: "Inventory", code: key("i") },
      { label: "Pick up", code: key(",") },
      { label: "Drop", code: key("d") },
      { label: "Eat", code: key("e") },
      { label: "Read", code: key("r") },
      { label: "Quaff (drink)", code: key("q") },
      { label: "Apply a tool", code: key("a") },
    ],
  },
  {
    label: "Gear",
    commands: [
      { label: "Wield a weapon", code: key("w") },
      { label: "Wear armor", code: key("W") },
      { label: "Take off armor", code: key("T") },
      { label: "Put on an accessory", code: key("P") },
      { label: "Remove an accessory", code: key("R") },
      { label: "Throw", code: key("t") },
      { label: "Fire from quiver", code: key("f") },
    ],
  },
  {
    label: "Explore",
    commands: [
      { label: "Search", code: key("s") },
      { label: "Rest a turn", code: key(".") },
      { label: "Look here", code: key(":") },
      { label: "Go up stairs", code: key("<") },
      { label: "Go down stairs", code: key(">") },
    ],
  },
  {
    label: "Magic",
    commands: [
      { label: "Cast a spell", code: key("Z") },
      { label: "Zap a wand", code: key("z") },
      { label: "Engrave", code: key("E") },
      // NetHack's only compiled-in key for prayer is Meta-p, the same shape
      // chat's Meta-c takes — reachable here without a real Alt keypress.
      { label: "Pray", code: meta("p") },
    ],
  },
  {
    label: "Game",
    commands: [
      { label: "Discoveries", code: key("\\") },
      { label: "Dungeon overview", code: ctrl("o") },
      { label: "Options", code: key("O") },
      { label: "Help", code: key("?") },
      { label: "Save and quit", code: key("S") },
    ],
  },
];
// Rule tables answering NetHack's prompts. Everything the policy doesn't
// drive on purpose falls back to the engine's own default - NetHack chose
// those to be safe - and unknown menus cancel.
import type { ExtCmd, MenuItemData, SelectMenuReply } from "../protocol";
import { k } from "./policy";

const ESC = 27;

/** First a-zA-Z character in a getobj choices string ("dfg or ?*") - an
 *  inventory letter; the punctuation alternatives are menus we don't want. */
function firstLetter(choices: string): number | null {
  const m = /[a-zA-Z]/.exec(choices.split(" or ")[0] ?? choices);
  return m ? k(m[0]) : null;
}

/** getobj prompts (e.g. "What do you want to eat? [d-g or ?*]") carry the
 *  legal inventory letters in the query's bracket segment, not in choices -
 *  getobj calls yn_function with an empty choices string (invent.c). Fall
 *  back to choices, then ESC, if the query has no usable letter. */
function firstLetterFromQuery(query: string, choices: string): number {
  const bracket = /\[([^\]]*)\]/.exec(query);
  if (bracket) {
    const m = /[a-zA-Z]/.exec(bracket[1]!.split(" or ")[0] ?? bracket[1]!);
    if (m) return k(m[0]);
  }
  return firstLetter(choices) ?? ESC;
}

const YN_RULES: [RegExp, (choices: string, def: number, query: string) => number][] = [
  [/^Are you sure you want to pray/i, () => k("y")],
  [/^Do you want (to try )?the tutorial/i, () => k("n")],
  [/^Shall I pick/i, () => k("n")], // we pick the character ourselves via menus
  [/^Really attack/i, () => k("n")], // peacefuls read like hostiles; decline
  [/here; (eat|force)/i, () => k("n")], // floor food is how bots die
  [/^What do you want to (eat|drink)/i, (_choices, _def, query) => firstLetterFromQuery(query, _choices)],
  [/^Do you want to see your (attributes|possessions)/i, () => k("n")], // death paperwork
];

export function answerYn(query: string, choices: string, def: number): number {
  for (const [re, answer] of YN_RULES) if (re.test(query)) return answer(choices, def, query);
  if (def) return def;
  return ESC;
}

const MENU_RULES: [RegExp, RegExp | "all" | "first"][] = [
  [/tutorial/i, /no/i], // decline tutorial menu (PICK_ONE, never cancel)
  [/Pick a role/i, /Valkyrie/],
  [/Pick a race/i, /human/i],
  [/Pick a gender/i, /female/i],
  [/Pick an alignment/i, /lawful/i],
  [/Pick up what/i, "all"],
  [/What do you want to eat/i, "first"],
];

export function answerMenu(prompt: string, items: MenuItemData[], how: number): SelectMenuReply {
  if (how === 0) return { picks: [] }; // PICK_NONE: display only
  const selectable = items.filter((i) => i.identifier !== 0);
  for (const [re, want] of MENU_RULES) {
    if (!re.test(prompt)) continue;
    if (want === "all") {
      // Corpses rot and poison: leave them on the floor rather than hoard
      // them into inventory, where the hunger path will eventually eat one
      // days old. Gold, weapons, armor, food rations etc. are still taken.
      const picks = selectable.filter((i) => !/\bcorpses?\b/i.test(i.text));
      return { picks: picks.map((i) => ({ identifier: i.identifier, count: -1, itemflags: i.itemflags })) };
    }
    const match = want === "first" ? selectable[0] : selectable.find((i) => (want as RegExp).test(i.text)) ?? selectable[0];
    return match ? { picks: [{ identifier: match.identifier, count: -1, itemflags: match.itemflags }] } : { picks: [] };
  }
  return { picks: [] }; // unknown menu: cancel
}

export function extCmdIndex(commands: ExtCmd[], want: string): number {
  if (!want) return -1;
  return commands.findIndex((c) => c.name === want);
}

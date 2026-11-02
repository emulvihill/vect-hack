// The node half of the KB read path: src/bot/kb.ts must never touch a
// filesystem (the browser bot shares it), so every node host reads the four
// data/kb files here and hands the parsed content in. The browser's ?bot
// branch does the same with static JSON imports (src/main.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKb } from "../../src/bot/kb.ts";

/** A file of the repo's own data/kb: always the checkout's, whatever the cwd. */
const repoJson = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8"));
/** A file of a caller-named KB directory: resolved like any other path the
 *  caller typed, so it agrees with the gym's own existence check. */
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

/** The Larn bot's KB, read from `dir` (`<dir>/meta/facts.json`,
 *  `<dir>/larn/facts.json`, `<dir>/larn/policy.json`).
 *
 *  `null` — the default, and what an unflagged gym run gets — is the untaught
 *  seed bot: empty fact tiers, so nothing sitting on disk can reach a control
 *  run or the frozen keystroke trace. Tuning still comes from the repo's own
 *  policy.json in both arms: the knobs the ladder was born with are the bot's
 *  constitution, not part of the experiment, and an A/B whose arms differ in
 *  tuning as well as facts measures two changes at once. */
export function larnKb(dir = null) {
  if (dir === null) {
    return loadKb({
      meta: { facts: [] },
      engine: { facts: [] },
      policy: repoJson("data/kb/larn/policy.json"),
    });
  }
  return loadKb({
    meta: json(join(dir, "meta/facts.json")),
    engine: json(join(dir, "larn/facts.json")),
    policy: json(join(dir, "larn/policy.json")),
  });
}

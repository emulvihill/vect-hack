// Split a committed fact set into single-kind knowledge bases, for the
// attribution experiment (vect-hack-b5f.24).
//
// r4c measured one improvement and could not attribute it: the mechanism runs
// through `avoid-terrain`, the claim kind whose ablation-probe leaks are
// ADMITTED under vect-hack-b5f.23, so the gain may be the model's prior
// knowledge of roguelikes rather than anything the bot learned. The threat half
// is clean — a threat leak still fails a batch and none did. Playing each half
// alone against the same held-out cohort is what separates them.
//
// Writes a whole KB directory (meta/, larn/) so the gym's --kb can point at it
// and every run records the compiled hash it actually played under.
//
//   node scripts/dev/kb-split.mjs --facts <facts.json> --kinds threat,note --out <dir>
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { larnKb } from "./bot-kb.mjs";

const { values: opts } = parseArgs({
  options: {
    facts: { type: "string" },
    kinds: { type: "string" },
    out: { type: "string" },
    kb: { type: "string", default: "data/kb" },
  },
});
const die = (m) => { console.error(m); process.exit(2); };
if (!opts.facts || !opts.kinds || !opts.out) {
  die("usage: kb-split.mjs --facts <facts.json> --kinds threat,note --out <dir> [--kb data/kb]");
}
const keep = new Set(opts.kinds.split(",").map((s) => s.trim()).filter(Boolean));

const all = JSON.parse(readFileSync(opts.facts, "utf8")).facts ?? [];
const facts = all.filter((f) => keep.has(f.claim.kind));

mkdirSync(join(opts.out, "meta"), { recursive: true });
mkdirSync(join(opts.out, "larn"), { recursive: true });
// The meta tier and the tuning are the SAME in every arm on purpose: the only
// thing that differs between arms is which claim kinds survive the filter, so
// a difference in play cannot be a difference in the knobs.
copyFileSync(join(opts.kb, "meta/facts.json"), join(opts.out, "meta/facts.json"));
copyFileSync(join(opts.kb, "larn/policy.json"), join(opts.out, "larn/policy.json"));
writeFileSync(join(opts.out, "larn/facts.json"), JSON.stringify({ facts }, null, 2) + "\n");

const kinds = {};
for (const f of facts) kinds[f.claim.kind] = (kinds[f.claim.kind] ?? 0) + 1;
console.log(`${opts.out}: ${facts.length} of ${all.length} facts (${JSON.stringify(kinds)}), tables hash ${larnKb(opts.out).hash}`);

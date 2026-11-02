// The compiled view of a knowledge base, and what a training batch was able to
// ground — the two halves of the `vect-hack-b5f.14` gate
// (docs/specs/2026-08-21-larn-third-learning-run.md).
//
// `compileFacts` derives the tables the ladder actually reads, so a fact set is
// only worth what its compiled form says: a claim below the confidence floor,
// or retired, changes no decision. Printing the tables beside the exit keys the
// TRAINING runs could ground is what lets a reader see whether the model
// learned a distinction — "the volcanic shaft is bad" — or merely restated
// every exit it happened to descend before dying.
//
// Reads only: it writes nothing and decides nothing.
//
//   node scripts/dev/kb-compiled-report.mjs [--kb data/kb] [--batch DIR]
//
// ".ts" import specifiers: node loads src/bot straight from source.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readTrajectoryLines } from "./trajectory-read.mjs";
import { compileFacts } from "../../src/bot/kbCompile.ts";
import { runGrounds, terrainKey } from "../../src/bot/digest.ts";
import { buildLarnDigest } from "../../src/modules/larn/bot/digest.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const kbDir = flag("--kb", "data/kb");
const batchDir = flag("--batch", null);

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const die = (msg) => { console.error(msg); process.exit(1); };

if (!existsSync(join(kbDir, "larn/facts.json"))) die(`no facts at ${join(kbDir, "larn/facts.json")}`);
const facts = readJson(join(kbDir, "larn/facts.json")).facts ?? [];
const floor = readJson(join(kbDir, "larn/policy.json")).factFloor;
const tables = compileFacts(facts, floor);

console.log(`# compiled tables — ${kbDir}, floor ${floor}`);
console.log(`facts: ${facts.length} stored, ${facts.filter((f) => !f.retired && f.confidence >= floor).length} above the floor`);
console.log(`threat:        ${Object.keys(tables.threat).length} keys`);
for (const [k, v] of Object.entries(tables.threat).sort()) console.log(`  ${k} = ${v}`);
console.log(`item-value:    ${Object.keys(tables.itemValue).length} keys`);
for (const [k, v] of Object.entries(tables.itemValue).sort()) console.log(`  ${k} = ${v}`);
// A threshold per key since c5eebfd, not the flat list this script was written
// against — and it printed "undefined keys" and then threw for every run after
// that commit, which nothing noticed because the b5f.14 gate it serves had no
// fact set to read between then and 2026-08-24. Printed with the capacity
// spelled out, because `hpmax <= threshold` is inclusive and the off-by-one
// there is the difference between an exit the hero can use and one it cannot.
console.log(`avoid-terrain: ${Object.keys(tables.avoidTerrain).length} keys`);
for (const [k, v] of Object.entries(tables.avoidTerrain).sort()) {
  console.log(`  ${k} = ${v}${v === Infinity ? "  (avoided at any capacity)" : `  (avoided while hpmax <= ${v}; usable from hpmax ${v + 1})`}`);
}

if (batchDir === null) process.exit(0);

// The grounded half. A key that no run could ground is a key the applier would
// have rejected, so the avoid table can only be read against this list.
const runs = readdirSync(batchDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(batchDir, e.name, "summary.json")))
  .map((e) => e.name).sort();

const groundedTerrain = new Map();   // key -> runs that could ground it
const groundedKiller = new Map();    // "ch|color" -> runs
let noKiller = 0;
for (const name of runs) {
  const dir = join(batchDir, name);
  const summary = readJson(join(dir, "summary.json"));
  const lines = await readTrajectoryLines(join(dir, "trajectory.jsonl.gz"));
  const grounds = runGrounds(buildLarnDigest(lines, summary));
  for (const t of grounds.terrain) {
    const k = terrainKey(t);
    groundedTerrain.set(k, (groundedTerrain.get(k) ?? 0) + 1);
  }
  if (grounds.killer === null) noKiller++;
  else {
    const k = `${grounds.killer.ch}|${grounds.killer.color}`;
    groundedKiller.set(k, (groundedKiller.get(k) ?? 0) + 1);
  }
}

console.log(`\n# what the batch could ground — ${batchDir}, ${runs.length} runs`);
console.log(`runs naming no killer: ${noKiller}`);
console.log(`grounded killer glyphs: ${groundedKiller.size}`);
for (const [k, n] of [...groundedKiller].sort()) console.log(`  ${k}  ${n} run(s)`);
console.log(`grounded exit keys: ${groundedTerrain.size}`);
for (const [k, n] of [...groundedTerrain].sort()) {
  const t = tables.avoidTerrain[k];
  console.log(`  ${k}  ${n} run(s)  ${t === undefined ? "not avoided" : `AVOIDED while hpmax <= ${t}`}`);
}
const strays = Object.keys(tables.avoidTerrain).filter((k) => !groundedTerrain.has(k));
if (strays.length) console.log(`avoided keys no run grounded: ${strays.join(", ")}`);

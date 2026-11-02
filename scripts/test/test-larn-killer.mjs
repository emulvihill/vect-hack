// The killer join, against the real engine (vect-hack-b5f.4).
//
// The digest gives the death cause as engine prose ("killed by a floating
// eye") and the beings that stood beside the hero as bare map glyphs. Nothing
// tied the two, so a reflecting model read adjacency as causation: 5 of the
// first 38 earned threat facts blamed a bystander, one of them on a run an
// arrow trap killed, where no being was responsible at all. __wrap_died
// (main-wasm.c) now sends the glyph the epitaph's creature was drawn as, and
// buildLarnDigest publishes it only when the screen drew that glyph beside the
// hero.
//
// Why this is an engine test and not a unit test. The unit suites pin the
// reducer over hand-built events (scripts/test/larn-bot-digest.test.ts) and
// the applier gate over hand-built deltas (bot-factdelta.test.ts). Neither can
// fail if the C never emits, if the event is lost on the way to the trajectory
// file, or if the glyph is the wrong one — and "the wrong one" is the whole
// bug. So this plays real games and checks the answers against Larn's own
// tables, read out of external/larn/data.c here rather than trusted from the
// shim that produced them. Two independent readings of the same source
// agreeing is what makes the join evidence rather than assertion.
//
// The seeds are frozen for the same reason test-larn-trace.mjs freezes five: a
// game whose ending is not known in advance can only be asserted about
// conditionally, and a conditional assertion over a random outcome is one that
// mostly does not run. Each seed below is here for a property the others do
// not have, and `expect` states it — so a ladder change that moves a game
// fails loudly with the property it can no longer show, rather than passing on
// a run that proves less.
//
// Seed 5 is the one that earns its keep. Its final sightings alternate E and
// A and END on the bystander, so "name the killer" and "name the nearest
// glyph" give different answers. A first cut of this test used a seed whose
// killer happened to be the last sighting too; deliberately breaking the join
// to return adjacent[last] left that test green.
//
// A frozen seed is a claim about how the bot plays, and a ladder change can
// retire one. See the note at the foot of this file for the third case that
// vect-hack-h9x.5 made unreachable, and what still covers it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { buildLarnDigest } from "../../src/modules/larn/bot/digest.ts";

const fail = (msg) => { console.error("FAIL: " + msg); process.exit(1); };
const repo = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

/** Larn's own name -> glyph mapping, read from the vendored source: monster[]
 *  (data.c:220) gives the name at each index and monstnamelist (data.c:180)
 *  gives the glyph at the same index. This is the table diedsub() prints from
 *  and the table the map export draws from — the two halves the digest could
 *  not join. Reading it here, from text, is what keeps this test independent
 *  of the shim it is checking. */
function larnGlyphs() {
  const src = readFileSync(repo("external/larn/data.c"), "utf8");
  const glyphs = /char\s+monstnamelist\[\]\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(src);
  if (!glyphs) fail("no monstnamelist[] in external/larn/data.c");
  const start = src.indexOf("struct monst    monster[] = {");
  if (start < 0) fail("no monster[] in external/larn/data.c");
  const table = src.slice(start, src.indexOf("\n};", start));
  const names = [...table.matchAll(/\{"([^"]*)"/g)].map((m) => m[1]);
  return (name) => {
    const i = names.indexOf(name);
    if (i < 0) fail(`the epitaph names "${name}", which is not in Larn's monster[]`);
    if (i >= glyphs[1].length) fail(`monster ${i} ("${name}") is past monstnamelist`);
    return glyphs[1][i];
  };
}
const glyphOf = larnGlyphs();

/** One seeded game through the real gym: its summary, its trajectory, and the
 *  digest built from both. */
function play(seed, maxCommands) {
  const out = mkdtempSync(join(tmpdir(), "vect-killer-"));
  try {
    execFileSync(process.execPath, [
      "scripts/dev/bot-gym.mjs", "--game", "larn", "--games", "1", "--parallel", "1",
      "--max-commands", String(maxCommands), "--timeout", "240", "--seed", String(seed), "--out", out,
    ], { stdio: ["ignore", "ignore", "inherit"] });
    const dir = readdirSync(out).find((n) => n.startsWith("larn-"));
    if (!dir) fail(`seed ${seed}: no run directory`);
    const summary = JSON.parse(readFileSync(join(out, dir, "summary.json"), "utf8"));
    const lines = gunzipSync(readFileSync(join(out, dir, "trajectory.jsonl.gz")))
      .toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
    return { summary, lines, digest: buildLarnDigest(lines, summary), deaths: lines.filter((l) => l.name === "death") };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The being the epitaph names, or null when it names none. */
function epitaphGlyph(cause) {
  const m = /^killed by an? (.+?)(?: on |$)/.exec(cause ?? "");
  return m ? glyphOf(m[1]) : null;
}

// --- Seed 5: the join, over a bystander that stood nearer. -------------------
{
  const { summary, digest, deaths } = play(5, 1500);
  const want = epitaphGlyph(summary.cause);
  if (summary.outcome !== "died" || want === null) {
    fail(`seed 5 ended "${summary.outcome}" / "${summary.cause}", not a being's kill — re-pick the seed`);
  }
  // died() is entered once on a real death and never returns from it. A second
  // event would mean the wrapper is firing where it should not, or that the
  // withdrawal for an averted death is being recorded as a death of its own.
  if (deaths.length !== 1) {
    fail(`seed 5: ${deaths.length} death events, want 1: ${JSON.stringify(deaths.map((d) => d.ev))}`);
  }
  if (deaths[0].ev.ch !== want) {
    fail(`seed 5: the epitaph names a glyph of "${want}", but the engine sent "${deaths[0].ev.ch}"`);
  }
  if (digest.killer === null) fail(`seed 5: the digest names no killer for "${summary.cause}"`);
  if (digest.killer.ch !== want) fail(`seed 5: the digest's killer is "${digest.killer.ch}", want "${want}"`);
  if (!digest.finalAdjacent.some((a) => a.ch === digest.killer.ch && a.color === digest.killer.color)) {
    fail("seed 5: the killer is not one of the sightings it was supposed to be chosen from");
  }
  // The property this seed is here for: the nearest glyph is the wrong answer.
  const adj = digest.finalAdjacent.map((a) => a.ch);
  const last = adj[adj.length - 1];
  if (last === want) {
    fail(`seed 5's last sighting is the killer ("${want}"), so this run cannot tell the join apart from`
      + " naming the nearest glyph — re-pick the seed rather than weakening the check");
  }
  console.log(`  seed 5: ${summary.cause} -> "${want}", over a nearer "${last}" (sightings ${adj.join("")})`);
}

// --- Seed 2: a death no being caused, with company. --------------------------
{
  const { summary, digest, deaths } = play(2, 1500);
  if (epitaphGlyph(summary.cause) !== null) {
    fail(`seed 2 ended "${summary.cause}", which names a being — re-pick the seed`);
  }
  if (deaths.length !== 1 || deaths[0].ev.ch !== "") {
    fail(`seed 2: a trap death sent ${JSON.stringify(deaths.map((d) => d.ev))}, want one event naming nobody`);
  }
  // The clearest case in the original bug report: a bat stood beside the hero
  // for the whole ending and an arrow killed them. Adjacency is not causation
  // even when there is only one candidate.
  if (digest.finalAdjacent.length === 0) {
    fail("seed 2: nothing stood beside the hero, so this run cannot show a bystander being refused");
  }
  if (digest.killer !== null) {
    fail(`seed 2: "${summary.cause}" named ${JSON.stringify(digest.killer)} as a killer`);
  }
  console.log(`  seed 2: ${summary.cause} -> nobody, despite ${digest.finalAdjacent.length} sightings`);
}

// --- The third case, and why it is not here (vect-hack-h9x.5, 2026-08-28). ---
//
// A third seed used to sit here: seed 7, whose hero was killed by a being the
// screen never drew beside it, so the engine named a glyph and the digest still
// said nobody. vect-hack-h9x.5 ended that population. Before the readiness bar,
// half of every batch fell down the volcanic shaft to internal 11 and was
// killed in a couple of dozen commands by something out of its sight; after it,
// the bot survives to fight ordinary monsters in melee and DIES ADJACENT TO ITS
// KILLER essentially always. A scan of seeds 1-29 under the new ladder found
// the killer's own glyph among the final sightings in every one of the 23
// being-deaths, so there is no seed left that can show this.
//
// The property is not lost, and it was deliberately not weakened to keep a case
// here: larn-bot-digest.test.ts, "names nobody when the killer was never drawn
// beside the hero", pins it over hand-built events. What that unit test cannot
// prove — that the C emits the glyph at all and that it survives the trajectory
// file — is what seed 5 above proves, and seed 2 proves the whole pipeline
// end-to-end for a death that names nobody. Re-adding a real-engine case for
// this would mean either a conditional assertion over a random outcome, which
// mostly does not run, or a fixture that no longer describes how the bot plays.

console.log("OK: the engine, Larn's own tables and the digest agree on the killer, and a trap death with"
  + " company names nobody");

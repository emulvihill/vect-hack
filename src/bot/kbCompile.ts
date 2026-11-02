// Facts -> the three tables the fast policy reads. Pure and deterministic:
// the tables are DERIVED, never stored, so they cannot drift from what the
// provenance audit covers (spec, "The compiler").
//
// **The avoid table is a threshold, not a set.** The third learning run
// compiled five terrain keys into one flat list and measured what that does:
// with every exit avoided, `passable()` leaves the descend step no eligible
// exit at all, descent falls to the breach step, and the learned distinction
// changes nothing — 0 migration over 100 held-out pairs
// (docs/reports/2026-08-22-larn-r3.md). The evidence had the
// ordering right and the compiler could not express it. So a key now compiles
// to the capacity a hero needs before the ladder will route through it: the
// volcanic shaft is a wall to a 10-hp character and an ordinary exit to a
// large one, which is what "avoid" meant all along.
//
// A fact with no threshold — nothing recorded a capacity — compiles to
// Infinity, which is the old behaviour: avoid at any size.
//
// ".ts" import extension rule applies to this directory (see trajectory.ts).
import { type Fact } from "./kb.ts";

export interface CompiledTables {
  threat: Record<string, number>;
  itemValue: Record<string, number>;
  /** Key -> the hero capacity (hpmax) at or below which the ladder routes
   *  around this terrain. Infinity means "at any capacity". */
  avoidTerrain: Record<string, number>;
}

export function compileFacts(facts: Fact[], floor: number): CompiledTables {
  const threat: Record<string, number> = {};
  const itemValue: Record<string, number> = {};
  const avoidTerrain: Record<string, number> = {};
  for (const f of facts) {
    if (f.retired || f.confidence < floor) continue;
    const c = f.claim;
    if (c.kind === "threat" && f.value !== null) threat[`${c.ch}|${c.color}|${c.depth}`] = f.value;
    else if (c.kind === "item-value" && f.value !== null) itemValue[c.ch] = f.value;
    else if (c.kind === "avoid-terrain") avoidTerrain[`${c.category}:${c.ch}`] = f.value ?? Infinity;
  }
  return { threat, itemValue, avoidTerrain };
}

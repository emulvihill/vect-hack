// The knowledge base: what the bot has learned, in a form both the LLM and
// the fast policy can read (spec L2). Phase 1a built the store and the read
// path; Phase 1b gives facts typed claims and evidence so a model can propose
// them and a deterministic applier can accept them.
//
// Three rules this file exists to enforce:
//   1. Facts carry provenance. A seed fact says so; anything else must name
//      the trajectory evidence behind it, because "the bot earned this" is
//      only auditable if the evidence is nameable. This is an audit trail,
//      not enforcement — see the spec's honest caveat.
//   2. Knowledge and tuning are different things. restLimit is a knob the
//      ladder was born with, not a claim about Larn; it lives in policy.json
//      so the provenance audit over facts.json stays meaningful. The fact
//      floor and the engagement knobs are knobs too, for the same reason.
//   3. The three policy tables are DERIVED from the facts, never stored
//      beside them (kbCompile.ts), so they cannot drift from what the audit
//      covers.
//
// NO FILESYSTEM ACCESS. The browser bot shares this module, so the caller
// reads the files and hands the parsed content in.
//
// ".ts" import extension rule applies to this directory (see trajectory.ts).
import { compileFacts } from "./kbCompile.ts";

export interface Evidence {
  /** The run id whose trajectory supports the claim, plus the event range. */
  trajectory: string;
  from: number;
  to: number;
  /** For numeric claims: the value this observation asserts. */
  value?: number;
}

export type Claim =
  | { kind: "threat"; ch: string; color: number; depth: number | "*" }
  | { kind: "avoid-terrain"; category: string; ch: string }
  | { kind: "item-value"; ch: string }
  | { kind: "note"; topic: string };

/** The applier derives ids, never the model: two runs that learn the same
 *  thing hit the same fact and merge instead of accumulating duplicates. */
export function claimId(engine: string, c: Claim): string {
  switch (c.kind) {
    case "threat": return `${engine}/threat/${c.ch}|${c.color}|${c.depth}`;
    case "avoid-terrain": return `${engine}/avoid-terrain/${c.category}:${c.ch}`;
    case "item-value": return `${engine}/item-value/${c.ch}`;
    case "note": return `${engine}/note/${c.topic}`;
  }
}

/** Confidence is arithmetic over evidence, never the model's self-report. */
export function confidenceOf(support: number, refute: number): number {
  return (support + 1) / (support + refute + 2);
}

export interface Fact {
  id: string;
  claim: Claim;
  text: string;
  /** Median of the supporting evidence's asserted values; null for notes. */
  value: number | null;
  confidence: number;
  support: Evidence[];
  refute: Evidence[];
  /** A retired fact keeps a tombstone; what the bot believed and abandoned
   *  is what makes the audit readable later. */
  retired: { reason: string; updated: string } | null;
  updated: string;
  /** Seed facts are the reviewable cold start and may carry no evidence. */
  seed: boolean;
}

export interface PolicyTuning {
  restLimit: number;
  stuckLimit: number;
  restBelowHpFraction: number;
  /** Confidence at or above which a fact compiles into a table. */
  factFloor: number;
  /** Experience level at which the engagement capacity's xlevel term
   *  saturates, and how much a saturated one adds. Together they are what
   *  lifts a healthy hero's capacity above a threat of 1.0, so that a learned
   *  threat can never veto a fight the hero is in shape to take
   *  (docs/specs/2026-08-21-larn-engagement-design.md). */
  engageLevelCap: number;
  engageLevelWeight: number;
  /** Consecutive disengage steps before the ladder fights anyway. Larn's
   *  monsters move, so an unbounded retreat is a livelock with extra steps. */
  disengageLimit: number;
  /** Experience level at or above which Larn's volcanic town shaft is a route
   *  rather than a hole. It drops the hero to internal 11 whatever their level
   *  (object.c:345), and at level 1 that was half of every batch dying in 19
   *  commands. A bar rather than a ban: the volcano holds the potion the win
   *  condition requires, so "never" would delete the win from the game
   *  (docs/specs/2026-08-28-larn-descent-readiness.md). */
  shaftMinXlevel: number;
  /** Fraction of hpmax at or above which the hero will take an ORDINARY
   *  downward exit. Ships at 0 — no bar — because raising it is a second
   *  variable, and because it cannot exceed restBelowHpFraction without
   *  deadlocking: the rest step stops resting at that fraction, so a higher
   *  descent bar refuses every staircase for the rest of the game. */
  descendMinHpFraction: number;
  /** Most wield commands the bot will spend in one game measuring what it is
   *  carrying (vect-hack-h9x.6). **0 disables the probe**, which is how the
   *  control arm of its A/B is run.
   *
   *  A safety bound, not a tuning target. Measured over 30 real games the bot
   *  spends about 8, or 1.2% of its commands; the bound exists because a
   *  RENAMED item is a new item to the probe, and Larn renames one whenever its
   *  enchantment moves — a rust monster walking a dagger down from -1 to -5
   *  buys five fresh measurements. That is correct (the item really did change)
   *  and it is still worth a ceiling. */
  wieldProbes: number;
  /** Open on a being at range with magic missile instead of closing
   *  (vect-hack-h9x.4). **false disables it**, which is how the control arm of
   *  its A/B is run. The hero knows the spell from character creation
   *  (create.c:42) and the charge count is the engine's to report, so this is
   *  a policy switch and not a budget. */
  castAtRange: boolean;
}

/** A facts.json as it actually arrives. TypeScript infers a JSON import's
 *  `claim.kind` as `string`, never as the four-way union, so a KB with real
 *  facts in it cannot be assigned to `Fact[]` however correct the file is —
 *  the repo typechecked only while data/kb was empty, and every non-empty KB
 *  broke `npm test` at three import sites. The read boundary already exists to
 *  check this file; it now narrows it too, so the cast happens once, next to
 *  the validation that earns it. */
export interface FactDocument {
  facts: readonly unknown[];
}

export interface KbInput {
  meta: FactDocument;
  engine: FactDocument;
  policy: PolicyTuning;
}

export interface Kb {
  tuning: PolicyTuning;
  /** Hash of the compiled tables: the knowledge state a run is attributable to. */
  hash: string;
  fact(id: string): Fact | null;
  /** null means "nothing learned about this yet" — never 0, which would read
   *  as "learned that it is harmless". */
  threat(ch: string, color: number, depth: number): number | null;
  itemValue(key: string): number | null;
  /** Should a hero of this capacity route around this terrain? A learned
   *  avoidance is a threshold, not a veto: the same exit is refused to a
   *  10-hp character and allowed to a large one, which is the difference
   *  between knowledge the ladder can act on and a table that avoids every
   *  exit at once (vect-hack-b5f.17). */
  avoidTerrain(key: string, hpmax: number): boolean;
}

/** The four kinds a Claim may have. Checked at the read boundary because that
 *  is where an untyped JSON document becomes a `Fact`: an unknown kind
 *  compiles into no table (kbCompile's switch falls through), so without this
 *  a typo in a hand-edited fact would be silently inert knowledge rather than
 *  a refusal to load. */
const CLAIM_KINDS: ReadonlySet<string> = new Set(["threat", "avoid-terrain", "item-value", "note"]);

/** Validate a facts document and narrow it to `Fact[]`.
 *
 *  Ids are the applier's job, not this validator's: a seed fact under meta/
 *  carries its own prefix, so an id that is not claimId(engine, claim) is a
 *  legal fact and not something to reject at the read boundary. */
function validate(doc: FactDocument, where: string): Fact[] {
  const facts: Fact[] = [];
  for (const raw of doc.facts) {
    const f = raw as Fact;
    const kind = (f as { claim?: { kind?: unknown } }).claim?.kind;
    if (typeof kind !== "string" || !CLAIM_KINDS.has(kind)) {
      throw new Error(`${where}: fact ${f?.id} has claim kind ${JSON.stringify(kind)}, want one of ${[...CLAIM_KINDS].join(", ")}`);
    }
    if (!f.seed && f.support.length === 0) {
      throw new Error(`${where}: learned fact ${f.id} names no evidence`);
    }
    if (!(f.confidence >= 0 && f.confidence <= 1)) {
      throw new Error(`${where}: fact ${f.id} has confidence ${f.confidence}, want 0..1`);
    }
    facts.push(f);
  }
  return facts;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Key order must not move the hash: two KBs with the same knowledge are the
 *  same knowledge state however their JSON happened to be written. */
function sorted(table: Record<string, number>): [string, number][] {
  return Object.keys(table).sort().map((k) => [k, table[k] as number]);
}

export function loadKb(input: KbInput): Kb {
  const metaFacts = validate(input.meta, "meta");
  const engineFacts = validate(input.engine, "engine");

  const facts = new Map<string, Fact>();
  for (const f of metaFacts) facts.set(f.id, f);
  for (const f of engineFacts) facts.set(f.id, f); // engine tier wins

  const tables = compileFacts([...facts.values()], input.policy.factFloor);
  // Infinity is not JSON, and a table that hashed it as null could not be
  // told from one that had learned nothing about the key at all.
  const hash = fnv1a(JSON.stringify([
    sorted(tables.threat), sorted(tables.itemValue),
    sorted(tables.avoidTerrain).map(([k, v]) => [k, v === Infinity ? "always" : v]),
  ]));

  return {
    tuning: input.policy,
    hash,
    fact: (id) => facts.get(id) ?? null,
    threat(ch, color, depth) {
      return tables.threat[`${ch}|${color}|${depth}`] ?? tables.threat[`${ch}|${color}|*`] ?? null;
    },
    itemValue: (key) => tables.itemValue[key] ?? null,
    avoidTerrain: (key, hpmax) => hpmax <= (tables.avoidTerrain[key] ?? -Infinity),
  };
}

// The fact delta: what a model may propose, and the deterministic applier
// that is the only thing allowed to turn a proposal into knowledge (spec,
// "The fact delta on the wire"). The model never writes a file, never chooses
// an id, and never sets a confidence — bad output is then a rejection with a
// reason, not a corrupted knowledge base.
//
// Consolidation lives here rather than in a later pass: merging by derived id
// at the moment of application is what stops near-duplicates from accumulating
// for something else to clean up. Applying the same delta set twice must
// therefore leave serializeFacts() byte-identical, which is why an unchanged
// fact keeps its old `updated` instead of being restamped.
//
// NO FILESYSTEM ACCESS. Pure functions over values; the node host reads and
// writes the files (see kb.ts's header for why this directory is bound that
// way).
//
// ".ts" import extension rule applies to this directory (see trajectory.ts).
import { terrainKey, type KillerIdentity, type RunGrounds } from "./digest.ts";
import { claimId, confidenceOf, type Claim, type Evidence, type Fact } from "./kb.ts";

export interface FactDelta {
  op: "assert" | "confirm" | "refute" | "retire";
  claim: Claim;
  value?: number;
  text?: string;
  reason?: string;
  evidence: Evidence[];
}

export interface DeltaRejection {
  delta: FactDelta;
  reason: string;
}

// ---------------------------------------------------------------------------
// Parsing: a model's reply is prose that happens to contain JSON.

const NO_ARRAY = "no JSON array in the reflection output";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Why this entry is not a delta, or null if it is one. A shape complaint
 *  only: whether the claim is *true* is the applier's problem, and whether it
 *  is *supported* is evidenceExists's. */
function shapeError(entry: unknown): string | null {
  if (!isRecord(entry)) return "not an object";
  const { op, claim, value, text, reason, evidence } = entry;
  if (op !== "assert" && op !== "confirm" && op !== "refute" && op !== "retire") {
    return `unknown op ${JSON.stringify(op)}`;
  }
  if (!isRecord(claim)) return "claim is not an object";
  switch (claim.kind) {
    case "threat":
      if (typeof claim.ch !== "string" || typeof claim.color !== "number") return "threat claim wants ch and color";
      if (typeof claim.depth !== "number" && claim.depth !== "*") return "threat claim wants depth or \"*\"";
      break;
    case "avoid-terrain":
      if (typeof claim.category !== "string" || typeof claim.ch !== "string") return "avoid-terrain claim wants category and ch";
      break;
    case "item-value":
      if (typeof claim.ch !== "string") return "item-value claim wants ch";
      break;
    case "note":
      if (typeof claim.topic !== "string") return "note claim wants topic";
      break;
    default:
      return `unknown claim kind ${JSON.stringify(claim.kind)}`;
  }
  if (value !== undefined && typeof value !== "number") return "value is not a number";
  if (text !== undefined && typeof text !== "string") return "text is not a string";
  if (reason !== undefined && typeof reason !== "string") return "reason is not a string";
  // Absent evidence is a shape the applier can judge: it rejects every op but
  // retire for it, with a reason the transcript can show.
  if (evidence !== undefined) {
    if (!Array.isArray(evidence)) return "evidence is not an array";
    for (const e of evidence) {
      if (!isRecord(e) || typeof e.trajectory !== "string" || typeof e.from !== "number" || typeof e.to !== "number") {
        return "evidence wants {trajectory, from, to}";
      }
      if (e.value !== undefined && typeof e.value !== "number") return "evidence value is not a number";
    }
  }
  return null;
}

/** Keep the typed subject and nothing else: a claim is stored on the fact, so
 *  a model that decorates one with extra keys must not get them persisted. */
function normalizeClaim(c: Record<string, unknown>): Claim {
  switch (c.kind) {
    case "threat": return { kind: "threat", ch: c.ch as string, color: c.color as number, depth: c.depth as number | "*" };
    case "avoid-terrain": return { kind: "avoid-terrain", category: c.category as string, ch: c.ch as string };
    case "item-value": return { kind: "item-value", ch: c.ch as string };
    default: return { kind: "note", topic: c.topic as string };
  }
}

/** The index closing the array that opens at `open`, or -1. Bracket depth, not
 *  a search for the last "]" — and string-aware, so a "]" inside a delta's own
 *  text cannot close the document. */
function balancedEnd(s: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") inString = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

/** Every top-level JSON array in the reply, in the order they appear. Prose on
 *  either side of the answer is the expected case, not the exotic one: a
 *  reasoning model narrates before it answers, and narration carries brackets
 *  — "the hero took the [V] shaft", "as noted in [1]", a <think> block. First
 *  "[" to last "]" reads that narration as part of the document and loses the
 *  whole reply; a depth scan finds each candidate on its own. Arrays nested
 *  inside a candidate are skipped: a delta's own evidence list is never the
 *  document. */
function arrayCandidates(s: string): unknown[][] {
  const out: unknown[][] = [];
  for (let i = s.indexOf("["); i >= 0; i = s.indexOf("[", i + 1)) {
    const end = balancedEnd(s, i);
    // Unbalanced from here: advance one character rather than past the run,
    // because an unclosed bracket in the prose must not swallow the answer.
    if (end < 0) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(s.slice(i, end + 1)); } catch { continue; }
    if (Array.isArray(parsed)) { out.push(parsed); i = end; }
  }
  return out;
}

function readDeltas(parsed: unknown[]): { deltas: FactDelta[]; error: string | null } {
  const deltas: FactDelta[] = [];
  const problems: string[] = [];
  parsed.forEach((entry, i) => {
    const why = shapeError(entry);
    if (why !== null) { problems.push(`entry ${i}: ${why}`); return; }
    const e = entry as Record<string, unknown>;
    const delta: FactDelta = {
      op: e.op as FactDelta["op"],
      claim: normalizeClaim(e.claim as Record<string, unknown>),
      evidence: ((e.evidence as Evidence[] | undefined) ?? []).map((v) =>
        v.value === undefined ? { trajectory: v.trajectory, from: v.from, to: v.to }
          : { trajectory: v.trajectory, from: v.from, to: v.to, value: v.value }),
    };
    if (typeof e.value === "number") delta.value = e.value;
    if (typeof e.text === "string") delta.text = e.text;
    if (typeof e.reason === "string") delta.reason = e.reason;
    deltas.push(delta);
  });
  return { deltas, error: problems.length === 0 ? null : problems.join("; ") };
}

/** Pull the delta array out of a model's reply. Never throws: a reply with no
 *  usable JSON is a rejection to record, not an exception to handle. */
export function parseDeltaDocument(raw: string): { deltas: FactDelta[]; error: string | null } {
  // Line-anchored: only a fence that owns its line is chrome. A bare
  // /```/g would also eat backticks inside a delta's text, and evidence
  // that quietly loses characters is worse than evidence that fails loudly.
  const unfenced = raw.replace(/^[ \t]*```[a-zA-Z]*[ \t]*$/gm, "");
  const candidates = arrayCandidates(unfenced);
  if (candidates.length === 0) return { deltas: [], error: NO_ARRAY };
  // The document is whichever candidate reads as the most deltas, the first
  // winning a tie. A bracketed aside is often valid JSON on its own ("[1]"
  // parses), so a candidate has to be judged by what it yields rather than by
  // where it sits — and the empty array, the answer a run that taught nothing
  // is supposed to give, still wins when it is the only candidate.
  const read = candidates.map(readDeltas);
  let best = read[0]!;
  for (const r of read) if (r.deltas.length > best.deltas.length) best = r;
  return best;
}

// ---------------------------------------------------------------------------
// Applying: ids, evidence, confidence and merging are ours, not the model's.

function evidenceKey(e: Evidence): string {
  return `${e.trajectory}|${e.from}|${e.to}`;
}

/** Union, deduplicated by (trajectory, from, to) and sorted, so the same
 *  evidence arriving twice cannot change a byte. The incumbent entry wins:
 *  re-asserting a range must not silently revise the value it carried. */
function unionEvidence(current: Evidence[], incoming: Evidence[]): Evidence[] {
  const byKey = new Map<string, Evidence>();
  for (const e of current) byKey.set(evidenceKey(e), e);
  for (const e of incoming) if (!byKey.has(evidenceKey(e))) byKey.set(evidenceKey(e), e);
  return [...byKey.values()].sort((a, b) =>
    a.trajectory < b.trajectory ? -1 : a.trajectory > b.trajectory ? 1 : a.from - b.from || a.to - b.to);
}

/** The median, so one outlier observation cannot swing a table row. */
function medianValue(support: Evidence[]): number | null {
  const values = support
    .map((e) => e.value)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const mid = values.length >> 1;
  return values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

/** The largest observation, for the two kinds whose value is a THRESHOLD
 *  rather than an average reading. A threat's value is the capacity it has
 *  been seen to beat, and an exit's is the capacity it has been seen to
 *  kill after: both answer "how big does the hero have to be before this stops
 *  being a reason to stay away", so a death above the current bar has to move
 *  it and a death below it must not lower it. A median would let a run of
 *  deaths at low capacity quietly certify a being that also kills healthy
 *  heroes. The ratchet is one-way by construction — `support` only grows. */
function maxValue(support: Evidence[]): number | null {
  let out: number | null = null;
  for (const e of support) {
    if (typeof e.value === "number" && (out === null || e.value > out)) out = e.value;
  }
  return out;
}

/** Kinds whose value is a threshold the evidence ratchets upward. */
function ratchets(claim: Claim): boolean {
  return claim.kind === "threat" || claim.kind === "avoid-terrain";
}

/** The number THIS run measured for the delta's subject, or null when the run
 *  cannot measure one.
 *
 *  **A value is an observation, not an opinion.** Phase 1b let the model state
 *  a threat's value and got a table of 43 keys almost all valued exactly 1.0
 *  (docs/reports/2026-08-22-larn-r3.md) — "a giant ant is lethal"
 *  is true of a level-1 character and says nothing about which fights to pick.
 *  The run itself has the number: the most the hero was seen holding while
 *  the killer stood beside them, within its final engagement — NOT the
 *  reading the fatal blow found, which in a multi-blow grind says only what
 *  the finisher finished (vect-hack-b5f.20). A being that beat 0.95 of
 *  capacity is one to walk away from; one whose whole engagement never saw
 *  the hero above 0.15 finished a fight that was already lost, and the
 *  ladder should take that fight in good health.
 *
 *  The same argument makes an exit's threshold the capacity the hero took it
 *  with. `grounds` is the run's own derivation, so a subject the applier
 *  cannot measure here is one the gates were going to reject anyway. */
function observedValue(claim: Claim, grounds: RunGrounds): number | null {
  if (claim.kind === "threat") return grounds.killedAtCapacity;
  if (claim.kind === "avoid-terrain") {
    const t = grounds.terrain.find((x) => x.category === claim.category && x.ch === claim.ch);
    return t === undefined ? null : t.power;
  }
  return null;
}

function needsValue(claim: Claim): boolean {
  return claim.kind === "threat" || claim.kind === "item-value";
}

/** Everything about a fact except when it was written. Two facts with the same
 *  body are the same knowledge, so the second write keeps the first's stamp. */
function body(f: Fact): string {
  return JSON.stringify([f.claim, f.text, f.value, f.confidence, f.support, f.refute, f.retired, f.seed]);
}

function copyFact(f: Fact): Fact {
  return { ...f, support: [...f.support], refute: [...f.refute], retired: f.retired ? { ...f.retired } : null };
}

/** Why a threat claim cannot rest on this run, or null (vect-hack-b5f.4).
 *
 *  The digest lists every being that stood beside the hero and names the one
 *  that killed them. Only the killer is evidence: standing next to a corpse is
 *  not what made the being lethal, and the first earned knowledge base blamed
 *  a bystander in 5 of its 38 threat facts on exactly that reasoning.
 *
 *  `assert` and `confirm` are both gated. A confirm raises confidence on a
 *  fact, so it needs the same evidence an assert does — the bystander bug
 *  would otherwise walk straight back in through the cheaper op.
 *
 *  `refute` and `retire` are not gated: they take a claim away rather than
 *  grounding one, and the failure they can cause is a fact lost, not a fact
 *  invented. They are still in the ablation probe's scope (reflect.ts's
 *  leakedSubjects counts any threat delta), so a refutation recited from
 *  priors still fails the batch.
 *
 *  Colour is compared as well as the glyph, even though every Larn monster is
 *  drawn in one colour slot today: colour is part of the claim id, so a claim
 *  keyed on a colour the screen did not draw would open a second, parallel
 *  fact about the same being (vect-hack-b5f.7). */
function threatGate(delta: FactDelta, killer: KillerIdentity | null): string | null {
  if (delta.claim.kind !== "threat") return null;
  if (delta.op !== "assert" && delta.op !== "confirm") return null;
  if (killer === null) {
    return "this run names no killer: a being that merely stood nearby is not evidence it is a threat";
  }
  if (delta.claim.ch !== killer.ch || delta.claim.color !== killer.color) {
    return `this run was killed by ${killer.ch} in colour ${killer.color}, not ${delta.claim.ch} in colour ${delta.claim.color}`;
  }
  return null;
}

/** Why an avoid-terrain claim cannot rest on this run, or null
 *  (vect-hack-b5f.6). The sibling of threatGate, and the same argument:
 *  telling a model to file its terrain lessons as typed claims is worth
 *  nothing if the applier then takes claims about terrain the run never
 *  showed. The admissible set is the exits the hero CHOSE — digest.ts's
 *  runGrounds, which both this and the prompt read, so the model is never
 *  invited to name a subject that is then refused.
 *
 *  `assert` and `confirm` are gated for the reason they are gated on a
 *  threat: a confirm raises confidence, so it needs the evidence an assert
 *  needs. `refute` and `retire` are not gated — they take a claim away, and
 *  the worst they cause is a fact lost rather than a fact invented.
 *
 *  What this does NOT establish is that the terrain was harmful. It answers
 *  "did this run show the hero choosing that exit", which is a claim about
 *  provenance, not about consequence — exactly the boundary the killer gate
 *  draws, and worth stating because the two are easy to conflate. */
function terrainGate(delta: FactDelta, terrain: RunGrounds["terrain"]): string | null {
  if (delta.claim.kind !== "avoid-terrain") return null;
  if (delta.op !== "assert" && delta.op !== "confirm") return null;
  const key = terrainKey(delta.claim);
  if (terrain.some((t) => terrainKey(t) === key)) return null;
  const offered = terrain.length === 0
    ? "this run took no exit it could have declined"
    : `this run's exits were ${terrain.map(terrainKey).join(", ")}`;
  return `${key} is not terrain this run chose to step onto: ${offered}`;
}

/** Why this delta cannot be applied, or null. */
function rejectReason(
  delta: FactDelta,
  id: string,
  existing: Fact | null,
  evidenceExists: (e: Evidence) => boolean,
  grounds: RunGrounds,
): string | null {
  if (delta.op !== "assert" && existing === null) return `no such fact ${id}`;
  if (delta.op !== "retire") {
    if (delta.evidence.length === 0) return "evidence required: the claim names none";
    for (const e of delta.evidence) {
      if (!(e.to > e.from)) return `evidence ${e.trajectory} [${e.from}..${e.to}] is not a range`;
      if (!evidenceExists(e)) return `evidence ${e.trajectory} [${e.from}..${e.to}] is not a range this delta set may cite`;
    }
  }
  if (delta.op === "assert" && needsValue(delta.claim)) {
    if (typeof delta.value !== "number" || !(delta.value >= 0 && delta.value <= 1)) return "value required in 0..1";
  }
  return threatGate(delta, grounds.killer) ?? terrainGate(delta, grounds.terrain);
}

/** `evidenceExists` is the citation scope, and it belongs to the caller: it
 *  answers whether THIS delta set may cite that range at all, not merely
 *  whether the range is real somewhere. The reflect host scopes it to the one
 *  run each delta was drawn from, because provenance naming the wrong game is
 *  worse than none — the audit trail would then certify a claim nothing
 *  supports. */
export function applyDeltas(
  facts: Fact[],
  deltas: FactDelta[],
  opts: {
    engine: string;
    now: string;
    evidenceExists: (e: Evidence) => boolean;
    /** What this run's digest showed, as the subjects a policy claim from it
     *  may name: the being that killed the hero, and the exits the hero chose
     *  to take (digest.ts, runGrounds). Run-scoped for the same reason
     *  evidenceExists is — it is a fact about the one game the deltas came
     *  from, which a batch-wide call cannot express. */
    grounds: RunGrounds;
  },
): { facts: Fact[]; accepted: number; rejections: DeltaRejection[] } {
  const out = facts.map(copyFact);
  const index = new Map(out.map((f) => [f.id, f]));
  const rejections: DeltaRejection[] = [];
  let accepted = 0;

  for (const delta of deltas) {
    const id = claimId(opts.engine, delta.claim);
    const existing = index.get(id) ?? null;
    const why = rejectReason(delta, id, existing, opts.evidenceExists, opts.grounds);
    if (why !== null) { rejections.push({ delta, reason: why }); continue; }

    const before = existing;
    const prior: Fact = existing ?? {
      id, claim: delta.claim, text: delta.text ?? "", value: null, confidence: 0,
      support: [], refute: [], retired: null, updated: opts.now, seed: false,
    };
    // What THIS run observed about the subject, which for a threat and for an
    // exit is a measurement rather than an opinion — see observedValue. It
    // rides on every range the delta brought, and it rides on a `confirm` as
    // well as an `assert`: the ratchet is built out of one observation per
    // run, and a run that confirms a threat by dying to it at full health is
    // exactly the observation that should raise it.
    const observed = observedValue(delta.claim, opts.grounds);
    const stated = delta.op === "assert" && needsValue(delta.claim) && typeof delta.value === "number"
      ? delta.value : null;
    const rides = observed ?? stated;
    const incoming = (delta.op === "assert" || delta.op === "confirm") && rides !== null
      ? delta.evidence.map((e) => ({ ...e, value: rides }))
      : delta.evidence;

    const next = copyFact(prior);
    if (delta.op === "assert" || delta.op === "confirm") next.support = unionEvidence(prior.support, incoming);
    if (delta.op === "refute") next.refute = unionEvidence(prior.refute, incoming);
    if (delta.op === "assert" && delta.text !== undefined) next.text = delta.text;
    if (delta.op === "retire") {
      const reason = delta.reason ?? "retired";
      // Retiring an already-retired fact for the same reason changes nothing,
      // so it must not restamp the tombstone either.
      next.retired = prior.retired && prior.retired.reason === reason ? prior.retired : { reason, updated: opts.now };
    }
    next.value = ratchets(next.claim) ? maxValue(next.support) : medianValue(next.support);
    next.confidence = confidenceOf(next.support.length, next.refute.length);
    next.updated = before !== null && body(next) === body(before) ? before.updated : opts.now;

    if (before === null) { out.push(next); index.set(id, next); }
    else { Object.assign(before, next); }
    accepted++;
  }

  return { facts: out, accepted, rejections };
}

/** The canonical on-disk form. Byte-identical output for equal state is the
 *  idempotence contract the reflect host's anti-thrash gate reads. */
export function serializeFacts(facts: Fact[]): string {
  const sorted = [...facts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({ facts: sorted }, null, 2) + "\n";
}

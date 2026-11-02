// Reflection: the prompt one finished game is turned into, and the machinery
// of the ablation probe (spec: 2026-08-19-bot-phase1b-larn-reflect-design.md,
// "The Brain" and "The ablation probe").
//
// Two things this file is responsible for.
//
// **The prompt is the black-box rule made concrete.** The digest is already the
// only thing the model may see; the system message is what stops it answering
// from what it knows about a 1986 BSD roguelike instead. It says so in as many
// words, and it offers the empty array as a legitimate answer — a model with no
// escape hatch invents a lesson rather than admit the run taught none.
//
// **It also has to say which kind a lesson goes under, because the wrong kind
// is silence.** Three kinds compile into the tables the ladder reads; `note`
// compiles into nothing. Phase 1b's prompt listed all four as peers and got
// what it asked for: across the 100 training reflections the model emitted 84
// notes and 2 avoid-terrain claims, and of the 53 runs whose hero rode the
// town's volcanic shaft to depth 11 not one filed the `stairs:V` claim that
// would have stopped it — the shaft insight was there, in the prose of a
// `note`, where nothing reads it (vect-hack-b5f.6,
// docs/reports/2026-08-21-larn-1b-ab.md). So the routing rule is
// stated before the kinds are listed, and the run block names the exact keys
// this run can ground.
//
// That block is the same runGrounds() the applier gates on, which is the point
// of deriving it in digest.ts: a key the model is offered is a key the applier
// takes. It is headed by what it is NOT — a list of conclusions — because the
// opposite failure is the one 1b actually lost an A/B to, and an invitation to
// file a delta per listed key would trade under-typing for over-claiming.
//
// The reply must be a bare JSON array. parseDeltaDocument recovers one from a
// reply that narrates around it — a reasoning model's preamble brackets things
// ("the hero took the [V] shaft") and a first-"[" slice would read that as the
// answer — but recovery picks the most delta-like candidate, which is a
// heuristic and not a contract. The instruction is stated twice and in the last
// line so the parser rarely has to guess.
//
// **The probe is the rule's only enforcement, and the rule now has one named
// hole.** A claim that survives a digest with its evidence removed was never
// learned from the dungeon. partitionLeaks compares every claim kind that
// compiles into policy — a `note` compiles into nothing, so a note appearing
// in both runs is a model repeating itself, not a prior laundered into
// behaviour — and splits the result: `threat` and `item-value` leaks still
// fail the batch, `avoid-terrain` leaks are admitted and recorded
// (PRIOR_ADMISSIBLE_KINDS, vect-hack-b5f.23).
//
// The digest's element counts are capped upstream (DIGEST_LIMITS) but its
// strings are not, so the byte ceiling lives here — capping the free text
// rather than the assembled message, because truncating the message would cut
// the digest JSON mid-object and hand the model something unparseable.
//
// NO FILESYSTEM ACCESS (see kb.ts's header).
//
// ".ts" import extension rule applies to this directory (see trajectory.ts).
import { type BrainRequest } from "./brain.ts";
import { runGrounds, type RunDigest } from "./digest.ts";
import { type FactDelta } from "./factDelta.ts";
import { claimId, type Fact } from "./kb.ts";

/** Free text the model never wrote and cannot be trusted to have kept short:
 *  an epitaph or a message is engine output of unbounded length. */
const TEXT_LIMIT = 240;
/** Facts listed in the prompt. Past this the KB is summarised rather than
 *  recited; a reflection that needs the 61st fact is a job for 1c's
 *  consolidation pass, not for a bigger prompt. */
const FACT_LIMIT = 60;

export const REFLECT_SYSTEM = `You are the reflection step of a self-teaching roguelike bot.

You are reflecting on ONE game the bot just played. Conclude ONLY what THIS run's digest supports; do not use outside knowledge of the game. If the digest supports no conclusion, return [].

You answer with fact deltas. A delta is a JSON object:

{"op": "assert", "claim": {...}, "value": 0.9, "text": "why this run shows it", "evidence": [{"trajectory": "<id>", "from": 412, "to": 468}]}

Which kind you file a lesson under decides whether it has any effect. Three of the four kinds change how the bot plays. The fourth, "note", changes nothing: it is prose filed for a person to read. So a lesson one of the first three can carry MUST be filed as that kind. If a lesson has a part one of them can carry and a part none of them can, emit both.

The four claim kinds. "ch" is always the map glyph the screen drew — never a monster or item name, which the bot never saw:

{"kind": "threat", "ch": "D", "color": 1, "depth": 11}
    A being that is dangerous. "color" is the colour slot the screen drew it in; "depth" is the dungeon level number, or "*" for every depth. "value" is 0..1, where 1 is lethal.
    Only the run's "killer" may be asserted or confirmed as a threat. "killer" is the being that landed the fatal blow, and "finalAdjacent" is everything that merely stood nearby — a bystander is not a threat. When "killer" is null this run shows nothing about any being, and a threat delta will be rejected; say nothing about one.
{"kind": "avoid-terrain", "category": "stairs", "ch": "V"}
    An exit the bot should not step onto. This is the kind for a lesson about WHERE the hero went — which staircase, shaft or entrance it took, and what that cost. A lesson naming a specific exit belongs here, never in a note.
    "category" and "ch" must be one of the eligible terrain keys in the run block below; a claim naming anything else is rejected.
{"kind": "item-value", "ch": ")"}
    How much picking this up is worth. "value" is 0..1, where 1 is most valuable.
{"kind": "note", "topic": "descent-pacing"}
    A lesson none of the three kinds above can carry. Put it in "text" under a short stable "topic". Nothing the bot does reads a note — it is recorded, and shown back to you when you reflect on a later run. Do not file a lesson here when it is about the run's killer or about one of the eligible terrain keys.

The four ops:

"assert"  state the claim. A threat or item-value assert MUST carry "value" in 0..1.
"confirm" this run supports a fact listed as already known.
"refute"  this run contradicts one of those facts.
"retire"  abandon one of those facts; give "reason".

Ids, confidence and merging are not yours: the claim IS the subject, and identical claims from different runs are merged for you. Do not invent an "id" field.

Neither is how dangerous something is. A threat and an exit are dangerous relative to what the hero could take, and this run measured that — the hit points the hero held going into the fight that killed them, and the hit points the hero took each exit with. Those numbers decide the value; the one you state for a threat is a fallback used only when the run measured none. Name the subject and say what happened to it.

Evidence: every op except "retire" MUST carry at least one range. Every range must name the trajectory id given in the run block below, with "from" and "to" inside [0, events) for the event count given there, and "to" greater than "from". A range naming any other trajectory, or reaching outside that window, is discarded.

Reply with a JSON array of deltas and nothing else. No preamble, no explanation, no code fence, and no commentary after the array: the first character of your reply is [ and the last is ].`;

function clampText(s: string): string {
  return s.length <= TEXT_LIMIT ? s : `${s.slice(0, TEXT_LIMIT)}…(${s.length} chars)`;
}

/** The digest as the model sees it: identical to the input except that the two
 *  unbounded free-text fields are cut to a readable length. */
function clampDigest(d: RunDigest): RunDigest {
  return { ...d, cause: clampText(d.cause), lastMessages: d.lastMessages.map(clampText) };
}

function factLine(f: Fact): string {
  const parts = [`confidence ${f.confidence.toFixed(2)}`];
  if (f.value !== null) parts.push(`value ${f.value}`);
  if (f.retired !== null) parts.push(`RETIRED: ${clampText(f.retired.reason)}`);
  return `- ${f.id} (${parts.join(", ")}): ${clampText(f.text)}`;
}

/** The subjects this run can ground, spelled out for the model.
 *
 *  It is the same runGrounds() the applier gates on, so a key offered here is
 *  a key that will be accepted, and the model is never invited to name one
 *  that is then rejected. Each line carries the observation behind the key —
 *  the descent it came from, the blow the killer landed — because a bare list
 *  reads as a list of conclusions.
 *
 *  The heading says what the list is NOT, deliberately. The failure this
 *  block exists to fix is under-typing: 53 of the 100 Phase-1b training runs
 *  took the volcanic shaft and not one of them filed the `stairs:V` claim
 *  that would have changed anything (vect-hack-b5f.6). The failure it could
 *  cause is the opposite one — a delta per listed key, on a run that showed
 *  nothing about any of them — and 1b lost an A/B to over-claiming, so the
 *  heading is the counterweight and `[]` stays a legitimate answer. */
function groundsBlock(digest: RunDigest): string {
  const g = runGrounds(digest);
  const lines: string[] = [];
  // The capacity the killer's own engagement beat, not the last living
  // reading: the fatal blow's margin says only what the finisher finished
  // (vect-hack-b5f.20). The applier measures the value from the same field.
  const beat = digest.killer?.capacity ?? null;
  const held = beat === null ? ""
    : `; the hero held ${beat.hp} of ${beat.hpmax} hit points going into that fight`;
  lines.push(g.killer === null
    ? "  threat: none — this run names no killer, so it shows nothing about any being"
    : `  threat: {"ch": ${JSON.stringify(g.killer.ch)}, "color": ${g.killer.color}} — the being that landed the fatal blow${held}`);
  if (g.terrain.length === 0) {
    lines.push("  avoid-terrain: none — this run took no exit it could have declined");
  } else {
    for (const t of g.terrain) {
      const from = digest.descents.find((d) => d.category === t.category && d.ch === t.ch);
      // The capacity is shown because it is what the choice was made with, and
      // an exit is only ever dangerous relative to it. The model still names
      // the subject and nothing more: the threshold itself is arithmetic over
      // this number, done by the applier (vect-hack-b5f.17).
      const where = from === undefined ? "" :
        ` — the hero stepped onto it at command ${from.atCommand}, depth ${from.fromDepth} to ${from.toDepth} at experience level ${from.xlevel}, with ${from.hp} of ${from.hpmax} hit points`;
      lines.push(`  avoid-terrain: {"category": ${JSON.stringify(t.category)}, "ch": ${JSON.stringify(t.ch)}}${where}`);
    }
  }
  return lines.join("\n");
}

export function buildReflectPrompt(
  digest: RunDigest,
  facts: Fact[],
  trajectoryId: string,
  events: number,
): BrainRequest {
  const listed = [...facts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, FACT_LIMIT);
  const known = listed.length === 0
    ? "(none — this is the first thing the bot has been told about this game)"
    : listed.map(factLine).join("\n")
      + (facts.length > listed.length ? `\n(and ${facts.length - listed.length} more, not listed)` : "");

  const user = `Run digest — the only evidence you have about this game:

${JSON.stringify(clampDigest(digest), null, 2)}

Run block:
  trajectory: ${trajectoryId}
  events: ${events}
Every evidence range must name trajectory ${trajectoryId} with from and to inside [0, ${events}).

Eligible claim keys — what this run is able to ground, not what it concluded. A key appearing here is not evidence that it hurt: claim one only if this run shows what came of the choice, and emit nothing about the rest.
${groundsBlock(digest)}

Facts already known:
${known}

Emit the deltas this run's digest supports, as a JSON array and nothing else.`;

  return { system: REFLECT_SYSTEM, user };
}

/** The probe input: the same run with the death taken away. The route, the
 *  depth and the terrain stay, so a claim about what killed the hero has
 *  nothing left to rest on — and a model that makes it anyway is reciting.
 *
 *  The HP pair goes with the death. `hp: 0 of 12` alongside `outcome: capped`
 *  says the hero died as plainly as the outcome did, through a channel the
 *  probe was not disabling — and a probe whose input still carries the evidence
 *  it removed cannot falsify anything. Both fields are blanked rather than set
 *  to a plausible survival: inventing HP the run never reached would be
 *  evidence too, just evidence pointing the other way.
 *
 *  `killer` goes with them, and it weakens what the probe proves about
 *  threats: the prompt now says a threat is inadmissible without a killer, so
 *  a compliant model stays quiet here whether or not its original claim came
 *  from the run. The probe still catches a model that answers anyway, but the
 *  load has shifted to the applier's own killer gate, which is arithmetic
 *  rather than instruction-following (src/bot/factDelta.ts).
 *
 *  **The descents stay, and that makes the probe HARDER on terrain claims than
 *  it was.** The probed prompt still lists `stairs:V` as an eligible key,
 *  because the route is not what the probe is taking away — so a model that
 *  answers "avoid the shaft" here is concluding it from "depth 0 to 11 at
 *  experience level 1" with nothing left to say what came of it, and that last
 *  step is knowledge about Larn rather than about this run. Counting it as a
 *  leak is the probe working. But it is a real change in how often a batch can
 *  fail (vect-hack-b5f.6): 1b's terrain claims were too rare to exercise this,
 *  and a batch that dies here needs its transcripts read before the prompt is
 *  blamed — the alternative reading is that the probe is now doing to terrain
 *  what it always did to threats.
 *
 *  **The hero has to look alive, and once did not.** This function used to
 *  send `hp: 0, hpmax: 0` beside `outcome: "capped"`, and the r3 training
 *  batch's own probe transcript read it exactly as it looks: *"the run ended
 *  capped with hp 0 immediately after"* — the model concluded the hero died
 *  from the numbers the ablation had left behind, which is the one thing the
 *  ablation exists to take away. A probe that leaks the death cannot tell a
 *  prior from evidence about anything, terrain or being. `hp` is therefore
 *  carried to `hpmax`: the counterfactual this probe poses is "the same route,
 *  and the hero was fine", and a model that still says avoid it is speaking
 *  about Larn rather than about this run. `hpmax` is the character's own
 *  ceiling and was never death evidence. */
export function stripDeathEvidence(d: RunDigest): RunDigest {
  return { ...d, outcome: "capped", cause: "", lastMessages: [], finalAdjacent: [], killer: null, hp: d.hpmax };
}

/** Subjects the probe run emitted that the original run emitted too, as claim
 *  ids. Every kind that compiles into a policy table counts, because those are
 *  the ones a laundered prior would change behaviour through — and that is all
 *  three of them (kbCompile.ts): `threat`, `avoid-terrain` and `item-value`.
 *  The comment here used to name only the first two while the compiler read
 *  three, which left an item claim recited from priors invisible to the probe.
 *  A `note` is genuinely outside the scope: it compiles into nothing, so a
 *  note in both runs is a model repeating itself, not a prior reaching policy.
 *  Sorted and deduplicated — the reflect host prints this list as the reason a
 *  batch failed. */
export function leakedSubjects(original: FactDelta[], probed: FactDelta[]): string[] {
  const { admitted, fatal } = partitionLeaks(original, probed);
  return [...admitted, ...fatal].sort();
}

/** Claim kinds whose leaks are ADMITTED rather than fatal: the model may rest
 *  them on what it knows about roguelikes, and a pass records them instead of
 *  refusing them.
 *
 *  This is a deliberate hole in the black-box rule, decided on 2026-08-24
 *  (vect-hack-b5f.23, docs/DECISIONS.md) after the first Claude-brain pass
 *  failed with 4 of 5 probes restating `avoid-terrain stairs:V`. The model's
 *  own words in those transcripts are what the hole is shaped around: it says
 *  "no damage was measured" and asserts the claim anyway, on the retained
 *  descent record plus an unstated "deeper is more dangerous". That premise is
 *  not in the digest and no ablation can remove it, because the subject of an
 *  avoid-terrain claim IS the descent the probe has to keep.
 *
 *  What it costs, stated so no report can imply otherwise: a terrain fact is
 *  no longer evidence that the loop learned something. It may be a transcript
 *  of what a frontier model already knew, and an A/B won on one is ambiguous
 *  between "the loop learns" and "the model was told". `threat` and
 *  `item-value` are NOT in this set and still fail a batch, so the hole is one
 *  claim kind wide and named. A `note` was never in scope: it compiles into
 *  nothing. */
export const PRIOR_ADMISSIBLE_KINDS: ReadonlySet<string> = new Set(["avoid-terrain"]);

/** The probe's verdict, split by what the host is allowed to do about it.
 *  Detection is unchanged and deliberately kept whole — every leaked subject
 *  is still found and still named in the transcript — because a rule that
 *  stops LOOKING cannot be audited or reversed later. Only the consequence
 *  differs by kind. */
export function partitionLeaks(
  original: FactDelta[],
  probed: FactDelta[],
): { admitted: string[]; fatal: string[] } {
  const subjects = (deltas: FactDelta[]): Map<string, string> => {
    const byId = new Map<string, string>();
    for (const d of deltas) {
      if (d.claim.kind !== "note") byId.set(claimId("larn", d.claim), d.claim.kind);
    }
    return byId;
  };
  // Both sides derive their ids the same way, so the engine prefix cancels
  // out; it is here because the id is what the transcript has to name.
  const before = subjects(original);
  const admitted: string[] = [];
  const fatal: string[] = [];
  for (const [id, kind] of subjects(probed)) {
    if (!before.has(id)) continue;
    (PRIOR_ADMISSIBLE_KINDS.has(kind) ? admitted : fatal).push(id);
  }
  return { admitted: admitted.sort(), fatal: fatal.sort() };
}

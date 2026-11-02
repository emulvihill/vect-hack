# The Phase 1b knowledge base, kept as a fixture

`larn/facts.json` and `meta/facts.json` are the 38 threat claims, 13 notes and
one terrain claim that one hundred training games earned in Phase 1b, exactly
as commit `3317426` wrote them. They are **not active knowledge**: the paired
held-out A/B rejected them and `data/kb/larn/facts.json` is empty by decision
(`docs/reports/2026-08-21-larn-1b-ab.md`).

They are here because they are the cheapest available falsification of the
engagement seam. That A/B did not show the facts were false — 33 of the 38
name the glyph of the creature the death message names. It showed that this
fact set, consumed by a ladder that read a threat value as a melee veto, plays
worse. So this set reproduces the whole regression deterministically, which
makes it the regression fixture for the fix
(`docs/specs/2026-08-21-larn-engagement-design.md`, "Stage 1").

The other five are the bystander bug (vect-hack-b5f.4): they name a creature
that stood beside the hero while something else did the killing, and one of
them names a bat on a run an arrow trap ended. The applier would now refuse all
five, because a threat assert has to name the run's own killer. That is not a
reason to re-run the set through it: these facts are frozen at what 1b wrote,
and a fixture that quietly improved would stop reproducing the regression it is
kept for.

`larn/policy.json` is the CURRENT tuning, not 1b's: the point of the fixture is
to hold the facts fixed while the consumer changes, and `fleeThreshold` no
longer exists.

Nothing may copy these into `data/kb/`. Shipping a hand-chosen survivor of a
rejected knowledge base would be a different treatment, unmeasured, picked by
the curation the reflect loop exists to avoid.

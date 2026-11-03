## 2026-11-03 — The Larn bot's LLM learning apparatus is retired

**Decision:** The knowledge base (`data/kb/`, `src/bot/kb.ts`,
`kbCompile.ts`), the reflect loop (`reflect.ts`, `factDelta.ts`, `brain.ts`,
`scripts/dev/bot-reflect.mjs` and the brain hosts), and the KB A/B tooling
(`abReport.ts`, `kb-ab-report.mjs`, `kb-split.mjs`, `kb-compiled-report.mjs`,
`reflect-prompt-probe.mjs`) are removed. The ladder's knobs are code
constants, `DEFAULT_TUNING` in `src/modules/larn/bot/policy.ts`; the gym and
the bench take `--tuning '<json>'`, a partial override that refuses an unknown
knob, which is what `policy-sweep.mjs` now passes. The fact reads went with
the KB in their empty-table forms: the bot fights the first adjacent being in
DIRS order, never routes to an item, and treats no terrain as learned-avoided.
`factFloor` and the engagement knobs (`engageLevelCap`, `engageLevelWeight`,
`disengageLimit`) went too, since they only weighed learned threats. The
deterministic bot, the gym, the bench and `policy-sweep.mjs` stay.

**Why:** Eric retired all AI learning in the project. Every learned fact set
had been rejected by its held-out A/B, so the shipped KB was empty and inert,
and the bot's play is unchanged: 40 gym games on master seed 4242 and the
500-game bench set gave byte-identical trajectories and summaries before and
after.

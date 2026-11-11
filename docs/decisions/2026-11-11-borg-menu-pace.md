## 2026-11-11 — ?borg=<ms> holds each menu frame for the move pace

**Decision:** With `?borg=<ms>`, main-wasm.c wraps the borg's `inkey_hack`.
Before each key read while a screen is saved (inventory, object and store
menus) it calls `Term_fresh()` and then sleeps the borg's own move pause,
`delay_factor² + borg_cfg[BORG_DELAY_FACTOR]²`, read from the engine per key.
Nothing on the TypeScript side computes it.

**Why:** The borg pauses only once per dungeon move
(borg-think-dungeon.c:1237); its menu key sequences go through `inkey_hack`
with no pause, so menus flashed past at any pace. Wrapping the hook from our
front end keeps the engine unpatched. The same pace as a move was Eric's call,
after watching a fifth and a half. Reading the engine's own number makes
"same as a move" true by construction rather than by two copies agreeing. The
fresh comes first because no menu refreshes the screen between drawing and
reading a key: a sleep before it held the frame from before the menu, and
one-key menus were never visible (measured 0–22ms on screen).

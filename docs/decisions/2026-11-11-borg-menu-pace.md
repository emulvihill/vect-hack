## 2026-11-11 — ?borg=<ms> paces menu keys at the move delay

**Decision:** With `?borg=<ms>`, main-wasm.c wraps the borg's `inkey_hack`
and sleeps `factor²` ms before every key it reads while a screen is
saved (inventory, object and store menus). A bare `?borg` installs nothing.

**Why:** The borg pauses only once per dungeon move
(borg-think-dungeon.c:1237); its menu key sequences go through `inkey_hack`
with no pause, so menus flashed past at any pace. Wrapping the hook from our
front end keeps the engine unpatched. The same pace as a move (Eric's call,
after watching a fifth and a half) makes each menu key as readable as a step; the
dungeon keeps its single pause, so moves are not slowed twice.

## 2026-11-03 — Each game's licenses page shows only VectHack's terms and its own

**Decision:** `scripts/build/stage-licenses.mjs` stages one page per game,
`dist/licenses/<game>.html`, carrying `LICENSE`, `THIRD_PARTY_NOTICES.md`,
`SOURCE.txt` and that game's own files (`MODULES`), and nothing of another
game; the Saves panel link points at the booted game's page
(`src/ui/licensesLink.ts`). `index.html`, for no game, carries VectHack's terms
alone. Game-specific notices moved out of `THIRD_PARTY_NOTICES.md` and `NOTICE`
into `NOTICE.NETHACK` and `NOTICE.ANGBAND`; `NOTICE` is gone. The four
`LICENSE.<GAME>` files stay at the root. Every text is still copied raw into
`dist/licenses/`.

**Why:** each game is covered by its own license, independent of VectHack's
MIT license, and a player of one game should read that game's terms, not four
games' worth. One deploy still serves all four games, so all texts ship;
only what each page shows is narrowed. Moving the license files gained
nothing, since the stage step picks files by name.

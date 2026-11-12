# Saves, imports, resets, and checkpoints

Demoted from `AGENTS.md` (vect-hack-2dr). AGENTS.md keeps the invariants below
and points here; this file keeps why each one is what it is.

- One storage volume per Module (`src/backplane/volumes.ts`): `/vect-nethack`,
  `/vect-angband`, `/vect-larn`, `/vect-moria`. A blob is a whole volume —
  **replace, not merge**.
- **F3 refuses a save with nobody in it** (vect-hack-70x). Counting files is
  not the guard: NetHack seeds four empty score files into every volume.
- **F4 warns rather than refuses**, so a characterless blob from an older
  build still loads.
- **A load never touches a live volume.** It parks bytes in the transfer
  store and reloads; the mount applies them, and clears the park either way.
- **A tab that cannot store is still playing a real character**, so F3 packs
  the engine's own session-only paths. Such a tab gets no autosave.
- **Losing tabs never checkpoint**, and a terminal tombstone means a
  dead or quit character cannot come back.

## The Saves panel: F3, F4, and the reset row

The **Saves** button
bottom-left, **F3** and **F4** are the one save affordance every Module shows
(`src/ui/saveMenu.ts`): F3 downloads the whole save volume as one `.vhsave`
blob (`src/backplane/saveBlob.ts`), F4 loads one back. A tab with no volume —
a second tab, or a browser that cannot store — is playing a real character
too, so F3 packs the engine's own session-only paths instead, under the
volume's own relative names. Each Module declares that layout as `sessionSave`
(a root plus the names that ARE its save), because none of those roots is a
volume: NetHack's is the FS root beside `/tmp` and the embed, Moria's is the
packaged seed, and walking one wholesale ships the build as a save. It packs
what the engine has written and a session-only tab gets no autosave, so the
player must use the game's own save command first — which is what the
session-only banner now says. **F3 refuses a save with nobody in it**
(vect-hack-70x): each volume declares in `characterPaths` (`volumes.ts`) the
names under which a CHARACTER lives, and `hasCharacter()`
(`src/backplane/character.ts`) is true only when a file at or under one of them
has BYTES. Counting files is the guard 47a considered and rejected — NetHack
seeds four empty score files into every volume, so "the export has files in it"
is true exactly when the player has nothing. The names are per Module and
include the checkpoints, which are sometimes the only copy there is: NetHack
`save` + `recover`, Angband `save` + `panic`, Larn `home/Larn.sav` +
`home/Larn12.0.ckp` (ckpfile, main-wasm.c:278), Moria `game.sav` + `recover`.
A load cannot touch a
live volume, so the page validates the file, confirms the overwrite, parks the
bytes in the Backplane's transfer store and reloads; the next worker's mount
replaces the volume with it between the populate syncfs and the seed, then
clears the park either way — a blob this build refuses must not be retried on
every reload. F4 asks the same character question and **warns rather than
refuses**: a characterless blob from an older build still loads, but the
question names what it would cost. Replace, not merge: a blob is a whole
volume. A Module may add
its own gate (`validateImport`); only Moria has one;
the panel's third row **deletes this game's stored save** (vect-hack-60i,
`src/ui/saveReset.ts`) — the way out of a volume whose bytes fatal the engine
on every boot, since the parked import is cleared by then and the character it
replaced is already gone. It travels the same road for the same reason and
works when the engine does not: the reset is parked in the transfer store
(a second key per volume; parking either a blob or a reset drops the other),
the page reloads, and the mount empties the volume before the engine looks at
it, asking no `validateImport` — a volume so broken its own Module's gate
rejects it is exactly the one this must remove. A row and no key, deliberately.

The panel's last row is not a save action: **Licenses & source** opens
`licenses/index.html` in a new tab (vect-hack-a4c). It lives here because the
Saves panel is the one piece of chrome every Module shows, and the NGPL and
GPL notices have to reach a player who arrived on a `?game=` link and never
saw the landing page. The href is relative so it resolves under any deploy
base; `scripts/test/licenses-page.test.ts` pins it to the page the build
stages.

Above it, **Quit to main page** appears only when the launcher passed
`?return=<url>` (`src/ui/returnLink.ts`): the site's links add `&return=/`, so
this repo never names the site that hosts it, and a URL without the parameter
shows no row. Only a same-origin URL counts — anything else, `javascript:`
included, leaves the row hidden, so the parameter is no open redirect. It is a
plain link: leaving is the same as closing the tab, and the character resumes
from its last checkpoint. `scripts/test/return-link.test.ts` pins it.
A death **before the engine has sent one message of its own** adds a sentence
pointing at it (`EngineSession.resetAdvice`); a death mid-game does not, since
that advice would cost a running character.

## Checkpoints and recovery

Moria's stock Ctrl-X save and
scores persist in `/vect-moria`. The elected writer also checkpoints only at a
completed outer-command turn tail, after 100 commands and at least 20 seconds;
native play does not resume until the unique-generation checkpoint is durable.
Recovery keeps two generations, falls back past corruption, never outranks a
changed explicit save, and records terminal tombstones so a dead/quit character
cannot return. Losing tabs remain session-only and never checkpoint.

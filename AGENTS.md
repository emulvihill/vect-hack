# vect-hack agent instructions

A project by Eric Mulvihill.

## Project

3D web client for official NetHack 5.0, Angband 4.2.6, BSD Larn 12.0, and
official Umoria 5.7.15: the real native cores compile to WASM and run in Web
Workers behind game-specific I/O adapters, with a shared TypeScript + Three.js
(WebGPU, WebGL fallback) presentation layer. Visual style: Arcade vector
graphics — monsters/items as rotating stroked 3D ASCII letterforms,
walls/floors as glowing wireframe geometry on black, additive compositing. Physics
tokens: `src/skins/tokens/quadrascan.json` — write adapters onto them, not new
physics. Look: atmospheric, not cheesy. Controls:
modernized, not archaic. Camera: orbital 3/4 view primary; first-person toggle on F2.

## Where the detail lives

Tier-0 is invariants and pointers; the reasoning behind them — much of it a
record of a mistake somebody already paid for — was demoted to `docs/`. **Read
the file for an area before changing anything in it.**

- `docs/PROJECT-MAP.md` — one entry per directory, the layering, and what each
  build script guards. The Backplane imports nothing from `modules/`,
  `render/` or `ui/`; **no Module imports another**; `src/skins/` is the single
  source of truth for every colour value; the engine submodules are **never
  patched**; every file the headless gym loads uses relative `.ts` specifiers
  and erasable-only TypeScript. In `main.ts` the view is constructed before the
  session, the storage grant stays on the synchronous path above the `?game`
  arms, and **no `Promise.all` may name one module twice**.
- `docs/TESTS.md` — what each engine test pins (`package.json` says which exist).
- `docs/GATES.md` — the render gates. **None is part of `npm test`.**
  `check:gates` starts and stops its own dev server on 5199 for the four that
  need one, and drives `check:payload`, which needs none, first; the individual
  gates need a server already running. A gate drives only public diagnostics
  accessors, because **an assertion that cannot fail is worse than no
  assertion**.
- `docs/BOT.md` — the Larn bot, the gym, the reflect loop, the knowledge base,
  and the frozen bench. **No fact and no readiness bar can seal a level.** Ids,
  confidence, merging and evidence scope are ours, never the model's. `data/kb`
  is empty **by decision, not by omission** — Phase 1 and Phase 2 are both
  closed. **Report `npm run bench:larn` beside `scripts/dev/bench-pair.mjs`,
  always.** `policy-sweep.mjs` refuses `--set held-out`, and nothing in code
  keeps a held-out seed out of a reflection — that wall is the runbook's.
- `docs/SAVES.md` — F3, F4, the reset row, session-only tabs, checkpoints and
  recovery. A blob is a whole volume: **replace, not merge**. F3 refuses a save
  with nobody in it (counting files is not the guard); F4 warns rather than
  refuses. **A load never touches a live volume.** Losing tabs never checkpoint,
  and a terminal tombstone means a dead or quit character cannot come back.
- `docs/UI.md` — every dev URL flag, the camera and key schemes, the hit flash
  and the Look HUD. **Function keys are view chrome; they never reach a native
  core.** `?game=<module>` is never implicit — no code may depend on a default
  game. A URL without `?touch` builds none of the touch scheme. The Look HUD
  sends the engine nothing, and an ambiguous hit draws nothing rather than a
  guessed pulse. Larn has no `hitInference.ts` and never flashes.
- `docs/decisions/` (one file per decision; `docs/DECISIONS.md` is the frozen
  log before 2026-10-22), `docs/RELEASE-CHECKLIST.md`,
  `LICENSING.md`, `src/backplane/CONTEXT.md`. `docs/specs/` holds the dated
  design documents and `docs/reports/` the measured runs that `docs/BOT.md`
  and `docs/GATES.md` cite; both are **frozen history**: add, never rewrite.

## Build, test, and run

```bash
scripts/build/setup-toolchain.sh    # once: engine submodules + emsdk (external/emsdk, gitignored)
scripts/build/build-nethack-wasm.sh # NetHack -> targets/wasm/, copied to public/modules/nethack/ (gitignored)
scripts/build/build-angband-wasm.sh # Angband 4.2.6 -> public/modules/angband/angband.*
npm run build:larn                  # Larn 12.0 -> public/modules/larn/larn.*
npm run build:moria                 # Umoria 5.7.15 -> public/modules/moria/moria.*

npm test                            # typecheck + vitest + every engine test, all Modules
npm run typecheck                   # tsc, no emit (noUnusedLocals + noUnusedParameters on)
npm run lint                        # eslint over the ~70 .mjs drivers under scripts/ — TS is typecheck's job
npm run test:render                 # vitest: all unit tests, every Module and shared layer
npm run test:nethack                # the NetHack engine tests: boot persist save-restore tabs autosave
npm run test:angband                # the Angband engine tests: boot persist save-restore autosave borg borg-death
npm run test:larn                   # the Larn engine tests: boot seed repro trace persist save-restore
                                    #   autosave map-contract status savefile gym reflect killer
npm run test:moria                  # the Moria engine tests: boot play checkpoint-native map-contract
                                    #   persist save-restore tabs autosave overlay build-contract
                                    # each is its own `test:<game>-<name>`; docs/TESTS.md says what each pins

npm run dev                         # vite dev server on 5173 (5199 only via .claude/launch.json)
npm run preview                     # offline scene + radar images, no GPU needed
npm run preview:mobile              # phone shots -> .preview/mobile-*.png: all four Modules at 390x844, with and without ?touch
npm run serve:www                   # build --base /play/ and serve the vecthack.com layout on 8080 (site from ../vect-hack-www/site, VH_SITE/PORT override)

npm run check:gates                 # payload + browser + controls + touch + angband-borg; dev server started and stopped for the four that need one (--only, --stamp)
npm run check:browser               # real Chromium + GPU: all vector Modules/backends, plus the WebGL-fallback and no-GPU arms; needs a dev server
npm run check:controls              # real Chromium: movement and effects against a live game
npm run check:angband-borg          # real Chromium: 10 minutes of borg play, measured
npm run check:touch                 # real Chromium at 390x844: the ?touch scheme, zero keys, and no Module scrolling sideways
npm run check:payload               # cold-cache Chromium: ?game=<M> must fetch no other Module's JS (needs no GPU, no server)
.github/workflows/ci.yml            # CI: typecheck + test:render + check:payload on push. No engine build, no GPU — docs/GATES.md

npm run bot:headless -- --game larn # bot gym: N games in child processes at full speed -> .gym/ (--games --parallel --max-commands --timeout --out --seed --kb)
npm run bot:reflect -- --batch DIR  # one model reflection per played game -> data/kb (--kb --brain --replay --url --model --effort --probe-sample --archive --no-reuse --dry-run --ship)
npm run bench:larn                  # the Phase 2 bench: a frozen seed set -> the pre-registered metrics (--set bench|held-out --kb --parallel --out --read-only)
node scripts/dev/policy-sweep.mjs   # a knob over the bench, one arm per value: --knob N --values a,b,c | --grid JSON (refuses --set held-out)
node scripts/dev/kb-ab-report.mjs   # the paired held-out A/B: --control DIR --treatment DIR [--out PREFIX --seed-master N --cohort N]
node scripts/dev/kb-split.mjs       # one KB per claim kind, for attribution arms: --facts F --kinds threat,note --out DIR
scripts/dev/worktree-setup.sh       # a fresh worktree has no build state; run this first
scripts/dev/worktree-teardown.sh    # remove a finished worktree without breaking the primary's submodules (--list, --discard)
node scripts/dev/larn-engagement-report.mjs --batch DIR   # what a batch did when a monster reached it: melee, never-swung, blows, capped
node scripts/dev/reflect-prompt-probe.mjs --transcripts DIR --out F.jsonl  # re-ask archived reflections under the current prompt: which kinds it routes a lesson to
```

`npm test` runs every Module's engine tests — there is no fast subset worth
preferring; the groups name a failure, they are not permission to leave a
Module unrun. **Each build script guards what its artifact cannot be checked
for afterwards** (`docs/PROJECT-MAP.md`).

Dev URL flags, in full in `docs/UI.md`: `?game=<module>` (`nethack` | `angband`
| `larn` | `moria`, never implicit), `?trace`, `?view=debug`, `?gl`,
`?skin=<quadrascan|ghost|high-contrast>` (`VECT_SKIN=name` for `npm test` and
`npm run preview`), `?bot` / `?bot=fast` / `?bot=<ms>`, `?borg` / `?borg=<ms>`
(Angband only), `?touch` (NetHack only). In-game: **F2** first person, the
**Saves** button with **F3** export / **F4** import, keypad 5 to face north.

## Playtesting in the browser

**The one rule: never edit `src/` while a game is live.** Vite HMR full-reloads
the page, the engine reboots, and the run is gone — NetHack deletes the save on
restore, so unless a checkpoint has landed it drops straight to character
creation. Collect findings across a whole session, then
batch the edits. Editing `AGENTS.md`/`docs/` is safe.

**Chrome (claude-in-chrome MCP).** Load every tool in one `ToolSearch`
`select:` call; call `tabs_context_mcp` before anything else and open a fresh
tab. Then:

- Send letters with `computer` `type`, not `key`. `key: "shift+z"` arrives at
  the page as plain `z`, which silently turns "cast a spell" into "zap a wand".
- `key` is right for `Escape`, `Return` and `ctrl+d`. Ctrl combinations reach
  the game; `TextHud` preventDefaults them, so Ctrl-D kicks and does not
  bookmark the page.
- Batch turns with `browser_batch`, and prefer reading state over screenshots —
  a screenshot of the 3D view is hard to reason about positionally.

**Page-side helpers.** Far faster than the `computer` tool, and they survive as
long as the page does. Paste once per page load via `javascript_tool`:

```js
window.nhKeys = (s) => { for (const ch of s)
  (document.activeElement||document.body).dispatchEvent(
    new KeyboardEvent('keydown',{key:ch,bubbles:true,cancelable:true})); };
window.kick = (dir) => { const t=document.activeElement||document.body;
  t.dispatchEvent(new KeyboardEvent('keydown',{key:'d',ctrlKey:true,bubbles:true,cancelable:true}));
  t.dispatchEvent(new KeyboardEvent('keydown',{key:dir,bubbles:true,cancelable:true})); };
window.dumpMap = () => { const m=window.__nhView.renderer.map, c=m.cells, o=[];
  for (let y=0;y<21;y++){ let r=''; for(let x=0;x<80;x++) r+=c[y*80+x].ch; o.push(r.replace(/\s+$/,'')); }
  return o.map((s,i)=>s?String(i).padStart(2)+' '+s:'').filter(Boolean).join('\n')
    + '\nhero '+JSON.stringify(m.hero)+' cursor '+JSON.stringify(m.cursor)
    + '\n'+document.getElementById('status').textContent; };
window.msgs = () => [...document.getElementById('messages').children]
  .slice(-5).map(d=>d.textContent).join('\n');
```

Await ~700-900ms after each `nhKeys` batch before reading — the engine answers
on a microtask through the worker. Any loop that repeats an action needs a stop
condition read from `msgs()`; kicking a door that already opened strains a leg.

`window.__nhView` is the live view and `__vhBooted` the boot flag. Monkeypatching
`__nhView.handle` to log `ShimEvent`s is the way to confirm what the engine
actually sends before building against it — that is how `curs` was shown to
track the farlook cursor. Patching JS in the page does not trigger HMR, so the
game survives it.

**Getting into a game.** Character creation is `n` (pick manually), role,
race, alignment, `y` to confirm, `Return` past the intro, then `y`/`n` for the
tutorial. `v h l` is a lawful human Valkyrie — the sturdiest thing to learn or
test on. Reaching the same state twice takes ~30s, so re-rolling after an
accidental reload is cheap.

**The tutorial level is the best renderer fixture** — one small level with
water *and* lava, a dark corridor, engravings, several locked doors and a trap
room. Route from the start: `llll`, `hhhhhhhh`, `khh`, `hnjjj`, `bj`, `jj`,
`jjj` reaches the water/lava room; from there `j`, `llll`, `hjj` puts you on
the locked door south (kick it), and the trap room is further east and south
past a second locked door and a dark corridor. Search with `10s` repeated.

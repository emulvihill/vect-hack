# Decisions — vect-hack

**Frozen history.** New decisions go in `docs/decisions/`, one file each
(`YYYY-MM-DD-<slug>.md`); see `docs/decisions/README.md`. Nothing is added
below this note.

Append-only log of non-obvious project decisions. Newest at top. Keep entries terse.

## 2026-10-21 — the gate service unit is rendered, not symlinked

**Decision:** `install-gate-timer.sh` derives the checkout from its own
location, refuses a linked worktree by comparing `--git-dir` with
`--git-common-dir`, and writes `vect-hack-gates.service` into
`~/.config/systemd/user/` with `@REPO@` substituted. The timer unit stays a
symlink. Replaces the 2026-10-02 entry that named the paths, which is removed.

**Why:** The tree is being republished from a squashed snapshot, so no
tracked file may name a machine, an account or an absolute home path. A
systemd `ExecStart` must be absolute, so the one path that cannot be
relative is produced at install time instead of committed.

## 2026-10-21 — the 2026-08-27 security review is deleted, not redacted

**Decision:** `docs/reports/2026-08-27-security-review.md` is
removed from the tree. The hygiene review of the same date stays, with its
paths and host names generalised. The retired proof of concept the effects
and token file grew from is no longer named anywhere; the physics is "the
vector-CRT model".

**Why:** The review printed live CDN identifiers and a step-by-step cost
attack against the live site; redaction would have left a document that was mostly holes. The codename
pointed agents at a repository nobody can open and produced false
provenance and licensing findings (NOTICE, LICENSING reviews).

## 2026-09-17 — hand Borg postmortem input back to the player

**Decision:** Latch Angband's complete native death menu in `BorgPlayer` and
delegate later blocking input to the wrapped view (`vect-hack-z5og`). Keep
nonblocking input drains empty. Test the real menu deterministically through
native retirement and inspect Information before manually exiting.

**Why:** The decorator's fallback Enter selects Information, dismisses its
inventory pages, and repeats forever on the tombstone. Inspection replaces the
menu text, so a one-screen guard would resume that loop. Handoff preserves
postmortem inspection; the native dead-character save is written only after
the player leaves the death menu.

## 2026-09-16 — Larn trap projection and policy-test fixtures

**Decision:** Publish teleporter, arrow, dart and trapdoor objects as one generic
trap kind and describe each as “a trap”. Append the kind without renumbering
historical map records. Keep pits distinct and hidden traps equivalent to floor.
Use explicit empty facts in baseline policy tests, retaining shipped tuning
and a separate shipped-KB validation/hash check (`vect-hack-pkz`, `vect-hack-b5f.25`).

**Why:** All four visible traps share the same terminal glyph; their native
subtype must not leak through the map or Look HUD. Policy expectations about
empty knowledge must not change when the shipped facts change. This bounded
repair does not establish universal terminal-glyph equivalence: elevators also
use `^`, and other object descriptions remain outside this trap fix.

## 2026-09-16 — center the shared non-touch overlay

**Decision:** Center `#overlay` on both viewport axes globally, rather than
adding an Angband-only offset. Keep the `vh-touch` top anchor and explicitly
override its transform to horizontal-only. `check:overlay` exercises real CSS
layout without GPU/engine/server work and runs before the existing touch gate.

**Why:** The fixed `6em` top edge covers Angband's mirrored prompt row. The user
requested trying global centering; short menus and full terminal screens now
center by their own height. Retaining the touch top offset without overriding
the new vertical translation would pull the phone panel above the viewport.
Very short windows may still overlap header chrome; the layout check verifies
that their clipped content remains scrollable rather than claiming otherwise.

## 2026-08-30 — lint covers the .mjs drivers; TypeScript stays typecheck's job

**Decision:** `eslint.config.mjs` lints the ~70 `.mjs` files under `scripts/`
and ignores every `.ts`. `npm run lint` runs in CI, not in `npm test`. Node is
pinned once in `.nvmrc`, with `engines` beside it and CI reading the file.
`noUnusedLocals` and `noUnusedParameters` are both on.

**Why the JavaScript-only scope:** typescript-eslint 8.68.0 declares
`typescript ">=4.8.4 <6.1.0"` and this repo is on 7.0.2. A plain install is a
hard ERESOLVE, which would fail `npm ci` in CI; `--legacy-peer-deps` throws at
import from the plugin's own `dist/index.js:52`; nested `overrides` still
ERESOLVE. The only working route aliases the root `typescript` to the TS 6
compat package, which would quietly demote `npm run typecheck` from tsc 7 to
tsc 6 — a real loss traded for a lint rule. So the `.mjs` drivers get the
coverage instead, which is the surface `allowJs` without `checkJs` leaves
entirely unchecked. Revisit when typescript-eslint supports TS 7.

**One thing the config had to learn after it landed:** it must ignore
`.claude/**`. The primary checkout carries every live agent worktree under
there, each a full copy of the repo, so `eslint .` lints them all — measured at
242 files and 12034 errors, none of them about this tree. A worktree contains no
other worktrees, so this cannot be seen from inside one, which is where the
config was verified. The same blind spot as the Vite-watcher trap, from the
other direction.

## 2026-08-30 — the detection check in check:controls asserted the boot paint

**Decision:** `fp-controls-check.mjs` no longer claims that "Detect all nearby"
repacks the whole level. It zeroes `counters.maxBatch` before the keystroke,
reports the batch size as evidence, and asserts only that the command reached
the engine and flushed the map and that the sweep kept what was known.

**Why:** `maxBatch` is a cumulative maximum and `on_level` marks `dirty_all` on
every level entry, so the birth paint had already satisfied the check — it held
with the `on_itemlist` handler deleted outright. Made able to fail, it fails on
UNMODIFIED production: in town nothing is detected, so nothing sets
`PR_ITEMLIST` and the fallback never arms (largest batch 1 grid of 1452). And
the fallback cannot be isolated from this gate anyway: `on_map` sets `dirty_all`
by itself for `EVENT_MAP`'s `(-1,-1)` whole-map payload, which `cave-map.c`
raises alongside `PR_ITEMLIST` on every detection — measured, a debug summon
repacks all 1452 grids with `on_itemlist` unregistered. An assertion that cannot
fail is worse than no assertion (vect-hack-azf); an assertion that fails on
correct code is worse still. So the claim was removed rather than restated, and
the measurements live in the file's header.

## 2026-08-30 — an effect's lifetime rides the event, not the grid

**Decision:** the Module's view signals `DungeonRenderer.effectFired(x, y, cell)`
and `MapFx` keeps the cell drawable for `EFFECT_LIFETIME_S` (0.25s);
`EntityLayer` draws that residue only where the engine currently shows terrain
or nothing. The grid stays engine truth. `check:controls` fires the wizard-mode
SPHERE a second time at `delay_factor` 0, read back from the engine.

**Why:** projections were visible only because Angband paces its own animation
with `delay_factor`, 40ms per radius by default, and our effect Cells lived on
the grid across that delay. A player who sets it to 0 from the options menu
collapses the animation: set and erase arrive in one batch and no frame ever
draws the blast. A grid-level TTL cannot fix it — `MapFx.observe()` samples the
grid per frame and cannot see a Cell that never survived one — so the
persistence had to be driven by the effect EVENT (vect-hack-auo). Measured in
one gate run, which prints both numbers: at `delay_factor` 0, grid-sampled
frames 0, drawn-from-residue frames 15.

## 2026-08-30 — MON_HIT reads the message text, alone among Angband's hit types

**Decision:** `inferAngbandHit()` takes the message text and requires a
`\byou\b` target for `MSG_MON_HIT`. Every other type stays purely typed.

**Why:** `MON_HIT` is a blow-METHOD type. `mon-blows.c` emits the same `msgt`
from `display_blow_message_vs_player()` and `display_blow_message_vs_monster()`,
so "The kobold hits the orc." reddened the player's `@` (vect-hack-xqg). Nothing
typed distinguishes the two emitters, so keeping the file purely typed meant
keeping the bug. The typed-vs-text split in the 2026-08-06 spec described what
each engine affords, not a prohibition, and the governing rule finishes the
argument: a `MON_HIT` naming a monster is known-not-the-hero, and this file draws
nothing for those. The cost is a second dependency on the pinned 4.2.6 submodule
— `act:hits {target}` and `BLOW_TAG_TARGET`'s literal "you" — but that is the
same pin the typed `list-message.h` positions already rest on, and the failure
mode if upstream drops the target tag is a lost flash, the side this file has
always erred on. `\byou\b` rather than a looser match so the possessive "your"
and a name like "young blue dragon" cannot pass for a target.

## 2026-08-30 — CI runs the buildless half of the suite, and says so

**Decision:** `.github/workflows/ci.yml` runs `typecheck` + `test:render` +
`check:payload` on push, on Node 24, and is named `checks (no engine build, no
GPU)`. The four engine groups and the four render gates are deliberately out,
and the workflow's own header comment names them and says why. The www repo gets
a matching workflow running `npm ci && npm test` in `infra/`.

**Why:** the engine artifacts are gitignored and cost 1.7 GB of emsdk plus four
builds to produce, against a suite that runs close to thirty minutes — expensive
on every push while the repo is private and minutes are metered. The naming
matters more than the omission: a check called "tests" that never touches an
engine is the same defect as an assertion that cannot fail. Measured, not
assumed: `test:render` passes with no `public/modules/` at all but fails with two
ENOENTs without the engine submodules' source, so the unit job checks out
submodules and the payload job does not.

**One thing CI's own arrival changed in a gate:** `check:payload`'s no-GPU arm
is a COMPARISON, so on a machine with no 3D at all both arms measure the same
tty page and "a browser with no GPU fetched no renderer" is true by
construction. The gate now refuses to report green when no Module's GPU arm
produced a canvas. A hosted runner normally gets WebGL through SwiftShader —
which is why the browser gate's nogpu arm must pass `--disable-3d-apis` to take
it away — but a runner without it now turns the job red on purpose.

## 2026-08-30 — check:controls waits for NetHack's parked command read, not 200 ms

**Decision:** the NetHack arm of `fp-controls-check.mjs` polls `nethackReady()`
— TextHud's `KeyQueue` has a waiter, nothing is buffered, and
`pendingInput === "none"` — before every observed press, and takes no fixed
sleep at all afterwards. A unit test pins both the predicate and the absence of
`waitForTimeout` in that arm. The four Module arms became functions run from one
`try/finally`.

**Why:** the gate's own header states the rule it was breaking. The other three
arms poll; this one slept 200 ms and asserted against whatever that landed in,
which went red about one run in eight. A parked-REQUEST poll rather than
Angband's quiescence poll, because NetHack does park a request and quiescence
cannot tell a command read from a prompt. The `try/finally` is
`browser-check.mjs`'s structure (vect-hack-azf), never propagated to its sibling.

**The flake itself was never reproduced, and the evidence is not a green
count.** Twelve warm cycles on the unchanged tree were all green, and 27
instrumented boots found the engine already parked at the instant the old arm
pressed F2. So a controlled experiment stood in for the repro: the slack the old
arm lived on is the 150 ms `settle()` slept after answering a boot prompt, and
with it set to 0, the OLD exit condition started from an unparked engine 8 times
out of 8 and failed the bead's `ArrowLeft turns +45 deg` every time, while the
new one started parked 8 out of 8 and passed with no post-press sleep. Twenty
consecutive green runs followed, each started immediately after
`check:browser` — but they are corroboration, not the proof. The mode-message
half of the bead's red is diagnosed and was not reproduced under any
perturbation tried.

## 2026-08-29 — chooseView takes loaders, so a no-GPU page never fetches the renderer

**Decision:** `chooseView` receives a loader per view (`() => Promise<class>`)
and calls only the winner's; it returns a discriminated `{kind, view}` instead of
a bare view, and `main.ts`'s four arms read the discriminant where they read
`view instanceof VectorView`. `check:payload` grew a `--disable-3d-apis` arm that
fails if a no-GPU load fetched the three.js chunk.

**Why:** the view classes were handed to the policy as VALUES, so both arms were
downloaded before it could pick one, and a browser shown a character grid paid
810 kB of three/webgpu + `src/render` (224 kB over the wire) to draw it. It buys
the common case nothing and it is honest to say so: a visitor with a GPU still
fetches all 810 kB, plus one probe's latency in front of it. The `instanceof`
went because the call site can no longer hold the vector class as a value
without re-importing the module the tty arm exists to skip; the discriminant
keeps the type error the `instanceof` was there for. Direction 2 of
vect-hack-po4 — whether three/webgpu can be trimmed at all — remains open and
unmeasured, and the bead stays open for it.

## 2026-08-29 — the opening camera framing is a width of map, not a distance

**Decision:** `OrbitCam` opens at `radius = 14 * max(1, 1.6 / aspect)` rather
than a fixed 14, and the orbital camera gained a two-finger pinch zoom. First
person gained neither. The rule reads the viewport and not the `CellGrid`.

**Why:** at 390x844 the fixed radius framed 7 of 80 map columns, and a
touchscreen cannot produce the wheel event that was the only zoom input — so the
touch spike had working controls over an unusable view (vect-hack-lxd). Pinning
the radius at and above a 1.6:1 stage makes every desktop viewport unchanged by
construction rather than by measurement, which is what let a shared render file
change without moving `check:browser`: measured bit-identical at 1440x900,
39/41/39 columns, radius 14.0. The grid is not consulted because a grid-derived
clamp could never fire (the narrowest map is Larn's 67 columns against a
~21-column framing) and because framing a fraction of Moria's 198 columns on a
phone is two pixels a cell: what a player needs is a fixed number of cells of
context, and every Module gets the same.

## 2026-08-29 — KeyQueue cancellation resolves with null, never rejects

**Decision:** `KeyQueue.cancel()` settles a parked waiter by resolving it with
`null` and latching the queue closed; it does not reject. NetHack's
`TextHud.readKey()`, which throws on a null blocking read by design, gains a
`disposed` branch that answers `ESC` — the value `fallbackValue()` already
returns for `nhgetch`.

**Why:** a rejection travels out of the view's `nextKey` into
`EngineSession.dispatch`'s catch — the throwing-dispatch guard for
vect-hack-1g5/c1w. That guard posts a cancel-shaped fallback to a worker being
terminated and tells the player a display error cancelled their action. A
deliberate teardown is neither, and a guard that fires for normal shutdown stops
meaning what it says. `null` is already the queue's answer for "no key" and
every Module's dispatch already turns it into that engine's own no-key reply. An
unawaited rejection would also be an unhandled rejection on a page that is
merely closing. The latch is one-way: a queue whose view is disposed is not
restartable, and a re-armable flag would only offer a way to resurrect a queue
whose pusher no longer exists.

## 2026-08-29 — the vendored token file lives in src/skins/, and the layering is a test

**Decision:** `quadrascan.json`, the base token file, moves
from `src/render/` to `src/skins/tokens/quadrascan.json` — under `tokens/`, so
the basename does not collide
with the default skin `src/skins/quadrascan.json`. `src/skins/` is now a leaf:
it imports nothing above itself. `scripts/test/layering.test.ts` enumerates
`src/` and asserts every rule in `docs/PROJECT-MAP.md`'s table. Supersedes
2026-07-26 ("quadrascan.json is vendored into src/render/").

**Why:** the only importer of the render copy was `src/skins/index.ts`, while
`src/render/palette.ts` and `TerrainBuilder.ts` import `src/skins` — the tree's
one import cycle, and the 2026-08-27 architecture review's only layering
violation (vect-hack-t72k). Tokens are skin data and skins are the documented
single source of truth for colour, so the file belongs under skins and render
reads it through `activeSkin().tokens` like everything else. The move changed no
byte of the file and no pixel of the scene: all five `npm run preview` artifacts
hash identically before and after.

**The review's premise was a false alarm, and that is worth recording** because
`docs/superpowers/` is frozen history and cannot be corrected in place: the two
`quadrascan.json` files were never two copies of one file that had drifted. One
is the base token file (733 B) and
the other is the default skin (1442 B) — different schemas sharing a basename.
Nothing had diverged, so no visual choice had to be made.

## 2026-08-29 — one VectLarn bridge the hosts decorate, with two loud defaults

**Decision:** `src/modules/larn/shimBridge.ts` is the only implementation of the
Larn shim's JS side; the six hosts pass it a `name`, one `onEvent` stream for
all display callbacks, and the four lifecycle callbacks. The gym hooks are
installed only when a host supplies them, and a display callback with no
`onEvent` throws rather than no-ops.

**Why:** six literal copies meant `statusBatch` broke four gates at once
(vect-hack-dwb). Sharing the code is the easy half; the two mitigations are the
part a refactor loses. `main-wasm.c` reads the gym hooks with `typeof`, so a
default turns "off" into "on for everyone" — the test asserts the property is
ABSENT, not that it returns 0. And a silent display default would hide the very
failure that made this bead cheap to find, so the default throws and names both
the callback and the host. Measured, not asserted: a throwaway seventh callback
cost 10 lines in three non-host files and zero host edits, with all thirteen
Larn gates green.

## 2026-08-29 — check:payload is a gate, first in the run, and never notifies

**Decision:** `check:payload` is the fifth row in `GATES`
(`scripts/dev/gate-run-utils.mjs`) and the first one a run drives, marked
`standalone: true`. The preflight and the dev server are asked for only when a
run contains a gate that needs them, so `--only payload` works on a machine with
no reachable render node and `--only browser` starts no production build. A run
can now be red and could-not-run at once; `verdictOf` ranks them, and a gate that
RAN and failed outranks a preflight nothing could have satisfied.
`NOTIFYING_GATES` stays exactly `browser` and `controls`.

**Why a row and not a second category:** vect-hack-hnw already settled the shape
— a gate is a row in that table and the runner reads the row. A second category
would have been a second way to be a gate, and the difference between payload
and the other four is one bit, not a mechanism.

**Why it runs first:** it is the only gate that can be driven before the
preflight decides whether anything else can be. At 03:30 on a logged-out
machine that is the difference between one real answer and exit 3 for
everything, which is the decay vect-hack-qv1 was filed on.

**Why it does not notify, being deterministic and stable:** borg is excluded on
luck and touch on churn, and neither applies here. Payload is excluded on
CONSEQUENCE — the channel carries "the desktop client will not render or will
not steer", and a chunk leak makes the download bigger while nobody is unable to
play. It still fails the run and still sets the exit code. Measured, not
estimated: 23.8s standalone, 28.3s under the runner, against the ~40s the bead
assumed.

## 2026-08-29 — the stamp verifies the gate list it cannot write

**Decision:** `--stamp` gains a fourth refusal (vect-hack-r1s, option C as
costed there): it refuses when a gate the run drove is not named in the "Last
verified green" paragraph, and the message names the missing gate.

**Why:** the line pairs a date the runner writes, which cannot rot, with a gate
list a human maintains, which rotted inside twenty-four hours — check:touch
landed on a parallel branch and the sentence went on naming three gates while a
run drove four, and the stamp silently re-dated the stale claim. This closes it
with the mechanism the stamp already uses: refuse rather than guess. Options A
(let the runner compose the sentence) and B (every gate emits a structured
coverage report) were costed in the bead and rejected — A deletes the content a
reader wanted, B needs a coverage schema four differently shaped gates can fill
honestly. What it cannot catch is a stale COUNT, and that is accepted, said
plainly in the code comment and pinned by a test. First live use is a refusal:
the committed sentence records a four-gate run from 2026-08-26 that predates
check:payload, and writing a payload clause in now to dodge that would have
re-created the exact rot the bead is about.

## 2026-08-29 — the Moria build contract runs with --require-build, last in test:moria

**Decision:** `npm run test:moria-build-contract` passes `--require-build`, and
sits at the end of the `test:moria` chain rather than the start.

**Why:** every link-line and behavioural pin lives behind that flag; without it
the script prints PENDING and exits 0, so wiring it in without the flag would
have satisfied vect-hack-03z and changed nothing. It runs last because it
performs real builds and republishes `public/modules/moria`, which the nine
groups ahead of it read.

## 2026-08-29 — a stub `make` in the Moria contract fixtures must carry the exported names

**Decision:** the stub link outputs in the dirty-source and atomic-publication
fixtures append `_moria_start _moria_describe`, from one shared constant.

**Why:** the build greps the artifact for `_moria_describe` before it reaches
the source-dirtied guard or the publication block, so after the Look HUD added
that export both fixtures stopped the build early: one assertion passed for the
wrong reason and the other crashed. These were VACUOUS, not merely stale.
Verified by deleting the source-dirtied guard from the build script — green
against the old fixtures, red against the repaired ones.

## 2026-08-29 — NetHack's main.ts test mocks VectorView as a real instance

**Decision:** `scripts/test/nethack-main.test.ts` mocks VectorView with a class
whose constructor records `this`, rather than the sibling files'
`constructor() { return seam.vector; }`.

**Why:** `?touch` and the look binding are both gated on
`view instanceof VectorView`, which a returned foreign object makes permanently
false. Under the sibling shape, deleting either line from main.ts keeps the test
green — which is still true of the Angband, Larn and Moria arms (vect-hack-25yk).

## 2026-08-29 — the phone overlay scrolls inside its own box

**Decision:** `#overlay` is capped at `calc(100vw - 24px)` with
`box-sizing: border-box` and `overflow: auto`, in the base rule rather than
only under `body.vh-touch`; the no-keyboard notice is left exactly as it was.
`check:touch` grew the assertion, and it waits for the overlay rather than
sleeping a fixed interval.

**Why:** vect-hack-0a4 offered two fixes and one of them was already shipped —
`#nokeyboard` has been `position: fixed; inset: 0` since d72. What `fixed`
resolves against is the LAYOUT viewport, and `#overlay`, 708px of 80-column
monospace against the initial containing block, had grown that to 549 on a
390px phone (`window.innerWidth` read 549, not 390). So the notice was
correctly fixed to the wrong thing and only the overflow could fix it.
`box-sizing` is part of the constraint and not tidying: content-box turned a
366px cap into a 400px element, and the first cut of the fix still grew the
viewport, to 395. Desktop is unaffected by construction — the cap is 1416px at
1440px wide against 708px of content — and the before/after screenshots are
byte-identical. The guard went into `check:touch` rather than
`mobile-preview.mjs`, which already printed `<-- SCROLLS SIDEWAYS` and exited 0
for the whole time the bug was open: a number that only shames you is not a
guard.

## 2026-08-29 — a worktree is torn down with `--force`, never with a submodule deinit

**Decision:** `scripts/dev/worktree-teardown.sh` removes a finished worktree
with `git worktree remove --force` and never runs `git submodule deinit`. It
refuses first on uncommitted changes, on commits not on `main`, and on
unversioned data it does not recognise as build state; afterwards it verifies
the primary checkout's submodule registration rather than assuming it.

**Why:** the procedure AGENTS.md previously gave was itself the trap it warned
about. It said to deinit inside the worktree first, and deinit unregisters the
submodules in `.git/config`, which every worktree SHARES — leaving the PRIMARY
checkout broken, silently, until some later build reads `external/`. The deinit
was never necessary: git's manual says "ones with submodules can be removed with
`--force`" (the "`--force` twice" nearby is about locked worktrees), and a
scratch worktree with all three submodules checked out was removed on git 2.53.0
with `git submodule status` in the primary unchanged. The unversioned-data
refusal was added the same day because its absence had just cost 150
non-regenerable reflection transcripts: every other thing in that directory was
reproducible from a frozen seed master, which is why nobody thought about the
one thing that was not.

## 2026-08-28 — a Larn verb ships behind a knob that defaults to off, and the knob is how its control arm is run

**Decision:** every Phase 2 capability (`wieldProbes`, `castAtRange`,
`descendMinHpFraction`) lands in `data/kb/larn/policy.json` at a neutral value,
with a unit test asserting the shipped value makes the code inert. The A/B's
control arm is then the same build with that one constant changed, and the
verdict is pre-registered in a spec committed before the run.

**Why:** it makes the comparison clean in a way an older commit cannot — any
incidental difference in the new code is present in BOTH arms, so the only thing
the measurement can attribute anything to is the knob. It was confirmed three
times: the control arm reproduced the previous build's held-out figures exactly
(598 commands, 455 score, medians 2 and 2) on every occasion. It also means a
measured-null capability stays in the tree as a search dimension for
vect-hack-h9x.11 rather than being deleted and rebuilt.

## 2026-08-28 — the bench's co-primary medians decide, and a paired per-seed test says whether they could see anything

**Decision:** `npm run bench:larn`'s median deepest-dungeon-depth and median
xlevel remain the ship rule. `scripts/dev/bench-pair.mjs` — up/down/tied counts,
mean delta and a sign test over untied pairs — is a REQUIRED diagnostic beside
them in every Phase 2 report, and is never itself a ship rule.

**Why:** dungeon depth runs 0-10, so a median over 500 games ties two thirds of
any comparison and cannot resolve a small effect; two verb reports wrote "no
effect" where the evidence supported only "no effect this instrument can see".
The reverse error is worse and was also measured: the r5 terrain arm PASSES the
median rule (depth 2 vs 2, xlevel 3 vs 2) while the paired test shows a
significant per-seed depth regression (-0.338, p < 0.001). The medians stay
primary because they are goal-aligned — a detectable 0.08 dungeon levels is not
progress toward the Eye — and the paired test stops a report claiming more, or
less, than it measured. See vect-hack-h9x.2.

## 2026-08-27 — a save is judged by bytes under declared character paths, not by file count

**Decision:** `ModuleVolume.characterPaths` names, per Module, where a character
lives; `hasCharacter()` is true only when a file at or under one of those names
has a non-zero size. F3 refuses when it is false and says to use the game's own
save command first; F4 keeps loading but asks a different question that names
what the empty file would cost. The paths include each engine's checkpoints.

**Why:** the guard that suggests itself — refuse an export whose file list is
empty — passes exactly the case it was written for, because NetHack seeds four
empty score files into every volume (vect-hack-47a rejected it for this).
Bytes under a declared name is the smallest rule that is actually about a
character. Checkpoints count because a tab that crashed before the player ever
used the save command has its character there and nowhere else — the shape of
a real exported Moria volume is runtime files, a score table, and
`recover/.pending.sav`. Larn's `home/Larn12.0.ckp` was found by an engine test
failing, not by reading: declaring `home` wholesale would have swept in
`.larnopts`, and declaring only `Larn.sav` would have called a checkpointed
game empty.

**Refused, not warned, at F3; warned, not refused, at F4:** the export is the
moment the useless file would be created, and refusing there costs nothing.
The import is somebody's file — possibly full of scores they want — and the
volume it lands in is theirs to spend.

## 2026-08-27 — deleting a save volume is parked like an import, not done in the page

**Decision:** the Saves panel's third row parks a reset in the transfer store
under a second key per volume and reloads; the next mount empties the volume
before the engine runs. Parking a blob or a reset drops the other. The reset
asks no `validateImport`. It has a menu row and no key, and a fatal that
arrives before the engine's first message appends one sentence pointing at it.

**Why:** the volume is mounted in the worker's filesystem, so the page cannot
touch it — the same reason an import is parked — and this must work when the
engine is dead, which the mount seam does and a worker round trip does not. No
Module gate, because a volume so broken that its own Module's gate rejects it
is exactly the one that has to be removable. No key, because F3 and F4 ask
before doing something reversible and this one is not. The fatal sentence is
scoped to a boot death: pointing a player whose game just crashed mid-run at
the button that deletes their character is advice that costs them the
character.

## 2026-08-27 — the deploy base arrives as VH_BASE, and the build asserts it landed

**Decision:** `vite.config.ts` reads `base: process.env.VH_BASE ?? "/"`, and the
deploy passes `VH_BASE=/play/` instead of `npm run build -- --base /play/`.
The deploy then greps the artifact — `dist/index.html` for `/play/assets/`,
`dist/assets/` for `/play/modules/` — and refuses to sync if either is absent.

**Why:** npm appends run-args after the whole `&&` chain in the build script, so
`--base /play/` reached `stage-licenses.mjs`, which never read it, and vite
built at base `/`. The flag was a no-op for the life of the deploy script. The
base is load-bearing for the engine and not just for asset hrefs: all four
workers build their module URL from `import.meta.env.BASE_URL`, so a wrong base
403s `/modules/*` as well as `/assets/*` behind CloudFront OAC. Nothing could
catch it — the chunk names are identical either way, `npm test` never builds for
a sub-path, and a smoke test that checks `/play/index.html` returns 200 passes
against an app that cannot load a single script. Hence a guard on the artifact
rather than trust in the invocation.

## 2026-08-26 — a Module downloads when someone plays it, and the acceptance test is a browser

**Decision:** each arm of main.ts's `?game` branch resolves its Module through
`await import(...)` inside its own boot function, and `npm run check:payload`
proves it by loading each `?game=<M>` in headless Chromium on a cold cache and
failing if any fetched chunk carries another Module's source. Attribution comes
from a rolldown `generateBundle` hook, not a string search of minified output.
main.ts exports `booted`, the arm's promise, because boot is no longer
synchronous and the composition tests used to wait one microtask.

**Why:** the goal is per-visitor, not per-bundle — a split whose chunk graph
looks right while every arm is still imported eagerly has not done the job, and
only a request log can tell the two apart. The measured win is small (5.7%) and
the report says why: the 918 kB was mostly `three/webgpu`, not other games
(docs/reports/2026-08-26-per-game-payload.md, vect-hack-po4).

## 2026-08-26 — the touch gate runs nightly, and never notifies

**Decision:** `check:touch` is the fourth gate in `npm run check:gates`, third
in the sequence, and the nightly timer runs it like the others. Its failures are
log only: `NOTIFYING_GATES` stays exactly `browser` and `controls`.

**Why it is in the nightly:** it costs 9s measured against the set's 11.6
minutes, and a gate a human has to remember is a gate that decays — which is the
whole of `vect-hack-zt7`. It landed on a parallel branch the same day and the
merge left it outside, so for a day the project had rebuilt the exact thing zt7
was filed to abolish.

**Why it does not notify, when the obvious objection is that it should:**
`touch-check.mjs` is deterministic, and determinism is normally what qualifies a
gate for the notification channel. It is excluded on the state of the *code it
watches*, not the quality of the gate: the touch scheme is a spike behind
`?touch` with `vect-hack-21k` and `vect-hack-lxd` still open against it, so it
is churning, and a gate on churning code goes red for expected reasons. That is
how a channel gets trained out of a person. Revisit when the touch scheme
settles.

**And the list is now deliberate.** `NOTIFYING_GATES` was two names because two
gates existed when `zt7` was written. It is two names now because browser and
controls are the pair that mean the desktop client's core rendering or control
path broke, and nothing else goes in without an argument. `gate-run.test.ts`
pins that as "exactly browser and controls, however many gates there are", read
off the real `GATES` table — shown red with `touch` added, and again with
`borg`, before it was believed.

## 2026-08-26 — the phone preview measures through pickCell, not its own projection

**Decision:** `npm run preview:mobile` drives all four Modules at 390x844 in a
real touch context and writes `.preview/mobile-*.png`. Its coverage number —
how much of the map the camera shows — is sampled through the renderer's own
`pickCell()`, the same inverse mapping the Look HUD uses, rather than a
projection derived in the script. Read it as an upper bound: `pickCell`
resolves through the floor plane, so a sample near the horizon still names a
cell nobody can read.

**Why:** the first version projected cell centres through the camera with a
guessed grid-to-world transform, and returned null on every run without saying
so. A preview that silently measures nothing looks exactly like a preview that
measured something fine. Asking the renderer is also the only version that
stays correct when the transform changes.

**What it found immediately:** at 390x844 with the touch layer up NetHack shows
11 of 80 columns and 14 of 21 rows; first person shows 5 and 6; Moria shows 13
of 198 columns. Rows are fine — portrait starves WIDTH, which is what makes the
missing pinch zoom (`vect-hack-lxd`) a blocker rather than a nicety. And
`?game=larn|angband|moria` each report `scrollWidth` 549 in a 390 viewport,
because an 80-column `div#overlay` widens the document and drags the
no-keyboard notice off screen with it (`vect-hack-0a4`).

## 2026-08-26 — Larn's prompt check is a pair, because one byte is not evidence

**Decision:** `check:controls` now drives Larn's gaze scheme, and its prompt arm
presses ArrowUp twice at one off-north heading — once inside `qshowstr()`'s
`more()` pager, once at the next command read — asserting plain `k` and then the
gazed vi letter. The `cmd` flag `nextKey` was called with is recorded beside
every consumed byte, so the discriminator is read rather than inferred from the
screen.

**Why:** Larn is the only Module where both answers are legal single bytes, so a
prompt-only assertion passes on a build that never armed gaze at all. Proven,
not assumed: with the arming forced on, the pair goes red; with it forced off,
nine assertions go red. The gate also declines doorways — Larn's home level is a
town, and home, the bank, the school, the stores, the entrance and the shaft
each answer a step with a `ttgetch()` prompt — because otherwise where a walk
lands decides whether the run passes. "Clear sends the engine nothing" is
deliberately NOT asserted for Larn, though Moria asserts it: Moria's original
mode sends keypad digits, while Larn's `mapKey` has no `Clear` case, so while
the binding exists the check cannot fail.

## 2026-08-26 — a worktree's dev server serves the source you did not edit

**Decision:** Any browser-gate work in a worktree restarts `npm run dev` after
each `src/` edit, kills it by listening port rather than by recorded PID, and
verifies the change in what the server serves before believing a gate result.

**Why:** Vite's watcher does not fire for a worktree under `.claude/worktrees/`,
so an edited file is served from the transform it already had. The failure is
silent and inverted: a sabotage that should redden a gate comes back green, and
the honest reading of a green sabotage is that the test is broken. Two further
traps cost time here — `npm run dev` is a wrapper whose grandchild listens, so
killing the recorded PID leaves the old server answering every "restart"; and a
`// SABOTAGE` marker verifies nothing, because esbuild strips comments. Verify
against code, with whitespace removed, since vite pretty-prints.

## 2026-08-26 — the tab that cannot save can still hand you its character

**Decision:** `packSave` gains a pack SOURCE — a root, plus the volume-relative
names that make up a save — and `MountOptions` gains `sessionSave`, where each
Module declares that source for the state where there is no volume. NetHack's
is `/` and the names `gamePaths()` seeds there; Angband's and Larn's are `/lib`
and the same `dirs` list `linkWritableDirs` uses; Moria's is `/moria-seed` and
`validateMoriaImport`'s own allow-list. `exportSave` picks the source on
whether the volume is MOUNTED, not on whether this tab owns it.

**Why:** `exportSave()` checked `state.persistent` and threw before touching a
filesystem, so F3 and the Saves button answered "there is nothing to export" in
exactly the four states where a character is unrecoverable — a second tab, no
Web Locks, no IndexedDB, a failed setup. The engine is still playing in all of
them: `seed(FS, null)` hands it real writable paths and the player spends hours
there. The tab that needed the escape hatch least was the only one that had it.
A blob is relative paths plus bytes, and every Module's session-only seed puts
the SAME relative names somewhere else, so packing the right root is the whole
fix. All four Modules round-trip through the real engines and the real parked-
import path, Moria included — its blob passes its own archive gate unweakened,
because the immutable runtime files it compares against the packaged seed ARE
the packaged seed.

**Why names and not just a root:** none of those roots is a volume. NetHack's
is the Emscripten root, beside `/tmp`, `/dev` and the read-only embed; Moria's
is the game's own installation. Walking one wholesale packs the build and calls
it a save — and Moria's gate then refuses the result. The names list is what
separates them, and it is single-sourced from the seed's own list in every
Module so the two layouts cannot drift apart silently.

**`release()` needed its own answer, and it is the opposite one.** It drops the
lock without unmounting and without re-seeding, so the engine goes on writing
through the symlink farm into a mount this tab no longer owns. Where the bytes
ARE is not the same question as whether they are ours to write: the export
follows the bytes (`state.mounted`) and the staging write does not
(`state.persistent`, so `beforeFlush` never reaches a volume we gave away).
A test proved red on the wrong discriminator.

**Also settled:** the vect-hack-dem copy said "this character will be gone" and
deliberately named no action, because the button it would have named refused.
It names it now — one shared rescue sentence appended to all three classes
rather than three near-copies. It says "save inside the game" FIRST, and that
is load-bearing: an export packs what the engine has WRITTEN, and a
session-only tab gets no autosave, because the checkpointer is built only for a
tab that owns a volume. The save-risk test that pinned the old rule is inverted
rather than deleted; its comment is the record of why it flipped.

**Not fixed here, and pre-existing:** F3 before anything is on disk packs an
empty or near-empty blob, which F4 will then restore over a good volume. It is
symmetric with a persistent tab, and F4 already makes the player confirm "it
replaces your <game> save in this browser", so it stays that player's choice.
A file-count guard would look like protection and would not be: NetHack's score
files are always seeded, so its empty export is never empty.
## 2026-08-26 — The touch scheme is one gaze table and one honest subset

**Decision:** The thumb pad is a 3x3 grid of gaze actions
(`src/ui/touch/scheme.ts`'s `PAD_GRID`), resolved by the same
`src/ui/gaze.ts` arithmetic the arrow keys use, with `reset-facing` in the
centre; one tap is one step and nothing on the pad ever asks for a run. The
action bar is a stated subset of six NetHack verbs — search, pick up, open,
rest, inventory, descend — plus a "More" slot that opens the command menu that
already exists. Everything on the bar reaches the engine and everything that
does not (the pad centre, the first-person toggle) is deliberately off it. All
of it is behind `?touch` and NetHack only, as a shared layer plus a per-Module
adapter (`src/modules/nethack/ui/touchAdapter.ts`).

**Why:** vect-hack-21k, decided by Eric before the spike and confirmed by it. A
second direction path would be a second place for a sign error to hide, and the
pad's nine keys turned out to be exactly one gaze table, so there is none. A
full on-screen keyboard was rejected as unusable at 390px; an honest subset that
says what it covers is better than an emulator nobody can drive. Open earns a
slot because the pad is what finally answers `getdir()` — see the next entry.

## 2026-08-26 — sendKeys grants a direction the same exception `remap` does

**Decision:** `TextHud.sendKeys(codes, answersDirection)` lets a compass
direction through while a getdir() `yn_function` is up, and nothing else
through at any prompt. The touch pad is the only caller that passes the flag.

**Why:** the pointer command menu carries no directional verb because "a menu
with no target has no answer for it" (commandMenu.ts). A thumb pad is an
answer for it, so open/close/kick/untrap become reachable without a keyboard —
but only if the queue gate has the same narrow exception the keyboard's
`remap` has had since vect-hack-be3.6. Safe for the reason resolveTarget
already gives: what travels is a plain ASCII direction letter, never a Meta
fold, so the shim's `c` return converter never sees anything over 128.

## 2026-08-26 — a yn_function may spell its answers inside the query

**Decision:** when `choices` is empty, `TextHud` reads a trailing bracketed
letter run out of the query text and offers those as yn chips
(`embeddedChoices`), except at a direction prompt.

**Why:** found by driving the touch build — character selection was
unanswerable. It is not a shim bug: `external/NetHack/src/role.c:2256` passes
`(char *) 0` for choices on "Shall I pick ... for you? [ynaq]" on purpose, so
it can shorten the prompt and validate the reply itself. Without this the
first question of every game had no clickable answer, which no mouse player
ever noticed because a mouse comes with a keyboard.
## 2026-08-26 — the browser gates run nightly, and only a human stamps them

**Decision:** `npm run check:gates` (`scripts/dev/gate-run.mjs`) runs
check:browser, check:controls and check:angband-borg in one command, starting
`npm run dev -- --port 5199 --strictPort` in its own process group and killing
that group on every exit path including SIGINT, and reusing rather than killing
a server already answering there. A user timer runs it at **03:30 nightly**,
`Persistent=true` so a run missed because the build host was off fires at next boot
(`scripts/dev/vect-hack-gates.{service,timer}`, installed by
`install-gate-timer.sh` the way task-llama's security-sweep pair is). It
notifies **only on a red run** — a nightly success notification is noise, and
noise trains the eye to dismiss the failure one — and a notification that
cannot be sent is logged without changing the verdict.

Three rulings inside that:

- **`--stamp` is never passed by the timer.** The runner rewrites
  `Last verified green:` in docs/RELEASE-CHECKLIST.md only when asked, and only
  on an all-green full run; a red run refuses out loud, and a `--only` subset is
  refused before anything starts. A nightly rewrite of a tracked file would
  leave a dirty tree every morning, and §5 of that checklist requires both trees
  clean to deploy. The nightly freshness signal is the artifact plus the
  notification, not a file in git.
- **"Could not run" is a third verdict, exit 3**, distinct from red (exit 1):
  no readable `/dev/dri/renderD*`, no Chromium, no WebGPU/WebGL2, or no server.
  logind grants render-node access as a seat ACL to the *active* session, so a
  logged-out build host genuinely cannot run these. Reporting that as red is a
  nightly false alarm, and a nightly false alarm is how a real one gets ignored.
  DISPLAY/WAYLAND_DISPLAY are deliberately NOT checked: all three gates launch
  headless Chromium, and the acceptance run was made with both unset.
- **A borg failure never sends a desktop notification** (Eric, 2026-08-26).
  `notify-send` fires for a `browser` or `controls` failure and not for `borg`,
  whether borg failed alone or beside another gate; when another gate also
  failed the notification names that one and does not mention borg. The borg
  gate watches a ten-minute unattended play session whose outcome is partly
  luck, so its failures are to be read deliberately rather than pushed at
  someone, and browser and controls are the two that mean the client broke.
  This is one reporting channel and not a downgrade: a borg failure still
  prints in the summary, still lands in summary.json, still keeps its full log,
  and still decides the run's exit code. No severity concept and no "advisory
  gate" abstraction — one named list, `NOTIFYING_GATES`. The could-not-run
  notification is unaffected. It also raises the stakes on the paragraph below:
  with nothing pushed at anyone, the log is the only place a borg failure is
  ever seen, and a log that blames a client hang for a character that simply
  died is misinformation in the one channel left.
- **Every run writes `~/.local/state/vect-hack/gates/<stamp>/`** — per-gate
  logs, a summary.json naming the tested sha and verdict, and the two JSON
  reports the gates write for themselves; last 20 kept. Outside the repo for the
  same clean-tree reason.

The first real run of that runner found `check:angband-borg` already red, and
two things about it are now settled. **The gate was asserting something false:**
it failed any console warning, with no allowlist, while the app deliberately
emits one — Chromium declines the storage grant for every profile with no
engagement history, which is every headless run, and `src/ui/saveRisk.ts` exists
to handle exactly that answer. It had been red since the save-risk work shipped
two days earlier, with every measured number healthy (60fps, no stall, 34,849
hero moves). The regex `browser-check.mjs` already had now lives in
`scripts/dev/gate-console.mjs` and both gates import it, so a third gate cannot
learn about it in only one place; only the DECLINED answer is listed, and "no
storage manager" and "the persistence request failed" stay fatal everywhere.
**And the gate could not tell a dead borg from a hung client**, which is now
fixed. `?borg` plays one character; when it dies, Angband parks in the death
screen, map traffic goes to zero, and the gate used to call that `map traffic
stalled for 540s` — a client hang that never happened, reported at any window
length. The gate measures the CLIENT under unattended play; a character dying
is Angband working correctly. So it now watches for the engine's own end-of-game
messages (`END_TELLS`: "You die." from take_hit player-util.c:251, enter_score's
score line score.c:283-303, the win at player-quest.c:250), stops sampling at
the first one, and judges the run over the window actually played. **The stall
check itself stays unconditional**: the loop breaks one sample after the end, so
post-death silence adds at most one second — it is not excused for a run that
ended. Scoping it
to `!ended` would have forgiven exactly one thing — a real >=30s freeze during
live play in a run whose borg died later — which is the assertion the gate was
built for. Only `the engine stopped` is scoped that way, since an engine exiting
after a finished game is correct.

**`MIN_PLAY_MS = 120000` is what keeps it able to fail.** Without a floor, every
red run could be excused by "the borg died", and an assertion that cannot fail
is worse than no assertion (vect-hack-azf). The number was fixed *before* the
death times were measured
(`.superpowers/sdd/zt7/borg-floor-preregistration.md`) and derives from this
gate's own constants: `START_MS` is 60s of warm-up in which a stall is not even
counted, plus 60 further one-second samples so the reported p05 is a percentile
rather than the single worst sample.

**What the measurement then said, and it is not what we hoped.** Eleven
timestamped borg deaths on 2026-08-26: 3.7, 9.5, 18.3, 27.9, 29.0, 32.0, 34.9,
38.4, 101.7, 200.5 and 273.7 seconds. Median 32s; only two of the eleven at or
past the 120s floor. So the floor is right and it does not rescue the gate:
when this borg dies it usually dies in the first 40 seconds, and those runs stay
red. What the fix buys is honesty and speed — an early death now fails in 19
seconds saying `the borg's game ended after 18s (You die.), below the 120s of
play this gate needs`, instead of burning ten minutes to report a fictitious
540-second client hang. Combined with the notification carve-out above, that is
the whole of what was wanted: nobody is woken by borg luck, and the log a human
does read tells the truth. Making the gate reliably GREEN would take a
different change — continuing across characters so the window is filled
regardless of borg mortality — and that is deliberately not decided here.

`check:controls` also gained the `fetch(URL_BASE).catch()` guard the other two
already had. It was the gate that rotted, and it was the one that answered a
missing server with four 30-second Playwright timeouts and no explanation.

**Why:** these three are the renderer's and the control schemes' only coverage
in a real browser, and none of them is in `npm test` because each needs a GPU.
`check:controls` spent an unknown period asserting `"Movement is still
vi-keys"` after every vector view had moved to `"Arrows walk where you look"`;
it surfaced only because a stale branch happened to carry the fix
(`vect-hack-zt7`). A gate nobody runs is not a gate.

## 2026-08-26 — a tab that cannot save says so on a banner, in three sentences

**Decision:** `mountVolume`'s seven session-only reasons become a tagged
`SessionOnlyReason { code, detail }` (`another-tab` | `browser-cannot` |
`setup-failed`), and the code — never the detail — crosses to the page as a new
Backplane lifecycle message that `EngineSession` routes to a page-wide listener
main.ts registers. The three sentences are:

- another-tab: "Your other tab owns this game's saved games, so nothing you do
  here will be saved. Close the other tab and reload to play a game you can
  keep."
- browser-cannot: "This browser cannot store saved games, so this character
  will be gone when you close the tab. Chrome or Firefox can store them."
- setup-failed: "Something went wrong setting up saved games, so this character
  will not be saved. Reload the page to try again."

They share the at-risk banner and add a second Saves-button class (`nosave`).
**Session-only wins both, in either arrival order**, and the at-risk class and
title are removed rather than left underneath. The banner is dismissible for
one page load and the dismissal is never stored, unlike the at-risk one.

**Why:** the state was a `console.warn` in a worker, and the game is
permadeath. No copy may name the Saves button: `exportSave()` checks
`state.persistent` before it touches the filesystem, so F3 and the button
answer "there is nothing to export" in exactly these three states — an escape
hatch that does not exist. Three classes and not seven because the player's
next move differs three ways; the detail stays on the console line because five
of the seven reasons splice `String(err)` into it. Showing the weaker "may be
deleted later" warning while the stronger one is true is the failure this
closes, so the precedence is pinned by a test proven red on the wrong choice.
The at-risk dismissal is remembered because it is about this *browser*; this
one is about this *tab*, and remembering it would hide a different situation
next visit.

**Also settled:** the "Saving is off — <developer sentence>" line every Module
posted into the message strip on `ready` is gone, along with the storage state
`ready` carried for it. It was the same warning in the place vect-hack-h4q
already rejected, and the readable half of it was exception text.

## 2026-08-26 — the degrade path is denied at the browser, not simulated

**Decision:** `check:browser` gains two arms that deny WebGPU (and then also
WebGL) with Chromium switches — `--disable-features=WebGPUService` and
`--disable-3d-apis` — rather than with `?gl` or a `getContext` monkeypatch. Both
also assert the denial landed, via a page-side probe read.

**Why:** `?gl` forces the backend and never runs `gpuAvailable()`, so the probe
that CHOOSES the renderer had no coverage at all; a rejected adapter promise
read as "available" would have shipped. Denying at the switch means the page's
own probe sees what a real visitor's browser shows it. Asserting the denial
separately is what stops an arm passing on a browser that denied nothing — the
first attempt used `--disable-features=WebGPU`, which does nothing while the
Vulkan flags are present, and only the probe assertion caught it.

**Also settled:** the text view is a supported way to play, not an error
screen, so the no-GPU arm asserts it is legible and playable — notice on screen
and unclipped, >=4.5:1 contrast, a walked hero — not merely present in the DOM.

## 2026-08-26 — two silent states get a screen: saves at risk, and no keyboard

**Decision:** the unpersisted-storage state (`vect-hack-h4q`) is drawn twice —
a one-sentence notice at boot whose dismissal persists in localStorage, plus a
mark on the Saves button worn for as long as the origin is unpersisted. A
touch-only visitor (`vect-hack-d72`) gets a full-page explanation and a button
that starts the self-playing demo. Both are Eric's calls; the notes on the
beads are the record.

**Why:** the two silent degrade paths were exactly the two that mean "your
character may not survive this session", and the F3/F4 export is a real escape
hatch nobody uses while they believe their saves are safe. Button-only was
rejected (most visitors never notice a changed button) and notice-only was
rejected (it is dismissed once and gone). On phones, explain-only leaves a
shared link with nothing to do and letting them in reads as broken software.

**Three things worth not re-deriving:**

- The grant is still fired and never awaited (`src/main.ts`): a permission
  heuristic must not stand in front of engine boot, so `showSaveRisk` runs off
  a `.then()` and reaches the Saves button by id rather than by reference.
- The touch test is `(pointer: coarse) and (hover: none)`, not the coarse half
  alone: a coarse pointer that can still hover is a cursor, and the notice
  covers the whole page, so a false positive locks out a visitor who could
  play. `isTouchOnly()` takes the two answers as arguments so it is pinned
  without a browser.
- Moria has no self-player, so a phone visitor pointed at it is offered
  NetHack's demo rather than a button that would start nothing.
  `SELF_PLAY_FLAG` has to keep agreeing with `main.ts`'s `?bot`/`?borg` arms.

## 2026-08-26 — the Larn Module ships; the grant is pursued, not waited on

**Decision:** Eric's call. The Larn Module ships in the public beta without
waiting for Noah Morgan's 1986 grant to be pinned to its original posting. If a
rights holder ever objects, the Module is removed promptly and respectfully.
`vect-hack-p5q` stays open — the citation is still worth having — but it is no
longer a launch gate, and `RELEASE-CHECKLIST.md` no longer lists it as one.

**Why:** the site is free and non-commercial, which is the exact condition the
quoted grant asks for; the grant is well attested by larn.org, Wikipedia and the
2005 debian-legal thread even though this project could not fetch the primary
post (larn.org 403s, Google Groups 429s); and Larn has been redistributed in
NetBSD's tree for decades on the same basis. Weighed against that, holding a
finished Module out of a free beta is a poor trade.

**What this obliges us to keep true:** removal has to stay cheap. The Module
boundary already makes that possible — `?game=larn` is one explicit arm in
`main.ts`, and `LICENSING.md` scopes the Larn row to `external/larn`,
`src/modules/larn/native/` and `public/modules/larn/*`. The per-game payload
split (`vect-hack-l11`) makes it cheaper still. Any monetisation is a separate
decision and breaks the grant's condition outright (`vect-hack-oab`).

**Recorded honestly:** the tree we ship (`external/larn/COPYRIGHT`) asserts
copyright and grants nothing; the permission exists only in the Usenet quote.
This decision accepts that risk knowingly rather than resolving it.

## 2026-08-24 — the Brain stays Opus: the cheaper models are slower here

**Decision:** Training reflection passes keep `claude-opus-5` at effort `high`.
Sonnet and Haiku were measured and rejected on their own merits.

**Why:** Measured on identical digests, one model at a time, no concurrency,
5 runs plus one ablation probe each through the same `claude -p` host — Opus
69s for 6 calls (~11.5s each), Sonnet 347s (~58s each), Haiku did not finish 6
calls in over 180s. Corroborated by the full 100-call Opus pass the same day:
median 10.4s, 0 refusals or transport errors. Both cheaper models also flatten
the `claim` object in their deltas, which `parseDeltaDocument` rejects, so a
correct lesson is recorded as a run that learned nothing. Effort is not the
lever: Haiku at `low` was no faster and failed identically. So the goal behind
the request — keep passes fast — is served by not switching
(`vect-hack-b5f.19`, follow-on `h9x.17`).

## 2026-08-24 — Phase 1 closes with a negative result, and nothing shipped

**Decision:** `vect-hack-b5f` is closed. `data/kb` stays empty. The registered
fourth run is closed unplayed rather than spending ~10 hours to re-answer a
question already answered.

**Why:** The closing experiment split the r4c fact set and played each half
against one held-out cohort. Terrain-only carries the entire effect and beats
the full set (+94 surface median, 31 wins to 11, 20 of 52 runs reaching xlevel
4 against the control's 5) — and terrain is the half whose ablation-probe leaks
were admitted because the model was reciting a prior. The cleanly-earned threat
half is a regression (16 wins to 23, median xlevel 2 to 1). So every gain the
phase measured came from knowledge the loop did not earn, and the knowledge it
did earn hurt. Full reasoning and disposition of all 22 child beads:
`docs/reports/2026-08-24-larn-phase1-closing.md`.

## 2026-08-24 — Phase 2: capability before learning, and the LLM's job changes

**Decision:** A new epic (`vect-hack-h9x`) takes priority over further learning
runs. Order: measurement (a goal-aligned bench, a ship rule that can ship,
per-command telemetry), then verbs (cast, descend by readiness, equip, use
consumables, shop, ascend, search), then direct policy search, then teaching.
The LLM's job moves from proposing facts judged by provenance to proposing
policy changes judged by play. Phase 1 (`b5f`) stays open; `b5f.24` still
decides whether its one measured win was real.

**Why:** The bot cannot buy, wear, wield, quaff, read, cast, search or climb
up — it even starts knowing magic missile and protection and has never cast
either (`create.c:42`). Over 200 measured games its deepest ordinary level is
5, median surface depth 2, and 48% suicide down the town shaft in 19 commands.
A learning loop over a policy that structurally cannot do the thing being
learned is measuring the wrong object, which is the deepest reason four runs
shipped nothing. The gym plays 5 games/second against the reflect loop's 20
minutes per 100 games, so for anything expressible as a number, search over
play is the cheaper optimiser. Judging a proposed CHANGE by held-out play also
dissolves the black-box problem the ablation gate exists for: a change asserts
nothing, so the model's priors become a legitimate source of hypotheses.

**Also recorded:** the Eye of Larn is not the win condition — it is a gem on
dungeon level 10 guarded by a demon lord, used for bank appraisal
(`create.c:265-268`, `store.c:589-596`). Winning is carrying the potion of cure
dianthroritis from V3 home before 300 mobuls (`object.c:1265-1306`). Level 10
is nevertheless the right proxy for "as deep as possible".

## 2026-08-24 — r4c is NO-SHIP, and the rule is now what blocks

**Decision:** The r4c fact set does not ship; `data/kb` returns to empty with
the 56 facts preserved beside the report. The pre-registered rule was applied
unchanged even though two of its three tests passed.

**Why:** Pooled median score delta 0 fails the first test, on 27 wins to 20
losses and 52 ties — 47 of them volcano pairs that tie structurally. That is
`vect-hack-b5f.22`'s third weakness measured: the rule cannot ship an
incremental win, only a shaft-mode flip. Changing the rule now, after seeing a
result it produced, is the thing pre-registration exists to prevent; any new
rule is registered before the batch that first uses it. Also recorded: the
run's own pre-registered prediction (a loss via `stairs:%` detours) was wrong —
the surface stratum won, because the detour acts as a descent brake worth twice
the survival.

## 2026-08-24 — the ablation probe's verdict on the Claude Brain stands, unedited

**Decision:** The first pass on the `claude -p` Brain failed the ablation probe
(4 of 5 samples restated `avoid-terrain stairs:V` with the death removed) and
the batch was refused: `data/kb` stays empty and the instrument was not touched.
The fast host is blocked on `vect-hack-b5f.23` rather than adopted.

**Why:** The transcripts indict the model, not the ablation — it says "no damage
was measured" and asserts the claim anyway, on the retained descent record plus
an unstated "deeper is more dangerous". That premise is outside knowledge, which
the prompt forbids. r3 recorded the only conditions under which changing a
measuring instrument after seeing its result is legitimate; none holds here.
Codex and GLM, asked blind, both reached the same reading at high confidence.

## 2026-08-24 — an avoid-terrain threshold measures exposure, not required capacity

**Decision:** Recorded as a measured defect (`vect-hack-b5f.21`), not patched in
passing: the r4 threshold vocabulary is not merely uninformative on an all-death
corpus, it is inverted, and any fix must keep `stairs:V` — the one key that
behaves as designed — working.

**Why:** The value is the hero's `hpmax` when it stepped onto the exit,
ratcheted to the max observed. The town shaft is exposure-censored at 10 (nothing
grows before reaching it); an ordinary staircase is taken at every capacity the
hero attains, so its bar climbs to the population ceiling — 38 against the
shaft's 10 over 100 games. Under `hpmax <= threshold` that walls the safe exit
for every hero the bot grows into and opens the shaft as soon as `hpmax` exceeds
10. Surviving longer before taking an exit makes that exit compile as more
dangerous.

## 2026-08-22 — the NetHack embed carries only what the engine never writes

**Decision:** `build-nethack-wasm.sh` prunes the runtime-writable files
(sysconf, perm, record, logfile, xlogfile, livelog) from `wasm-data` after the
full make and relinks via the src-level target, so the embed ships only nhdat,
license and symbols. A guard fails the build if those three are missing.

**Why:** Current emsdk (6.0.4) loads embedded files at initRuntime — AFTER
preRun and the volume mount — so an embedded copy of a path the boot seed
already created (sysconf/perm as root files, score files as symlinks into the
volume) throws EEXIST from `_emscripten_fs_load_embedded_files` and the engine
never reaches main. The old artifact only booted because an upstream
install-step ordering race had left those files out of wasm-data when it was
linked; a from-scratch rebuild (after the checkout was recovered from origin)
won the race, embedded them, and every NetHack test failed at boot. Every one
of those files is the seed's to provide, so the embed loses them
unconditionally rather than by race.

## 2026-08-22 — the cloud Brain shells out to `claude -p`, not the SDK

**Decision:** `--brain claude` replaces `--brain anthropic`.
`scripts/dev/brain-claude.mjs` runs the `claude` CLI in a fresh empty temp
directory per call (`--system-prompt` replacing the harness prompt);
`brain-anthropic.mjs` and the `@anthropic-ai/sdk` dependency are gone. The
"second adapter, not a second `--url`" reasoning below stands unchanged.

**Why:** The credential. The CLI holds the OAuth login this machine already
has; the SDK needed a separate API key issued, stored and rotated for a job
already authorized as this user. A reflection is one prompt in, one document
out — the subprocess costs a fork and removes the credential problem. The
empty cwd is load-bearing: run from the repo, the CLI would put this project's
own CLAUDE.md/AGENTS.md in front of the model proposing knowledge-base facts,
an uncontrolled input nothing downstream records.

**Also:** the adapter's temp-dir cleanup is guarded to refuse any path outside
its own `mkdtemp` prefix. The first sabotage pass redirected `cwd` to the repo
root to prove the empty-directory assertion, and the unguarded
`rmSync(cwd, { recursive: true })` deleted the entire checkout (recovered from
origin plus the session transcript). A recursive delete answers only to the
line that created the directory; leaking a temp dir is the cheap fault.

## 2026-08-22 — the cloud Brain is a second adapter, not a second `--url`

**Decision:** `--brain anthropic` constructs `anthropicBrain` from
`scripts/dev/brain-anthropic.mjs`, which calls Claude through the official
Anthropic SDK. `localBrain` keeps the OpenAI chat shape for llama-server. No
proxy, no shim, no compatibility layer.

**Why:** Repointing `--url` was never a config change. The local body sends
`temperature: 0` and `seed: 7`; Claude's API removed `temperature` (400) and
has no `seed`. Nor is there an endpoint to point at — task-llama's only
OpenAI-compatible HTTP services are llama-server itself, and its Claude routing
is a Python library, not a port. A proxy built to close that gap would hide the
served model id and take every HTTP status away from the Brain, which is
exactly what `brain-fetch.mjs` is written to leave the Brain's to reject. The
adapter lives in `scripts/dev/` because `src/bot/` is shared with the browser
bot and may not carry an SDK or a credential store. Cost: `localBrain`'s
temperature-and-seed reproducibility does not transfer. It was belt and braces
— what makes a pass repeatable is the transcript reuse rule (byte-identical
prompt plus matching trajectory sha256), which is untouched.

## 2026-08-22 — a threat is measured at the fight's peak, not at the fatal blow

**Decision:** The killer carries `capacity` — the peak living reading seen
while it stood beside the hero, within its final engagement (adjacency with
gaps of at most two commands, reset on a level change) — and a threat's value
is measured against that, never against `hpBeforeDeath`. The fourth learning
run's reflection pass was stopped and restarted under the fixed instrument;
the pre-registration carries an addendum with the results-shopping guards.

**Why:** vect-hack-b5f.20. Nearly every Larn melee death is a multi-blow
grind, so the last living reading measures what the finisher finished: a
being that beat a full-health hero read 0.1 and the threat channel would have
converged inert — the mirror of 1b's all-1.0 table, from the same instrument
shape (one end-state number standing in for a fight). Peak over the
engagement's first reading because a hero who heals mid-fight and dies was
beaten at the healed capacity; two blind second opinions (Codex, GLM)
converged on that instant independently. Same-glyph conflation within a
streak stays a known limit until per-blow attribution (vect-hack-b5f.8).

## 2026-08-22 — the ablated hero reads as alive, and a learned avoidance that covers every exit is not a preference

**Decision:** `stripDeathEvidence` carries `hp` to `hpmax` instead of sending
`hp: 0, hpmax: 0`. The leak test and the retained descents are unchanged. And
the third learning run's 53-fact set is NOT shipped: `data/kb` stays empty, the
facts live in the history of `data/kb/larn/facts.json` at `540958f`, and the
transcripts under `docs/reports/2026-08-21-larn-r3-training/`.

**Why:** vect-hack-b5f.16. The probe blanked five death fields and then wrote a
sixth that reports the death anyway; its own transcript reasons "the run ended
capped with hp 0 immediately after", so the guard was failing batches on a
signal it had left behind. Re-probed with the hero alive, all five probes claim
nothing. Fixing an instrument after it produces a result is results-shopping
unless the defect is provable without the numbers: this one is, from the stored
transcript, and the unit test was shown failing on the old choice.

The A/B then said NO-SHIP on all three tests — 16 wins to 31 losses, pooled
median score delta 0, control-surface depth delta -1 — with **0 migration in
either direction**. The note-routing fix worked (`stairs:V` earned 99 supporting
runs against 19 and 7 for the ordinary exits, and notes fell from 84 to 5), but
`compileFacts` reads confidence rather than evidence weight, so all five terrain
keys compiled into one flat list. With every exit avoided the descend step has
no eligible exit and descent falls to the breach step, which takes whatever it
reaches first — the shaft as often as the staircase. The lesson the batch
learned was a ranking, and the claim vocabulary cannot express one
(vect-hack-b5f.17, vect-hack-b5f.14).

## 2026-08-21 — reflection.json is the resume record; the retry wraps the socket and nothing else

**Decision:** `bot-reflect.mjs` reuses a recorded reply when the prompt it would
send is byte-identical to the recorded one AND `trajectorySha256` still matches
the trajectory on disk; anything else is re-asked. The recorded `raw` is what
gets reused, never the recorded `parse` — it is re-run through
`parseDeltaDocument` every time. A reflection that is reused carries its `probe`
forward; one that is re-asked drops it. `--no-reuse` forces fresh calls. The
model id is deliberately not part of the test. Separately, the transport moved
to `scripts/dev/brain-fetch.mjs` and gained four retries with backoff around a
transport failure only — a status the server sent resolves and stays the Brain's
to reject.

**Why:** vect-hack-b5f.13. A 200-game pass is ~5 hours of model calls, and
llama-swap evicting the model at run 67 killed the process with ECONNRESET and
wasted all 66 finished reflections, because every run was reflected
unconditionally. The prompt carries the KB the bot held and the hash carries the
bytes the claim cites, so those two together are exactly the question "does this
recorded reply still answer what I am about to ask" — nothing else is needed and
nothing less is safe. Reusing the stored parse would let an older parser's
normalization past the applier, whose whole rule is that `parseDeltaDocument` is
the only normalizer. Reuse is also *more* reproducible than re-asking:
temperature 0 and a fixed seed make a re-ask nominally identical, but
server-side batching can still move a token. The retry is scoped to the socket
because retrying an answered request turns one refusal into four and hides the
reason behind the last of them.

## 2026-08-21 — No learned fact may seal a level: the breach step asks the map, not the knowledge base

**Decision:** `passable()` splits into `walkable()` — what the map allows — and
`avoided()` — what the KB has learned to route around. The ladder's step 6b,
the one that fires when nothing else is reachable, is built on `walkable()`, so
it crosses a learned avoidance exactly as it already crossed a known trap.
Learned avoidance is a preference; it is never a wall.

**Why:** the comment at that step already claimed this and the code did not do
it (`passable(...) || knownTrap(...)` still returns false for an avoided cell,
because an avoided staircase is not a trap). It went unnoticed while
`data/kb/larn/facts.json` was empty. It stops being harmless the moment the
reflect loop is asked to produce more `avoid-terrain` facts (b5f.6, below): a
wrong one keyed on `stairs:E` would have kept the bot in the town for the whole
game, which is `vect-hack-b5f.11`'s sealed level under a new name. With the
split, a wrong fact costs the bot a detour and a later descent, and the A/B
measures a preference rather than a livelock.

## 2026-08-21 — A lesson goes under the kind that changes behaviour, and a terrain claim names an exit the run chose

**Decision:** the reflect prompt states the routing rule before it lists the
claim kinds — three kinds compile into the tables the ladder reads, `note`
compiles into nothing, so a lesson one of the three can carry must be filed as
that kind — and the run block names the exact keys this run can ground.
`runGrounds()` (`src/bot/digest.ts`) derives them: the killer, and the exits the
hero chose. The applier gates `avoid-terrain` on that same list, the way
`vect-hack-b5f.4` gates `threat` on the killer. `note` stays in the vocabulary.

**Why:** `vect-hack-b5f.6`. Across the 100 committed Phase-1b training
reflections the model emitted 85 threat asserts, 84 notes and 2 avoid-terrain
claims — and of the 53 runs whose hero rode the town's volcanic shaft to depth
11, **none** filed the `stairs:V` claim that would have changed anything. The
insight was there, in the prose of a `note` under the topic `descent-pacing`,
where nothing reads it; the A/B's migration counts show the consequence, zero
seeds crossing between the volcano and surface strata in either direction
(`docs/reports/2026-08-21-larn-1b-ab.md`).

Three things this deliberately does not do. It does not drop `note`: most of
those 84 were about descent pacing, which no claim kind carries, and removing
the escape hatch pushes the pressure to say something into the kinds that
change behaviour — which is how 1b lost its A/B. It does not source terrain
subjects from `finalTerrain`: standing somewhere is not choosing it, a hero
dies on the floor of the room the fight was in, and a key for that would let
"avoid the floor" be claimed. And the gate establishes provenance, not
consequence — that this run showed the hero taking that exit, not that the exit
was harmful — which is exactly the boundary the killer gate draws.

`DescentTaken` gains `category` so the `"<category>:<ch>"` key is derivable
without anyone assuming Larn's exits are stairs; it is the classified underlay
`finalTerrain` already publishes, so an undiscovered trap door reports the floor
the screen drew and grounds nothing.

Found in the same review and fixed with it: the ablation probe compared two
claim kinds while the compiler read three, so an `item-value` claim recited
from priors was invisible to it.

**Measured before merging** (`docs/reports/2026-08-21-larn-note-routing.md`):
re-asking 18 of those same digests under the new prompt, **12 of 12 shaft runs
now file an accepted `stairs:V`** against a baseline of 0 of 53, no run without
a shaft descent claims one, and nothing the model emitted was rejected. Two
results nobody asked for: notes went 16 to 0, so keeping `note` is now an
argument from principle rather than from behaviour; and 3 of 6 non-shaft runs
claimed the ordinary exit they died past, which the breach split above keeps
survivable but which a successor must measure the compiled table for before it
runs an A/B.

## 2026-08-21 — The second learning run is abandoned, not paused

**Decision:** `vect-hack-b5f.9` ends with no result. Its two played batches and
66 reflection transcripts are discarded with their worktree; the
pre-registration stays in `docs/specs/` under an ABANDONED header,
as a design that was never measured.

**Why:** reflection died two thirds of the way through (`vect-hack-b5f.13` —
the host cannot resume a dropped pass), and by then the run's frozen tree had
been overtaken: `2e5fe6c` merged three fixes to the ladder the run was
measuring. Two arms of one A/B must be the same bot, so the played control arm
could not be paired with any treatment arm run after the merge. Resuming would
have produced a number nobody could defend, which is worse than no number. The
successor also needs a fresh held-out master: `20260822` was spent developing
`vect-hack-b5f.10` and `b5f.11` on one of its seeds.

## 2026-08-21 — Gold is not in the pack, so a full pack says nothing about it

**Decision:** The Larn ladder's loot step is off while `packFull` is set, with
one carve-out: an `item` cell drawn `*` is still routed to. The carve-out is a
single glyph and models nothing else — no weight, no slot arithmetic, no
"can I carry this" predicate.

**Why:** the wholesale switch-off (vect-hack-b5f.10, below) was too wide.
`OGOLDPILE`, `OMAXGOLD`, `OKGOLD` and `ODGOLD` all dispatch to `ogold()`
(`external/larn/object.c:46`), which adds straight to `c[GOLD]` and calls
`bottomgold()` (`object.c:1250`). It never reaches `take()`, so it asks no
question and no pack can refuse it. Every other object the semantic exporter
calls an item arrives at `finditem()` or at one of the four typed prompts, and
every one of those ends in `take()` — so gold is the whole of the exception, and
the engine draws no other distinction worth copying. Without the carve-out, the
first knowledge base to give `*` a positive item value would have one refusal
stop the hero walking to gold for the rest of the game. `data/kb` is empty
today, which is exactly why no regression batch could have caught it.

**The glyph is `*`, not `$`:** `data.c`'s `objnamelist` draws all four gold ids
as `*`; the two `$` entries in that table are `OBANK` and `OBANK2`, which
`terrain_identity` reports as terrain and never as an item.

## 2026-08-21 — The Larn bot's anti-stuck memory latches on the map, not on movement

**Decision:** A move that did not move the hero no longer counts toward `stuck`
when the cell it aimed at still shows a *closed* door; the block list latches at
`stuckLimit` for every other cell exactly as before. No expiry, no per-door
counter, no change to `stuckLimit`.

**Why:** `blocked` is a claim that a cell is impassable terrain, kept for the
whole level, and Larn's closed door is not terrain refusing — it is a die roll.
`object.c` OCLOSEDDOOR fails on `rnd(11) < 7`, six times in eleven, prints
nothing in the ordinary case and shoves the hero back to `lastpx/lastpy`. Three
in a row is `(6/11)^3`, about one closed door in six, and that door was then
sealed for the level. On seed 1185260916 both doorways into the far half of
level 2 latched: 705 of 1139 cells and that level's down staircase went
unreachable and the run spent 24000 commands wandering (vect-hack-b5f.11). The
map is the only honest signal, because a success writes
`item[x][y] = OOPENDOOR` while a failure writes nothing at all — so the rule is
stated over what the semantic map shows (`door` vs `door-open`), which is the
claim being made. Retrying is unbounded on purpose: the door opens with
probability 5/11 per attempt, so what ends the retry is the map changing, not a
clock. This is the half that freed seed 1185260916: the pack fix (entry below)
left it capped on depth 2 with score 0, because the doors were the seal. With
both in, it dies on depth 4 at command 1822 with score 2579.

## 2026-08-21 — A full pack is the engine's word, and it expires when the engine's own inputs move

**Decision:** `LarnBotModel.packFull` latches on Larn's own refusal, "You can't
carry anything else" (global.c:481). While it is set the prompt table skips its
`(t) take it` rule so item prompts fall through to `(i) ignore it`, and the
ladder's loot step is off wholesale — not the per-cell `lootRefused` set it
replaces, because the refusal is a fact about the PACK and a per-cell memory only
walks the hero to the next item to be told the same thing. The latch clears when
the status tap's `<occupied slots>:<xlevel>` pair differs from what it was at the
refusal, and it survives a level change: the hero carries the pack downstairs.

**Why:** vect-hack-b5f.10. Answering "take" with a full pack buys a refusal and
changes nothing; seed 1185260916 paid it 522 times in 24000 commands (now 5).
The xlevel half is not decoration: take()'s limit is `15 + (c[LEVEL] >> 1)`
capped at 26, so capacity grows as the hero levels — a latch watching only the
slot count froze that seed's pack at 16 items where the unfixed bot reached 18.
Copying the formula into the bot would be a second implementation of a game rule,
free to drift, so the bot asks the engine again instead: a pack that is still
full answers with one more refusal and re-latches. That is also why nothing here
models weight or slots.

**Not fixed here:** with this change alone that seed still caps at 24000 on
depth 2, and it was never going to do otherwise. The 522 refusals were a cost
paid alongside the livelock, not the livelock: what sealed the level was the
anti-stuck block list latching onto two closed doors (vect-hack-b5f.11, the
entry above). Both changes are needed, and with both the seed dies on depth 4 at
command 1822 with score 2579.

## 2026-08-21 — The engine names the killer; the screen decides whether we may say so

**Decision:** `__wrap_died` (main-wasm.c) sends the map glyph of the creature the
epitaph is about to name, as a new one-way `death` event; `buildLarnDigest`
publishes it as `RunDigest.killer` only when the run ended in a death AND that
glyph was drawn beside the hero in the final frames. The applier gates on it: an
`assert` or `confirm` of a `threat` claim is rejected unless the claim's
(glyph, colour) is the killer's. `refute` and `retire` are not gated. A run that
names no killer — a trap death, a win, a capped run, a killer the player never
saw, a trajectory recorded before the event existed — can teach nothing about
any being. Follow-ups filed: vect-hack-b5f.7 (colour carries no information in a
Larn threat id), vect-hack-b5f.8 (threats are only learnable from a fatal blow).

**Why:** vect-hack-b5f.4. `cause` named the killer in prose and `finalAdjacent`
listed glyphs, with nothing tying them, so the reflect model read adjacency as
causation: 5 of the first 38 earned threat facts blamed a bystander, one of them
on a run an arrow trap killed. The join has to come from the engine — it is the
only party that knows `monstnamelist[x]` and `monster[x].name` are one being —
and the adjacency condition is what keeps it inside the black-box rule: the
engine says which of the beings the screen ALREADY SHOWED struck the blow, and
never introduces a glyph the screen withheld. Larn's own see-invisible rule
(`monstnamelist[INVISIBLESTALKER]` flips between ' ' and 'I') falls out of the
same table read, so an unseen killer reports nobody without a special case.

**Contested.** An adversarial review (Codex/gpt-5.6-sol) held that any native
join breaks the rule however it is fenced, because the screen never drew the
sentence "this glyph is the one the epitaph names", and that the alternative was
to drop per-being threat claims outright. A second (GLM-5.2) read the rule as
governing a field's content rather than its computation and called the fix legal
but owed an explicit argument — which is now in `src/bot/digest.ts`'s header.
The bug's own text listed the engine-side tie first, conditioned on being
feasible, and it is; dropping `threat` would gut the engagement design shipped
the same day. Both reviews agreed the gate must cover `confirm`, and both found
real defects that are fixed here: an out-of-bounds read (`died()` splits at
x < 256, `monstnamelist` holds 129 bytes and `monster[]` ends at MAXMONST + 8),
`-INT_MIN` on the negation, and the gate needing the full (glyph, colour)
identity rather than the glyph alone.

## 2026-08-21 — Threat is a claim about a being; engagement is a decision about a fight

**Decision:** The Larn ladder no longer compares a learned threat to a constant.
`engage()` compares it to what the hero can absorb — hp fraction plus an
experience term, deliberately uncapped above 1 — so a healthy hero fights any
threat in 0..1. `fleeThreshold` is deleted from `policy.json` rather than
re-tuned. Declining costs a bounded step away (`disengageLimit`), and a cornered
hero swings anyway. A new breach step removes the wall a monster or a known trap
makes of a corridor. `data/kb` stays empty; the rejected 1b fact set is kept as a
regression fixture under `scripts/test/fixtures/kb-1b/`, never as knowledge.

**Why:** Phase 1b's A/B lost on that seam. The reflect model answered honestly —
a giant ant is lethal to a level-1 character — so 28 of 38 threat claims came
back at 1.0 and the ladder read the table as "never fight": 74 of 100 runs never
swung. Lowering the threshold only moves the same cliff. Uncapping capacity is
load-bearing rather than cosmetic: with a ceiling of exactly 1, `threat <
capacity` is false at threat 1.0 and the whole regression returns under a new
formula. Re-measuring the same fact set through the fixed consumer gave 18 wins
to 28 losses (still NO-SHIP, from 11-40) with zero capped runs in 400 games, so
the consumer defect is closed and the fact set's own defects — bystander
attribution, unread notes — are what remain
(`docs/reports/2026-08-21-larn-engagement.md`).

**Note:** Larn has no hunger, so no scarcity term pushes the other way; the mobul
clock is the analogue and is unreachable, since the 1a baseline's median run
elapses 2 mobuls of 300. "Scarcity raises risk tolerance" is recorded as a
meta-tier candidate for the engines that do have a hunger clock.

## 2026-08-21 — License docs: a Module's row is distribution terms, not sole license

**Decision:** Amend the scope/notice model after an adversarial second-opinion
pass (Codex, `xhigh`). A Module's map row states the term on which that Module
is **distributed as a whole**; it is not the only license inside it and does
not re-license VectHack's own code. Larn is the explicit case: Morgan's grant
is not copyleft, so `src/modules/larn/native/` stays MIT and the NetBSD files
stay BSD, with all conditions applying cumulatively. Renamed the appendix
"Additional component licenses and required notices". Added the missing
Angband BSD notices, the CC0 `isaac64.c` note, musl's sub-component portions,
explicit GPLv2 2(a)/NGPL 2(a) change dates, and `dist/licenses/SOURCE.txt`
naming the exact build commit.

**Why:** The earlier "each Module's own license governs all of it" wording was
right for copyleft and wrong for Larn — and it contradicted a later paragraph
in the same file. Worse, the first pass audited Larn's compiled sources for
permissive notices but never Angband's: `message.c`, `wiz-stats.c`,
`z-textblock.c` (+ headers) and `sound.h` are BSD-2-clause, link into
`angband.wasm` via ANGFILES/ZFILES, and their binary-form clause was
unsatisfied. Staging license texts alone also left object code with no
source-acquisition information. GLM reviewed the same work and found none of
this; it had no file access, which is the lesson.

## 2026-08-21 — License docs: scope per Module, notices in one appendix

**Decision:** State one governing license per Module (NetHack NGPL, Angband
GPL-2.0-only, Umoria GPL-3.0-or-later, Larn Morgan's no-profit grant) and keep
permissive inner components (Larn's BSD files, Lua, musl, Emscripten) out of
the map as attribution notices only. Drop `sound.prf` from `angband.data`.
Ship license texts in `dist/licenses/`. Add dated GPLv2 2(a) / GPLv3 5(a)
modification notices. Relabel the www footer's source link NGPL ¶3(b).

**Why:** A joint Claude/Codex review (`docs/agent-chat/`, 2026-08-20) found the
old "whole app is NGPL" claim incompatible with the GPL Modules, the Larn tree
mixed-license (five UCB BSD-3 files, one Zoulas BSD-2), a CC-noncommercial file
shipped inside a GPLv2 bundle, Lua absent from every notice, and no license
texts in `dist/` at all. Mapping every inner license was accurate but
unreadable at sixteen rows, so scope and notices were separated: copyleft sets
scope per Module; permissive components only add attribution. `sound.prf` is
the one file that conflicts rather than adds, so removing it is what lets the
Angband line stay one line — `pref.prf`'s `%:sound.prf` include survives
because the handler passes `quiet=true` and discards the result
(`ui-prefs.c:438`).

## 2026-08-21 — Phase 1b decision rule applied: the first earned KB does not ship

**Decision:** The Larn reflect loop ran end to end — 100 training games on
master 20260818, one local-model reflection each, 170 of 171 deltas accepted,
52 facts — and the pre-registered rule read NO-SHIP on the held-out cohort
(master 20260819): pooled median score delta 0, 5 wins against 40 losses, guard
-1 where it required 0 or better. `data/kb/larn/facts.json` returns to the empty
set, byte-identical to its pre-run state; the facts stay in history at
`3317426` and their model transcripts stay committed under
`docs/reports/2026-08-21-larn-1b-training/`. Report:
`docs/reports/2026-08-21-larn-1b-ab.md`.

**Why:** 28 of the 38 learned threat claims carry value 1.0 and all but two
clear the 0.7 flee threshold, so the ladder stopped starting fights: melee
attempts per run fell from a median of 6 to 0, and 74 of 100 treatment runs
never swung. Larn's score is earned by playing, so the surface stratum lost 475
points at the median. Nothing was hand-picked in either direction — curating
which earned facts survive is the thing this phase exists to avoid — and a rule
that can only say yes measures nothing, so the negative result is the phase
succeeding, not failing.

## 2026-08-20 — A refused pickup is remembered per cell, not as a pack-full latch

**Decision:** `LarnBrain` keeps a `lootRefused` set of posKeys. Larn's own
"You can't carry anything else" (`external/larn/global.c:481`), read at the next
command boundary out of `textSinceLastKey`, adds the hero's current cell; the
loot step's `wantsItem` skips those cells. It is a set apart from the anti-stuck
`blocked` list — a refused cell is still passable, it is only no longer worth
walking to — and it clears with the same two resets, the engine's level event
and the teleport-sized jump, because a posKey is one map's geometry
(`vect-hack-b5f.2.1`).

**Why:** `nextStep()` never counts the start cell, so a hero standing on an item
Larn would not take sees no loot target, walks off, and is routed straight back
on the next decision — a two-cell loop that burns the whole command budget the
moment the reflect loop writes its first `item-value` fact. A global pack-full
latch would be tighter (the refusal is a property of the pack, not the cell) but
the seed bot never drops or uses anything, so nothing could ever clear it: the
un-latch would be a branch that cannot run, which is worse than not having it.

## 2026-08-20 — The model proposes facts; a deterministic applier is the only writer

**Decision:** Phase 1b's reflect loop (spec
`2026-08-19-bot-phase1b-larn-reflect-design.md`, `vect-hack-b5f.2`) never lets
an LLM touch `data/kb/`. It emits typed claim deltas; `src/bot/factDelta.ts`
derives each fact's id from the claim's subject, computes confidence as
`(support + 1) / (support + refute + 2)`, merges by that id, takes the median
of numeric claims, and serialises canonically. `facts.json` holds facts only —
the threat/item/terrain tables the ladder reads are compiled from them on load
(`src/bot/kbCompile.ts`) and never stored. A delta may cite only the run it was
reflecting on. `item-value` claims key on the map glyph, not the rendered item
name.

**Why:** Every rule removes a class of damage. Derived ids mean two runs that
learn the same thing merge instead of accumulating near-duplicates, so most KB
thrash is prevented rather than repaired — the standing gate is that applying a
delta set twice is byte-identical. Arithmetic confidence keeps the least
reliable number in the pipeline (a model's self-report) away from the one the
fast policy acts on. Compiled tables cannot drift from the provenance that
justifies them; a table the model wrote directly would sit outside the audit
that `facts.json` exists to support. Per-run evidence scoping closes
misattribution — provenance naming the wrong game certifies a fact nothing
supports — though it cannot close fabrication, and the code says so. And the
glyph key is the only one the policy can reach: it routes over map cells, which
carry `ch`; the item's name appears on pickup, after the decision is made.

## 2026-08-20 — The digest samples what the screen showed, not what the input loop did

**Decision:** `src/modules/larn/bot/digest.ts` records the hero's surroundings,
the ground under them, and every descent from the engine's own frames — map
batches and status pushes — never from command boundaries. `atCommand` still
stamps which command a sighting belongs to; only how often the digest looks
changed.

**Why:** Three defects of one family, all found by running the builder against
real recorded games rather than synthetic fixtures. A descent whose depth
change ended the run was dropped, because no later command boundary existed to
diff against. A captured descent named the wrong glyph, because the exit cell
was read at a boundary the hero had already left — `$` where the hero actually
fell through `E`. And `finalAdjacent` was empty for every death, because a
death happens after the last command, so the monster that killed the hero was
invisible in exactly the runs that explain the death. Nothing about a descent
or a death happens when the bot is asked for a key. Fifty-three of the Phase 1a
baseline's hundred games die by taking the town's `V` shaft, so a digest that
drops or misnames that descent makes the phase's central fact unlearnable —
and a wrong glyph is worse than silence, because the bot would then route
around the wrong terrain.

## 2026-08-20 — A/B strata are frozen from the control arm, and the guard fails closed

**Decision:** `src/bot/abReport.ts` labels each seed `volcano` or `surface` by
what the **control** run did on it, never the treatment, and reports seeds that
crossed as `migratedToSurface`/`migratedToVolcano` — a finding, not a metric.
The guard requires the median per-seed depth delta in the control-`surface`
stratum to be at least zero, and an empty stratum makes it false rather than
vacuously true.

**Why:** The likeliest thing Phase 1b teaches is to stop taking the shaft,
which moves seeds out of the volcano population; labelling by the treatment's
own depth would be conditioning on an outcome the treatment caused, which
manufactures differences out of nothing. The control arm is the pre-treatment
behaviour by construction, so it is the honest label source. The guard exists
to stop one specific false victory — a bot that survives longer by never
descending — and a guard that passes when it has no evidence to judge is an
assertion that cannot fail (see 2026-08-19 above, and vect-hack-azf).
## 2026-08-19 — The GPU gates expect the declined storage grant, and nothing else about it

**Decision:** `browser-check.mjs` allowlists exactly one persistence message,
anchored whole: `[vect-hack] saves may be evicted: the browser declined
persistence`. The other two `persistentStorage.ts` warnings — no storage
manager, and the request threw — stay fatal. We did not make headless Chromium
grant the permission instead (it would, if the gate granted `notifications`).

**Why:** Chromium gives the grant to origins it has engagement with, and
Playwright launches a fresh ephemeral profile every run, so `persist()` declines
deterministically — 8 runs of 8. That is the harness, not the app: `false` is a
normal answer this code is written to handle, and the branch behaviour is
already pinned by `scripts/test/backplane-persistent-storage.test.ts` under
`npm test`. Buying a green gate with `grantPermissions(['notifications'])` would
hang it on an undocumented Chromium heuristic and test the browser rather than
the renderer. The two fatal messages are the ones that mean something is really
wrong, so the split is where the signal is. `check:browser` had been red since
5d721cf (2026-08-11) without anyone noticing, because it needs a GPU and is not
in `npm test` (vect-hack-15b).

## 2026-08-19 — Multi-tab safety is asserted against IndexedDB, never a tab's MEMFS

**Decision:** A test that asks what one tab did to another's save reads the
durable volume — a bare IDBFS mount that only populates (the `editVolume()`
shape in `test-nethack-autosave.mjs`), or IndexedDB directly
(`readDurableFiles()` in `moria-persist-play.mjs`) — never the other tab's
`FS`. And the writer closes *before* the loser wherever `close()` flushes, so
the loser's damage is the last write the volume sees. Fixed across all four
Modules (vect-hack-egc, after vect-hack-6lh); each site was falsified by
reintroducing the damage and watching the old assertion stay green.

**Why:** each tab is a separate Emscripten heap. One module instance cannot
reach another's MEMFS under any implementation, so `writer.read(path)` after
the loser acts is a tautology of process isolation — the vect-hack-azf rule,
one layer down. `test-nethack-tabs.mjs` is the regression test for
vect-hack-4ho, a real data-loss bug, and it printed OK with that bug
reintroduced: the loser wiped IndexedDB, and the writer's closing flush put
everything back from its intact memory before the third tab looked.

## 2026-08-18 — Naming a cell in NetHack costs game RNG, and that is accepted

**Decision:** The Look HUD's NetHack describer calls `do_screen_description()`,
whose `didlook:` tail (`external/NetHack/src/pager.c:1590`) can `mksobj()` a
temporary object for a remembered glyph that is no longer really there —
reaching `next_ident()`, `svc.context.ident += rnd(2)`, the *game* RNG and
saved state (`mkobj.c:521`) — and sets `t->tseen` on a trap it names. We take
that cost rather than avoid it, and say so where the code says "read-only"
(`wasmAbi.ts`, `worker.ts`, the amended spec bullet). The one windowport
escape hatch (`impossible()` inside `lookat()`) is covered by making the call
under the checkpointer's non-unwinding bridge swap, not by hoping it never
fires. The other three Modules' describers, which this repo owns, stay free of
both.

**Why:** `auto_describe()` (`getpos.c:640`) calls the identical function once
per cell as NetHack's own farlook, travel and targeting cursor is walked across
the map, with `iflags.autodescribe` on by default. A hover fires at the same
rate — once per cell entered — so pointing costs the engine exactly what
upstream's own cursor costs. The alternatives were patching
`external/NetHack`, which AGENTS.md forbids because the submodule stays a
clean external dependency, or abandoning a uniform native-query describer for
per-Module screen scraping. A main-thread answer cache was declined
separately: keyed on anything the game-free HUD can see, it would show a stale
name for a monster that had moved.

## 2026-08-18 — Dead assertions are swept for deliberately, not found by accident (vect-hack-egc, vect-hack-8r0)

**Decision:** All 138 tests and the four GPU gates were read in one pass looking
only for assertions that cannot fail, or cannot fail for the reason they claim
(`docs/notes/2026-08-18-dead-assertion-sweep/`). Findings are
graded DEAD / WEAK / NARROW and each carries a falsification experiment — the
exact production mutation that should break it and does not. The multi-tab
cluster is `vect-hack-egc`; the rest is `vect-hack-8r0`.

**Why:** Four dead assertions surfaced in two days, every one of them found by
someone working nearby rather than by anyone looking — a detection method that
only covers where work happens to go. The sweep found 13 more DEAD, 17 WEAK and
13 NARROW. The systemic one is worth the entry on its own: six persistence and
multi-tab tests, in all four Modules, assert against a module's own private
MEMFS instead of the durable volume, which the second tab cannot reach in any
implementation. `test-nethack-tabs.mjs` is the regression test for
`vect-hack-4ho`, a real data-loss bug, and that bug would pass it today —
partly because the writer closes last and its flush repairs the damage before
the third tab looks. Two things came out clean and are worth recording as
evidence the practice works: `browser-check.mjs` (the script vect-hack-azf
fixed) had nothing, and the shared Backplane/render/ui layer had zero dead
assertions across 29 files. The defects cluster in per-Module tests, worst in
the real-engine ones, where building a genuine falsification costs the most.

## 2026-08-18 — The bot KB splits earned facts from born-with tuning; the Phase 1a baseline is a pilot, not a promotion gate

**Decision:** `data/kb/<tier>/facts.json` holds only claims about the game that
play could earn or refute, each carrying provenance — `{kind:"seed"}` or the
trajectories and event ranges behind it — and `src/bot/kb.ts` refuses a learned
fact that names no evidence. Knobs the survivor ladder was born with
(`restLimit`, `stuckLimit`, `restBelowHpFraction`) live apart in
`data/kb/larn/policy.json` and carry no provenance at all. The Phase 1a
baseline (`docs/reports/2026-08-18-larn-baseline.md`, 100 seeded
games) is published with its Wilson intervals, its two modes, and an explicit
"pilot, not a promotion baseline" caveat; two seed cohorts are frozen in its
manifest, a training master (20260818) and a held-out evaluation master
(20260819) that Phase 1b may not play.

**Why:** Conflating the two kinds of number would make the provenance audit
meaningless on day one: `restLimit: 150` is a tuning constant nobody learned,
and if it sat in `facts.json` as a seed fact then "how much of this KB did the
bot earn?" would be answered by counting a file that was mostly knobs. Ratios
over `facts.json` mean something only while every row in it is a claim play
could have made. On the baseline: at 0 wins in 98 game results the two-sided
95% upper bound is still 3.8%, so a later "small but real" improvement is
indistinguishable from this batch — Phase 1b is measured on paired per-seed
depth and score, not on a win rate. The distribution is bimodal (53 of 100 took
the town's volcanic shaft and died at depth 11 in a median of 22 commands; the
rest ran long on levels 1–4), so the report gives modes and histograms rather
than a median that describes no game played. Held-out seeds are frozen now
because a phase that reflects on its own evaluation set is measuring nothing.
## 2026-08-18 — Look HUD identifies cells through a pure native query, not key injection or batch names

**Decision:** Point-and-look (spec `2026-08-18-look-hud-design.md`,
`vect-hack-kew`) is one Backplane request `describe(x, y)` answered by a
read-only native function per Module: NetHack's own `do_screen_description`
added to our export list (no source patch), and a small `describe()` in each
of the Angband/Larn/Moria exporters using the engine's naming functions. It is
called from the worker's message handler while the engine is Asyncify-
suspended. Rejected: naming every cell in the map batch, and driving each
engine's look command with synthetic keys or clicks.

**Why:** A synthetic NetHack click misfires: `getpos` (farlook, travel,
`#jump`, polearm) and `getdir` read through the same `nh_poskey`, and only
`program_state.input_state` — invisible to JS — tells them apart, so a hover
during "Where do you want to hit?" would pick that square. Batch names would
grow Angband's packed and Moria's sanitized fixed-width ABIs with strings and
do per-glyph work for cells nobody hovers. The pure query never touches input
state, works during menus and prompts, changes no ABI, and a spike proved
`do_screen_description` has no windowport calls and is callable while
suspended (`coord` passes as a pointer to a 4-byte temp; `firstmatch` is the
autodescribe phrase).

## 2026-08-17 — Bot campaign order Larn → Moria → Angband → NetHack; black-box seed; one child process per game

**Decision:** The self-teaching bot (spec
`2026-08-17-self-teaching-bot-design.md`) is built engine by engine in
climax-difficulty order, and its seed knowledge is operational only — no
monster/item/strategy tables, and nothing from the Angband borg (Eric: that is
cheating; the bot learns from the game). Phase 0 ships a game-free `src/bot/`
layer plus the Larn adapter and gym. The gym plays each game in its own node
process under a game-agnostic orchestrator (`scripts/dev/bot-gym.mjs` →
`bot-gym-<game>.mjs`); the child writes its trajectory and summary
synchronously inside the engine's `quit()` callback and the orchestrator gzips
afterwards.

**Why:** Larn is the only engine where reliably winning is a first-iteration
target, so the whole loop gets validated against a true win before the harder
games; the ladder makes mistakes cheap and carries meta-knowledge forward. A
process per game gives a fresh wasm heap and dungeon, free parallelism, and
makes a wedged engine a SIGKILL rather than a leak; Larn ends through `exit()`
right after `quit()`, so writes there must be synchronous. Larn seeds its RNG
from `time()` at second resolution, so the orchestrator's one-second spawn gate
is a stopgap until the shim takes a seed (vect-hack-1x5). Session-only storage
(`locks: null`) because nothing needs to survive a game yet. The scoreboard's
`depth` is Larn's own level number (H=0, 1–10, V1–V3=11–13), and the seed bot
takes every descent it is offered, including the town's volcanic shaft:
declining it would be game knowledge the reflect loop must earn (seed policy),
so a Phase 0 baseline is largely a shaft-dive histogram until Phase 1 learns
otherwise.

## 2026-08-11 — The outer command request clears Moria's overlay stack

**Decision:** `vectMoriaGameRunKeyInput` calls `moriaSemanticOverlayReset()`
before every outer-command read, dropping any claimed overlay scope. The
invariant, not a list of upstream quirks: with the dungeon on screen and the
cursor on the hero, no full-screen display can legitimately be up, so anything
still claimed was never given back. `npm run test:moria-overlay` drives the
real engine through each screen and asserts the overlay is NONE at the next
command.

**Why:** Umoria does not balance its saved screens — `inventoryExecuteCommand`
always calls `terminalSaveScreen()` but calls `terminalRestoreScreen()` only
when the screen it ends on is not `Blank`, and `e` with nothing equipped (a
fresh character) takes exactly that branch. Our shim hangs the overlay scope on
that pair, so one keypress stranded a scope and `VectorView` hid the canvas
behind the 80x24 text screen for the rest of the session — the 3D view simply
never came back. The store path had already hand-unwound the same class of
imbalance with `popThroughOverlay(STORE)`; per-path unwinds only cover the
paths someone thought of, and `external/umoria` is never patched.

## 2026-08-11 — Loading a save replaces the volume, at mount, for every Module (vect-hack-9h1)

**Decision:** One save affordance in every game — a Saves button plus F3/F4 —
over three shared files (`ui/saveMenu.ts`, `saveDownload.ts`, `saveUpload.ts`).
A load validates the file on the page, confirms the overwrite, parks the bytes
in an IndexedDB transfer store (`backplane/pendingImport.ts`) and reloads;
`mountVolume` applies it between the populate syncfs and the seed, wholesale —
the volume is emptied and rewritten, not merged — then clears the park whether
it applied or refused. A Module may register a `validateImport` gate; Moria's
existing archive gate is wired as one, and is the only one.

**Why:** An import cannot land in a live volume: it is mounted in the worker's
FS and the engine holds its own handles and its own idea of the save. Between
populate and seed is the only moment its contents can be swapped, and that
moment already exists once, in the Backplane, for all four Modules — so the
affordance needed no per-Module protocol message and no `main.ts` branching
beyond naming the volume. Replace rather than merge because a blob is a whole
volume; merging leaves one character's save beside another's score file, each
true and the pair nonsense. The park is cleared on refusal too: a blob this
build will never accept would otherwise be retried on every reload forever.

## 2026-08-11 — Larn's command discriminator is `--wrap=yylex`; gaze tables move to one adapter (vect-hack-bil)

**Decision:** Larn's command-vs-prompt seam is a link-time wrap of `yylex()` in
our own shim (src/modules/larn/native/main-wasm.c): a flag set for the duration
of `__real_yylex` becomes the `cmd` argument `__wrap_read` passes to
`gatherKey`. The gaze binding tables and chord resolver duplicated verbatim in
the Angband and Moria VectorViews moved to a shared adapter,
`src/ui/gazeControls.ts` (`gazeKey()`), which Larn's view now also uses with its
existing `movementKey` vi-byte encoder. NetHack keeps its own rebindable
moveKeys layer.

**Why:** `parse()` (main.c:672) is `yylex()`'s only caller and every prompt
reads through `ttgetch()` instead, so "fd-0 read inside yylex" is exactly "Larn
is asking for a command" — no upstream patch, no JS heuristic, and count-digit
reads inside yylex correctly keep command context for the direction that
follows. The tables were three byte-identical copies of a policy (what a chord
means per camera mode); what stays per-Module is exactly what differs: the
command seam and the engine's key encoding.

## 2026-08-11 — One degrade policy, still no Module registry (vect-hack-4c7)

**Decision:** `src/ui/chooseView.ts` owns the `?view=debug` / no-GPU / `?gl`
sequence all four Modules ran identically (canvas grab, debug check, probe, tty
fallback with `GPU_UNAVAILABLE_NOTICE`, else vector view); each `make*View()` in
main.ts is one line naming that game's two view classes. Nothing else moves: the
`?game` if/else stays literal, sessions stay hand-constructed, and each Module
keeps its own Vite worker literal. The 2026-08-04 rejection of a Module registry
stands.

**Why:** Four byte-identical copies of a policy is the one thing a fourth Module
proved is not per-game — the copies differed only in which two classes they
named. It is a policy, not an enumeration: nothing here can list the games, so
it cannot grow into the registry. It sits beside `gpuSupport.ts` rather than in
it so the probe stays a pure question with no DOM or URL in it.

## 2026-08-11 — Larn refuses `savefile:`, out loud, and keeps playing (vect-hack-am8)

**Decision:** `__wrap_readopts` (src/modules/larn/native/main-wasm.c) restores
`savefilename` to `/lib/home/Larn.sav` after every `.larnopts` parse and posts a
Backplane notice saying the option was ignored. The option is refused; the game
is not. Every other `.larnopts` directive still applies, and external/larn is
untouched — `-Wl,--wrap=readopts` joins the existing wrap list.

**Why:** `savefile:` strcpy()s any path over `savefilename` (tok.c:226-229), and
under WASM every filesystem outside the mounted volume is MEMFS that dies with
the tab. Proven with the real engine on the pre-fix build: a planted `.larnopts`
sent an S-save to `/tmp`, `savegame()` returned 0, and the worker reported
`saved: true` for a game that no longer existed. Confining rather than rejecting
because there is no way to edit `.larnopts` from inside the browser — failing the
boot would brick a volume the player could never open again — and announcing it
because silently rewriting a configured path is the lie that refusing it out loud
is not. With the path pinned, `saved: true` is true by construction: the save is
always on the one path recovery reads. No shipped code writes `.larnopts` today;
the generic `.vhsave` restore would accept `home/.larnopts` verbatim the moment
Larn gets Moria's import.

## 2026-08-11 — Persistent storage is asked for once per page, from main.ts (vect-hack-9tv)

**Decision:** `requestPersistentStorage()` (src/backplane/persistentStorage.ts)
asks `navigator.storage` for the eviction exemption once per page, wired into
`main.ts` beside the `?game` branch and skipped on the redirect evaluation. It
is fired, never awaited. Absent storage manager, a rejection, and a refusal all
resolve `false` and log one line; the return value is the whole observable
result — no on-screen chrome, no quota estimate, no export/import (all cut from
the bead, export/import to vect-hack-4zn).

**Why:** The grant is origin-wide, so it belongs neither in a Module's
`persist.ts` nor in a worker — four workers would make four requests for one
grant, and `StorageManager.persist()` is Window-only anyway (`lib.webworker.d.ts`
declares `persisted()` and not `persist()`), so a worker could not ask. Chrome
grants silently on engagement heuristics and is most of the users; Firefox
prompts, which is why the redirect evaluation stays quiet and why an
already-persisted origin is never asked twice; Safari does not really honour it.
Verified against real engines that an evicted volume is a first boot, not a
half-populated one: with the whole IndexedDB database deleted, Moria's volume
listing matches a pristine boot exactly and reaches character birth without
offering a restore, and NetHack starts a fresh character without asking to
recover and checkpoints again. IDBFS holds its connection open and registers no
`onversionchange`, so a delete cannot land under a live tab at all.

## 2026-08-11 — Worker error/messageerror are engine deaths, told once (vect-hack-4p9)

**Decision:** `EngineSession` attaches `worker.onerror` and
`worker.onmessageerror` to the fatal-notice path. An ErrorEvent is worded from
its own message plus `filename:lineno`, or "the engine worker failed to start"
when it carries none; a `messageerror` is worded as a deserialization failure,
since it carries nothing to quote. Neither terminates the worker. Every death
report of any kind — posted `fatal` included — logs to the console, but only
the first reaches `onNotice`.

**Why:** A worker killed before its own `error` listener runs (script load
failure, OOM) was console-only. A `messageerror` leaves the worker alive but
the session dead: the class's invariant is one reply-owing message in flight
and its id was inside the value nobody could read, so the Asyncify-suspended
engine can never be answered. Terminating would contradict the posted fatal,
which only notices, and would cut short a worker still flushing its volume. The
once-only guard exists because each Module's worker posts a fatal from its own
`error` listener without cancelling the event, so one death now arrives twice.

## 2026-08-08 — Moria checkpoints reuse the exact writer at the turn tail

**Decision:** Compile pinned `game_save.cpp` once through a project-owned
same-translation-unit adapter and call its private exact writer for internal
checkpoints. An explicit typed snapshot rolls back every touched native and
terminal field; a field-encoded trailer restores state the stock format omits.
Only a source-marked completed outer command may checkpoint, after the sole
turn-tail monster update. Unique checksummed generations become durable through
one awaited IDBFS flush; descendant digests, terminal tombstones, and corrupt
fallback arbitrate recovery.

**Why:** Reimplementing the serializer duplicates hundreds of format-sensitive
lines. Public `saveGame()` mutates input, RNG, search/rest, burden, speeds, UI,
and terminal state, while rewinding raw WASM memory would overwrite the active
stack and still miss JavaScript-owned state. The tail seam resumes at the next
turn without replaying its preamble, and exact generations avoid IDBFS's
millisecond-mtime equality trap.

## 2026-08-08 — Moria browser controls are proven at consumed input boundaries

**Decision:** Chromium gates synchronize Moria actions on its parked native
input request and record the byte, context, and key mode that `nextKey`
actually returns. Original-mode run is asserted as two source reads: `.` at
the outer command boundary, then an exact direction byte at the literal read.

**Why:** Terminal DOM and semantic frames can coalesce or lag the native read;
a visible hero or prompt is not proof that camera remapping was armed. The
source-owned `outer-command`/`literal` discriminator plus the consumed bytes
makes movement, run, Clear, and prompt-isolation assertions able to fail.

## 2026-08-08 — Moria input context is call-site-owned and polling always yields

**Decision:** Compile only upstream `game_run.cpp` with
`getKeyInput=vectMoriaGameRunKeyInput` and pin its three direct reads. Its
non-message-row outer read is command-mapped; the two row-zero count reads and
all other prompts remain literal. Key replies distinguish byte (including
NUL) from no-key and never represent EOF. Polls await a Worker timer task at
zero or 10 ms. Normal exit is only the awaited `--wrap=exit` marker followed
by Emscripten 6's observed `undefined` Asyncify unwind; every native return is
fatal.

**Why:** A global cursor heuristic misclassifies nested farlook, while the
single translation-unit seam exactly identifies command ownership without
patching upstream. Explicit statuses prevent channel failure from entering
Umoria's mutating EOF/panic-save ladder; task yielding keeps run/rest
interruptible; the pre-exit marker makes normal teardown distinguishable from
startup returns and faults.

## 2026-08-08 — Moria build inputs and publication are content-verified

**Decision:** The Moria build verifies the exact Umoria and emsdk commits,
compiles every approved upstream C++ unit except the two project-owned boundary
replacements, fingerprints flags/native files/seed generator/seed bytes, and
hashes all three successful artifacts. It publishes one complete versioned
artifact directory through an atomic `public/modules/moria` pointer switch.

**Why:** Make does not track flags, preload bytes, or the `.wasm`/`.data` side
effects of its JavaScript target. Explicit content guards prevent stale or
corrupt artifacts from passing an incremental build, while the single pointer
switch prevents a browser from observing a mixed three-file module.

## 2026-08-08 — Umoria source pin and GPL boundary

**Decision:** Canonical Moria source is the official
`dungeons-of-moria/umoria` repository, pinned cleanly in `external/umoria` at
`3bf8abc4f76812810e59d738492c7b61fb8f1bb6`. Upstream stays unmodified;
project-owned GPL-3.0-or-later files replace only `main.cpp` and `ui_io.cpp`,
preserve applicable copyright/SPDX provenance, and ship with the GPL-covered
engine through the repository's corresponding-source path.

**Why:** Upstream records that the free-moria effort obtained contributor
permission beginning in 2007 and official maintainer David Grabiner released
Umoria 5.6 under GPL-3.0-or-later in late 2008. The exact official pin plus a
clean replacement boundary makes that provenance and every adaptation
auditable without patching historical source.

## 2026-08-07 — Larn's custom no-profit grant requires a license map

**Decision:** Package metadata uses `SEE LICENSE IN LICENSING.md`, not an SPDX
expression. The license map applies Noah Morgan's original permission to the
Larn source, native porting shim, and built artifacts: source use,
modification, and ports are permitted provided no profit is made.

**Why:** NetBSD hosting does not relicense Morgan's code, and the vendored
`external/larn/COPYRIGHT` identifies Morgan's copyright without a BSD grant.
His custom no-profit condition has no accurate SPDX expression. VectHack's
free, ad-free hosting complies; commercial use requires separate permission.

## 2026-08-07 — Legacy game shims are game-specific; the Module boundary stays clean

**Decision:** Keep upstream game sources pristine and pinned. A Module's
native/test shim may use source-specific wrappers, global reads, terminal
decoding, and guarded heuristics behind its typed semantic adapter. That
adapter feeds the shared Backplane `CellGrid`, `KeyQueue`/input,
lifecycle/save routing, and persistence namespace; the renderer consumes the
`CellGrid`. Standardize shared responsibilities, not wire vocabularies or shim
implementation.

**Why:** These museum binaries are static and more same-generation games are
planned. Isolating per-game ugliness preserves source provenance/auditability,
keeps license-relevant upstream boundaries explicit, and avoids either
patching upstream or forcing legacy quirks into shared layers. Document every
assumption and guard it with real-engine checks; Larn's `CLEAR`/`cl_up`
overlay heuristic is an intentional pinned adapter.

## 2026-08-07 — Larn hero identity and position come from larn_map_info

**Decision:** `larn_map_info` emits `TOP_CAT=HERO` at
`(playerx, playery)`, making hero identity and position native semantic data.
The TypeScript classifier materializes that category with fixed `ch: "@"` and
`color: 15` presentation.

**Why:** BSD Larn 12.0's `showplayer()` draws only a bare cursor. The native
tap removes any TypeScript inference from player coordinates while retaining
the Module's fixed hero presentation.

## 2026-08-07 — Larn 12.3 re-investigated, rejected

**Decision:** Remain on the NetBSD BSD-Larn-12.0 snapshot.

**Why:** 12.3 has the same parallel, inlined-map design with no query
function, so it solves none of phase 2's map work. Static/extern hard errors
plus `sgtty.h`, `SIGEMT`, and `exit`/`lrint` compatibility need about 90
source edits across 24 files, violating the pristine-source invariant; its
real `@` glyph saves only about ten cosmetic lines already handled by the
native tap.

## 2026-08-07 — Larn map tap: write our own larn_map_info()

**Decision:** Implement a native map adapter: `larn_map_info()` reads Larn's
live `extern` arrays and packs `drawscreen`-faithful known-map characters,
including hidden-trap and see-invisible semantics via direct
`objnamelist`/`monstnamelist` reads. A blind `showcell` does not query those
live arrays: the shim moves the semantic hero with an old/new two-record
delta made from its last-transmitted map shadow, so the camera follows the
known player position without exposing current occupants, objects, traps, or
unexplored terrain. Blind `draws`/`drawscreen` calls replay the requested
shadow region too; a blind level transition starts as unseen plus the hero.
Non-blind redraws query the live source. Keep the TypeScript classifier a
thin decoder.

**Why:** Larn has no upstream map query and its visibility logic is inlined.
The pinned source cannot drift, so this resolves the reviewed leaked-unseen,
hidden-trap, see-invisible, and wrong-character failures without reproducing
fragile game state in TypeScript. A real-engine contract gate forces
blindness at a proven command boundary and pins both hero movement and the
absence of any newly live cell data, including an explicit redraw; it also
pins restoration of a known item beneath the departing hero.

## 2026-08-06 — Larn source pin

**Decision:** Vendor the NetBSD `games/larn` snapshot (BSD Larn 12.0,
fetched 2026-08-06 from `cdn.netbsd.org/.../NetBSD-current/src/games/larn/`)
into `external/larn/` as the Larn Module source — not a submodule, because
the NetBSD src tree is too heavy to submodule wholesale.

**Why:** Both HunterZ/larn candidates failed the cflags-only axis: 12.3
(`00d60428284f`) has ~30 `static declaration follows non-static` hard
errors (clang C, no `-W` downgrade) plus bare `exit()` and removed
`<varargs.h>`; 12.4-alpha2 (`e61f3fbfc31b`) has the same `screen`
static/extern conflict plus unconditional `conio.h`/curses includes. The
NetBSD snapshot compiles cflags-only (22/22 `.o`, 0 errors, 0 warnings)
with the terminfo semantic-byte `lpbuf` surface the design preferred from
12.3 — no JS ANSI parser needed. See
docs/specs/larn-spike.md for the full surface contract.

## 2026-08-06 — Hit flash never guesses: ambiguity answers "no pulse"

**Decision:** Neither engine reports a victim's position, so the red pulse
(`DungeonRenderer.hitFlash`) is inferred per Module — and every ambiguous
signal resolves by last-key freshness or not at all. Angband splits the hit
message types into melee-only (MSG_HIT, HIT_HI_GREAT, HIT_HI_SUPERB) and
ambiguous melee-or-ranged (HIT_GOOD, HIT_GREAT, HIT_SUPERB, SHOOT_HIT); the
first resolves to hero + a fresh `lastDir` or to nothing, the second falls back
to the last effect cell. `lastEffect` is consumed by one message: a bolt whose
first post-flight message is an unclassified type loses its pulse — a
deliberate ceiling, because `send()` cannot be the only consumer (under `?borg`
the decorator answers the engine and no key is ever sent, so a stale missile
cell would sit there until a later melee crit claimed it). NetHack's kick never
pulses at all: dokick.c prints "You kick %s." identically for a monster and a
floor object, so the text cannot tell combat from stubbing a toe.

**Why:** A wrong pulse is a lie about where the fight is and reads as a bug;
a missing pulse reads as nothing at all. Text and typed-message families are
all the two engines offer, so the only honest tiebreak is what the player just
pressed — and that is only trustworthy while it is fresh: `lastDir` is stamped
at key consumption (NetHack's `readKey`, the queue's one consumer) so a
type-ahead prompt answer cannot aim it, counts only command-level direction
keys in Angband, and dies with the level in both.

## 2026-08-04 — No privileged game: modules/ layout, explicit ?game, symmetric names

**Decision:** Engine artifacts live in `public/modules/<game>/` (was
`public/core/` shared flat); one subdirectory per game. NetHack loses its
"the core game" naming everywhere: `build:nethack`/`build-nethack-wasm.sh`,
`test:nethack-*`/`test-nethack-*.mjs`, `nethack-scene.png` previews — all
mirroring the angband names. The boot guard is `__vhBooted` (game-neutral);
`__nhView`/`__angbandView` stay per-game. A URL without `?game=` redirects to
`?game=nethack` in main.ts rather than booting a default — no code may depend
on an implicit default game.
**Why:** Adding a third game must be additive: a new `src/modules/<game>/`,
a new `public/modules/<game>/`, new prefixed scripts — no renames of existing
files and no untangling of unprefixed names that silently meant "nethack".

## 2026-08-04 — Per-game skins punted

**Decision:** No per-game skin overrides (e.g. red walls for Angband) for now;
the skin system stays session-global exactly as is.
**Why:** With two games we can't yet see how per-game overrides should compose
with named skins once more games exist. Revisit when a third game forces the
question.

## 2026-08-03 — A save leaves the browser as one blob, packed in the Backplane

**Decision:** `src/backplane/saveBlob.ts` packs a whole Module volume into one
`VECTSAVE1` container (magic, one line of JSON manifest, then the file bodies)
and unpacks it back; `saveExport.ts` carries it across the worker boundary and
`src/ui/saveDownload.ts` binds it to **F3** in both games. The manifest carries
the game id and so does the filename (`vecthack-angband-20260803-2149.vhsave`),
but only the manifest is enforced — a renamed file still cannot be restored
into the other game's volume. Directories are not recorded and climbing or
anchored paths are rejected at parse time.

**Why:** IndexedDB is evictable and origin-scoped (vect-hack-9tv), so a
character born on localhost has no route to vecthack.com and no route at all
off the machine. Hardening storage in place has a low ceiling; giving the
player a file does not. It lives in the Backplane because it is the same
primitive a server-side save (vect-hack-4zn) would PUT, and because nothing in
it is engine-specific: it moves paths and bytes.

**Also:** the round trip is owned by `EngineSession` the way notice/fatal are —
the reply is Backplane vocabulary, so the delegate never sees it and each
Module's session is a one-line facade; the worker side is one
`answerExportRequest()` call. `PersistFS` and `SaveFS` stay two views of one
object — Emscripten's FS — that cannot be stated as one interface, because each
Module extends `PersistFS` with its own `stat`/`readFile` declarations and
TypeScript requires inherited members to be identical rather than compatible;
the cast is unchecked because a missing call already fails by name on first
use. Both engine persistence tests export and restore against the real FS,
which is the only place `mkdirTree`/`isDir`/`isFile` are the real ones.

## 2026-08-03 — ANGBAND_DIR_USER is repointed at /lib/user by hand

**Decision:** `main-wasm.c` overrides `ANGBAND_DIR_USER` and
`ANGBAND_DIR_ARCHIVE` to `/lib/user` and `/lib/user/archive` after
`init_file_paths()` and before `create_needed_dirs()`.

**Why:** Emscripten is a UNIX build, so config.h:68 defines
`PRIVATE_USER_PATH` as `"~/.angband"` and `init_file_paths` takes the private
branch for the user directory only — the tilde expands to nothing here and it
lands as a bare `/Angband` in MEMFS, outside the volume and discarded on
reload. Save, scores and panic escaped it because `USE_PRIVATE_PATHS` is
undefined and they are built from `datapath` instead, which is why this went
unnoticed: the four writable directories persist.ts links into the volume
looked right, and `user` was simply never written to. What lives there is not
scratch: borg.txt, the preferences the options menu writes, and the archive of
finished savefiles. Found by dumping the engine's filesystem after a borg run
(`/Angband/borg.txt`, 1069 bytes, next to an empty `/vect-angband/user`).
test:angband-borg now asserts the borg's config reaches the volume, and names
`/Angband` in the failure when it does not.

## 2026-08-03 — Effect observers are moved to the head of their handler lists

**Decision:** `main-wasm.c` queues effects rather than posting them, releases
the queue after `flush_map()` inside `TERM_XTRA_FRESH`, and re-registers
`on_bolt`/`on_missile`/`on_explosion` from an `EVENT_ENTER_WORLD` handler
(`arm_effect_handlers`) so they run before Angband's own display handlers.

**Why:** Measured in the browser: without this, no rendered frame ever
contained an effect Cell. Angband's `display_explosion`/`display_bolt` pace
the animation themselves (draw, `Term_fresh()`, `Term_xtra(TERM_XTRA_DELAY,
delay_factor)` — four 40ms steps for a radius-3 blast), and our observers were
running *after* all of them, so the whole blast reached the semantic grid once
the animation was over and the next repaint erased it 1ms later. Order was
being inherited from whenever `main()` happened to register; a remove-then-add
makes it explicit (game-event.c adds at the head). `EVENT_ENTER_WORLD` is the
one place to do it: `ui_enter_world` (ui-display.c:2718) re-adds the display
handlers at the head every time it runs, and it runs at game start
(ui-game.c:752) *and on leaving a store* (ui-store.c:1322) — so arming per
level instead would have gone stale on the first shop visit. Our arming
handler is registered before `init_display()` so it runs last in that
dispatch. It must not be armed from the fresh hook: `display_bolt` calls
`Term_fresh()` from inside the `EVENT_BOLT` dispatch, and removing a list
entry there would free the node `game_event_dispatch` is walking. Releasing
after the map batch matters for the same reason in the other direction: an effect applied
before that batch is overwritten by it. After the fix the blast holds for the
engine's own delays — `check:controls` counts nine drawn frames — and is still
cleared by the engine's repaint, never by a client-side TTL. One arming site
rather than two on purpose: it makes the projection assertion in
`check:controls` a real test of the ordering (it reads zero drawn frames when
the ordering is wrong, which is how the bug was found).

## 2026-08-03 — "Does it glow" is measured as bloom-added halo, not a ratio of ratios

**Decision:** `browser-check.mjs` asserts `(halo_on - halo_off) / core_off >=
0.5` instead of `haloRatio_on / haloRatio_off >= 2`.

**Why:** The old metric assumed every dim pixel in the frame came from bloom.
Angband's town fills the screen with distant floor grid whose faint strokes
land in the halo bucket on their own, which put the *bare-core* halo/core ratio
at ~6 and made the on/off ratio read 1.2 — "bloom adds nothing" on a scene that
plainly glows. The two shots are the same frozen frame, so subtracting cancels
the scene and leaves only what the bloom stack drew. Measured across both
Modules and both backends: 1.1–1.6, and ~0 with the stack disabled.

## 2026-08-03 — The prompt strip reserves its line

**Decision:** `#prompt` carries `min-height: 1.25em`.

**Why:** Angband's view keeps the strip shown and mirrors the term's top row
into it, so the strip collapsed to zero height whenever that row emptied. The
stage grew by a line, the canvas resized, and every resize rebuilt the trail
targets and the viewport texture the line materials copy through — measured as
a 684↔666px oscillation on nearly every turn, with WebGL logging
`bindTexture: attempt to use a deleted object` each time. Reserving the line
removes the oscillation entirely.

## 2026-08-03 — Angband checkpoints gate on !msg_flag and forced auto_more

**Decision:** The checkpoint calls `save_game_checked()` from
`wasm_handle_event`, immediately before the blocking key wait, guarded by
`wait && cmd && !msg_flag && wasm_checkpoint_due()` and wrapped in a scoped
`OPT(player, auto_more) = true`.

**Why:** `save_game_checked()` is not input-free. It opens with
`event_signal(EVENT_MESSAGE_FLUSH)` (ui-game.c:1055), which reaches
`message_flush` → `msg_flush` → `anykey()` → `inkey_ex()`
(ui-input.c:612/388/311) — a nested blocking key wait. Under Asyncify that is
a re-entrant suspend, and it would also eat the player's next keypress on a
`-more-`. `msg_flag` is public (ui-input.h:85) and false exactly when that
handler is a no-op; `auto_more` closes the `lore_save`-failure branch
(ui-game.c:1090-1093), which queues and flushes a message of its own.
`message_column`/`keymap_auto_more` are static and unreachable. Everything
else in the graph is input-free, and `save_game_checked` never prompts on
failure — `close_game` does (ui-game.c:1161-1166).

## 2026-08-03 — Angband productization architecture settled (vect-hack-3vk.3)

**Decision:** Phase 3 follows all eight decisions in
`2026-08-02-angband-productization-design.md`: optional per-Cell terrain
underlay; batched native `map_info` tap; a 198×66 dungeon grid; mirrored-term
HUD and full-screen overlay rather than a shared HUD shell; direct
`save_game_checked()` checkpoints with no NetHack-style recovery mirror;
`ALLOW_BORG` plus `?borg`; skw caveats 1–2 absorbed with caveat 3 parked; and
camera-only pointer input.

**Why:** Each choice uses Angband's public engine semantics, preserves the
unpatched submodule and thin Backplane, and adds only machinery demonstrated
by the second consumer. The rejected alternatives add parsing, shared API, or
persistence complexity without improving the phase-3 gate.

## 2026-08-02 — TtyView renders once per burst, on a frame raced with a timer (vect-hack-yzk)

**Decision:** `TtyView.scheduleRender()` gates *both* `gridToHtml` and the
`innerHTML` write on one render per burst, scheduled as
`requestAnimationFrame` raced against a 32 ms `setTimeout` — whichever fires
first renders and drops the other. The per-event grid mutation stays inline.

**Why:** Angband's `update_maps()` calls `Term_fresh()` once per changed
square (`ui-display.c:1418`), so one town step arrives as 28-80 separate
postMessages — each its own main-thread task, so the microtask this replaced
(DebugView's) coalesced nothing and the whole 80x24 grid was rebuilt and
re-parsed per message. Measured on one boot and one walk, pre-fix behaviour
reinstated by making rAF synchronous: 74.5 ms/step median (85 msgs/step, max
148 ms) → 4.9 ms/step (max 9.1), 77 DOM writes → 2, 49 ms inside `innerHTML`
→ 1.6 ms; latency stopped tracking message count. The timer is not
belt-and-braces: rAF stalls in hidden panes and headless runs, which is
exactly why DebugView is microtask-only (vect-hack-r05), and a rAF-only gate
would leave those never painting at all. It does not reintroduce r05's bug —
the frame is armed once per burst and cancelled when the timer wins, not
re-armed per render.

## 2026-08-02 — Backplane extracted; Modules under src/modules/ (epic vect-hack-3vk phase 2)

**Decision:** Shared layer extracted to `src/backplane/` (Cell/Category grid,
EngineSession, KeyQueue, volume registry) per the backplane design spec;
NetHack reshaped into `src/modules/nethack/` (classifier split out of
MapModel, MapModel deleted), Angband conformed into `src/modules/angband/`.
Storage renamed to `/vect-nethack` + `vect-nethack/persist` with NO
migration — old `/persist` saves knowingly orphaned. Exactly two behavioral
deltas, both in EngineSession: engine fatals surface as notices
(vect-hack-1g5) and a throwing view posts a cancel-shaped fallback instead
of wedging Asyncify (vect-hack-c1w). Additionally sanctioned: Angband's
quit≠fatal reclassification (Tasks 12-13) and the Object.hasOwn key-lookup
fixes. Classification pinned by nethack-classifier.test.ts — unchanged except
blank-cmap dark stone → unseen (the one sanctioned classification delta).
Previews byte-identical through the rename.

**Why:** Two real consumers existed (design doctrine: extract only what the
second consumer demonstrates); ownership became directories so the hygiene
rule is enforceable; the rename beats carrying legacy names into every
future Module for unreleased software.

## 2026-08-02 — Epic 3vk stays off main: merge reverted, work continues on its branch

**Decision:** The Angband spike merge (7cb5089) is reverted from main
(49798e8). Epic vect-hack-3vk (spike + seam extraction + productization)
continues on the long-lived branch `worktree-vect-hack-3vk` in a worktree;
main stays NetHack-only until Eric decides the platform work ships — which
may be never. If it does ship, the revert must be reverted first (or the
branch rebased): git considers those commits already merged.

**Why:** Eric's call after playing the spike: keep the platform experiment
isolated end-to-end rather than landing it phase by phase.

## 2026-08-02 — Angband spike: own-main() front end over an unpatched submodule

**Decision:** `external/angband` pinned at f0f6bd223 (4.2.6-166), never
patched. Our front end (`src/angband/native/main-wasm.c`) supplies `main()`;
upstream `main.o` is not linked (Shelob's own flavour). The borg objects are
in BASEOBJS but compile empty (`ALLOW_BORG` undefined), so no borg symbols
exist and none appear in ASYNCIFY_REMOVE. Shelob's Safari list carries over
with 4.2 renames (`Term_mbstowcs` → `text_mbstowcs`); its three core patches
are all unnecessary at 4.2.6 (clean compile verified; saves out of scope).
**Why:** Same clean-external discipline as NetHack; Shelob proved the shape,
the research pass proved the link (exit 0, 4.0 MB wasm).

## 2026-08-02 — Platform simplified: one App, internal Game Seam, two games private

**Decision:** Supersedes the same-day "shell + downloadable modules" entry
below. One versioned App holds all of Eric's code; only Engine Builds (GPL
engine wasm, reproducible from GPL-clean Engine Repos) load as external
artifacts. "Module" means exactly one thing: the per-game integration unit
inside the App (Classifier + input map + glue), never the wasm. The Game Seam
is internal and versions with the App — no protocol compatibility matrix.
Cells carry a shared-layer-owned closed Category set plus module-owned open
Kinds; per-Module storage volumes; checkpoint/recover are NetHack Module
code. Scope: NetHack + Angband, private, no distribution — repo layout,
library extraction/publication, licensing posture, xNetHack all deferred to a
scale-to-N spec. Sequencing: Angband spike (structural Module shape only, raw
tty grid, no classifier) → seam extraction from two real consumers → Angband
productization. Glossary: CONTEXT.md. Spec rewritten in place:
docs/specs/2026-08-02-vect-platform-design.md.

**Why:** Downloadable modules bought legal separation and catalog scaling that
a private two-game build doesn't need, at the cost of a versioned-protocol
treadmill. With everything compiling together, the seam can change freely
until it's proven against two consumers; deriving Categories in the extraction
step (not the spike) keeps one game from authoring the vocabulary alone.

## 2026-08-02 — Platform play: shell + downloadable WASM game modules, Angband next

**Decision:** vect-hack grows into a multi-engine vector-arcade platform: a
maintained shell (render core/HUD/skins/catalog) downloading versioned WASM
game modules. Angband is the second engine (spike first, before any monorepo
extraction); xNetHack is the cheap catalog add (it rebased onto NetHack 5.0).
The generic vector-CRT drawing layer gets open-sourced separately under MIT;
monetization stays parked behind legal counsel (vect-hack-oab). Spec:
docs/specs/2026-08-02-vect-platform-design.md; research basis:
docs/research/2026-08-02-*.md.

**Why:** Research verified the combination (classic canon × client-side WASM ×
vector identity) is unowned; Angband verdict SMOOTH (4.2.6 already links under
our toolchain; Shelob is an architecture-identical recipe); module separation
is simultaneously the best product and best legal architecture; MIT library
resolves proprietary-shell-vs-copyleft-engines without picking a side.

## 2026-08-01 — Orbital keys rotate with the camera; NumLock is the pad's mode switch

**Decision:** Orbital mode resolves the eight direction keys through the same
gaze-relative resolver as first person — all screen-relative moves, never
turns (the pointer owns orbital turning). Keys are matched by `e.key`, so the
NumLock-off numpad is the movement pad and the NumLock-on numpad types count
prefixes; Clear (keypad 5) eases the bearing back to north-up in both modes.

**Why:** After a drag, keyboard "up" no longer matched screen "up". Matching
`e.key` instead of `e.code` keeps keypad counts reachable (NumLock chooses)
rather than sacrificing them permanently; rotating the vi letters was
rejected because every letter is a live NetHack command.

## 2026-07-31 — Bot player is a WindowPortHandler decorator

**Decision:** The self-playing bot (`?bot`) wraps the active view as a
`WindowPortHandler`: display events forward through, the eight input events
are answered by a pure policy over its own BotModel (which reuses MapModel).
Menus are buffered per window and answered unseen. No LLM; no existing bot
(TAEB/BotHack/autoascend are wrong-language, wrong-interface tty scrapers).
**Why:** The windowport seam is the project's own pattern — one `?bot`
conditional in main.ts, zero coupling elsewhere, fully unit-testable in node.
BotModel doesn't get its status-field layout from `status_enablefield`: this
port wires that windowport slot to the no-op `genl_status_enablefield` (see
`win/shim/winshim.c`), so the shim event never fires. Instead BotModel reads
field indexes straight off the `STATUS_FIELD` constants (`BL_HP`, `BL_HPMAX`,
`BL_HUNGER`) exported at boot — the same source `worker.ts` already uses for
the HUD. Two policy calls were also human-approved deviations from the spec
text rather than oversights: fight ranks above eat when both apply, and a
stuck door gets roughly a dozen anti-stuck attempts before the brain gives up
on it, well past the three-attempt threshold for a plain blocked cell.

## 2026-07-31 — Shim `eval` for get_nhuuid() rather than widen the CSP
**Decision:** src/core/evalShim.ts replaces the worker's global `eval` — before the emscripten glue is imported — with a two-entry table answering the exact scripts NetHack's `get_nhuuid()` runs (`sys/libnh/libnhmain.c:818`), and throws on anything else. The site keeps `script-src 'self' 'wasm-unsafe-eval'`; `'unsafe-eval'` was not added.
**Why:** The glue implements `emscripten_run_script_int/_string` as `eval(UTF8ToString(ptr))`. Under the live CSP that throws inside a wasm import, Asyncify swallows the throw, and the engine suspends forever: character creation completed and the game then hung at newgame with no output and no console error — the launch blocker on vecthack.com, reproduced with byte-identical dist served with and without the header (stuck right after `shim_destroy_nhwindow`; with the shim the same build renders a level and walks). `'unsafe-eval'` would blow an XSS hole across the whole site to serve two compile-time string constants. The shim also fails loudly: if upstream ever evals something new, a test breaks instead of the tab silently hanging again. Pinned by scripts/test/eval-shim.test.ts (vect-hack-efb).

## 2026-07-31 — Fixed: multi-pick PICK_ANY menus (pickup/drop) crashed the tab
**Decision:** `writeMenuPicks` (src/core/wasmAbi.ts) now writes NetHack's `menu_item` array at a 16-byte stride — `item` (8B, zeroed high half), `count` at offset 8, `itemflags` at offset 12 — instead of the old 12-byte stride.
**Why:** `anything` (include/wintype.h) is 8 bytes on wasm32 because of its `a_int64`/`a_uint64` members, confirmed by compiling `sizeof`/`offsetof` through the project's own emcc. The old 12-byte stride under-allocated and misaligned every entry past the first, corrupting wasm memory — reproduced live via a scripted Playwright run (`D`, select 2+ items, Enter) as a hard tab crash ("Target crashed"), matching the "menu hides but controls don't activate" bug report. A single pick happened to read a few garbage bytes past the buffer without visibly failing, which is why it went unnoticed. No prior test exercised more than one pick against the real wasm ABI; scripts/test/wasm-abi.test.ts now pins the byte layout directly.

## 2026-07-31 — Opaque walls are a colourless depth mask; skins own every colour
**Decision:** Wall opacity comes from fill quads with `colorWrite: false` plus,
for partial opacity, a second depthTest-free line pass whose additive alphas
split exactly (main x opacity, ghost x 1−opacity). All colour/theme values live
in src/skins/*.json — code and index.html hold no colour literals; the vendored
quadrascan token file remains the physics base that skins override.
**Why:** The additive stroke stack writes no depth, so occlusion had to be new
geometry; making it invisible keeps the vector look intact and the split trick
makes translucency exact rather than approximate. One authoritative skin file
means a new look (low-vision, translucent) is data, not code.

## 2026-07-30 — Stand-on menu detects loot by message, not by glyph stash

**Decision:** Clicking the hero's own `@` opens a stand-on menu (Pick up, Look
here, stairs rows off a one-cell `MapModel.under` terrain stash); stepping
onto an item auto-opens the same menu in a pass-through mode where any key
dismisses and acts. Loot detection matches the engine's "You see here…"
messages rather than stashing the covered glyph.

**Why:** The `@` overwrites its cell, and a glyph stash goes stale silently
when items are dropped or created under the hero — the engine's own
announcement can't. Terrain (for the stairs rows) is the reverse: it was seen
before the hero stepped on and cannot change underfoot, so the stash is
reliable there. Pass-through keeps the unasked-for menu from ever costing a
keystroke; player-opened menus stay modal. Bead vect-hack-0m1.

## 2026-07-30 — Alt folds to Meta on the command path only; Cmd always drops (vect-hack-cio)

**Decision:** `keyCode()` turns Alt+printable into NetHack's Meta byte
(`M(c) = 0x80 | c`, keys.ts `meta()`) — but only while `prompting === 0`;
during a prompt the keystroke is dropped entirely. Cmd (`metaKey`) printables
are always dropped, never folded and never delivered bare.

**Why:** Before this, Alt+c (chat) silently executed bare `c` (close) — a
*different* command with no signal of the miss. The prompt gate exists because
yn_function's no-choices path and message_menu hand the raw code back through
the compiled 'c' return converter, which throws over 128 and wedges Asyncify
(the same ceiling as vect-hack-0vd); and answering a prompt with the bare
letter would answer a question the player didn't pose. Cmd is dropped rather
than folded because it rides OS/browser shortcuts the page can't reliably
intercept — the only universally wrong outcome is running the bare letter.

## 2026-07-30 — cancelling the action menu vetoes the paired click (vect-hack-9wt)

**Decision:** When an outside pointerdown closes the action menu, TextHud sets
a one-shot `outsideDismissal` flag; VectorView's canvas click handler
asks-and-clears it (`consumeOutsideDismissal()`) before acting. An unconsumed
flag is cleared by the *next* pointerdown via a `once` capture listener —
registered during dispatch, so it never fires for the dismissing event itself.

**Why:** The menu closes on pointerdown but the browser still delivers that
gesture's click, and primaryAction would run on whatever cell it landed on —
the documented "click elsewhere to cancel" gesture could attack a monster.
Clearing on next-pointerdown (not a timer) means a dismissal whose click never
reached the canvas can't swallow a later, deliberate click, without guessing
at gesture timing.

## 2026-07-30 — DebugView redraws are microtask-only; the rAF loop is gone (vect-hack-r05)

**Decision:** `flush()` no longer re-arms `requestAnimationFrame`; the
microtask scheduled by `scheduleFlush()` is the only redraw path.

**Why:** The tail rAF made every flush entry spawn one more perpetual
per-frame callback — additive, unbounded, and DebugView is the shipped no-GPU
fallback, so long sessions degraded. The rAF loop was vestigial: the
microtask already exists precisely because rAF stalls in hidden panes
(browser-pane quirk), so nothing was lost by deleting it.

## 2026-07-30 — pointer picks test entity volumes before the floor plane (vect-hack-hqo)

**Decision:** `pickCell` tests the pointer ray against a stand-in box per
occupied cell — floor to `glyphTop()` (EntityLayer's hover + cap height + bob
travel), 0.45-cell half-width — nearest hit first, floor plane as fallback.
Monsters and objects only; first person skips the hero's own volume. Pure
math in `src/render/pick.ts` over MapModel occupancy; the line meshes are
still never raycast.

**Why:** Letterforms stand up from the floor, so in the 3/4 view a click on
the glyph the player sees intersected the plane cells *behind* it — the pick
landed on empty floor and the pointer action silently did nothing, reading as
"context menus don't exist". Terrain and effects get no volume: a zap
crossing a cell must not eat a click on the floor past it. The MapModel-only
boundary keeps the picker testable without a GPU and immune to scene-graph
private-geometry coupling (vect-hack-azf's lesson).

## 2026-07-30 — the trap frame self-lights; the glyph and floor still dim (vect-hack-03t)

**Decision:** In `buildTerrain`, the trap case sets the ambient light to 1
before `emitTrap` so the danger frame's four segments render at full
brightness, while the flat glyph keeps the cell's real light and the floor
under it was already drawn dimmed.

**Why:** The frame marks a lethal tile — darkness dimming it defeats its whole
purpose, same reasoning as lava's existing exemption. Frame-only, because a
fully lit trapped tile would read as the one bright floor on a dark level.
This reveals nothing hidden: an undiscovered trap is never sent as a glyph
(`tseen` gating is the engine's), so only traps a tty player would already see
as `^` get the lit frame.

## 2026-07-30 — bones persist by copy-reconcile, not symlink (vect-hack-nvx)

**Decision:** Bones files are reconciled between the FS root and
`/persist/bones` by whole-file copy: volume → root at mount (inside the run
dependency), root → volume inside every `flush()` — the checkpointer's and the
`exit_nhwindows` one, which runs after `savebones()` has committed. The root's
`bon*` set is authoritative during a session; the reconcile deletes stored
bones the root no longer has.

**Why:** `set_bonesfile_name()` builds dynamic names (`bonD0.5`, `bonM0.T`,
`bonQBar.n`) opened straight at the root, so the symlink seam saves and scores
use has nothing fixed to link. `bon*` matches nothing else at the root: every
other dynamic name — level files, `commit_bonesfile()`'s temp `.bn` file — is
built from the lock base `0<plname>`. Deleting consumed bones from the volume
is what keeps a ghost from being met twice (`getbones()` unlinks at load); a
tab killed before the next flush reopens that window, same shape as a crash on
any platform, and the checkpoint cadence keeps it short.

## 2026-07-30 — be3 post-review: blocking overlays click to dismiss; overrides bind camera actions only

**Decision:** A blocking text window (`display_nhwindow`, blocking) now
dismisses on a click anywhere in `#overlay`, with a visible hint line, guarded
to stand down while either menu kind owns the overlay. And `parseOverride`
refuses a keybinding to a pointer-only action (`attack`, `open`, ...):
`ACTIONS` split into `CAMERA_ACTIONS` + `POINTER_ACTIONS`, and only the former
are key-bindable.

**Why:** Half the `☰` command menu (help, discoveries, dungeon overview) ends
in a "press any key" wait the pointer had no way to press — the last
keyboard-only dead end in the be3 surface. And `resolve()` never answers a
pointer action for a key, so an override like `{"Ctrl+F2": "attack"}` loaded
cleanly and then did nothing; the validator's whole premise is that nothing
dead loads without a console report. Same pass also hardened the action menu's
deferred outside-click registration against a close() racing it, and scoped
the message-collapse reset to `NHW_MESSAGE` clears only.

## 2026-07-29 — Stand-on verbs go in a command menu, not on the pointer

**Decision:** be3.7's "pointer targets beyond monsters and doors" became two
separate things: five more adjacent-cell verbs (close, search, untrap, a wider
kick, and open as a left-click primary), and a `☰` command menu holding every
no-target command. The items, stairs, fountains and altars the bead named are
in the menu, not on the map.

**Why:** They cannot be on the map. Pick up, quaff and the stairs are stand-on
verbs in NetHack — the hero must already be on the cell — so reaching one by
pointer would mean walking there, which be3.2 declined. And the hero's own
cell draws as `@`: `MapModel` holds one glyph per cell, so a hero-cell menu
could not see the stairs it would be offering. The bead's own review note
about moving `applicableActions`' `dir === null` gate into the rows falls away
with it: every surviving cell verb is adjacency-relative, so the single gate
is still right, and `MENU_TABLE` now carries a comment saying when it stops
being.

## 2026-07-29 — yn_function answers are clickable

**Decision:** `yn_function` renders each of its fixed choices as a clickable
chip in `#prompt`, plus an `esc` chip that feeds a real ESC. Empty-choices
prompts, `getdir()` among them, render none.

**Why:** Half the command menu's rows end in a confirmation, so a menu built
to need no letters dead-ended on a typed `y`. The `esc` chip feeds ESC rather
than an answer of its own so `ynFunction`'s escape rule stays in one place.
`getdir()` is excluded because be3.6 already answers it, better, with the
direction the camera is looking.

## 2026-07-29 — getdir()'s direction prompt is told apart from other empty-choices prompts by text, not shape

**Decision:** `TextHud`'s `prompting` gate (which turns `remap` off during any `yn_function`/`message_menu`, so a remapped arrow can't misanswer "Really quit?") now has one narrower exception: `isDirectionPrompt(query, choices)` reopens it for exactly getdir()'s prompt, so first-person's gaze-relative arrows can answer "In what direction?" the way a keyboard player answers it with hjklyubn. The discriminator is `choices === "" && /direction/i.test(query)` — empty choices alone isn't enough, since a dozen other `yn_function` callers (`invent.c`, `spell.c`, `detect.c`, `pager.c`, `quest.c`, `role.c`) also pass NULL `resp`, and `def` doesn't help either since several of those also pass `'\0'`. Every getdir() call site's query the port is likely to show — the compiled-in default and every custom string a caller substitutes (`dig.c`, `sounds.c`, `pickup.c`, `wizcmds.c`) — contains "direction", with one exception: `lock.c`'s pit-trapped `#open` ("Open where? [.>]", shown only when stuck in a pit over a container) doesn't, and its choices are still empty like every other getdir() call (`get_adjacent_loc()` always passes the prompt straight through as `yn_function`'s query with `choices` NULL). `isDirectionPrompt` returning false for it is harmless rather than exhaustive: the ordinary gate stays up, so a raw keypress — KEYMAP's arrow-to-hjkl mapping included — still answers it; the only loss is gaze-relative arrows for this one obscure prompt. Grepping the rest of `external/NetHack/src` for other empty-choices callers whose query contains "direction" still turns up none, so text remains the right discriminator — it just isn't exhaustive over every getdir() site the way the first pass assumed.

**Why:** The ShimEvent getdir() produces (`{name:"yn_function", choices:"", def:0}`) is genuinely indistinguishable by shape from several unrelated prompts, so the brief anticipated text matching might be necessary — it was. Reopening the gate stays safe by the same argument the old gate's comment made for a different reason: every `Action` `remap` can produce from a keyboard chord is validated against `ACTIONS` (`keyBindings.ts`), and `resolve()` only ever answers a movement action with a plain ASCII direction letter or a "turn" that feeds nothing at all — never a value the `yn_function` return path's `char` cast can choke on. `scripts/test/remap.test.ts` pins both the default and a custom getdir query, a same-shape false positive (`detect.c`'s "What do you look for?"), the mode-decline fallthrough, and the gate closing again once the prompt is answered. Not runtime-verified in this environment (no GPU/dev server); flagged for a browser pass.

## 2026-07-29 — Menu quantity control reads the DOM live; it never mirrors into state

**Decision:** be3.4's per-row `<input class="mqty">` (pointer-driven inventory/selection
menus) is the only "current" copy of a row's pending count — `TextHud.onMenuClick` reads
its `.value` at click time rather than syncing it into `MenuState` on every keystroke.
The keyboard's classic digit-prefix-then-letter keeps its own one-shot buffer
(`typedCount`), cleared the moment an accelerator is consumed. Both paths converge on
one `selectItem(idx, count)`, which mirrors NetHack's own `toggle_menu_curr`
(win/tty/wintty.c) exactly: a fresh count > 0 updates an already-selected item without
deselecting it; a bare press/click (no count) toggles; typing "0" is a no-op, never
"select zero".

**Why:** A first pass mirrored the typed quantity into `MenuState.counts` as the user
typed, so one map could serve both input methods. That broke fidelity: re-pressing an
already-selected accelerator with no fresh digits must always deselect in real NetHack,
even though the row still visually shows its old count — a leftover value sitting in a
shared map made that stale count look "freshly typed" to the next keypress. Keeping the
DOM as the single source of truth for the pointer side, and a real one-shot buffer for
the keyboard side, matches what `process_menu_window`/`toggle_menu_curr` actually do
(leading zeros never start a count; a count only sticks after a *fresh* nonzero digit;
`reset_count` fires on every non-digit key) — the reset has to be genuinely
per-keystroke, not "whatever the UI happens to be showing".
`scripts/test/menu.test.ts` pins the deselect-on-bare-repress case directly. Not
runtime-verified in this environment (no GPU/dev server); flagged for a browser pass,
particularly the native `<input type=number>` spinner and its `stopPropagation` gate
against `onKey`'s global command routing.

## 2026-07-29 — Pointer hostility is an approximation; the engine's own attack confirmation is the real backstop

**Decision:** `MapModel.isHostile()` (be3.3's left-click attack table entry) treats any visible monster that isn't the hero and isn't a pet as attackable. NetHack's windowport `glyph_info` (include/wintype.h) carries `MG_*` flags but no peacefulness bit — `mpeaceful` lives on `struct monst` (monst.h) and is never exported to the display layer, by design. The one-click primary action and the pointer's own menu both still exclude pets outright (`MG_PET` is a real, reliable flag); a genuinely peaceful non-tame monster (shopkeeper, guard, quest ally) reads as hostile here and a left click would attack it, same as walking into one blind from the keyboard — NetHack's own attack confirmation (`confirm`/`safe_dog`, both default-on) is what actually stops the hit, not this layer.

**Why:** A true peacefulness bit would mean patching `external/NetHack`, which AGENTS.md rules out — it stays an unmodified upstream submodule. The engine's confirmation prompt is the identical safety net a keyboard player already relies on for the same blind spot, so the gap is real but not a new hazard.

## 2026-07-29 — Pointer "chat" sends Meta-c, not the #chat extended command

**Decision:** be3.3's chat action sends `meta("c")` (`0x80 | 'c'` = 227), chat's compiled-in single key (`src/cmd.c`: `{ M('c'), "chat", ... }`), rather than driving `#chat` through the extended-command prompt.

**Why:** `#chat` answers through an interactive `getlin()` that `TextHud` drives with a real DOM `<input>`, not the plain key queue pointer actions feed into; sequencing that programmatically would be far more fragile than replaying the byte a real Alt+C keypress already produces. `nh_poskey`'s wasm ABI return type is a full `i32` (`winshim.c`'s `DECLCB(int, ..., "i")`), so 227 survives the worker boundary intact — unlike `yn_function`/`message_menu`'s `char`-typed return, which is why those two clamp above 127 and this doesn't. Not runtime-verified in this environment (no browser/GPU); flagged for a browser pass.

## 2026-07-29 — Trap danger framing shares lava's ink and gain on purpose; message collapse substitutes for tty's line/history split

**Decision:** A trap tile draws its ordinary flat glyph plus a danger-red square frame (`INK.trap` = `S.alert`, `TerrainBuilder.emitTrap`), triggered for every glyph `MapModel`'s `terrainKind()` classifies `"trap"` — `^ " ~`, matching upstream `is_cmap_trap()`'s range (real traps, the web, the vibrating square). The frame deliberately reuses lava's gain (`GAIN.trap = GAIN.lava = 1.35`, both "as hot a read as lava"), so shape — a square frame versus lava's raised crest — is what tells the two lethal reads apart, not brightness. Separately, `TextHud.message()` now collapses a repeated *real* message into a running `(xN)` counter in place rather than reprinting it; overwrites an `ATR_NOHISTORY` transient (farlook autodescribe, the `Count: N` echo) in place for as long as the transient streak lasts; and on `clear_nhwindow` of the message window, removes a transient last line's DOM element outright rather than merely forgetting it.

**Why:** A bare trap glyph read identically to any other floor feature at a glance, so a lethal tile was indistinguishable from an engraving until it was too late; giving it lava's own gain rather than a dimmer one keeps "this will kill you" legible at the same intensity, which is exactly why shape has to carry the distinction instead. For messages: tty keeps one message line separate from a scrolling history, and marks farlook/`Count:` `ATR_NOHISTORY` so they only ever occupy that one line, never the history; we have no such split, so overwrite-in-place is the nearest equivalent, and the `(xN)` counter lets a real repeated event collapse visually without silently dropping one from what's on screen. The DOM removal on `clear_nhwindow` exists because `src/cmd.c:5106` clears `WIN_MESSAGE` before every `Count: N` once `cnt > 9` — nulling `lastLine` without removing its element left one stale line behind per digit typed, which is what `scripts/test/message-collapse.test.ts`'s clear_nhwindow cases now pin.

## 2026-07-29 — First-person movement is gaze-relative on the arrow keys

**Decision:** In first-person view the arrow keys resolve against the camera's heading
snapped to NetHack's eight directions; left/right turn 45° for free rather than
strafing. Keys map through two layers — a chord-to-action table meant to become
user-editable, and a pure action-to-command resolver that is not. `TextHud.remap` is
gated by a `prompting` counter so only the `nhgetch` path is ever remapped.

**Why:** WASD would have displaced wield, apply, search and drop, and vect-hack-be3
requires classic keys keep working. The arrows were already movement, so remapping them
costs no command. Splitting the binding table from the compass math makes a rebinding UI
a later data change rather than a rewrite. The `prompting` gate exists because
`yn_function` and `message_menu` block on the same key queue as the command loop
(TextHud.ts:250,274) with no other marker — without it a remapped ArrowUp would answer
"Really quit?" with a k.

## 2026-07-28 — The build verifies Lua itself and pins the compiler (vect-hack-reh)
**Decision:** `build-wasm.sh` no longer calls `make fetch-lua`. It reads `LUA_VERSION` out of NetHack's Makefile, looks the tarball's sha256 up in `external/NetHack/submodules/CHKSUMS`, downloads from the same three mirrors, and refuses to unpack on a mismatch — or on a missing checksum entry, or a missing `sha256sum`. It skips the download entirely once `lib/lua-$V/src/lua.h` exists, and replicates upstream's `rm -f include/nhlua.h` on a fresh fetch. `setup-toolchain.sh` pins `EMSDK_VERSION=6.0.4` and `EMSDK_COMMIT=224ec5f9…`, clones or converges the checkout onto that tag, verifies `rev-parse HEAD` against the commit, and installs/activates the pinned version instead of `latest`.
**Why:** Both holes let something other than the intended bytes into `nethack.wasm`. Upstream's `fetch-Lua` (`Makefile:2226`) computes the hash and discards the answer — the check statement ends in `;`, `tar zxf` runs regardless, and the recipe closes with `true` — so a tampered tarball was compiled in behind a printed warning; the invocation is independently broken (`--ignore-missing` passes on a name mismatch, and `-c FILE < tarball` is not how `sha256sum -c` reads its target). `install latest` meant the compiler was whatever emscripten published that morning, unrecorded, so no build was reproducible. The pin is not a change of toolchain: the already-installed SDK resolved to `sdk-releases-b23272fa…`, which *is* 6.0.4, so the artifact is unaffected. Verified the fetch three ways against a scratch tree — real download passes the real recorded hash, a doctored CHKSUMS entry exits 1 with nothing unpacked, and a second call skips. The commit verification is what stops a retagged upstream, and it is the only thing checking it: moving the pin means checking both values by hand.

## 2026-07-28 — Licensing is MIT AND NGPL, dual-layer (vect-hack-3g2)
**Decision:** Original code is MIT (`LICENSE`); `external/NetHack`, the built core artifacts, and `src/core/recoverSave.ts` are NGPL (`LICENSE.NETHACK`, verbatim from `dat/license`); the distributed app as a whole is subject to NGPL terms. Map in `LICENSING.md`, bundle notices (three.js, Emscripten) in `THIRD_PARTY_NOTICES.md`, `package.json` says `MIT AND NGPL`.
**Why:** `recoverSave.ts` ports `util/recover.c`, making it a derivative under NGPL ¶2b — it can never be MIT, and since it compiles into the app bundle, ¶2b reaches the shipped whole. The core wasm is object-code NetHack (¶3); the public repo at the pinned submodule commit is the corresponding source, which satisfies ¶3a even for commercial hosting (¶3b's archive-pointer option is noncommercial-only). Everything Eric wrote except the recover port stays MIT so the renderer/bridge are reusable without NetHack. `worker.ts` decodes wasm memory from header-derived struct offsets — interface facts, left MIT; any future transliteration of C logic crosses the same line recover.c did.

## 2026-07-28 — The radar sizes its backing store on both dimensions
**Decision:** `Radar.draw()`'s inline backing-store resize became the exported `fitBacking(canvas, size, ratio)`, which compares `width` *and* `height` against the wanted pixel count and returns the context scale.
**Why:** The old guard was `if (canvas.width !== pixels)`, assuming the two always move together. They do — after the first resize. A canvas *starts* at 300 x 150, so a ratio that asks for exactly 300 slipped past the guard and left the default 150 height: `min(240px, 34vmin)` at `devicePixelRatio` 1.25 (a 125% desktop scale, the common Linux/Windows setting) is 300 on the nose. The widget then painted a square radar into a 2:1 store and the browser stretched it back to the square CSS box — twice as tall, cropped at the midline. Measured in real Chromium across ratios 1 / 1.25 / 1.5 / 2: only 1.25 came back `300x150`, and all four are square now. `fitBacking` exists so the regression has a test in `npm test`, which runs without a DOM. `Trail.ts` already checked both dimensions; this was the only other place.

## 2026-07-28 — No GPU is a supported browser, not an error
**Decision:** `src/ui/gpuSupport.ts` probes for a GPU before `main.ts` builds a view: `gpuAvailable()` takes a `GpuProbe` and returns true only if a WebGPU adapter actually arrives or a throwaway canvas yields a WebGL 2 context (`?gl` counts WebGL alone; a throw or rejection is a no). Failing that, the canvas is removed, `DebugView` takes over, and the HUD says so in plain words. Boot went async to hold the one await. `VectorView`'s start-failure branch no longer prints the raw exception either — the error goes to `console.error`, the player gets a sentence and the `?view=debug` hint.
**Why:** VS Code's Simple Browser exposes `navigator.gpu`, refuses every adapter, and offers no WebGL 2 underneath. three then falls back to WebGL, gets `null` from `getContext`, and calls `getSupportedExtensions()` on it — so the player's first message was `[renderer failed to start: TypeError: Cannot read properties of null (reading 'getSupportedExtensions')]` on top of a perfectly healthy restored game. Presence of `navigator.gpu` is therefore not evidence of a GPU, which is the whole reason the probe requests an adapter and the probe is async. Verified both ways in real Chromium against the dev server: `--disable-gpu --disable-webgl --disable-webgl2` now lands in the text view with the notice and zero page errors, while a GPU-capable run still reports `webgpu` (and `webgl` under `?gl`).

## 2026-07-28 — The trail rebuilds its buffers on resize instead of resizing them
**Decision:** `Trail.setSize()` disposes both `TrailBuffer`s and constructs a new pair at the new size (`TrailBuffer` now takes its size in the constructor) rather than calling `RenderTarget.setSize()`.
**Why:** Resizing a live `RenderTarget` left three sampling a stale GPU texture at the old size, and `Line2NodeMaterial` — `transparent`, so it blends against `viewportOpaqueMipTexture()` — copies the framebuffer mid-pass at the *new* size. Every frame after a canvas resize then failed WebGPU validation (`copySize 1280x705 touches outside of Texture 1280x684`), the command buffer went invalid, and the view never recovered: 556 console errors in one `check:browser` run, with the screenshot saturated to 285907 lit pixels. Found by the rewritten checker, then reproduced with no checker code in the loop — boot a character, then toggle `#prompt`'s 21px bar from the outside: 230 errors in four resizes, none after this change. The prompt bar showing or hiding is the app's own most common resize, so this was breaking real games, not just the check.

## 2026-07-28 — check:browser assertions must be able to fail (vect-hack-azf)
**Decision:** `DungeonRenderer` grew a diagnostics group — `backend` (now gated on an `initialized` flag), `frames`, `cameraDrift`, `setBloomEnabled()`, `renderStill()`, plus `DungeonCamera.drift` and `LineBatch.setBloomEnabled()` — and `browser-check.mjs` drives only that, never a private. It answers menus with an accelerator the menu actually renders (`.macc`), tries every direction until the hero moves, closes its browser in a `finally` and records a thrown run as a failure so the other backend still runs. Both glow screenshots are now frozen stills taken past the trail.
**Why:** Every assertion in the old script was decorative. three sets `renderer.backend` in its constructor and only replaces it on the fallback path, so reading it before `init()` resolved always agreed with what was asked for; a blank baseline gave `haloRatio` 0 and a gain of `Infinity`, which passes; a thrown assertion leaked Chromium and skipped the second backend; and `replyTo` only knew `y`/`n`, so a real pick-one menu spun to the 60s deadline and reported the app as stuck. The walk assumed a free room to the east — legitimate map variance, not a bug, was reported as "the hero never moved". The paired stills replace a bloom-off still drawn past the trail against a bloom-on frame drawn through it: on WebGPU the trail ghosts everything that moves, and that halo (which the beam stack never drew) swamped the measurement either way round — through the trail the gain collapsed to 1.0x, past it on one side only it wandered between 1.9x and 4.4x on the same build.

## 2026-07-28 — check:browser whitelists winshim's reentrancy log
**Decision:** `scripts/dev/browser-check.mjs` grew an `EXPECTED_CONSOLE` list and drops `'shim_*' attempting second call to 'local_callback' before 'shim_nh_poskey' has finished` from the console errors it fails on. Nothing in `src/` changed.
**Why:** Autosave makes that nested call deliberately — `worker.ts` reaches `checkpoint.maybe()` from inside `shim_nh_poskey`, and `save_currentstate()` opens with `mark_synch()` (`src/do.c:1355`) — so `reentryMutexLock` (`win/shim/winshim.c:313`), which logs whenever `shimFunctionRunning` is set, fires on every healthy run. The guard cannot distinguish this from the unwinding reentrancy it exists to catch; `answerInPlace()` resolves in place, which is `Asyncify.handleSleep`'s non-unwinding path, so nothing crashes. Evidence that it is the checkpoint and not a real fault: the identical message, naming the same two calls, comes out of `npm run test:autosave` in plain node, and that test then asserts the mirror holds the hero's own level — the exact thing an unwound `save_currentstate()` would have failed to write. Whitelisted in the checker rather than silenced in `winshim.c`, because NetHack stays an unpatched external dependency.

## 2026-07-28 — Two cameras behind one interface, and two answers to "which way is the camera"
**Decision:** `src/render/DungeonCamera.ts` is the seam `DungeonRenderer` draws through; `OrbitCam` and the new `FirstPersonCam` implement it, and `setMode()`/`toggleMode()` swap one for the other (bearing handed over, hero followed, `snap()`, old camera disposed). The interface carries *both* `azimuth` — one heading, which is what the radar wants — and `facingAt(x, y)` — the yaw that turns one glyph toward the camera, which is what the letterforms want; `buildEntities` takes `number | ((x, y) => number)` for its facing and grew a `hideHero` option. First person opens its own projection (68° FOV, near 0.03) at `EYE_HEIGHT` 0.55, and scales the whole bloom stack by `FP_WIDTH_SCALE` 1.3 through the new `LineBatch.setWidthScale()`. **F2** toggles it, from `VectorView`.
**Why:** Branching on a mode inside the renderer would have put the fork in the frame loop, where the atmosphere pass and trail also live; behind an interface the frame code is mode-blind. `azimuth` and `facingAt` are one number from orbit — at radius 14 the look-at angle to any cell is within a few degrees of the bearing, and at the followed cell they are equal, which `first-person.test.ts` pins — and two very different numbers from inside the room, so the split is exactly where the two consumers disagree. Stroke widths are screen-space pixels tuned at orbit distance and do not thicken as the camera closes in, so first person needed a scale; it multiplies each layer from its constructed base (idempotent, `1` restores) rather than forking the layer stack, which would have drifted from the model's §3.2. The hero letterform is skipped in first person because the camera is standing inside it. F2 because `TextHud.keyCode()` translates only its KEYMAP names and single characters — a function key resolves to `null` and can never reach NetHack, while every letter and Ctrl-combination is a game command.

## 2026-07-28 — Phosphor persistence is a ping-pong max() trail, WebGPU only
**Decision:** `src/render/effects/Trail.ts` implements phosphor persistence as the model's *deferred upgrade*, not its shipped form: two HalfFloat render targets, each frame rendered fresh (full clear), then the previous accumulation composited over it at `residual = 2^(-dt/half_life)` under `CustomBlending`/`MaxEquation` — `max(new, prev·decay)` — then blitted and swapped. On the WebGL fallback backend `DungeonRenderer` bypasses the trail entirely and renders direct.
**Why:** The shipped single-FBO fade (fade quad + additive redraw) saturates on vect-hack's content: the dungeon is *static* geometry redrawn at 60fps, so steady state is `draw/fadeAlpha ≈ 26×` draw — check:browser measured halo/core collapsing from 1.52 to 0.40 as everything blew out toward white. `max()` makes a static scene a fixed point (no build-up) while moving glyphs still trail. HalfFloat because 8-bit residues quantize and stick as permanent ~5% ghosts. WebGL is excluded because three 0.185's WebGL fallback has no `MaxEquation` (`equationToGL` maps only Add/Subtract/ReverseSubtract; the call fails with INVALID_ENUM and silently draws under the last bound equation) — losing persistence per tier is exactly the model's §4 degradation table. Side effect: WebGPU's halo/core metric now reads slightly below WebGL's at equal scene size — the MSAA resolve moved from gamma space to linear light, which brightens antialiased edge pixels; accepted as inherent to any float-buffer trail.

## 2026-07-28 — No `three/tsl` imports; node materials only
**Decision:** GPU effect code builds shaders with node material options (`MeshBasicNodeMaterial({ map })`, `.color` as multiplier) and never imports from `three/tsl`.
**Why:** With typescript 7.0.2, even a two-line file importing `texture` from `three/tsl` sends `tsc` past 32 GB RSS without terminating (bisected against a clean tree, which checks in 0.2s). `npm test` gates on the typecheck, so any TSL import bricks the suite. The node materials build the same texture nodes internally.

## 2026-07-28 — Effects physics are ported modules; the map adapter is the only game-aware piece
**Decision:** The atmosphere pass (vect-hack-ojo) lives in `src/render/effects/`: `signal`/`dwell`/`flare`/`arc`/`persistence` are straight ports of the vector-CRT model §2–3 defaulting every number from `TOKENS` (quadrascan.json), pinned by `scripts/test/atmosphere.test.ts`; `lighting.ts` (hero light radius) is vect-hack's own, keyed on **hero world position** through the per-segment `gain` scalar — no camera terms anywhere, so vect-hack-4i4's first-person camera inherits every effect unchanged. `mapFx.ts` is the host adapter ("ports write adapters, not new physics"): it scans the 80×21 grid per frame, fires 1.0 energy when a cell turns into an effect glyph, and feeds light/energy/flares to the builders. Zap glyphs (`- | \ /` in the zap range, now flagged `Cell.zap` by MapModel) render as arc-jittered beams instead of letterforms, with the px-based arc tokens applied through one adapter constant `CELL_PX = 128`. Terrain rebuilds when the hero's cell changes (the light is cellwise), with lava exempt from dimming (self-luminous).
**Why:** Copying token values or physics into the renderer is how ports drift; every formula that could be a pure function is one, and is tested against the spec's own numbers. The energy envelope wants discrete events, and "a cell just became an effect glyph" is the only event stream the windowport actually provides. Cellwise light rebuild costs one terrain build per hero move — the same cost as any terrain change — and avoids per-frame terrain rebuilds or fragile fat-line shader surgery (Line2NodeMaterial computes vertices in clip space, and the TSL route is barred by the entry above).

## 2026-07-28 — The radar is 2D chrome on the render loop, with two distances
**Decision:** `src/ui/hud/Radar.ts` is a `<canvas>` sibling of the WebGPU canvas, painted by `drawRadar()` in CSS pixels — not scene geometry. A blip's ring position is Manhattan (`|dx| + |dy|`, the rim being `RADAR_RANGE`), while its bearing is euclidean. `DungeonRenderer` gained an `onFrame(facing)` hook that `VectorView` wires to `radar.draw()`; the radar repaints only when the map is invalidated or the bearing moves.
**Why:** In the scene graph the radar would have to be billboarded, depth-sorted and unprojected against whatever camera is running, and would still be occluded by a wall; as chrome it is exact and camera-agnostic, which is what vect-hack-4i4's first-person view will need. Manhattan is the number that answers "how many turns until it reaches me" and euclidean is the one that answers "which way do I look" — using either for both makes a diagonal contact lie about one of them. `onFrame` rather than a second `requestAnimationFrame` loop: the bearing only changes inside a frame, and a second loop would paint the radar out of step with the scene it annotates. `scripts/dev/browser-check.mjs` now hides `#radar` before profiling glow — the widget carries its own beam stack, which the renderer's bloom toggle cannot reach, so leaving it in put an identical halo floor in both shots and collapsed the measured gain from 11.2x to 1.4x.

## 2026-07-27 — Rebuild the recovery save in the port, not with the engine's recover_savefile()
**Decision:** `restoreRecoverySet()` now turns a validated mirror into a finished save file itself (`src/core/recoverSave.ts`, a port of `util/recover.c`'s `restore_savefile()`) and leaves nothing at the FS root, so `getlock()` never offers "Recover [r]" and the engine takes its ordinary `restore_saved_game()` → `dorecover()` path. `scripts/build/build-wasm.sh` pins `SUPPORTED_NETHACK=5.0.0` and fails the build if the submodule moves.
**Why:** `recover_savefile()` sets `program_state.in_self_recover` and deliberately leaves it for the caller to clear (`src/files.c:3074`). `sys/unix/unixmain.c:275` and `sys/windows/windmain.c:464` clear it; `sys/libnh/libnhmain.c` — the main the wasm target builds (`cross-pre2.500:396`) — never does. It is the first guard in `save_currentstate()` (`src/do.c:1379`), so after an in-engine recovery every checkpoint silently wrote nothing: autosave died two commands in, the player kept playing against a stale mirror, and a second tab-close rewound them with no warning (then discarded the game on the third). Measured, not inferred — after a `recover_savefile()` restore neither `level.0` nor the hero's level file was touched, while a restore from a real `#save` checkpointed perfectly. A fork was ruled out (NetHack must stay a clean external dependency), and `util/recover.c` exists precisely so something outside the engine can do this, so the port uses a supported seam rather than working around one. Codex, asked for a second opinion, confirmed the diagnosis independently and preferred linking a small project-owned C helper to clear the flag; rejected because injecting our object into NetHack's link couples us harder to their build than the port does.

## 2026-07-27 — Status-line field formats mirrored from botl.c, not taken from the port
**Decision:** `TextHud` carries a `STATUS_FMT` table (BL_* index → printf format) copied from `initblstats[]` (`src/botl.c:703`), and applies `status_enablefield`'s format only if one ever arrives. It also resolves `\GXXXXNNNN` glyph escapes in status text to a literal `$`.
**Why:** `win/shim/winshim.c:251` wires the windowport table to `genl_status_enablefield`, so `shim_status_enablefield` never fires and the port receives no field names or formats — the status line was bare values ("12 12 14 20 8 9 ... 7 7 1 9 11 11"), which misled a playtest into reading power as HP. Patching the submodule would mean introducing patch machinery and a wasm rebuild for a static table. `BL_GOLD` is NetHack's only `\G` producer in the status line and it is always the currency symbol, which is exactly what `invis_goldsym` substitutes.

## 2026-07-27 — Renamed again, vec-hack → vect-hack
**Decision:** Same sweep as the entry below, one step further: `vect-hack` / "VectHack" everywhere — directory, package name, README heading and page title, `[vect-hack]` console prefix, `vect-hack/persist` Web Lock, and the issue-tracker prefix and every ID. The entry below is left describing the first rename as it happened.
**Why:** "vect" reads as vector; "vec" read as a truncation.

## 2026-07-27 — Renamed the project to vec-hack
**Decision:** `nethack-3d` → `vec-hack` everywhere, no compatibility aliases: repo directory, package name, display name "VecHack" (README heading, page title), the `[vec-hack]` console prefix, the `vec-hack/persist` Web Lock, and the issue-tracker prefix (all 20 IDs and their in-text references). Third-party references to JamesIV4/nethack-3d and to NetHack itself are untouched.
**Why:** The name describes the renderer, not "3D NetHack"; keeping legacy aliases would have outlived the reason for them.

## 2026-07-27 — Centralized shared agent instructions
**Decision:** Shared workflow rules moved to ~/.claude/AGENTS.md; this repo's AGENTS.md keeps project specifics only. CLAUDE.md is the @AGENTS.md pointer.
**Why:** 15 repos carried drifting, contradictory copies of the same rules.

## 2026-07-26 — Autosave is NetHack's own crash recovery, switched on
**Decision:** Turn on `SELF_RECOVER` and export `save_currentstate()` (both from `build-wasm.sh`'s `EMCC_CFLAGS`, no submodule patch), call the checkpoint on a command + wall-clock interval from the main-loop key request, mirror the changed level files into `/persist/recover` with a manifest written last, and put a validated set back at the FS root in `preRun` so `getlock()` can rebuild a save. The bridge answers getlock's `Destroy/Recover/Cancel` prompt with `r` itself. Spec: `docs/specs/2026-07-26-autosave-design.md`.
**Why:** `restore.c:928` deletes the save on every restore, so mid-game nothing on disk describes the character; and a save cannot be written at unload, because `visibilitychange` gives no async time and the engine is ASYNCIFY-suspended behind a `postMessage`. Checkpoints therefore have to happen during play, and `dosave0()` cannot supply them — it runs `WRITING | FREEING`, deletes every level file and ends the game. `save_currentstate()` is the non-destructive twin NetHack already calls on level changes, and `recover_savefile()` already rebuilds a save from what it writes; both were simply off. Inventing a snapshot format would have meant owning NetHack's serialization forever. Three things this cost, all invisible when wrong: `MAXPLAYERS` had to leave the sysconf, because any value routes `getlock()` into its `alock`/`block` branch, which has no recovery path at all; the checkpoint's own `mark_synch()` and `getmsghistory()` calls had to be answered by a thenable that resolves in place, or Asyncify unwinds out of the checkpoint and it writes `level.0` but not the current level — a mirror `recover_savefile()` cannot use; and the set must be validated before the engine sees it, since `getlock()` answers a failed recovery with `error()`, which kills the process. Verified by `npm run test:autosave`, including the corrupt-set case.

## 2026-07-26 — One tab owns the save volume, elected by a Web Lock
**Decision:** `persist.ts` takes an exclusive `navigator.locks` lock (`ifAvailable`, held for the tab's lifetime) before mounting IDBFS. Tabs that lose run on a session-only MEMFS filesystem, never mount the volume, and never call `syncfs`; the player is told via a new `notice` message on the worker protocol. `PersistHandle.release()` hands the lock back for in-process teardown (the node tests need it; a browser drops it with the tab).
**Why:** `IDBFS.syncfs(populate=false)` is a whole-volume reconcile — it deletes every IndexedDB entry the local MEMFS lacks — and `autoPersist` runs exactly that after **every write**, not just at `flush()`. Two tabs therefore destroyed each other's saves and the shared top-ten list from the first turn, silently. NetHack's own guard (`getlock()`) can't help, because we deliberately keep lock files in per-tab MEMFS. Election is the smallest fix that matches the engine's one-game-at-a-time model. Verified with two real browser tabs and by `npm run test:tabs`, which fails if the election is removed.

## 2026-07-26 — Storage setup can neither throw nor hang
**Decision:** All of `persist.ts`'s async work runs inside one `try/catch/finally`; the run dependency is released in `finally`, `syncfs` is wrapped in a helper that always settles (10s cap), lock acquisition is capped at 5s, and `persistent` only becomes true after a populate has actually succeeded on a volume this tab owns.
**Why:** Setup holds an emscripten run dependency, so anything thrown before `removeRunDependency` left `main()` uncalled — a black screen with one console error. `flush()` is awaited inside an ASYNCIFY-suspended `exit_nhwindows`, so a `syncfs` that never called back froze game over. Both are reachable: `indexedDB.open` fires `onblocked` whenever another tab holds an older DB version. And `IDBFS.mount()` never opens IndexedDB (`getDB` is first reached from `syncfs`), so a blocked store can only surface asynchronously — the old `catch` around the mount could not see it and reported `persistent: true` in exactly the environments the flag exists to detect.

## 2026-07-26 — "ready" is announced from the first windowport call, not from onRuntimeInitialized
**Decision:** `worker.ts` posts `{type:"ready", constants}` lazily, on the first shim callback, instead of from emscripten's `onRuntimeInitialized`.
**Why:** `libnhmain.c` fills `nethackGlobal.constants` in `js_constants_init()`, which `main()` calls — so at `onRuntimeInitialized` the object is still `{}`. The old timing shipped empty constants, which left `MapModel.off` null: `categorize()` returns `"none"` for every glyph, so `TerrainBuilder`/`EntityLayer` had nothing to build and **the 3D view rendered nothing at all**. It also left `blCondition` at -1, so BL_CONDITION status updates decoded a bitmask pointer as a string. Invisible to every headless test, because those construct `MapModel` and call `configure()` with fabricated constants. `test-wasm-boot.mjs` now pins the ordering fact.

## 2026-07-26 — Renderer verification runs headless Chromium against the real GPU
**Decision:** `npm run check:browser` (`scripts/dev/browser-check.mjs`) drives Playwright's Chromium at a running dev server, answers character creation reactively, walks a few turns, and asserts backend, frame rate, camera follow, and a glow ratio — once for WebGPU and once for `?gl`. Not in `npm test`.
**Why:** The three things the offline preview cannot reach — `WebGPURenderer.init()` picking a backend, the additive beam-bloom stack, and frame rate — all need a GPU. This machine has one, so they are checkable rather than eyeball-only. Two gotchas worth keeping: headless Chromium only exposes `navigator.gpu` on a secure origin *and* behind `--enable-unsafe-webgpu`, and `drawImage()` from a WebGPU canvas outside its frame returns blank, so pixels are measured from the composited screenshot via ImageMagick instead. Glow is measured as dim-pixel/bright-pixel ratio: ~1.6 with the stack, ~0.2 with only the core layer.

## 2026-07-26 — One IDBFS volume at /persist, with the engine's paths symlinked into it
**Decision:** Saves and scores persist through a single IDBFS mount at `/persist` (`autoPersist: true`), with `/save`, `/record`, `/logfile`, `/xlogfile` and `/livelog` created as symlinks into it during `preRun`. The populate sync holds an emscripten run dependency so `main()` cannot start on an empty `/save`. Level lock files and `/perm` stay in MEMFS.
**Why:** The build bakes `HACKDIR="/"` and compiles without `PREFIXES_IN_USE`, so `fqname()` returns bare basenames and every game file is opened at the FS root — next to the embedded read-only data (`/nhdat`, `/symbols`), which rules out mounting IDBFS over `/`. Prefixes can't be redirected at runtime either: `chdirx()` sets them before any JS runs. Symlinks are the one seam that needs no submodule patch. Level files are excluded on purpose — a save bundles every level into itself, so persisting them would just churn IndexedDB on each stair. `autoPersist` gives sync-on-write for free (it wraps `mknod`/`close`/`unlink`/`rename`); `exit_nhwindows` flushes explicitly on top.

## 2026-07-26 — NetHack is driven headlessly in tests instead of waiting for a browser
**Decision:** `scripts/test/test-save-restore.mjs` answers the windowport itself — character creation menus, `#save`, extcmd lookup — and asserts the second boot restores the same character. fake-indexeddb supplies the IndexedDB node lacks.
**Why:** Save/restore is the one acceptance criterion that looked like it needed a browser, and it runs in 0.3s without one. The driver doubles as a check on shim decoding: a menu or `get_ext_cmd` regression stalls the session instead of silently passing. Note the top-ten list is verified at the filesystem level rather than by playing to a score — stock NetHack drops sub-`sysopt.pointsmin` games, so a turn-1 quit is never recorded.

## 2026-07-26 — One Three.js entry point (`three/webgpu`), fat lines from the WebGPU addon
**Decision:** Every renderer module imports from `three/webgpu` (never bare `three`), and strokes use `three/addons/lines/webgpu/LineSegments2.js` with `Line2NodeMaterial`. `WebGPURenderer` falls back to its WebGL backend by itself, so there is one code path, not two.
**Why:** The classic `LineMaterial` is a `ShaderMaterial` and cannot render under `WebGPURenderer`; picking the WebGPU line addon is what makes the single-path fallback possible. Both bundles import the same `three.core.js`, so mixing entry points would not duplicate classes — but keeping to one avoids ever having to reason about it. Types come from `@types/three` (three itself ships none).

## 2026-07-26 — Glyph category from the glyph number, terrain kind from the tty character
**Decision:** `MapModel` classifies a cell as terrain/object/monster/effect using the `GLYPH_*_OFF` offsets `libnhmain.c` exports, then picks the specific terrain kind (wall, floor, door, stairs...) from `ttychar`. Open doors are told from walls by NetHack's brown tint.
**Why:** NetHack 5.0 exports only the coarse offsets; the per-symbol cmap boundaries (`GLYPH_CMAP_MAIN_OFF` and friends) are not in `js_constants_init`. The coarse offsets already remove every dangerous ambiguity — a wand and a wall both draw as `-`, and only the glyph number separates them. Within terrain the character is unambiguous enough, and the tint heuristic covers the one case it is not.

## 2026-07-26 — Glyphs sway toward the camera and hover, rather than spinning freely
**Decision:** Entity letterforms yaw to the camera's bearing plus a slow sine sway, float `HOVER` above the floor, and bob on a second sine. Free continuous rotation was tried and dropped.
**Why:** A freely spinning letter is edge-on half the time, and the map has to stay readable — that is an acceptance criterion, not a preference. Sway keeps the 3D motion while never hiding the glyph. Hover plus bob gives the drifting, weightless quality of the arcade originals; the floor ring under the hero and pets keeps the true cell unambiguous.

## 2026-07-26 — Offline software preview instead of a browser for renderer verification
**Decision:** `npm run preview` runs the real geometry builders and the real `OrbitCam` through a software rasterizer (`scripts/dev/scene-preview.test.ts`) and writes a PPM/PNG. It asserts the follow camera centres the hero.
**Why:** There is no browser automation in this environment, and "does the dungeon look right" cannot be answered by unit tests. Everything except the GPU material — grid layout, wall geometry, letterforms, camera framing — is pure math and can be checked from a terminal. Cheap to keep, and it will carry the atmosphere and controls work too.

## 2026-07-26 — quadrascan.json is vendored into src/render/
**Decision:** `src/render/quadrascan.json` holds the vector-CRT token values, imported directly.
**Why:** Keeps the numbers in one place and preserves the adapter rule — we map onto the tokens (`beamLayers()` is model §3.2 verbatim), we do not restate the physics.

## 2026-07-26 — Windowport state that ports own is set from JS, not by patching winshim.c
**Decision:** Where NetHack expects the windowport itself to maintain core state (`iflags.window_inited`, `svp.plname`), our JS bridge writes it through the globals `libnhmain.c` exposes on `nethackGlobal.globals`, rather than patching `win/shim/winshim.c`.
**Why:** Keeps `external/NetHack` an unmodified upstream submodule, so it stays trivially rebasable on the 5.0 branch. libnh already exports exactly these globals for this purpose. Concretely: without setting `window_inited`, `really_done()` skips `exit_nhwindows()` and dumps the score list to `raw_print`, so the client never learns the game ended.

## 2026-07-25 — Track NetHack-5.0 branch tip, not the 5.0.0 release tag
**Decision:** The `external/NetHack` submodule pins the tip of upstream's `NetHack-5.0` maintenance branch rather than `NetHack-5.0.0_Release`.
**Why:** The release tag's WASM target has build bugs (`-Werror` vs newer clang in files.c; duplicate `after_opt_showpaths` in libnhmain.c) that upstream fixed on the branch the day after release. The branch is the devteam's stable maintenance line and where CROSS_TO_WASM fixes land.

## 2026-07-25 — Visual style: Star Wars arcade vector graphics
**Decision:** The renderer targets the Atari color-vector (Quadrascan/AVG) look — glowing stroked letterforms and wireframe-outlined geometry on a black void, additive compositing, bloom/persistence/flare/arc effects. Physics constants live in `tokens/quadrascan.json`; we write a Three.js adapter, not new physics. Beads vect-hack-fdp / vect-hack-ojo.
**Why:** Eric's stated aesthetic; an earlier proof of concept already researched and locked the hard calls (AVG not DVG, triangulated strokes never GL_LINES, seconds-based frame-rate-independent physics). Starting point, not final: shaded/filled glyph treatments may be layered in later; the vector look is the base the design iterates from.

## 2026-07-25 — Camera: orbital 3/4 primary, first-person toggle later
**Decision:** Orbital tilted-overhead camera following `@` (rotate/zoom) is the primary view; a switchable first-person mode is planned but deferred until orbital is solid.
**Why:** Orbital preserves NetHack's tactical readability; first-person fights the turn-based information model and doubles renderer/control work up front.

## 2026-07-25 — Greenfield, not a fork of JamesIV4/nethack-3d
**Decision:** Build our own client with our own design vision; use the existing JamesIV4/nethack-3d project only as prior art to study (windowport bridge, glyph handling pitfalls).
**Why:** Full ownership of architecture and aesthetic. Forking would inherit their React/Zustand stack and design decisions.

## 2026-07-25 — Engine: official NetHack 5.0 C core compiled to WASM
**Decision:** Compile the official NetHack 5.0.0 source (upstream supports `CROSS_TO_WASM=1` / `libnh`) with Emscripten, run it in a Web Worker, and implement the presentation as a NetHack windowport bridge. Front end is TypeScript + Three.js (r185+, WebGPURenderer with WebGL fallback). No reimplementation of game logic.
**Why:** Faithful port by construction — real game logic, AI, RNG. Upstream already maintains the WASM cross-compile target. Rules out reimplementation (fidelity risk, enormous scope) and native engines (web-first goal).

# Render gates and offline previews

Demoted from `AGENTS.md` (vect-hack-2dr): the reasoning behind
`npm run preview`, `check:browser`, `check:controls`, `check:angband-borg`,
`check:touch`, `check:payload` and `check:gates`. AGENTS.md keeps the command
names and the invariants; this file keeps what each gate asserts, what it
deliberately does NOT assert, and why.

The one-line invariants AGENTS.md still states:

- `check:gates` starts and stops its own dev server on 5199; the individual
  gates need one already running.
- `check:browser`, `check:controls`, `check:touch` and `check:angband-borg`
  need a GPU and a render node. `check:payload` needs neither.
- None of them is part of `npm test`.
- A gate drives only public diagnostics accessors: an assertion that cannot
  fail is worse than no assertion.

## The offline previews

`npm run preview` writes `.preview/nethack-scene.png` and `.preview/nethack-scene-fp.png` by
running the real geometry builders and both cameras through a software
rasterizer, and `.preview/radar.png` by running the real `drawRadar()` into an
SVG-emitting 2D context — use them to check renderer and HUD changes when no
browser is available. It writes `.preview/angband-scene.png` and
`angband-scene-fp.png` the same way from a packed record batch through
`AngbandClassifier`, which is also where the terrain underlay is pinned: an
occupied floor keeps its own faint floor edges, and the same fixture with the
underlay stripped outlines those tiles as holes. Larn and Moria emit matching
orbital/first-person PPM and PNG pairs through their own classifiers; Moria's
fixture enters through the sanitized seven-word public record ABI. All approximate: the beam-bloom
stack and additive compositing only exist on the GPU.

## `npm run check:browser`

`npm run check:browser` is the GPU counterpart: it drives real Chromium through
character creation and a walk for each vector Module on each backend, every
direction in turn until the hero actually moves, since which way is open depends
on where they spawned — then reports the backend the renderer chose, the frame rate,
whether the camera settled on the hero, and how much halo the bloom stack itself
adds per bare-core pixel. That last number is a difference between the two shots,
not a ratio of their halo/core ratios: a scene can be full of faint strokes that
were never bloom (Angband's town fills the frame with distant floor grid), and a
ratio reads those as "bloom added nothing". Recent runs land roughly 1.1–1.8
depending on scene size; the floor is 0.5. Both glow shots are frozen stills drawn past the
phosphor trail, so the pair differs by the bloom stack and nothing else — its ghost
of every moving glyph reads as halo the beam stack never drew. It drives only
`DungeonRenderer`'s diagnostics accessors, never a private: an assertion that
cannot fail is worse than no assertion (vect-hack-azf).

### The two degrade arms

Two of the ten arms are not about a Module at all but about the degrade policy
in `src/ui/` (vect-hack-4d0). `nethack-fallback` denies WebGPU at the Chromium
switch — not with `?gl`, which forces the backend and never runs the probe —
and asserts `gpuAvailable()` CHOSE WebGL. `nethack-nogpu` denies both APIs and
asserts the text view is a playable surface: canvas removed, `GPU_UNAVAILABLE_NOTICE`
on screen, unclipped, >=10px and >=4.5:1 contrast, and a hero that walked. Both
also assert the denial itself landed, because an arm that only checks what the
page did would pass on a browser that denied nothing.

Screenshots land in `.preview/`. It is not part of `npm test` — it needs a GPU
and a running dev server.

## `npm run check:controls`

`npm run check:controls` boots a character the same way and drives the
first-person scheme against the live engine: forward walks the cell the camera
is looking at, a turn sends the engine nothing, and a prompt never sees a
remapped arrow. The unit tests pin those rules in isolation; this one catches
the composition, where a sign error in the yaw convention would otherwise hide.
It counts windowport events rather than reading a turn counter — NetHack's
`time` option is off by default, so there is no `T:` on the status line and
watching it would be an assertion that cannot fail. It also proves the orbital
scheme: direction keys follow the dragged bearing, and Clear (keypad 5)
resets it to north-up. It then does the same for Angband, where the gaze
arithmetic is shared but the key encoding is not: forward must arrive as the
keypad digit the camera faces, shift must carry run, and a menu must get the
arrow unremapped — read from the keys the view actually handed the engine. Camera
actions are armed only while a command request is pending, so the script waits
for the engine to go quiet before each observed press; without that wait it is
racing the engine, not testing it. The same run fires a real projection through
wizard mode ("Perform an effect", SPHERE — centred on the player, so it needs no
target) and asserts the blast survives to a drawn frame and is then cleared by
the engine's own repaint. Moria is paced by the engine's parked input request:
the gate records the exact consumed byte/context, proves original-mode run is
`.` plus a literal direction, and proves a nested direction prompt receives no
camera-remapped arrow. Larn's leg (same shared adapter, vi-byte
encoding, `__wrap_yylex` command seam) records the `cmd` discriminator beside
every consumed byte, and its prompt check is a PAIR: Larn is the only Module
where both answers are legal bytes, so the gate presses ArrowUp twice at one
off-north heading — once inside `qshowstr()`'s `more()` pager, once at the
next command — and asserts 'k' then the gazed letter. Either half alone would
pass on a build that never armed gaze at all. It also declines doorways:
Larn's home level is a town, and home, the bank, the school, the stores, the
entrance and the shaft each answer a step with a `ttgetch()` prompt, so where
a walk happens to land must not decide whether the run passes (every such
loop takes ESC; `more()` takes only a space). Same requirements as
`check:browser`: a GPU and a dev server on 5199.

Every arm waits for a readiness CONDITION before an observed press, never for a
fixed interval, and each Module spells that condition in its own terms: Angband
polls for event quiescence (`angbandQuiet`), Moria for its exact parked native
request (`moriaPending`), Larn for the `__wrap_yylex` discriminator, and NetHack
— which has no `nextKey` seam to wrap, being fed from a `document` keydown
listener — for a parked command read (`nethackReady`: TextHud's own `KeyQueue`
waiter set, an empty buffer, and `pendingInput === "none"`, the one state
`remap` is consulted in). Quiescence alone would not have done for NetHack: a
`yn_function` is a wait too, and an arrow there is a plain `h`.

The NetHack arm slept 200 ms instead of asking, until vect-hack-hfa, and went
red about one run in eight — a mode message the engine had already overwritten,
and an ArrowLeft spent on whatever was still in the way. With the engine
provably parked *before* each press, nothing has to be waited for *after* one:
F2, a turn and a drag all commit synchronously, because `DungeonCamera.heading`
is the committed target rather than the eased angle. The four arms are functions
run from one `try/finally` (vect-hack-8r0), the structure `browser-check.mjs`
has had since vect-hack-azf: a section that throws fails its own Module as a
counted check, closes the browser, and lets the other three still run. Before
it, an exception in the first arm skipped the other three and reported no tally
at all.

The Angband arm fires the wizard-mode SPHERE **twice**: once at the default
`delay_factor`, where the assertion is that effect Cells reached the grid,
survived to a drawn frame, and were then cleared by the engine's own repaint;
and once with `delay_factor` **0**, read back from the engine so the arm cannot
pass by having quietly run at the default. That second arm asserts frames that
DREW an effect the grid did not hold (`DungeonRenderer.drawnEffects`), because
the grid-sampled measurement is zero there by construction — and it prints both
numbers side by side, so one run is its own before and after (measured on
landing: `grid-sampled frames 0 (peak 0 Cells), drawn-from-residue frames 15
(peak 21 glyphs)`). A lingering effect *Cell* is still a failure: the lifetime
lives on the event, not on the grid (vect-hack-auo).

The Angband section's last block is not the full-sweep proof its name used to
promise. Detection in town finds nothing, so the `EVENT_ITEMLIST` ->
`dirty_fallback` path never arms there, and `on_map`'s whole-map payload sets
`dirty_all` on its own in every path that does. The block asserts that the
command reached the engine and that the sweep kept what was known, and prints
the batch size as evidence rather than asserting it (vect-hack-8r0).

## `npm run check:angband-borg`

`npm run check:angband-borg` is the sustained half of the merge gate: it boots
`?game=angband&borg` and samples for ten minutes (`BORG_GATE_MS` overrides),
reporting frame rate p50/p05, map batches/sec, full sweeps/sec, terrain
rebuilds/sec, the largest grid batch in words, hero moves and new-level displays
(`EVENT_NEW_LEVEL_DISPLAY`, which a stair-scumming borg racks up a couple a
second — it is not dungeon depth). It fails on a fatal notice, a page error, an
average below 30fps, a borg that never moved, or **30s without map traffic —
unconditionally**. It measures the CLIENT under unattended play, and a borg
whose character dies is Angband working correctly, so the gate watches for the
engine's own end-of-game messages (`END_TELLS` — "You die." from take_hit,
enter_score's score line, the win) and **stops sampling** at the first one,
judging the run over the window actually played. Note the mechanism: the stall
check is unconditional, and post-death silence simply has almost no time to
accumulate — the loop breaks one sample after the end, so at most one second of
quiet is counted, NOT because the check is excused for a run that ended. A
>=30s freeze during live play stays fatal even if the borg dies later
(vect-hack-zt7). The one assertion
that IS scoped to a run with no end is `the engine stopped`, since an engine
exiting after a finished game is correct. To keep the gate able to fail at all,
an end inside `MIN_PLAY_MS` (120s: 60s of unmeasured warm-up plus 60
one-second samples, so the p05 means something) is itself a failure — otherwise
every red run could be excused by "the borg died". It does not instrument the key protocol: under
`?borg` the decorator answers the engine itself and never calls the view's
`nextKey`, so a counter there would read zero however broken things were — an
unanswered request shows up here as the stall instead.

## `npm run check:gates`

`npm run check:gates` is the one a human should have to remember: it runs
check:payload, check:browser, check:controls, check:touch and
check:angband-borg in sequence,
starting `npm run dev -- --port 5199 --strictPort` in its own process group and
killing that group on every exit path
including Ctrl-C, and reusing rather than killing a server already answering
there. `--only browser,controls` re-runs a subset; `BORG_GATE_MS` and `NH_URL`
pass through, and an `NH_URL` the caller chose is theirs — the runner then
manages nothing. The full set costs ~12.0 minutes measured (payload 28s, browser 62s,
controls 22s, touch 9s, borg 600s), and much less whenever the borg dies early,
because that gate stops at the end of the game. The borg gate is the one that
goes red most often, on its own merits rather than by confusion: a character
that dies inside `MIN_PLAY_MS` fails the run honestly, and the paragraph above
says why. `check:touch` is the fourth gate (vect-hack-hnw): it is third in the
sequence rather than last because 9s of deterministic phone checks should land
before ten minutes of unattended borg play, not behind it. `check:payload` is the fifth gate and the only one of a
different kind (vect-hack-qv1): it needs neither a GPU nor a server, because it
runs its own `vite build` and `vite preview`. That is a property of the ROW —
`standalone: true` in `GATES` — rather than a second runner, so it keeps
`--only`, the artifact and the notification policy every other gate has. It
runs **first**, before the preflight, which is the whole point: on a machine
with no reachable render node it is the one gate that still answers, so a
logged-out nightly reports a real payload result beside its "could not run"
instead of exit 3 for everything. `--only payload` runs there too, and `--only
browser` starts no 28-second production build. The preflight and the server are
asked for only when a hosted gate is in the run.

### Verdicts, the artifact, and the nightly timer

It has three verdicts, not two: green (0), red (1), and **could
not run (3)** — no readable `/dev/dri/renderD*`, no Chromium, no WebGPU/WebGL2,
or no server. That third one exists because logind grants render-node access as
a seat ACL to the active session, so a logged-out machine cannot run these at
all, and calling that red is a false alarm. A run can now be both, and the
order is settled: **a gate that RAN and failed outranks a preflight nothing
could have satisfied**, so a payload regression found on a logged-out machine
is exit 1, not exit 3. It needs no display: every gate is headless. Every run leaves `~/.local/state/vect-hack/gates/<stamp>/` (per-gate
logs, `summary.json`, the gates' own three JSON reports; last 20 kept), outside the
repo because §5 of `docs/RELEASE-CHECKLIST.md` needs a clean tree. `--stamp`
rewrites that checklist's `Last verified green:` date, and only a human passes
it: it refuses a red run, refuses a `--only` subset, refuses a run driven
against a foreign `NH_URL`, and — since vect-hack-r1s — **refuses when the
"Last verified green" sentence does not name a gate the run drove**, printing
which one. The date it writes cannot rot; the gate list beside it is a human's
and rotted inside a day, so the stamp now verifies that prose instead of
trusting it. What it cannot see is a stale COUNT — "85 checks" becoming 90
leaves every gate mentioned and the line still wrong. Only option B in that
bead closes that, and B was judged not worth agreeing a coverage schema four
differently shaped gates could fill honestly. The nightly 03:30 timer
(`scripts/dev/vect-hack-gates.{service,timer}`,
`scripts/dev/install-gate-timer.sh`, installed from the primary checkout) runs
without it. It notifies on a red run, but **only for `browser` or `controls`**
— a deliberate two-gate list, not the gates that happened to exist first
(`NOTIFYING_GATES`). A borg failure is logged and never pushed, because that
gate watches a ten-minute unattended session whose outcome is partly luck; a
touch failure is logged and never pushed for a different reason — the touch
scheme is a spike with `vect-hack-21k` and `vect-hack-lxd` still open against
it, and a gate on churning code goes red for expected reasons, which is what
teaches an eye to dismiss the notification that matters. And a payload failure
is logged and never pushed for a third: it is deterministic AND it watches
settled code, so neither excuse applies — it is out on **consequence**, because
a chunk leak makes the download bigger and nobody is unable to play
(vect-hack-qv1). The channel means "the desktop client will not render or will
not steer". All three still print, all three still reach `summary.json` and
their own log, and all three still set the exit code.

## `npm run check:touch`

This command first runs `npm run check:overlay`: a CPU-only Chromium layout
regression that needs no server or engine. It loads the shipped HTML/CSS and skin,
checks full terminal and short-menu centering at desktop and phone sizes, checks
viewport bounds and real horizontal/vertical scrolling, and verifies that the
explicit touch anchor keeps its panel on screen above the action bar. The
960x360 tall-content sample checks clipping and scrolling, not prompt clearance:
viewport centering can still overlap the chrome in a very short window.
The check fails with the old fixed top offset or a missing touch transform
override. It is not part of `npm test`, which needs no browser.

`npm run check:touch` drives the `?touch` scheme in real Chromium at 390x844
and fails if the page ever receives a keyboard event. What that scheme builds,
and why a URL without the flag builds none of it, is in `docs/UI.md`.

It also carries the one phone assertion that is not about the touch scheme
(vect-hack-0a4): at 390x844, **no Module may widen the layout viewport**.
`#overlay` is 80 columns of `white-space: pre` monospace — a 708px box whose
containing block is the initial one — so before the fix it grew the layout
viewport to 549 on Larn, Angband and Moria, and `#nokeyboard`, though correctly
`position: fixed`, is fixed to the LAYOUT viewport and so centred its demo
button and its dismiss link past the right edge of a 390px phone. The overlay
is capped with `box-sizing: border-box` and `max-width: calc(100vw - 24px)` and
scrolls inside its own box; `box-sizing` is part of the constraint and not
tidying, because a content-box cap of `100vw - 24px` is a 400px element once
the padding and border are added.

The assertion is three things together and each half is load bearing: the
width, AND that the notice's two controls are on screen, AND that the overlay
is actually up on the three Modules that open with one. The width alone would
go green on a page that stopped drawing the notice; the notice's own box alone
would go green at 549 the day something else widened the document; and a Module
with no overlay up is measuring nothing. NetHack passes on both sides of the
fix, which is exactly why it escaped the bug, so the gate prints that rather
than asserting it. Cost: the gate went from ~9s to ~26s, and it now boots all
four Modules rather than NetHack alone.

Its last-but-one section is the half of vect-hack-lxd that is not about the
touch scheme at all: the camera framing, and the pinch that changes it. Three
pass marks, written down before the first post-change run — the opening view
frames at least 16 of the map's 80 columns, two fingers drawn together leave at
least 1.2x that, and two fingers spread apart leave fewer than both, because a
zoom that only goes one way is not a zoom. It drives a real two-finger gesture
through CDP (`Input.dispatchTouchEvent`), since Playwright's touchscreen can
only tap, and it measures through `pickCell` — the renderer's own inverse
mapping, the same measure `preview:mobile` prints — rather than reading a
private radius.

## `npm run check:payload`

`npm run check:payload` is the acceptance test for per-game payload
(vect-hack-l11): it builds, serves `dist/`, loads each `?game=<M>` in headless
Chromium with the cache disabled, and **fails if any fetched chunk carries
another Module's source**. Attribution is the bundler's own record of each
chunk's module ids, read in a rolldown `generateBundle` hook — not a string
search of minified output, which is a guess about what minification keeps. It
also fails if three.js lands in more than one chunk, which is what a split that
copies the shared render layer per Module looks like. It reports cold-cache
transferred bytes and a time-to-interactive median per Module to
`.preview/payload.json` (`VH_PAYLOAD_OUT` moves it), neither of them gated —
localhost timings say little about a real connection.
Note what the rule is NOT: "does this chunk include the Module being played?"
is an assertion that cannot fail, because the pre-split build's one chunk
included all four, and it passed its own acceptance test.
The measured win was 5.7%, not the large fraction l11's description implied:
all four Modules' JavaScript together is 84.5 kB against 839.6 kB of shared
`three/webgpu` and render layer, so the 918 kB bundle was never mostly other
games (`docs/reports/2026-08-26-per-game-payload.md`). The remaining 840 kB
is `WebGPURenderer` itself, both backends statically imported, and it does not
trim without leaving `three/webgpu`; the line stack adds ~5 kB gzip on top. On
the wire it is ~180 kB brotli. The "transferred" column is what `vite preview`
sent, which is gzip, and only the page's own fetches: a worker's requests sit
on the worker's timeline, so the worker chunk and the engine glue go uncounted.
The `gzip` and `brotli` columns beside it compress the built file behind every
recorded request, page and worker alike, because the live site serves brotli
(vect-hack-8gd7.1; `docs/reports/2026-11-02-three-webgpu-attribution-correction.md`).
A request with no built file behind it — the engine glue wherever the engines
were never built, CI included — adds nothing to either column and is listed as
`not-built` instead.

It has a second arm per Module: the same page in a Chromium launched with
`--disable-3d-apis`, which is what a browser with no GPU sees. It **fails if
that load fetched the three.js chunk** — the acceptance test for vect-hack-po4's
first direction, and the thing that keeps the win from silently regressing.
Measured when it landed: a no-GPU visitor's JavaScript went from 252.4 kB to
28.3 kB transferred on NetHack, and about 224 kB less on all four; the GPU path
moved by under 1 kB, downward, because the vector arm no longer fetches the tty
view either. Each load also records whether the canvas survived, because bytes
alone cannot say which arm a run measured, and a "normal" run that quietly fell
back to the tty view would otherwise report the no-GPU number as the common
case. The extra four loads roughly double the gate: ~75s including its own
`vite build`, against the 28s recorded above.

## CI — `.github/workflows/ci.yml`

`.github/workflows/ci.yml` is the whole of CI, and its name states its limits:
**checks (no engine build, no GPU)**. On every push it runs `npm run typecheck`
and `npm run test:render` in one job and `npm run check:payload` in another, on
Node 24.

It cannot run `npm test`. The four engine groups boot WASM artifacts that are
gitignored build outputs, and producing them needs the pinned emsdk (~1.7 GB
installed) plus four build scripts, against a suite that runs close to thirty
minutes. It cannot run the four render gates either — a GitHub-hosted runner has
no render node, which is exactly the exit-3 "could not run" verdict above. So
nothing in CI is evidence about any engine core, any native shim, or
save/restore, and the workflow's own header comment says so. The naming matters
more than the omission: a check called "tests" that never touches an engine is
the same defect as an assertion that cannot fail.

Two measured facts shape it. `test:render` needs no WASM artifact but DOES need
the engine submodules' SOURCE — `recover-save.test.ts` parses
`external/NetHack/include/global.h` and `moria-checkpoint-strategy.test.ts`
reads `external/umoria/src/game_save.cpp` — so the unit job checks out
`submodules: true` and without it the suite fails with two ENOENTs. The payload
job takes no submodules, because `check:payload` builds `src/` and `src/`
mentions `external/` only in comments; proved by moving all three submodule
trees aside and watching it still pass in 25.5s.

A WASM build job, if it is ever wanted, belongs in a second workflow on
`workflow_dispatch` plus a nightly `schedule`, with `actions/cache` over
`external/emsdk` keyed on the pinned `EMSDK_COMMIT` and the submodule SHAs.

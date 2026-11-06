# Pre-release checklist

The gates that are **not** in `npm test`, and the questions a release has to
answer before the public sees it. `npm test` covers unit and engine tests on
every Module; everything below needs a GPU, a network, or a human, which is
exactly why each one has gone stale at least once.

Run from the primary checkout, on a machine with a GPU.

## 0. The beta blockers

Every open P1 that stands between here and a public beta, ordered by what
unblocks the most. Filed 2026-08-26; the issue tracker is the source of truth if
this drifts.

| issue | what it is | shape |
| --- | --- | --- |
| `vect-hack-lxd` | no pinch zoom, and a phone opens on 7 of 80 columns | small — but it is shared camera code |
| `vect-hack-21k` | touch interface — make phones a supported platform | project — blocked on `lxd` |

Closed since this list was filed: `d72` (phone visitors are told), `4d0` (both
non-WebGPU arms are now gate arms), `4zn` (decided — no server saves for the
beta, client-only storage stands), `h4q` with its split `dem` (both silent
degrade paths now reach the player), `47a` (a session-only tab exports the
character it is actually playing), `zt7` (one command runs the gates, and a
nightly does it unasked), `pj0` (`check:controls` drives all four Modules'
gaze schemes — Larn's leg included), and `l11` (each Module downloads when it
is played, proven by `check:payload` — but it bought 5.7%, and `po4` names the
840 kB that is actually the download).

`lxd` is new and came out of the `21k` spike: the touch controls work, and the
view they drive does not. `OrbitCam` binds only pointer and wheel events, so
there is no pinch zoom at all, and a 390px phone opens on 7 of 80 columns —
a hero you can drive but cannot see. It blocks `21k` rather than sitting
beside it.

`21k` no longer sits outside the beta. Eric decided on 2026-08-26 to make a
phone playable rather than merely informed, so the bar is functional, not
polished — `d72` stops a visitor hitting a wall, and `21k` decides whether
they stay.

## 1. The gates

Five gates run outside `npm test`, and one command runs all five:

```bash
npm run check:gates                       # payload + browser + controls + touch + borg: ~12.0 min (28s, 62s, 22s, 9s, 600s)
npm run check:gates -- --only controls    # re-run one; gates: payload, browser, controls, touch, borg
npm run check:gates -- --stamp            # green full run only: re-dates the line below, and refuses unless it names every gate the run drove
```

Four of them — `browser`, `controls`, `touch`, `borg` — need a dev server on
5199 and a real GPU, and are the only coverage the renderer, the control
schemes and the touch scheme have in a real browser. The runner manages that
server for them.

`check:payload` is the fifth and needs neither: it runs its own `vite build`
and `vite preview` (section 2 says what it checks). So it is driven **first**,
before the runner asks the machine for anything — on a machine with no
reachable GPU it is the one gate that still answers, and a run that could not
reach a GPU reports `payload` beside its `could not run` rather than exit 3 for
everything (`vect-hack-qv1`). `--only payload` works on such a machine too, and
`--only browser` starts no build.

`check:touch` is the phone gate: `?touch` at 390x844, a character created and a
hero walked by finger only, and the run fails if the page ever receives a
keyboard event. It costs 9s measured on the build host, which is why it is in the
nightly and not just the pre-release run.

`BORG_GATE_MS=120000` shortens the borg gate for iteration. Expect the borg gate
to be red more often than not, and to say why: `?borg` plays one character, and
eleven timed deaths on 2026-08-26 ran a median of 32s, well under the 120s of
play the gate needs before it will judge a finished game. Such a run now fails
in seconds with `the borg's game ended after 13s (You die.)`, which is a fact
about the borg and not about the client. A `map traffic stalled` failure still
means what it always meant — the client went quiet with no reason given — and is
worth stopping for.

`check:gates` starts `npm run dev -- --port 5199 --strictPort` itself and stops
it on every exit path including Ctrl-C, reuses a server already answering there
rather than killing the one you are debugging with, and exits 3 — "could not
run", which is not "failed" — when the machine has no GPU it can reach. A gate
that RAN and failed outranks that: a payload regression found on a logged-out
machine is exit 1, not exit 3. Set
`NH_URL` to point the gates at some other server; the runner then starts and
stops nothing, and it is passed only to the four that have a server to be
pointed at. Each gate is still its own npm script — `check:payload`,
`check:browser`, `check:controls`, `check:touch`, `check:angband-borg` — if you
want one on its own server; the four hosted ones say so and exit 1 when nothing
answers at `NH_URL`.

Every run leaves `~/.local/state/vect-hack/gates/<timestamp>/` — each gate's
log, a `summary.json` naming the tested sha and the verdict, and the three JSON
reports the gates write for themselves. The last 20 runs are kept. That
directory is outside the repo on purpose: section 5 needs a clean tree, and the
nightly timer (03:30, installed with `scripts/dev/install-gate-timer.sh`) must
never leave one dirty. It never passes `--stamp`, and it notifies only for a
`browser` or `controls` failure. A borg failure is logged, not pushed, because
that gate's ten-minute unattended session is partly luck; a touch failure is
logged, not pushed, because the touch scheme is still a spike with
`vect-hack-21k` and `vect-hack-lxd` open against it, and a gate on churning code
goes red for expected reasons; a payload failure is logged, not pushed, on
consequence — a chunk leak makes the download bigger, and nobody is unable to
play. Read `summary.json` for any of the three.

**Why this list exists.** `check:controls` spent an unknown period asserting
`"Movement is still vi-keys"` while every vector view had moved to
`"Arrows walk where you look"` — the gate was red, and nothing in CI could
notice because these do not run in CI. A gate outside the test suite decays
silently; running it on a schedule is the only thing that stops that.

Run on 2026-08-27 against `e12864d` (the deploy-base fix), twice: `browser`,
`controls` and `touch` green both times, `borg` red both times because its
character died at 88s and then 79s — under the 120s the gate needs before it
will judge a finished game. Both runs measured 59.9fps p50 and **worst stall
0s**, so this is the borg's luck and not the client, exactly as this section
predicts. `--stamp` refused both, correctly, so the date below still records
the last run that was green in all four browser gates.

Last verified green: **2026-08-26** — the four browser gates, one run:
`check:browser` ten arms (all four Modules on WebGPU and WebGL at 60fps, plus
the WebGL-fallback and no-GPU arms, `vect-hack-4d0`), `check:controls` 85
checks, `check:touch` 32 checks, and `check:angband-borg` 130s of play at
59.9fps p50 — the borg's own character died at 129s, past the 120s the gate
needs before it will judge a finished game.

**That run predates `check:payload`, which joined the gate set on 2026-08-29
(`vect-hack-qv1`), so the line above does not cover it — and the next
`npm run check:gates -- --stamp` will REFUSE, naming `check:payload` as the
gate the sentence does not mention.** That is the refusal working, not a bug:
`--stamp` re-dates the line but will not write the coverage claim beside it,
because a claim a runner invents is the claim that rotted here in the first
place (`vect-hack-r1s`). Replace the sentence with what your green run actually
covered, then stamp. Note also what the refusal cannot see: a stale COUNT. "85
checks" becoming 90 leaves every gate mentioned and the sentence still wrong;
only option B in `vect-hack-r1s` closes that, and it was judged not worth its
price.

## 2. Payload and delivery

```bash
npm run check:payload           # no GPU and no server: it builds and serves its own
curl -sI -H 'Accept-Encoding: br,gzip' https://vecthack.net/play/modules/nethack/nethack.wasm
```

- `check:payload` is a pass/fail gate, unlike the rest of this section, and
  since `vect-hack-qv1` it is section 1's first gate — `check:gates` drives it,
  and so does the nightly. Run it alone when you want it alone; it needs
  nothing but this checkout. It
  loads each `?game=<M>` in headless Chromium on a cold cache and fails if any
  fetched chunk carries another Module's source, or if three.js lands in more
  than one chunk (`vect-hack-l11`). It also prints per-Module transferred bytes
  and a time-to-interactive median, neither of them gated.
- Playing one Module costs its own JavaScript — NetHack 39 kB, Larn 20 kB,
  Moria 13 kB, Angband 12 kB — plus **840 kB shared**, which is `three/webgpu`
  and the render layer and is 90% of the download. That is the number worth
  watching here, and `vect-hack-po4` is where it is being attacked.
- The `curl` must show `content-encoding`. CloudFront should compress
  `application/wasm` under 10 MB and CDK defaults `compress` to true. **Checked
  against the live distribution on 2026-08-27** (`8177a13`): all four Modules'
  wasm came back `content-encoding: br` with `content-type: application/wasm`.
  Note the endpoint that answered was the distribution's CloudFront endpoint,
  not `vecthack.com` — the registrar DNS is still unhooked.

## 3. First-run and degrade paths

Every one of these should tell a non-technical visitor what happened:

| State | Expected |
| --- | --- |
| No WebGPU and no WebGL | tty view plus an on-screen notice naming Chrome/Firefox |
| Engine fatal or worker error | on-screen notice asking the player to reload |
| Persistence declined | one-time notice, and a marked Saves button while it lasts |
| Web Locks unavailable, or a second tab | one-time notice naming the cause, plus a `nosave` Saves button |
| Phone or tablet | full-page explanation, plus the self-playing demo |

## 4. Licensing

- `LICENSING.md` maps every Module. Three are unambiguous: NGPL, GPL-2.0-only,
  GPL-3.0-or-later.
- **Larn is different, and this is settled** (decision, 2026-08-26). The tree we
  ship (`external/larn/COPYRIGHT`) asserts copyright and grants nothing; the
  no-profit permission in `LICENSE.LARN` is Morgan's 10 July 1986 Usenet post,
  checked against the archive on 2026-11-02 (`vect-hack-p5q`). The Module **ships
  anyway** while the site is free, and comes out promptly if anyone objects.
  Not a launch gate. What IS a gate: any monetisation breaks the grant's
  condition outright (`vect-hack-oab`), and removal must stay cheap — keep the
  Larn arm in `main.ts` and the `LICENSING.md` row scoped as they are.
- `THIRD_PARTY_NOTICES.md` (every game) and `NOTICE.NETHACK` / `NOTICE.ANGBAND`
  (one game each) must still match what the build actually bundles; a new
  notice goes in the file of the game that ships it, and `MODULES` in
  `scripts/build/stage-licenses.mjs` names each game's files.

## 5. Version and tag

A PR bumps `package.json` (`npm version X.Y.Z --no-git-tag-version`) and
moves `CHANGELOG.md`'s `[Unreleased]` notes under `[X.Y.Z]`. After the
squash-merge, tag the merge commit and publish its section:
`git tag -a vX.Y.Z -m vX.Y.Z <merge-sha> && git push origin vX.Y.Z`, then
`gh release create vX.Y.Z --notes-file <the section>`
(`docs/decisions/2026-11-03-versioning.md`).

## 6. Deploy

`npm --prefix ../vect-hack-www run deploy` (`scripts/deploy.sh`; `deploy:dry`
first) — preflight requires both trees clean and at `origin/main`, the game's
HEAD to be the tag of its own version, and the Cloudflare Access service token
(`~/.config/vecthack/access.env`). The new version is uploaded with no
traffic, checked at its Access-gated Version URL, and only then promoted.
Each deploy is recorded as a GitHub Deployment of that tag (environment
`vecthack.com`), so it leaves nothing to commit.

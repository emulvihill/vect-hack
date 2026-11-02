# Larn Module — source-viability spike report

Issue: vect-hack-611. Task 1 of the Larn Module phase-1 plan.
Date: 2026-08-06.

This is the contract every later task consumes. The values below are pinned
from the vendored source; the file:line references are to `external/larn/`
unless noted otherwise.

## 1. Candidate picked + why

**Picked: NetBSD `games/larn` snapshot (vendored).** The other two candidates
both require source patches to compile under Emscripten, which violates the
pristine-source invariant (the same rule `external/NetHack` and
`external/angband` follow).

- **HunterZ/larn 12.3 (`00d60428284f`)** — REJECTED. K&R-era C with ~30
  `static declaration of 'X' follows non-static declaration` errors (forward
  declarations missing `static`, e.g. `spells.c`, `store.c`, `scores.c`,
  `display.c`, `create.c`, `diag.c`, `moreobj.c`, `fortune.c`, `movem.c`,
  `monster.c`, `regen.c`, `help.c`, `tgetent.c`, `tgetstr.c`, `tgoto.c`,
  `tputs.c`) plus bare `exit()` calls and `<varargs.h>` (removed in clang).
  The static/extern conflict is a hard error in clang C with no `-W`
  downgrade (only `-fpermissive`, a C++ flag, relaxes it — verified
  empirically). Source patches would be needed.
- **HunterZ/larn 12.4-alpha2 (`e61f3fbfc31b`)** — REJECTED. Headers are
  modernized (prototyped, `<stdarg.h>`) and 22/26 files compile, but
  `movem.c:218` has the same `static`/`extern` `screen` conflict
  (`extern signed char screen[MAXX][MAXY]` in `larndata.h:114` vs
  `static signed char screen[MAXX][MAXY]` in `movem.c:218`), plus an
  unconditional `#include <conio.h>` (MSDOS, `io.c:62`) and an unconditional
  curses back-end (`ansiterm.c:118 #include <curses.h>`). It is an alpha
  with the DOS-port merge unfinished. Source patches would be needed.
- **NetBSD `games/larn`** — PICKED. Compiles cflags-only: **22/22 `.o`,
  0 errors, 0 warnings**, with the terminfo (termcap-successor) terminal
  surface whose semantic-byte `lpbuf` protocol is the same semantic-grid
  surface the design preferred from 12.3 — no JS ANSI parser needed. The
  NetBSD modernization (David Holland et al., 2008) fixed exactly the K&R
  forward-decl and varargs issues that break the HunterZ versions.

The pick follows the design's rule: "If every candidate needs source
patches, vendor the NetBSD-modernized snapshot."

## 2. LARN_PIN

The source is a **vendored snapshot**, not a git submodule (the NetBSD src
tree is too heavy to submodule). Pin identity:

- Origin: `https://cdn.netbsd.org/pub/NetBSD/NetBSD-current/src/games/larn/`
- Fetched: 2026-08-06.
- Directory last-modified on that mirror: 30-Jun-2026 03:01 UTC.
- Version: BSD Larn 12.0 (`-DVER=12 -DSUBVER=0`, per the NetBSD `Makefile`).
- Per-file revision tags are intact in each `__RCSID("$NetBSD: ...$")`
  banner (e.g. `io.c,v 1.31 2024/03/26`, `main.c,v 1.x`, …).

The pin is recorded in `external/larn/README.vect-hack`. Task 6's
`build-larn-wasm.sh` should guard on a sha256 of the `external/larn/`
directory (the Angband pin-guard pattern, adapted for a vendored dir
instead of a submodule commit).

## 3. Working LARN_CFLAGS

```
-std=gnu89 -Wno-implicit-int -Wno-implicit-function-declaration \
-Wno-int-conversion -Wno-incompatible-pointer-types -Wno-return-mismatch \
-Wno-format-nonliteral -DBSD -DVER=12 -DSUBVER=0 -DNONAP -DUIDSCORE -DTERMIOS \
-I external/larn -I src/modules/larn/native/compat \
-include src/modules/larn/native/compat/netbsd_compat.h
```

Flags:
- `-std=gnu89` — K&R-era C; the only mode that accepts the old-style
  definitions.
- `-Wno-implicit-int` / `-Wno-implicit-function-declaration` /
  `-Wno-int-conversion` / `-Wno-incompatible-pointer-types` /
  `-Wno-return-mismatch` / `-Wno-format-nonliteral` — silence the K&R-vs-
  modern clang diagnostics. None of these touch the static/extern class
  (which is why the HunterZ versions cannot be rescued by cflags).
- `-DBSD -DVER=12 -DSUBVER=0 -DNONAP -DUIDSCORE -DTERMIOS` — the NetBSD
  `Makefile`'s own `CPPFLAGS`. `TERMIOS` selects the POSIX termios tty path
  (vs `SYSV termio`); `NONAP` makes `napms()` a no-op (no Emscripten nap);
  we do **NOT** define `-DVT100`, so the termcap/terminfo semantic-byte
  path is active (the design's preferred surface).
- `-I src/modules/larn/native/compat` — our compat headers (see §11). Not
  in `external/larn`, so the source stays pristine.
- `-include .../netbsd_compat.h` — force-included before every TU (see §11).

## 4. Display + map dimensions

- **LARN_COLS = 80, LARN_ROWS = 24** — the terminal display the engine
  writes to. Confirmed: `cursor()` `x_num[]` table runs to `;80H`
  (`io.c:590-595`), `cursors()` positions at `cursor(1, 24)` (`io.c:630`),
  `setscroll()` targets rows 20-24 (`header.h:401`), and `draws(...)` clears
  with `cl_up(79, ymax)` (`display.c:253`) — 80 columns wide.
- **Map viewport = MAXX (67) x MAXY (17)** — `header.h:11-12`. This is the
  dungeon grid the classifier (phase 2) maps to `Cell`s; the right-side
  panel (cols 68-79) holds stats/inventory/spell lists. The display is
  wider than the map.

## 5. LARN_WRITABLE_DIRS

The engine writes to these paths (constructed in `main.c` / `config.c`).
File:line references are where each path is built:

| Path | Built at | Notes |
|---|---|---|
| `$HOME/Larn.sav` (save) | `main.c:118-121` (`getenv("HOME")` → `savefilename` + `"/Larn.sav"`) | falls back to `./Larn.sav` if `HOME` unset |
| `$HOME/.larnopts` (options) | `main.c:123` (`snprintf(optsfile, ..., "%s/.larnopts", ptr)`) | user options file; read by `readopts()` |
| `/var/games/larn/lscore12.0` (score) | `config.c:33` = `_PATH_SCORE` (`pathnames.h:35`) | scoreboard; `makeboard()` creates it |
| `/var/games/larn/llog12.0` (log) | `config.c:27` = `_PATH_LOG` (`pathnames.h:34`) | game log |
| `/var/games/larn/playerids` (player ids) | `config.c:42` = `_PATH_PLAYERIDS` (`pathnames.h:38`) | player-id allocation |
| `Larn12.0.ckp` (checkpoint, cwd-relative) | `config.c:45` (`char ckpfile[] = "Larn12.0.ckp"`) | only written under `DOCHECKPOINTS` (not defined here) |
| `Diagfile` (diag, cwd-relative) | `config.c:44` | wizard-mode diagnostic |
| `/tmp/larnmail.XXXXXX` (mail temp) | `bill.c:134` (`snprintf(fname, ..., "%slarnmail.XXXXXX", _PATH_TMP)`) | the mail routine (`MAIL` is defined for non-MSDOS) |

**Remap for the WASM build (Task 5/6):** like Angband's `/lib/` mount, the
shim overrides `_PATH_*` (via `-D` on the pathnames.h macros) and `HOME` so
the read-only data roots at `/lib/` and the writable dirs land under the
`/vect-larn` IDBFS volume (e.g. save → `/lib/save/Larn.sav`, score/log/
playerids → `/lib/`, ckpfile → `/lib/`). The exact layout is Task 6's call;
the source values above are the contract.

## 6. Terminal interception surface

Compiled **without** `-DVT100`, so the active path is the termcap/terminfo
**semantic-byte** path: the engine writes semantic bytes into `lpbuf` (via
the macros in `header.h`), and `lflush()` decodes them. The shim replaces
the decode layer (replacing `lflush()` and the terminfo entry points, or
providing them as stubs that feed a JS grid writer) so the semantic bytes
become `CellGrid` writes — no ANSI parser.

### Semantic byte protocol (`header.h:409-416`, terminfo mode)

| Byte | Value | Meaning |
|---|---|---|
| `ST_START` | 1 | begin standout (inverse video) — `header.h:409` |
| `ST_END` | 2 | end standout — `header.h:410` |
| `BOLD` | 3 | begin bold — `header.h:411` |
| `END_BOLD` | 4 | end bold — `header.h:412` |
| `CLEAR` | 5 | clear screen + home cursor — `header.h:413` |
| `CL_LINE` | 6 | clear to end of line — `header.h:414` |
| `CL_DOWN` | 14 | clear to end of display — `header.h:415` |
| `CURSOR` | 15 | move cursor; followed by `x, y` bytes — `header.h:416` |

(NetBSD dropped 12.3's `T_INIT`/`T_END` markers — `setupvt100()` at
`io.c:146` no longer emits them; terminfo init is `init_term()` →
`setupterm()`.)

Macros that emit these bytes into `lpbuf` (the shim does not replace these;
they feed `lflush()`): `lprc(ch)` (`header.h:432`), `clear()`
(`header.h:426`), `cltoeoln()` (`header.h:428`), `setbold()`/
`resetbold()` (`header.h:418`/`420`), `setscroll()`/`resetscroll()`
(`header.h:422`/`424`).

### The decode chokepoint the shim replaces

- `void lflush(void)` — `io.c:773` (terminfo-mode definition; the VT100
  one at `io.c:889` is under `#else` and inactive). Walks `lpbuf`→`lpnt`,
  decodes each semantic byte via `tputs(<cap>, 0, ttputch)` /
  `tiparm(cursor_address, x, y)`, and emits printable chars via
  `ttputch()`. When `enable_scroll <= -1` (set by `set_score_output()`,
  `io.c:757`) it writes `lpbuf` raw to `io_outfd` for the scoreboard
  listing. **This is the single function the shim replaces** — or it
  replaces the terminfo entry points below and keeps `lflush()`.

### Lower-level helpers (static in `io.c` — replaced only if the shim
keeps `lflush()` and stubs the terminfo layer instead)

- `static int ttputch(int ch)` — `io.c:909` — emits one decoded char to
  `outbuf`.
- `static void flush_buf(void)` — `io.c:921` — flushes `outbuf` to
  `io_outfd`.

### Terminfo entry points (declared in our `compat/term.h`; the shim
provides them at link, or they stay unresolved and `lflush()` is replaced)

- `int setupterm(const char *, int, int *)` — called at `io.c:650`
  (inside `init_term()`).
- `int tputs(const char *, int, int (*)(int))` — called at `io.c:798`
  et seq.
- `char *tiparm(const char *, ...)` — called at `io.c:821` et seq.
- Capability globals (`char *`): `clear_screen`, `clr_eol`, `clr_eos`,
  `cursor_address`, `delete_line`, `insert_line`, `enter_standout_mode`,
  `exit_standout_mode` — referenced at `io.c:798-857`.

### High-level grid primitives (the design's named surface; all feed
`lflush()` via `lpbuf`)

- `void cursor(int x, int y)` — `io.c:615` (terminfo mode; emits `CURSOR`
  byte + `x` + `y`).
- `void cursors(void)` — `io.c:630` — `cursor(1, 24)`.
- `void cl_line(int x, int y)` — `io.c:676`.
- `void cl_up(int x, int y)` — `io.c:692`.
- `void cl_dn(int x, int y)` — `io.c:712`.
- `void standout(const char *str)` — `io.c:738` — print string in
  standout (wraps with `ST_START`/`ST_END`).
- `int lprintf(const char *fmt, ...)` — `io.c:235` (modern varargs).
- `void lprcat(const char *str)` — `io.c:559`.
- `void lwrite(char *buf, int len)` — `io.c:286`.
- `void lprint(long x)` — `io.c:267`.
- `void beep(void)` — `io.c:986`.

### Terminal setup/teardown (the shim stubs these — no tty under WASM)

- `void setupvt100(void)` — `io.c:146` — `clear()` + `setscroll()` +
  `scbr()`.
- `void clearvt100(void)` — `io.c:159` — `clear()` + `resetscroll()` +
  `sncbr()`.
- `void init_term(void)` — `io.c:648` — `setupterm()` + capability
  sanity checks + `outbuf` malloc. **The shim must replace this** (no
  real terminfo db) — provide `cursor_address`/`clr_eol`/`clear_screen`
  as non-NULL, or stub `init_term()` to a no-op.
- `void scbr(void)` — `io.c:187` — cbreak/echo-off (calls `tcgetattr`/
  `tcsetattr` under `TERMIOS`).
- `void sncbr(void)` — `io.c:200` — restore.
- `void newgame(void)` — `io.c:211` — seeds `rnd()` + `lcreat(NULL)`.

## 7. Key input surface

- **`int ttgetch(void)` — `io.c:170`** — the key-read primitive. Flushes
  `lflush()`, then `read(0, &byt, 1)` (`io.c:177`) and returns the byte.
- **The actual suspend points are the `read(0, &b, 1)` calls**, not
  `ttgetch` alone: `io.c:177` (via `ttgetch`) and `tok.c:77`, `tok.c:81`,
  `tok.c:124` (the lexer `yylex()` reads tokens directly from fd 0, not
  via `ttgetch`). The shim intercepts `read()` for fd 0 (the terminal) and
  turns it into the Asyncify key wait — the analog of Angband's
  `Term_xtra(TERM_XTRA_EVENT)` → `wasm_gather_key`.
- **Arrow keys**: Larn uses `hjkl`/`yubn` (single-byte movement commands;
  uppercase = run) — see `parse()` in `main.c:668`, movement cases at
  `main.c:675-720`. There are **no termcap arrow-key sequences** — every
  input is a single byte. So
  `keys.ts` maps movement keys to single ASCII codes (no sequence
  assembly). The `LarnKey` shape is still `{ code; mods }` (mods carries
  `shift` for run / uppercase, matching the Angband split), but `code` is
  always one byte. `KC_ESCAPE` is `27`.

## 8. NO_ASYNCIFY

**Empirically pinned in Task 7.** The key-wait suspend is `read(0, &b, 1)`
(§7). Static first-pass candidates — functions that must never unwind
because they may be on the stack across the suspend, or are called from
paths that reach it, and that the Asyncify instrumentation must therefore
*not* skip:

- `savegame` — the save serializer (called from the `S` command in
  `parse()` and from `sigpanic()`).
- `quit`, `died` — game-end paths reachable from many command handlers.
- `lprintf`, `snprintf`, `sprintf`, `sscanf` — printf/scanf family
  (Larn ships its own `lprintf` in `io.c:235`; `snprintf`/`sprintf`/
  `sscanf` are libc).
- `qsort` — **not used** in the NetBSD snapshot (verified: no `qsort(`
  calls), so it is NOT a candidate (unlike Angband's list).

The final `NO_ASYNCIFY` list — including whether `savegame`/`quit`/`died`
are actually reachable across the `read` suspend, and whether `lprintf`'s
buffer writes touch it — is empirically pinned in Task 7, the same way
Angband's `game_event_dispatch` canary was empirically validated. The
Asyncify link flags themselves are added in Task 6.

**Pinned in Task 6.** The list shipped in `scripts/build/larn-wasm.mk` is
`NO_ASYNCIFY := savegame,lprintf`. Reasoning, confirmed by a clean link and
a node load smoke that reaches the first `read` suspend without hanging:

- Kept (`savegame`, `lprintf`) — provably never on the stack across the
  `read(0,&b,1)` suspend. `savegame` (diag.c:179) writes the save file and
  reads nothing. `lprintf` (io.c:235) formats into `lpbuf` and may call our
  `lflush` (which posts to JS and never reads); it returns before any
  `ttgetch`/`yylex` suspend, so it is never on the stack across the suspend.
- Dropped from the static candidates (`quit`, `died`) — they call
  `ttgetch()` (global.c:382) / the scoreboard `-more-` prompts (scores.c:593)
  which reach `read(0,...)`; they MUST stay instrumented. The brief's "move
  it out if it hangs" was preempted by this call-graph analysis.
- Dropped from the static candidates (`snprintf`, `sprintf`, `sscanf`) —
  this toolchain (emscripten 6.0.4 / musl) inlines or aliases them, so the
  link warned `Asyncify removelist contained a non-existing function name`
  on each. Inert entries are harmless but noisy; the inlined call sites are
  instrumented by default, which is fine because none reaches a read.
- `qsort` — not used (spike §8); not a candidate.

The node load smoke (`src/modules/larn/native/main-wasm.c` boots through
`larn_upstream_main`, posts 37 lflush-driven events to `globalThis.VectLarn`,
and suspends at the first `read`/`gatherKey`) is the empirical evidence this
list is correct for the boot path. Task 12's full-suite gate re-checks it
under sustained play.

## 9. Data root the engine expects

Native (from `pathnames.h` + `main.c`):
- Read-only: `/usr/share/games/larn/` — `larn.help` (`_PATH_HELP`,
  `pathnames.h:36`), `larnmaze` (`_PATH_LEVELS`, `pathnames.h:37`).
- Writable: `/var/games/larn/` (`lscore12.0`, `llog12.0`, `playerids`) and
  `$HOME` (`Larn.sav`, `.larnopts`).

For the WASM build, the shim overrides the `_PATH_*` macros (via `-D` on
the command line, so `pathnames.h` sees our paths) and sets `HOME=/lib` (or
overrides `savefilename`/`optsfile` directly) so everything roots under the
`--preload-file` `/lib/` mount, with the writable dirs linked into the
`/vect-larn` IDBFS volume — the Angband pattern (`init_file_paths("/lib/",
...)` + `ANGBAND_DIR_USER = "/lib/user"`).

## 10. Files to stage into lib/

Data files the engine reads at runtime (the `--preload-file lib@/lib` VFS):
- `larn.help` — the on-line help text (`?` command). Source: NetBSD
  `src/games/larn/datfiles/larn.help`.
- `larnmaze` — the pre-made dungeon level data (`larnlevels`).
  Source: NetBSD `src/games/larn/datfiles/larnmaze`.

That is the complete read-only data set. Fortunes are **inlined** as a
static `const char *flines[]` array in `fortune.c:50-83` — no `larn.ftn`
file to stage (NetBSD dropped the 12.3 fortune-file read). The
`datfiles/larnopts` sample options file is not read by the engine at
runtime (the engine reads `$HOME/.larnopts`, which is a writable user file
under the volume, not a staged lib/ file) — do not stage it.

License hygiene: `larn.help` and `larnmaze` are plain text data files with
no embedded tiles/sounds/fonts (Larn predates all of those). Exclude any
such assets if a future revision carries them (the Angband carve-out
discipline).

## 11. Compat headers (ours, in `src/modules/larn/native/compat/`)

These are NOT in `external/larn` — they are ours, reached via `-I` and
`-include` in `LARN_CFLAGS`, so the vendored source stays pristine. All C
compat lives here and in `main-wasm.c` (Task 6), the same discipline as
`src/modules/angband/native/main-wasm.c`.

- `sys/cdefs.h` — NetBSD's `__RCSID("$NetBSD: ...$")` file-scope stamp.
  musl has no `<sys/cdefs.h>`; we define `__RCSID` to a static const
  declaration (valid at file scope, per-TU, no link conflict).
- `term.h` — terminfo surface `io.c` includes: declares `setupterm`/
  `tputs`/`tiparm` and the eight capability globals (`clear_screen`,
  `clr_eol`, `clr_eos`, `cursor_address`, `delete_line`, `insert_line`,
  `enter_standout_mode`, `exit_standout_mode`). Declarations only; the
  shim (Task 6) provides the implementations or replaces `lflush()` so
  they are never linked.
- `sgtty.h` — `struct sgttyb` for `scbr()`/`sncbr()` (the non-SYSV/
  non-TERMIOS path; inactive under `-DTERMIOS` but the header is still
  included). Minimal struct + `gtty`/`stty` declarations.
- `netbsd_compat.h` — force-included (`-include`) before every TU:
  defines `SIGEMT` (BSD signal not in musl, used at `signal.c:109`) and
  declares `sys_signame` (NetBSD signal-name array, `signal.c:132`). The
  shim stubs `sigsetup()` at runtime, so both are inert.

## 12. Spike evidence

The compile probe (Task 1's deliverable):

```bash
source external/emsdk/emsdk_env.sh
for f in external/larn/*.c; do
  case "$f" in */main.c) continue;; esac
  emcc $LARN_CFLAGS -c "$f" -o build/larn/$(basename ${f%.c}).o
done
```

Result: **22/22 `.o` produced, 0 errors, 0 warnings** (where
`LARN_CFLAGS` is §3 above). Equivalent via the makefile:
`make -f scripts/build/larn-wasm.mk VECT_ROOT=$ROOT compile-cores` — also
22/22. The working flags are recorded in `/tmp/larn-compile.log`.

The compat headers and the makefile are committed alongside this report;
the emsdk symlink and any `build/larn/` output are gitignored.
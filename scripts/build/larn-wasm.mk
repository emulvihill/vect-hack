# Emscripten compile+link for the NetBSD Larn snapshot — invoked by
# scripts/build/build-larn-wasm.sh as:
#   make -f $ROOT/scripts/build/larn-wasm.mk VECT_ROOT=$ROOT build/larn/larn.js
#
# Own-main() flavour with a rename, NOT the exclude-main.o flavour the Angband
# makefile uses. Larn's main.c holds the command dispatcher (parse()) and the
# inventory helpers (show3/qshowstr/parse2/readnum) that global.c, action.c,
# object.c, monster.c, store.c and scores.c call — so main.o MUST link.
# main.c's own main() is neutralised at compile time by -Dmain=larn_upstream_main
# (applied only to main.c, via the per-file rule below) and our shim
# (src/modules/larn/native/main-wasm.c) supplies the real main(). main.c's
# renamed main() is dead code (wasm-ld GCs it; even if not, getpwuid/getlogin
# resolve against musl stubs).
#
# The external/larn tree is never edited — same rule as external/NetHack and
# external/angband. All C compatibility lives in
# src/modules/larn/native/compat/ (reached via -I and -include) and in
# main-wasm.c.

LARN := $(VECT_ROOT)/external/larn
COMPAT := $(VECT_ROOT)/src/modules/larn/native/compat
OUT := $(VECT_ROOT)/build/larn

CC := emcc

# --- LARN_CFLAGS (proven by the Task-1 spike; see docs/specs/
# larn-spike.md §3) ---
# -std=gnu89             the NetBSD snapshot is K&R-era C; gnu89 is the mode
#                        that accepts its old-style definitions
# -Wno-* family          silence the K&R-vs-modern clang diagnostics that are
#                        warnings-in-spirit but errors-by-default; none of
#                        these touch the static/extern class (which is why
#                        HunterZ 12.3/12.4-alpha2 were rejected)
# -Wno-macro-redefined   musl's <paths.h> defines _PATH_TMP; if a future
#                        revision defines it on the command line too, the
#                        redefinition would warn. Kept harmless here.
# -DBSD -DVER=12 -DSUBVER=0 -DNONAP -DUIDSCORE -DTERMIOS
#                        the NetBSD Makefile's own CPPFLAGS; TERMIOS selects
#                        the POSIX termios tty path (vs SYSV termio); NONAP
#                        makes napms() a no-op (Emscripten has no nap); we do
#                        NOT define -DVT100, so the termcap/terminfo semantic-
#                        byte path is active (the design's preferred surface)
# Data root: the _PATH_* overrides are NOT done here. pathnames.h `#define`s
# them unconditionally after any -D, so -D is silently overridden (the last
# definition wins). The writable/read-only roots are pinned by redefining
# config.c's five globals (logfile/scorefile/helpfile/larnlevels/playerids)
# in main-wasm.c, which --allow-multiple-definition resolves in our favour
# (main-wasm.o before config.o). HOME is set at runtime in main-wasm.c
# (getenv, not a pathnames.h macro) so savefilename/optsfile root in /lib/home.
# -I $(LARN)             the engine's own headers (header.h, extern.h,
#                        pathnames.h)
# -I $(COMPAT)           our compat headers (sys/cdefs.h, term.h) —
#                        musl/Emscripten ships neither; they are ours, not in
#                        external/larn, so the source stays pristine. (io.c
#                        would want sgtty.h only without TERMIO/TERMIOS —
#                        -DTERMIOS below keeps that include dead.)
# -include $(COMPAT)/netbsd_compat.h
#                        force-included before every TU: declares SIGEMT and
#                        sys_signame (signal.c) which musl lacks but the
#                        NetBSD snapshot assumes, and pulls in <time.h> so
#                        time()/ctime() are properly prototyped under gnu89
LARN_CFLAGS := -std=gnu89 -Wno-implicit-int -Wno-implicit-function-declaration \
  -Wno-int-conversion -Wno-incompatible-pointer-types -Wno-return-mismatch \
  -Wno-format-nonliteral -Wno-macro-redefined \
  -DBSD -DVER=12 -DSUBVER=0 -DNONAP -DUIDSCORE -DTERMIOS \
  -I $(LARN) -I $(COMPAT) -include $(COMPAT)/netbsd_compat.h

# --- NO_ASYNCIFY (spike §8; empirically pinned in Task 6) ---
# Functions removed from Asyncify instrumentation because they are provably
# never on the stack across the read(0,&b,1) suspend (the only Asyncify
# suspend point, reached via ttgetch io.c:177 and yylex tok.c:81/124):
#   lprintf - formats into lpbuf and may call our lflush (no read); never
#             on the stack across ttgetch
# NOT removed (kept instrumented) because they DO call ttgetch -> read:
#   quit()  calls ttgetch() in its yes/no loop (global.c:382)
#   died()  runs the scoreboard with -more- prompts (scores.c:593); wrapped
#           (--wrap=died, Task 8) but __wrap_died only flags -257 then tails
#           to __real_died, so keeping the wrap instrumented is correct.
# Dropped from the spike's static candidates: the libc printf/scanf family
# (snprintf, sprintf, sscanf) — this toolchain inlines or aliases them, so
# they do not resolve as symbols and the link warned "non-existing function
# name" on each. Inert entries are harmless but noisy; instrumenting the
# inlined call sites (the fallback) is harmless because none reach a read.
# qsort is not used in this snapshot (spike §8), so it is not a candidate
# (unlike Angband's list). Pinned in Task 6 below.
# savegame (diag.c:179) writes the save file and never reaches a read, so it
# must remain outside Asyncify. Task 8 wraps the public symbol at link time:
# Asyncify therefore sees the actual body as __wrap_savegame (not savegame or
# __real_savegame; both names warn as absent in the removelist). The wrapper
# tails through __real_savegame then calls synchronous wasm_save_landed(), so
# it cannot suspend and __wrap_savegame is safe to remove.
NO_ASYNCIFY := __wrap_savegame,lprintf

LDFLAGS := -O2 -s ENVIRONMENT=worker,node -s EXPORT_ES6=1 -s MODULARIZE \
  -s 'EXPORT_NAME="createLarnModule"' -s ASYNCIFY \
  -s ASYNCIFY_REMOVE="$(NO_ASYNCIFY)" -s ALLOW_MEMORY_GROWTH -lidbfs.js \
  -s 'EXPORTED_RUNTIME_METHODS=["FS","ccall","UTF8ToString"]' \
  -Wl,--allow-multiple-definition -Wl,--wrap=read -Wl,--wrap=ioctl \
  -Wl,--wrap=exit -Wl,--wrap=showcell -Wl,--wrap=drawscreen -Wl,--wrap=draws \
  -Wl,--wrap=died -Wl,--wrap=savegame -Wl,--wrap=restoregame -Wl,--wrap=fstat \
  -Wl,--wrap=readopts -Wl,--wrap=yylex -Wl,--wrap=newgame \
  -Wl,--wrap=sleep -Wl,--wrap=usleep

# Engine objects in the NetBSD Makefile's SRCS order, with main.o kept (main
# renamed) and our shim listed FIRST. --allow-multiple-definition resolves
# the resulting duplicate lflush/init_term/sigsetup definitions in favour of
# the first object seen, so main-wasm.o must precede io.o and signal.o: our
# lflush/init_term/sigsetup win, io.c's are discarded, and every internal
# call to those names (from lprintf/lprc/lcreat/ttgetch/etc.) resolves to
# ours.
LARN_SRCS := $(LARN)/object.c $(LARN)/create.c $(LARN)/tok.c $(LARN)/display.c \
  $(LARN)/global.c $(LARN)/data.c $(LARN)/io.c $(LARN)/monster.c $(LARN)/store.c \
  $(LARN)/diag.c $(LARN)/help.c $(LARN)/config.c $(LARN)/nap.c $(LARN)/bill.c \
  $(LARN)/scores.c $(LARN)/signal.c $(LARN)/action.c $(LARN)/moreobj.c \
  $(LARN)/movem.c $(LARN)/regen.c $(LARN)/fortune.c $(LARN)/savelev.c \
  $(LARN)/main.c
LARN_OBJS := $(patsubst $(LARN)/%.c,$(OUT)/%.o,$(LARN_SRCS))
OBJS := $(OUT)/main-wasm.o $(LARN_OBJS)

# Order guard: --allow-multiple-definition resolves a duplicate in favour of
# the FIRST object, so a reorder that demotes main-wasm.o silently hands
# lflush/init_term/sigsetup back to io.c/signal.c — the link succeeds and the
# screen goes dark. Fail the build instead of the boot test.
ifneq ($(firstword $(OBJS)),$(OUT)/main-wasm.o)
$(error main-wasm.o must be FIRST in OBJS: link order decides which lflush wins)
endif

.PHONY: all compile-cores
all: $(OUT)/larn.js

# Compile-only spike target (Task 1): every engine .c -> .o, cflags-only.
compile-cores: $(LARN_OBJS)

# Linked from $(OUT) with relative -o and --preload-file: Emscripten bakes the
# output path into the glue as the .data package name (vect-hack-uur5).
$(OUT)/larn.js: $(OBJS)
	cd $(OUT) && $(CC) $(LARN_CFLAGS) $(LDFLAGS) \
	  --preload-file stage/lib@/lib -o larn.js $(OBJS)

# Our front end, compiled out-of-tree into $(OUT). Listed first in OBJS so
# --allow-multiple-definition resolves the duplicate lflush/init_term/
# sigsetup in its favour.
$(OUT)/main-wasm.o: $(VECT_ROOT)/src/modules/larn/native/main-wasm.c | $(OUT)
	$(CC) $(LARN_CFLAGS) -o $@ -c $<

# main.c compiled with its main() renamed so the command dispatcher and
# inventory helpers link, but the engine's own startup does not compete
# with our main(). -Dmain=... is applied ONLY here, not to the other engine
# TUs or to main-wasm.c (whose main() is the real entry).
$(OUT)/main.o: $(LARN)/main.c | $(OUT)
	$(CC) $(LARN_CFLAGS) -Dmain=larn_upstream_main -o $@ -c $<

$(OUT)/%.o: $(LARN)/%.c | $(OUT)
	$(CC) $(LARN_CFLAGS) -o $@ -c $<

$(OUT):
	mkdir -p $@

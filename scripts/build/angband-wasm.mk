# Emscripten compile+link for Angband 4.2.6 — invoked by
# scripts/build/build-angband-wasm.sh as:
#   make -C external/angband/src -f $ROOT/scripts/build/angband-wasm.mk VECT_ROOT=$ROOT
# cwd is the submodule's src/, so `include Makefile.inc` resolves and core
# objects land there (upstream's own .gitignore covers src/*.o and
# src/**/*.o, so the submodule stays clean). Our front end compiles
# out-of-tree into $(OUT).
#
# Flags start from the proven link recipe of the 2026-08-02 feasibility spike
# (Makefile.wasmlink: exit 0, 4.0 MB wasm) with three deliberate changes:
#   ENVIRONMENT=worker,node  — the node smoke test must load the module
#                              (NetHack's build sets no ENVIRONMENT at all,
#                              which is why node loads it today)
#   EXPORT_ES6=1             — NetHack precedent (cross-pre2.500:330)
#   ASYNCIFY_REMOVE          — Shelob's Safari-stack list adapted to 4.2.6:
#                              Term_mbstowcs -> text_mbstowcs (renamed in
#                              4.2); borg_* dropped (ALLOW_BORG is not
#                              defined, the borg objects compile empty, the
#                              symbols do not exist).
# BASEOBJS = ANGFILES + ZFILES (Makefile.inc:9); upstream main.o is a
# separate MAINFILES object and is NOT linked — this is the own-main()
# flavour, exactly Shelob's OBJS = $(BASEOBJS) main-emscripten.o.
include Makefile.inc

CC := emcc
# -DALLOW_BORG arms the built-in borg (external/angband/src/borg/*), which is
# the epic's crash gate (vect-hack-3vk.4). Without it those objects compile to
# empty translation units. build-angband-wasm.sh stamps this makefile's sha256
# and discards every .o when it moves, so the empty borg objects cannot be
# silently reused across this change.
CFLAGS := -O2 -I. -w -DALLOW_BORG
# CANARY — `game_event_dispatch` in this list MUST NEVER RESOLVE. It is on the
# stack across Asyncify suspend points, so removing it from instrumentation
# would corrupt the unwind: its registered handlers reach both of our suspends —
# display_explosion/display_bolt/display_missile (ui-display.c:1559/1645/1696,
# registered at 2757-2763) call Term_xtra(TERM_XTRA_DELAY, msec) ->
# emscripten_sleep, and check_for_player_interrupt (ui-game.c:645, registered at
# ui-display.c:2766) calls inkey_ex() -> Term_xtra(TERM_XTRA_EVENT, ...) ->
# the EM_ASYNC_JS wasm_gather_key. It is inert today only by accident: the
# function is static in 4.2.6 (game-event.c:33) and declared in no header, so
# the linker cannot match the name and answers with
#   warning: Asyncify removelist contained a non-existing function name: 'game_event_dispatch'
# That warning is the canary, and build-angband-wasm.sh fails the build if a
# link runs without printing it. If it ever DISAPPEARS — a toolchain change,
# LTO, or a build that gives the symbol external linkage — the entry has armed,
# and it must be deleted before shipping or the game will hang somewhere far
# from this file with no explanation.
# CHECKED 2026-08-03 under -DALLOW_BORG (the scenario this comment named as the
# likely trigger): the warning is still emitted, so the entry remains inert and
# stays. The build script now re-checks it on every link, so this note is
# history rather than the thing standing guard.
# Do NOT trim the other unresolved names to quiet the log; the Safari list is
# kept whole on purpose (the rest was audited clean: Term_fresh reaches only
# FRESH, Term_activate only LEVEL, both synchronous, and quit/quit_fmt/vformat/
# vstrnfmt/text_mbstowcs cannot reach a suspend).
NO_ASYNCIFY := quit,quit_fmt,vformat,vstrnfmt,vfiprintf,sscanf,qsort,text_mbstowcs,Term_activate,Term_fresh,Term_fresh_row_pict,Term_fresh_row_text,Term_fresh_row_both,game_event_dispatch
LDFLAGS := -s ENVIRONMENT=worker,node -s EXPORT_ES6=1 -s MODULARIZE \
  -s 'EXPORT_NAME="createAngbandModule"' -s ASYNCIFY \
  -s ASYNCIFY_REMOVE="$(NO_ASYNCIFY)" -s ALLOW_MEMORY_GROWTH -lidbfs.js \
  -s 'EXPORTED_RUNTIME_METHODS=["FS","ccall","UTF8ToString"]'

OUT := $(VECT_ROOT)/build/angband
OBJS := $(BASEOBJS) $(OUT)/main-wasm.o

# Linked from $(OUT) with relative -o and --preload-file: Emscripten bakes the
# output path into the glue as the .data package name (vect-hack-uur5).
$(OUT)/angband.js: $(OBJS)
	cd $(OUT) && $(CC) $(CFLAGS) $(LDFLAGS) --preload-file stage/lib@/lib \
	  -o angband.js $(abspath $(OBJS))

$(OUT)/main-wasm.o: $(VECT_ROOT)/src/modules/angband/native/main-wasm.c
	$(CC) $(CFLAGS) -o $@ -c $<

%.o: %.c
	$(CC) $(CFLAGS) -o $@ -c $<

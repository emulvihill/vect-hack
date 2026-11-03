/**
 * \file main-wasm.c
 * \brief VectHack front end: NetBSD BSD Larn 12.0 in a Web Worker via Emscripten.
 *
 * Own-main() flavour: this file supplies main(), so upstream main.c's main()
 * is renamed at compile time (`-Dmain=larn_upstream_main` in larn-wasm.mk) and
 * the upstream tree is never edited. Unlike Angband's main.c (which holds
 * only main()+startup), Larn's main.c ALSO holds the command dispatcher
 * (parse()) and the inventory display helpers (show3/qshowstr/parse2/readnum)
 * that global.c, action.c, object.c, monster.c, store.c and scores.c call — so
 * main.o MUST link, with its main() neutralised. Excluding main.o (the brief's
 * first-pass shape, mirroring Angband) leaves those symbols undefined; the
 * rename is the own-main() flavour that keeps the engine whole.
 *
 * Terminal interception: Route A from the spike (docs/specs/
 * larn-spike.md §6). Compiled without -DVT100, so the active output path is
 * the termcap/terminfo semantic-byte path — the engine writes semantic
 * bytes (ST_START/ST_END/BOLD/END_BOLD/CLEAR/CL_LINE/CL_DOWN/CURSOR, defined
 * in external/larn/header.h:409-416) into the global lpbuf (data.c:117), and
 * lflush() decodes them. This shim REPLACES lflush() via link-order override
 * (-Wl,--allow-multiple-definition with main-wasm.o before io.o): the shim's
 * strong lflush() wins, io.c's is discarded, and every internal lflush()
 * call (from lprintf/lprc/lcreat/ttgetch) resolves to ours. The shim walks
 * lpbuf->lpnt directly (lpbuf/lpnt/lpend are non-static globals, data.c:117;
 * declared extern in header.h:344) and posts clear/curs/text events to
 * globalThis.VectLarn — no ANSI parser, no terminfo db.
 *
 * Key input: the suspend is read(0, &b, 1) (io.c:177 via ttgetch; also
 * tok.c:77/81/124 in yylex, which reads fd 0 directly rather than via
 * ttgetch). The shim intercepts read() for fd 0 via -Wl,--wrap=read: the
 * wrapper turns a read on the terminal fd into the Asyncify key wait (the
 * analog of Angband's Term_xtra(EVENT) -> wasm_gather_key), and delegates
 * every other fd to the real read. tok.c's ioctl(0, FIONREAD, &ic)
 * type-ahead flush is similarly wrapped (--wrap=ioctl) to report no
 * type-ahead, so the do/while in yylex falls straight through to the
 * blocking read.
 *
 * The JS side of every EM_*JS block is globalThis.VectLarn, installed by
 * src/modules/larn/worker.ts (browser, Task 7) or a node smoke check before
 * the module is instantiated.
 *
 * This work ports Larn, copyrighted by Noah Morgan as recorded in
 * external/larn/COPYRIGHT. Morgan's original grant permits source use,
 * modification, and ports provided no profit is made; see LICENSING.md.
 */
#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/cdefs.h>

#include "header.h"
#include "extern.h"
#include "pathnames.h"

#ifndef FIONREAD
#define FIONREAD 0x541B
#endif

/* ---- JS bridge: globalThis.VectLarn ----
 * The async-gather / sync-getter split mirrors src/modules/angband/native/
 * main-wasm.c:87-97. gatherKey(wait, cmd) is the single Asyncify suspend
 * point (the read(0,&b,1) the shim intercepts); keyCode()/keyMods() are read
 * back synchronously after it resolves. */
EM_ASYNC_JS(int, wasm_gather_key, (int wait, int cmd), {
	return globalThis.VectLarn.gatherKey(wait, cmd);
});
EM_JS(int, wasm_key_code, (), { return globalThis.VectLarn.keyCode(); });
EM_JS(int, wasm_key_mods, (), { return globalThis.VectLarn.keyMods(); });

/* Terminal output primitives. Each maps to a LarnEvent
 * (src/modules/larn/protocol.ts). text takes a NUL-terminated ASCII run;
 * Larn's lpbuf holds only bytes >= 32 plus the semantic markers, so no NUL
 * can appear inside a run. */
EM_JS(void, wasm_text, (int x, int y, int rgb, const char *s), {
	globalThis.VectLarn.text(x, y, rgb, UTF8ToString(s));
});
EM_JS(void, wasm_curs, (int x, int y), {
	globalThis.VectLarn.curs(x, y);
});
EM_JS(void, wasm_wipe, (int x, int y, int n), {
	globalThis.VectLarn.wipe(x, y, n);
});
EM_JS(void, wasm_clear, (void), {
	globalThis.VectLarn.clear();
});
EM_JS(void, wasm_flush, (void), {
	globalThis.VectLarn.flush();
});
EM_JS(void, wasm_quit, (int saved), {
	globalThis.VectLarn.quit(saved);
});
/* Synchronous signal that a save (checkpoint OR S-save) has landed on disk:
 * the worker flushes the IDBFS volume so the save survives a tab close.
 * savegame() is NO_ASYNCIFY (larn-wasm.mk), so this must not suspend — a
 * plain EM_JS never crosses the Asyncify boundary. */
EM_JS(void, wasm_save_landed, (), {
	globalThis.VectLarn.saveLanded();
});
/* An out-of-band player message (protocol.ts's LifecycleToMain `notice`), for
 * the one thing the shim decides before the engine owns a screen: a .larnopts
 * option it refused. */
EM_JS(void, wasm_notice, (const char *s), {
	globalThis.VectLarn.notice(UTF8ToString(s));
});
/* The map glyph of the creature the epitaph is about to name, or 0 for none
 * (protocol.ts's `death` event). This is the join the run digest cannot
 * make for itself: the screen prints "killed by a giant ant" in one place and
 * draws a 'G' in another, and only the engine knows they are the same being
 * (vect-hack-b5f.4). Sent as an int, not a string: it is one character. */
EM_JS(void, wasm_death, (int ch), {
	globalThis.VectLarn.death(ch);
});

/* ---- Gym mode ----------------------------------------------------------
 * The headless gym needs deterministic games; the browser must not have
 * them. Rather than a new wasm export plus a ccall, gym mode rides the
 * globalThis.VectLarn object every host already installs: the gym defines
 * these optional methods, the worker does not, and an absent method reads
 * as "off". Both are plain (non-async) EM_JS calls made outside any key
 * wait, so they never touch the Asyncify boundary.
 */
EM_JS(int, wasm_gym_seed, (), {
	var v = globalThis.VectLarn;
	return (v && typeof v.gymSeed === "function") ? (v.gymSeed() | 0) : 0;
});

/* newgame() (io.c:211) is the single seeding site: it stores initialtime and
 * then seeds BOTH generators from it — seedrand() for the randx LCG behind
 * rnd()/rund() (header.h:435-439) and srandom() for libc random(), whose
 * only consumer is fortune.c:93.
 *
 * Wrapping time() instead would be wrong twice: time() also feeds the score
 * file (scores.c:688) and diagnostics (diag.c:226), so a wrap contaminates
 * values Larn persists; and gltime is a TURN counter incremented by gameplay
 * (regen.c:40), not a wall-clock derivative — it becomes reproducible because
 * the decisions are, not because time is frozen.
 *
 * Let the real newgame() run first so initialtime keeps its true value, then
 * overwrite the seeds. Fresh games only: Larn saves neither randx nor libc
 * random() state, so a restored save cannot be bit-reproducible.
 */
void __real_newgame(void);

void
__wrap_newgame(void)
{
	int seed;

	__real_newgame();
	seed = wasm_gym_seed();
	if (seed != 0) {
		seedrand((unsigned long)seed);
		srandom((unsigned)seed);
	}
}

EM_JS(int, wasm_gym_fast, (), {
	var v = globalThis.VectLarn;
	return (v && typeof v.gymFast === "function") ? (v.gymFast() | 0) : 0;
});

/* Headless throughput. nap() calls lflush() and THEN usleep() (nap.c:17-23),
 * and every sleep() site does the same (action.c:92, help.c:122,
 * scores.c:624, tok.c:95; signal.c:134 writes to fd 2 first). Wrapping the
 * CALLERS would drop those flushes, which drops the events the bot's world
 * model is built from, which can change its decisions — silently corrupting
 * the baseline the speed-up exists to produce. Wrapping the sleeps themselves
 * keeps every observation and removes only the waiting.
 * scripts/test/test-larn-trace.mjs proves the equivalence: the fixture was
 * recorded with the sleeps active and must still match with them suppressed.
 */
unsigned int __real_sleep(unsigned int seconds);
int __real_usleep(useconds_t usec);

unsigned int
__wrap_sleep(unsigned int seconds)
{
	if (wasm_gym_fast())
		return 0;	/* no time left unslept: nothing waited */
	return __real_sleep(seconds);
}

int
__wrap_usleep(useconds_t usec)
{
	if (wasm_gym_fast())
		return 0;
	return __real_usleep(usec);
}

/* The 80x24 terminal the semantic-byte stream addresses (io.c's termcap
 * surface; src/modules/larn/grid.ts mirrors the same dimensions). */
#define TERM_COLS 80
#define TERM_ROWS 24

/* ---- Terminal attribute -> RGB ----
 * The semantic-byte path carries no per-character colour, only the three
 * Larn term attributes: normal, standout (inverse video) and bold. We map
 * each to one 0xRRGGBB so the tty-text view (Task 9) has something to render
 * before the phase-2 classifier assigns monster/item colours. The values are
 * placeholders; the skin owns the real palette (src/skins/). */
#define RGB_NORMAL   0xCCCCCC
#define RGB_STANDOUT 0xFFFFFF
#define RGB_BOLD     0xFFE05A

/* ---- Terminfo surface, owned by the shim ----
 * io.c (non-VT100 path) references eight terminfo capability globals and
 * the three entry points setupterm/tputs/tiparm. Our lflush() replaces the
 * decoder so the globals are never read by us, but cl_dn() (io.c:720) still
 * checks `if (!clr_eos)` and io.c's own init_term()/lflush() (discarded as
 * duplicate definitions via --allow-multiple-definition) still reference the
 * rest. Define all eight as NULL and the three entry points as stubs so the
 * link resolves whether or not wasm-ld GCs the dead functions. */
char *clear_screen = 0;
char *clr_eol = 0;
/* Non-NULL on purpose, unlike its seven siblings: cl_dn() (io.c:720) checks
 * `if (!clr_eos)` and, when it is NULL, falls back to emitting CL_LINE+'\n'
 * for every row to 24 — walking cury off the grid and costing 24 events per
 * clear-down. Any non-NULL value routes cl_dn through the single CL_DOWN
 * byte our decoder handles. The string is never printed: only our lflush()
 * decodes, and it switches on the byte, not the capability. */
char *clr_eos = (char *)"\016";
char *cursor_address = 0;
char *delete_line = 0;
char *insert_line = 0;
char *enter_standout_mode = 0;
char *exit_standout_mode = 0;

int setupterm(const char *term, int fd, int *errp)
{
	(void)term; (void)fd; (void)errp;
	return 0;
}
int tputs(const char *str, int affcnt, int (*putc_)(int))
{
	(void)str; (void)affcnt; (void)putc_;
	return 0;
}
char *tiparm(const char *str, ...)
{
	return (char *)str;
}

/* netbsd_compat.h declares sys_signame (signal.c's sigpanic indexes it); the
 * shim stubs sigsetup() below so it is never indexed, but the symbol must
 * resolve at link time regardless of GC. */
const char *sys_signame[1] = { 0 };

/* ---- Data-root globals (config.c) — overridden via link order ----
 * config.c initialises these five from the _PATH_* macros in pathnames.h:
 *   char logfile[]    = _PATH_LOG;
 *   char scorefile[]  = _PATH_SCORE;
 *   char helpfile[]   = _PATH_HELP;
 *   char larnlevels[] = _PATH_LEVELS;
 *   char playerids[]  = _PATH_PLAYERIDS;
 * Overriding the macros via -D does NOT work: pathnames.h `#define`s them
 * unconditionally AFTER any -D, so the upstream value always wins (a macro
 * redefinition, silenced by -Wno-macro-redefined but not overridden). Instead
 * we redefine the globals themselves here and let --allow-multiple-definition
 * (main-wasm.o before config.o in OBJS) pick ours. savefilename/optsfile are
 * NOT overridden — main.c builds them from getenv("HOME"), and the shim's
 * main() sets HOME=/lib/home so they root in the volume. */
char logfile[]    = "/lib/scores/llog12.0";
char scorefile[]  = "/lib/scores/lscore12.0";
char helpfile[]   = "/lib/larn.help";
char larnlevels[] = "/lib/larnmaze";
char playerids[]  = "/lib/scores/playerids";
/* ckpfile is the native checkpoint filename (config.c:45 initialises it to
 * "Larn12.0.ckp", cwd-relative). Override it the same way as the five above
 * — link-order, via --allow-multiple-definition — so the checkpoint Larn
 * writes every CHECKPOINT_INTERVAL commands (tok.c:60-63) roots in the
 * /lib/home IDBFS volume (mountLarnStorage) and survives a tab close. */
char ckpfile[]    = "/lib/home/Larn12.0.ckp";
/* The explicit save. Not a global we can override — main.c:120-121 builds it
 * as getenv("HOME") "/Larn.sav" — but the one path recovery is pinned to, so
 * both the ++ recovery test in main() and __wrap_readopts below name it here
 * rather than repeating the literal. */
#define LARN_SAVEFILE "/lib/home/Larn.sav"

/* ---- Per-cell map record: the C mirror of mapRecords.ts ----
 * larn_map_info() packs one 9-word record per cell, faithful to how
 * drawscreen() (external/larn/display.c:285-374) renders the KNOWN map:
 *   know==0           -> unseen/blank
 *   mitem!=0          -> monster char (monstnamelist[mitem])
 *   item==OWALL       -> wall
 *   item in features  -> feature kind (altar/throne/fountain/store/...)
 *   item in stairs    -> stairs (up/down kind)
 *   item in traps     -> trap (door/dart/arrow kind)
 *   hidden trap vars  -> floor (objnamelist entry is a space; the player
 *                        does not see them — same as drawscreen's blank)
 *   OANNIHILATION     -> terrain FLOOR, occupant effect (a moving sphere,
 *                        monster.c:1797, NOT terrain)
 *   else (carryable)  -> terrain FLOOR, occupant ITEM
 *
 * Blindness: drawscreen() does NOT check c[BLINDCOUNT] (confirmed by
 * reading display.c:285-374 — only showcell() returns early on blind at
 * display.c:381). The semantic adapter is intentionally stricter: blind
 * drawscreen/draws replay the last public shadow rather than turning that
 * legacy redraw quirk into a live-map oracle. A blind showcell emits a cached
 * two-cell hero delta (see the dirty guard below), never a fresh larn_map_info
 * query. The hero is always semantic data (the player knows their own
 * position); showplayer() (display.c:475) only moves the cursor, so
 * drawscreen has NO player '@' branch and we emit the hero ourselves.
 *
 * See-invisible is baked into monstnamelist: the engine mutates
 * monstnamelist[INVISIBLESTALKER] between ' ' and 'I'. Reading the table
 * directly (like showcell/drawscreen do) captures it — no separate
 * c[SEEINVISIBLE] check. If monstnamelist[mitem]==' ' the player does not
 * see the monster, so the cell gets TOP_NONE (matches drawscreen's blank).
 *
 * Layout constants mirror src/modules/larn/mapRecords.ts exactly; the
 * TERRAIN_KIND word is an index INTO KIND_NAMES in that file (do not
 * reorder). Palette indices are ANSI-16 from src/render/colors.ts.
 */
#define GRID_STRIDE 9
#define GRID_X 0
#define GRID_Y 1
#define GRID_TERRAIN_CAT 2
#define GRID_TERRAIN_CHAR 3
#define GRID_TERRAIN_COLOR 4
#define GRID_TERRAIN_KIND 5
#define GRID_TOP_CAT 6
#define GRID_TOP_CHAR 7
#define GRID_TOP_COLOR 8

#define TERRAIN_UNSEEN    0
#define TERRAIN_FLOOR     1
#define TERRAIN_WALL      2
#define TERRAIN_DOOR      3
#define TERRAIN_DOOR_OPEN 4
#define TERRAIN_STAIRS    5
#define TERRAIN_FEATURE   6
#define TERRAIN_TRAP      7

#define TOP_NONE    0
#define TOP_HERO    1
#define TOP_MONSTER 2
#define TOP_ITEM    3

/* Real-engine contract tests need deterministic access to blindness without
 * gambling on randomly generated potions. This symbol is retained in the
 * Emscripten artifact but is intentionally absent from the worker/protocol:
 * it is a native-shim diagnostic, not part of the Larn Module interface. */
EMSCRIPTEN_KEEPALIVE void
vect_larn_test_set_blind(int turns, int hide_x, int hide_y)
{
	c[BLINDCOUNT] = turns;
	/* Make the target deterministically differ from the last public batch:
	 * movement still succeeds (item/mitem are untouched), but a live map
	 * query would now report unseen terrain and fail the contract gate. */
	if (hide_x >= 0 && hide_x < MAXX && hide_y >= 0 && hide_y < MAXY)
		know[hide_x][hide_y] = 0;
}

EMSCRIPTEN_KEEPALIVE void
vect_larn_test_put_gold_under_hero(void)
{
	item[playerx][playery] = OGOLDPILE;
	iarg[playerx][playery] = 1;
	know[playerx][playery] = 1;
}

/* Map/Look contract: traps are generated at random depths and never appear
 * in the town the contract fixture plays. Plant only the bounded fixture set
 * (visible traps, hidden traps, pit and floor for cleanup). The read-back
 * hook is what keeps that test from being vacuous: a concealed trap is
 * byte-identical to floor in the public record, by design, so nothing the
 * Module exports can confirm the plant landed. Same rule as set_blind above:
 * retained in the artifact, absent from the worker protocol. */
EMSCRIPTEN_KEEPALIVE void
vect_larn_test_put_trap(int x, int y, int it)
{
	if (x < 0 || x >= MAXX || y < 0 || y >= MAXY)
		return;
	switch (it) {
	case 0:
	case OTELEPORTER:
	case OTRAPARROW:
	case ODARTRAP:
	case OTRAPDOOR:
	case OIVTELETRAP:
	case OTRAPARROWIV:
	case OIVDARTRAP:
	case OIVTRAPDOOR:
	case OPIT:
		break;
	default:
		return;
	}
	item[x][y] = it;
	iarg[x][y] = 0;
	know[x][y] = 1;
}

EMSCRIPTEN_KEEPALIVE int
vect_larn_test_item_at(int x, int y)
{
	if (x < 0 || x >= MAXX || y < 0 || y >= MAXY)
		return -1;
	return item[x][y];
}

/* KIND_NAMES indices — mirror mapRecords.ts ordering (0..21).
 * Slots 13 and 18..20 are retained for historical records, never emitted. */
#define KIND_NONE          0
#define KIND_ALTAR         1
#define KIND_THRONE        2
#define KIND_DEAD_THRONE   3
#define KIND_STATUE        4
#define KIND_FOUNTAIN      5
#define KIND_DEAD_FOUNTAIN 6
#define KIND_SCHOOL        7
#define KIND_BANK          8
#define KIND_STORE         9
#define KIND_TRADE         10
#define KIND_LRS           11
#define KIND_MIRROR        12
#define KIND_TELEPORTER    13
#define KIND_HOME          14
#define KIND_PIT           15
#define KIND_UP            16
#define KIND_DOWN          17
#define KIND_TRAP_DOOR     18
#define KIND_TRAP_DART     19
#define KIND_TRAP_ARROW    20
#define KIND_TRAP          21

/* ANSI-16 palette indices (src/render/colors.ts). Terrain by category;
 * occupant colours: hero=white(15), monster=red(1), item=yellow(11). */
#define COLOR_FLOOR    7  /* gray */
#define COLOR_WALL     6  /* cyan */
#define COLOR_DOOR     3  /* brown */
#define COLOR_STAIRS   15 /* white */
#define COLOR_FEATURE  5  /* magenta */
#define COLOR_TRAP     1  /* red */
#define COLOR_HERO     15 /* white */
#define COLOR_MONSTER  1  /* red */
#define COLOR_ITEM     11 /* yellow */

/* terrain_identity: map an item[] cell to a {category, kind} pair, exactly
 * grouping Larn's object IDs (header.h:159-261) the way drawscreen renders
 * them. Carryables and empty floor (item==0) collapse to FLOOR; the
 * occupant step decides whether a carryable becomes TOP_ITEM. Hidden trap
 * variants render as floor (their objnamelist entry is a space). */
static void
terrain_identity(u_char it, int *cat, int *kind)
{
	*kind = KIND_NONE;
	switch (it) {
	case 0:
		*cat = TERRAIN_FLOOR;
		break;
	case OWALL:
		*cat = TERRAIN_WALL;
		break;
	case OCLOSEDDOOR:
		*cat = TERRAIN_DOOR;
		break;
	case OOPENDOOR:
		*cat = TERRAIN_DOOR_OPEN;
		break;
	case OSTAIRSUP:
	case OELEVATORUP:
	case OVOLUP:
		*cat = TERRAIN_STAIRS;
		*kind = KIND_UP;
		break;
	case OSTAIRSDOWN:
	case OELEVATORDOWN:
	case OVOLDOWN:
	case OENTRANCE:
		*cat = TERRAIN_STAIRS;
		*kind = KIND_DOWN;
		break;
	case OALTAR:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_ALTAR;
		break;
	case OTHRONE:
	case OTHRONE2:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_THRONE;
		break;
	case ODEADTHRONE:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_DEAD_THRONE;
		break;
	case OSTATUE:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_STATUE;
		break;
	case OFOUNTAIN:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_FOUNTAIN;
		break;
	case ODEADFOUNTAIN:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_DEAD_FOUNTAIN;
		break;
	case OSCHOOL:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_SCHOOL;
		break;
	case OBANK:
	case OBANK2:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_BANK;
		break;
	case ODNDSTORE:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_STORE;
		break;
	case OTRADEPOST:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_TRADE;
		break;
	case OLRS:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_LRS;
		break;
	case OMIRROR:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_MIRROR;
		break;
	case OHOME:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_HOME;
		break;
	case OPIT:
		*cat = TERRAIN_FEATURE;
		*kind = KIND_PIT;
		break;
	case OTELEPORTER:
	case OTRAPDOOR:
	case ODARTRAP:
	case OTRAPARROW:
		*cat = TERRAIN_TRAP;
		*kind = KIND_TRAP;
		break;
	/* Hidden trap variants: the player does not see them. drawscreen/
	 * showcell print objnamelist[<hidden>] which is a space — render as
	 * floor so the cell reads as empty, not as a visible trap. */
	case OIVTELETRAP:
	case OTRAPARROWIV:
	case OIVDARTRAP:
	case OIVTRAPDOOR:
		*cat = TERRAIN_FLOOR;
		break;
	/* OANNIHILATION is a moving sphere of annihilation (monster.c:1797),
	 * not terrain — terrain is floor; the sphere is emitted as an occupant
	 * effect in larn_map_info. */
	case OANNIHILATION:
		*cat = TERRAIN_FLOOR;
		break;
	default:
		/* Carryables (gold/armor/weapon/ring/scroll/potion/book/chest/
		 * amulet/gem/cookie/urn/...) sit on floor; the occupant step
		 * promotes them to TOP_ITEM when their glyph is visible. */
		*cat = TERRAIN_FLOOR;
		break;
	}
}

static void
larn_map_info(int x, int y, int include_hero, int32_t *out)
{
	u_char it, mt;
	int cat, kind, ch, i;

	for (i = 0; i < GRID_STRIDE; i++)
		out[i] = 0;
	out[GRID_X] = x;
	out[GRID_Y] = y;

	if (know[x][y] == 0) {
		out[GRID_TERRAIN_CAT] = TERRAIN_UNSEEN;
		/* The player always knows their own position, even on a cell the
		 * know[] array has not lit (it has, in practice). */
		if (include_hero && x == playerx && y == playery) {
			out[GRID_TOP_CAT] = TOP_HERO;
			out[GRID_TOP_CHAR] = '@';
			out[GRID_TOP_COLOR] = COLOR_HERO;
		}
		return;
	}

	it = item[x][y];
	mt = mitem[x][y];

	/* Terrain. */
	terrain_identity(it, &cat, &kind);
	out[GRID_TERRAIN_CAT] = cat;
	out[GRID_TERRAIN_CHAR] = objnamelist[it];
	out[GRID_TERRAIN_KIND] = kind;
	switch (cat) {
	case TERRAIN_WALL:      out[GRID_TERRAIN_COLOR] = COLOR_WALL; break;
	case TERRAIN_DOOR:      out[GRID_TERRAIN_COLOR] = COLOR_DOOR; break;
	case TERRAIN_DOOR_OPEN: out[GRID_TERRAIN_COLOR] = COLOR_DOOR; break;
	case TERRAIN_STAIRS:    out[GRID_TERRAIN_COLOR] = COLOR_STAIRS; break;
	case TERRAIN_FEATURE:   out[GRID_TERRAIN_COLOR] = COLOR_FEATURE; break;
	case TERRAIN_TRAP:      out[GRID_TERRAIN_COLOR] = COLOR_TRAP; break;
	default:                out[GRID_TERRAIN_COLOR] = COLOR_FLOOR; break;
	}

	/* Occupant (mirrors drawscreen's precedence: monster > sphere >
	 * carryable; the optional semantic hero overrides the source occupant). */
	if (mt != 0) {
		ch = monstnamelist[mt];
		if (ch != ' ') {
			out[GRID_TOP_CAT] = TOP_MONSTER;
			out[GRID_TOP_CHAR] = ch;
			out[GRID_TOP_COLOR] = COLOR_MONSTER;
		}
	} else if (it == OANNIHILATION) {
		ch = objnamelist[it];
		if (ch != ' ') {
			out[GRID_TOP_CAT] = TOP_MONSTER;
			out[GRID_TOP_CHAR] = ch;
			out[GRID_TOP_COLOR] = COLOR_MONSTER;
		}
	} else if (cat == TERRAIN_FLOOR && it != 0) {
		ch = objnamelist[it];
		if (ch != ' ') {
			out[GRID_TOP_CAT] = TOP_ITEM;
			out[GRID_TOP_CHAR] = ch;
			out[GRID_TOP_COLOR] = COLOR_ITEM;
		}
	}
	if (include_hero && x == playerx && y == playery) {
		out[GRID_TOP_CAT] = TOP_HERO;
		out[GRID_TOP_CHAR] = '@';
		out[GRID_TOP_COLOR] = COLOR_HERO;
	}
}

/* Look HUD (spec 2026-08-18). Larn has no look command, so this follows Larn's
 * own step-on wording (object.c's lookforobject) and the visibility rules the
 * map draw itself uses — the same monstnamelist/objnamelist space test
 * larn_map_info applies, so nothing is named that the map does not already
 * show. Table lookups and one snprintf into a static buffer; no allocation,
 * no output, no RNG. */
EMSCRIPTEN_KEEPALIVE const char *
vect_larn_describe(int x, int y)
{
	static char buf[128];
	u_char it, mt;
	int i;

	if (x < 0 || x >= MAXX || y < 0 || y >= MAXY)
		return NULL;
	if (x == playerx && y == playery)
		return "you";
	/* The map replays its blind shadow rather than live item/mitem/know
	 * (see the dirty guard below); naming from the live arrays would undo
	 * exactly that. */
	if (c[BLINDCOUNT])
		return NULL;
	if (know[x][y] == 0)
		return NULL;

	mt = mitem[x][y];
	if (mt != 0 && monstnamelist[mt] != ' ')
		return monster[mt].name;

	it = item[x][y];
	/* One test for every cell the map draws blank: objnamelist is a space
	 * for empty floor (index 0) and for exactly the four hidden trap
	 * variants (OTRAPARROWIV, OIVDARTRAP, OIVTRAPDOOR, OIVTELETRAP —
	 * data.c:179 has spaces at 0, 67, 73, 76, 78 and nowhere else), so all
	 * five get the same answer.
	 *
	 * Answering NULL for the traps was a leak, not a courtesy: the label
	 * would then say what the map refuses to. Hover along a corridor, every
	 * cell reads "Floor", and the one that goes silent is a trap the player
	 * has not found — a detector built out of a hole. NULL is reserved for
	 * "I cannot see this at all"; a concealed thing is answered with its
	 * disguise, which is what the siblings do (Moria names a secret door
	 * "a granite wall", semantic-wasm.cpp; Angband lets an unseen trap fall
	 * through to square_apparent_name). */
	if (objnamelist[it] == ' ')
		return "floor";

	switch (it) {
	case OTELEPORTER:
	case OTRAPARROW:
	case ODARTRAP:
	case OTRAPDOOR:
		return "a trap";
	case OPOTION:
		i = iarg[x][y];
		if (potionname[i][0] != 0) {
			(void)snprintf(buf, sizeof(buf), "a magic potion of%s",
			    potionname[i]);
			return buf;
		}
		return "a magic potion";
	case OSCROLL:
		i = iarg[x][y];
		if (scrollname[i][0] != 0) {
			(void)snprintf(buf, sizeof(buf), "a magic scroll of%s",
			    scrollname[i]);
			return buf;
		}
		return "a magic scroll";
	case OMAXGOLD:
	case OKGOLD:
	case ODGOLD:
		return "gold";
	default:
		/* objectname[] is Larn's own wording, articles included, and
		 * covers every terrain fixture the classifier's kind table
		 * names. A NULL entry is an object with no name of its own. */
		return objectname[it] ? objectname[it] : NULL;
	}
}

/* ---- Dirty guard + overlay detection ----
 * map_dirty is set by the --wrap=showcell/--wrap=drawscreen wrappers before
 * the real function runs, so any lflush() that follows packs the map. Intra-
 * TU calls within display.c (draws()->drawscreen(), seemagic()->drawscreen())
 * are not wrapped, but the next cross-TU showcell/drawscreen catches up —
 * acceptable (Codex flagged packing on every lflush; this avoids it for the
 * common side-panel-only flushes).
 *
 * Overlay heuristic: there is no save_screen/restore_screen in 12.0. A bare
 * CLEAR not preceded by a wrapped map draw means a full-screen screen started
 * via clear(). Small inventory/listing screens instead begin with
 * cl_up(79,n), whose decoded signature is CL_LINE at the top-left while no
 * map draw is dirty. Either signature opens the full-term overlay.
 *
 * Non-blind drawscreen()/draws() set map_dirty before terminal output; blind
 * calls mark a shadow replay instead. Either flush closes any overlay marker
 * before its transition is emitted. The draws wrapper matters for inventory's
 * t_endup(): it redraws only the rows cl_up() borrowed without making a
 * cross-TU drawscreen() call.
 */
static int map_dirty = 0;
static int blind_hero_dirty = 0;
static int blind_shadow_dirty = 0;
static int blind_xmin, blind_xmax, blind_ymin, blind_ymax;
static int overlay_active = 0;
static int overlay_emitted = -1;
static int last_level = -1;
/* Last records actually transmitted by a full map batch. While blind, the
 * live item[]/mitem[]/know[] arrays continue changing; querying them to move
 * the semantic hero would reveal state showcell deliberately suppressed.
 * Keep the last public record for every cell and build the old/new hero delta
 * only from this shadow. At the hero cell, TOP is cleared in the shadow so
 * leaving it restores the previously public terrain rather than a stale @. */
static int32_t map_shadow[MAXX * MAXY * GRID_STRIDE];
static int map_shadow_valid = 0;
static int last_hero_x = -1, last_hero_y = -1;

void __real_showcell(int, int);
void
__wrap_showcell(int x, int y)
{
	/* showcell() returns immediately when c[BLINDCOUNT] is set
	 * (display.c:381-382) — it renders nothing while blind. Gate the
	 * dirty mark on blindness so a blind showcell (player movement)
	 * does not cause flush_map to pack current mitem[] positions on
	 * known cells, which would show monsters moving the blind player
	 * cannot see. Explicit blind redraws are handled separately from the
	 * last-transmitted shadow. */
	if (!c[BLINDCOUNT])
		map_dirty = 1;
	else
		blind_hero_dirty = 1;
	__real_showcell(x, y);
}

void __real_drawscreen(void);
void
__wrap_drawscreen(void)
{
	if (!c[BLINDCOUNT])
		map_dirty = 1;
	else {
		blind_shadow_dirty = 1;
		blind_xmin = blind_ymin = 0;
		blind_xmax = MAXX;
		blind_ymax = MAXY;
		blind_hero_dirty = 1;
	}
	__real_drawscreen();
}

void __real_draws(int, int, int, int);
void
__wrap_draws(int xmin, int xmax, int ymin, int ymax)
{
	if (!c[BLINDCOUNT])
		map_dirty = 1;
	else {
		if (!blind_shadow_dirty) {
			blind_xmin = xmin;
			blind_xmax = xmax;
			blind_ymin = ymin;
			blind_ymax = ymax;
		} else {
			if (xmin < blind_xmin) blind_xmin = xmin;
			if (xmax > blind_xmax) blind_xmax = xmax;
			if (ymin < blind_ymin) blind_ymin = ymin;
			if (ymax > blind_ymax) blind_ymax = ymax;
		}
		blind_shadow_dirty = 1;
		blind_hero_dirty = 1;
	}
	__real_draws(xmin, xmax, ymin, ymax);
}

static void
emit_overlay(void)
{
	if (overlay_emitted != overlay_active) {
		overlay_emitted = overlay_active;
		EM_ASM({ globalThis.VectLarn.overlay($0); }, overlay_active);
	}
}

/* flush_map: pack the whole MAXX*MAXY grid and push it as one mapBatch of
 * GRID_STRIDE-word records. malloc/free are libc (no EXPORTED_FUNCTIONS
 * entry — Larn already allocates via libc). Called only when map_dirty. */
static void
flush_map(void)
{
	int total, x, y, i;
	int32_t *buf;

	if (!map_dirty)
		return;
	map_dirty = 0;
	if (level != last_level) {
		last_level = (int)level;
		EM_ASM({ globalThis.VectLarn.level($0, $1); }, MAXX, MAXY);
	}
	total = MAXX * MAXY * GRID_STRIDE;
	buf = malloc((size_t)total * sizeof(*buf));
	if (!buf)
		return;
	i = 0;
	for (y = 0; y < MAXY; y++)
		for (x = 0; x < MAXX; x++) {
			int32_t *shadow;
			larn_map_info(x, y, 1, buf + i);
			shadow = map_shadow + i;
			if (x == playerx && y == playery)
				larn_map_info(x, y, 0, shadow);
			else
				memcpy(shadow, buf + i, GRID_STRIDE * sizeof(*shadow));
			i += GRID_STRIDE;
		}
	EM_ASM({ globalThis.VectLarn.mapBatch(HEAP32.subarray($0 >> 2, ($0 >> 2) + $1)); },
		buf, total);
	free(buf);
	map_shadow_valid = 1;
	last_hero_x = playerx;
	last_hero_y = playery;
	blind_hero_dirty = 0;
	blind_shadow_dirty = 0;
	/* The map is being redrawn — any full-screen overlay has closed. */
	overlay_active = 0;
}
/* ---- Status tap ----
 * Mirrors src/modules/larn/statusRecords.ts word for word. The projection is
 * WHAT THE SCREEN PRINTS: bot_linex()'s scalars (display.c:66-95), botside()'s
 * labels as presence bits (display.c:177-220), qshowstr()'s two ROUNDED mobul
 * values (main.c:361), and show3()'s inventory rendering (main.c:604-643).
 * Raw gltime, raw ivenarg and the TELEFLAG-hidden level never cross.
 *
 * Pushed from lflush() beside flush_map(), never pulled: the headless gym
 * installs its own VectLarn bridge and never loads worker.ts, so a host-side
 * pull would not fire in the runner the baseline is measured with — and
 * calling a wasm export from inside the async bridge risks an Asyncify unwind
 * that exits the export half-done.
 */
#define ST_SPELLS 0
#define ST_SPELLMAX 1
#define ST_AC 2
#define ST_WC 3
#define ST_XLEVEL 4
#define ST_EXPERIENCE 5
#define ST_HP 6
#define ST_HPMAX 7
#define ST_STR 8
#define ST_INT 9
#define ST_WIS 10
#define ST_CON 11
#define ST_DEX 12
#define ST_CHA 13
#define ST_GOLD 14
#define ST_DEPTH 15
#define ST_MOBULS_ELAPSED 16
#define ST_MOBULS_LEFT 17
#define ST_FLAGS 18
#define ST_SLOTS 19
#define ST_NAME_BYTES 20
#define ST_HEADER 21
#define ST_SLOT_STRIDE 2
#define ST_SLOT_LETTER 0
#define ST_SLOT_CLASS 1
#define ST_DEPTH_UNKNOWN (-1)

#define ST_CLASS_NONE 0
#define ST_CLASS_POTION 1
#define ST_CLASS_SCROLL 2
#define ST_CLASS_PLAIN 3
#define ST_CLASS_ENCHANTED 4

/* iven[]/ivenarg[] are 26 entries (data.c:127-128); upstream's own `j <= 26`
 * loops read one past the end. 26 is the real slot count, and 'a' + k then
 * stays inside a-z as show1() prints it. */
#define ST_MAX_SLOTS 26
#define ST_NAMES_CAP 4096
#define ST_WORDS (ST_HEADER + ST_MAX_SLOTS * ST_SLOT_STRIDE)

/* bot_data[] order, display.c:183-199. The bit index is the array index, and
 * it is the same order as CONDITION_NAMES in statusRecords.ts — a
 * transposition here mislabels a condition forever. */
static const int status_flag_id[17] = {
	STEALTH, UNDEADPRO, SPIRITPRO, CHARMCOUNT, TIMESTOP, HOLDMONST, GIANTSTR,
	FIRERESISTANCE, DEXCOUNT, STRCOUNT, SCAREMONST, HASTESELF, CANCELLATION,
	INVISIBILITY, ALTPRO, PROTECTIONTIME, WTW
};

/* show3()'s own branching, not a taxonomy of our own: the PLAIN list is
 * exactly the set show3 passes to show1(NULL). */
static int
status_item_class(int obj)
{
	switch (obj) {
	case OPOTION:
		return ST_CLASS_POTION;
	case OSCROLL:
		return ST_CLASS_SCROLL;
	case OLARNEYE: case OBOOK: case OSPIRITSCARAB: case ODIAMOND: case ORUBY:
	case OCUBEofUNDEAD: case OEMERALD: case OCHEST: case OCOOKIE: case OSAPPHIRE:
	case ONOTHEFT:
		return ST_CLASS_PLAIN;
	default:
		return ST_CLASS_ENCHANTED;
	}
}

/* Reproduce show3()'s line for slot k (without its leading "\n%c)   ").
 * Identification is potionname[]/scrollname[] being non-empty — NOT know[][],
 * which is map visibility. show1() prints " of%s" and an identified name
 * carries its own leading space (data.c:338/374), so " of" concatenates
 * directly. Returns bytes written, excluding the NUL; cap is always >= 1, and
 * every append re-checks truncation, so a full buffer can never walk buf + n
 * past cap and spray the following statics. */
static int
status_item_name(int k, char *buf, int cap)
{
	int obj = iven[k];
	const char *extra = NULL;
	int n;

	if (obj == OPOTION)
		extra = potionname[ivenarg[k]];
	else if (obj == OSCROLL)
		extra = scrollname[ivenarg[k]];

	if (extra != NULL)
		n = snprintf(buf, (size_t)cap, "%s%s%s", objectname[obj],
			extra[0] ? " of" : "", extra[0] ? extra : "");
	else if (status_item_class(obj) == ST_CLASS_ENCHANTED && ivenarg[k] > 0)
		n = snprintf(buf, (size_t)cap, "%s + %ld", objectname[obj], (long)ivenarg[k]);
	else if (status_item_class(obj) == ST_CLASS_ENCHANTED && ivenarg[k] < 0)
		n = snprintf(buf, (size_t)cap, "%s %ld", objectname[obj], (long)ivenarg[k]);
	else
		n = snprintf(buf, (size_t)cap, "%s", objectname[obj]);
	if (n < 0 || n >= cap)
		return cap - 1;
	if (c[WIELD] == k) {
		int m = snprintf(buf + n, (size_t)(cap - n), " (weapon in hand)");
		if (m < 0 || m >= cap - n)
			return cap - 1;
		n += m;
	}
	if (c[WEAR] == k || c[SHIELD] == k) {
		int m = snprintf(buf + n, (size_t)(cap - n), " (being worn)");
		if (m < 0 || m >= cap - n)
			return cap - 1;
		n += m;
	}
	return n;
}

static int32_t status_buf[ST_WORDS];
static char status_names[ST_NAMES_CAP];
static int32_t status_last[ST_WORDS];
static char status_last_names[ST_NAMES_CAP];
static int status_last_valid = 0;

static void
flush_status(void)
{
	int i, k, slots = 0, off = 0, words;
	unsigned int flags = 0;

	memset(status_buf, 0, sizeof(status_buf));
	status_buf[ST_SPELLS] = (int32_t)c[SPELLS];
	status_buf[ST_SPELLMAX] = (int32_t)c[SPELLMAX];
	status_buf[ST_AC] = (int32_t)c[AC];
	status_buf[ST_WC] = (int32_t)c[WCLASS];
	status_buf[ST_XLEVEL] = (int32_t)c[LEVEL];
	status_buf[ST_EXPERIENCE] = (int32_t)c[EXPERIENCE];
	status_buf[ST_HP] = (int32_t)c[HP];
	status_buf[ST_HPMAX] = (int32_t)c[HPMAX];
	/* The status line prints the sum, not the base (display.c:81-82). */
	status_buf[ST_STR] = (int32_t)(c[STRENGTH] + c[STREXTRA]);
	status_buf[ST_INT] = (int32_t)c[INTELLIGENCE];
	status_buf[ST_WIS] = (int32_t)c[WISDOM];
	status_buf[ST_CON] = (int32_t)c[CONSTITUTION];
	status_buf[ST_DEX] = (int32_t)c[DEXTERITY];
	status_buf[ST_CHA] = (int32_t)c[CHARISMA];
	status_buf[ST_GOLD] = (int32_t)c[GOLD];
	/* bot_linex() clears TELEFLAG in town and in wizard mode before deciding
	 * to print "?", so the same two exceptions decide whether the level is
	 * public here. Reading, not clearing: the tap never writes engine state. */
	status_buf[ST_DEPTH] = (level != 0 && !wizard && c[TELEFLAG])
		? ST_DEPTH_UNKNOWN : (int32_t)level;
	/* qshowstr()'s two rounded values (main.c:361), never raw gltime. */
	status_buf[ST_MOBULS_ELAPSED] = (int32_t)((gltime + 99) / 100 + 1);
	status_buf[ST_MOBULS_LEFT] = (int32_t)((TIMELIMIT - gltime) / 100);

	/* Presence only: botside() prints the label, never the countdown. */
	for (i = 0; i < 17; i++)
		if (c[status_flag_id[i]])
			flags |= 1u << i;
	status_buf[ST_FLAGS] = (int32_t)flags;

	for (k = 0; k < ST_MAX_SLOTS; k++) {
		int n;
		if (!iven[k])
			continue;
		if (off + 1 >= ST_NAMES_CAP)
			break;
		n = status_item_name(k, status_names + off, ST_NAMES_CAP - off - 1);
		status_buf[ST_HEADER + slots * ST_SLOT_STRIDE + ST_SLOT_LETTER] = 'a' + k;
		status_buf[ST_HEADER + slots * ST_SLOT_STRIDE + ST_SLOT_CLASS] =
			status_item_class(iven[k]);
		off += n;
		status_names[off++] = '\0';
		slots++;
	}
	status_buf[ST_SLOTS] = slots;
	status_buf[ST_NAME_BYTES] = off;

	words = ST_HEADER + slots * ST_SLOT_STRIDE;
	/* The dirty check compares the COMPLETE serialized record, inventory
	 * bytes included: a renamed item with identical scalars is a change. */
	if (status_last_valid &&
	    memcmp(status_last, status_buf, (size_t)words * sizeof(int32_t)) == 0 &&
	    status_last[ST_NAME_BYTES] == off &&
	    memcmp(status_last_names, status_names, (size_t)off) == 0)
		return;
	memcpy(status_last, status_buf, sizeof(status_last));
	memcpy(status_last_names, status_names, (size_t)off);
	status_last_valid = 1;

	EM_ASM({
		globalThis.VectLarn.statusBatch(
			HEAP32.subarray($0 >> 2, ($0 >> 2) + $1),
			HEAPU8.subarray($2, $2 + $3));
	}, status_buf, words, status_names, off);
}

/* A blind explicit redraw (drawscreen/draws) must not turn the semantic map
 * into a live-state oracle. Replay only the requested rectangle from the
 * last public shadow. On a blind level transition there is no shadow for the
 * new level, so publish an unseen grid plus the known hero position; the
 * first non-blind showcell replaces it with a live full batch. */
static void
flush_blind_shadow(void)
{
	int x, y, i, width, height, total;
	int new_level;
	int32_t *buf, *src;

	if (!blind_shadow_dirty)
		return;
	blind_shadow_dirty = 0;
	new_level = (level != last_level);
	if (!map_shadow_valid || new_level) {
		memset(map_shadow, 0, sizeof(map_shadow));
		for (y = 0; y < MAXY; y++)
			for (x = 0; x < MAXX; x++) {
				src = map_shadow + (y * MAXX + x) * GRID_STRIDE;
				src[GRID_X] = x;
				src[GRID_Y] = y;
				src[GRID_TERRAIN_CAT] = TERRAIN_UNSEEN;
			}
		map_shadow_valid = 1;
		blind_xmin = blind_ymin = 0;
		blind_xmax = MAXX;
		blind_ymax = MAXY;
		last_level = (int)level;
		last_hero_x = playerx;
		last_hero_y = playery;
		blind_hero_dirty = 0;
		EM_ASM({ globalThis.VectLarn.level($0, $1); }, MAXX, MAXY);
	}

	if (blind_xmin < 0) blind_xmin = 0;
	if (blind_ymin < 0) blind_ymin = 0;
	if (blind_xmax > MAXX) blind_xmax = MAXX;
	if (blind_ymax > MAXY) blind_ymax = MAXY;
	width = blind_xmax - blind_xmin;
	height = blind_ymax - blind_ymin;
	if (width <= 0 || height <= 0)
		return;
	total = width * height * GRID_STRIDE;
	buf = malloc((size_t)total * sizeof(*buf));
	if (!buf)
		return;
	i = 0;
	for (y = blind_ymin; y < blind_ymax; y++)
		for (x = blind_xmin; x < blind_xmax; x++) {
			src = map_shadow + (y * MAXX + x) * GRID_STRIDE;
			memcpy(buf + i, src, GRID_STRIDE * sizeof(*buf));
			if (x == last_hero_x && y == last_hero_y) {
				buf[i + GRID_TOP_CAT] = TOP_HERO;
				buf[i + GRID_TOP_CHAR] = '@';
				buf[i + GRID_TOP_COLOR] = COLOR_HERO;
			}
			i += GRID_STRIDE;
		}
	EM_ASM({ globalThis.VectLarn.mapBatch(HEAP32.subarray($0 >> 2, ($0 >> 2) + $1)); },
		buf, total);
	free(buf);
	overlay_active = 0;
}

/* Move only the semantic hero while blind. Both records come from the last
 * full batch, so current monsters, objects, traps and unexplored terrain
 * remain private. VectorView applies record batches incrementally: restoring
 * the old cached record removes @, and overlaying @ on the new cached record
 * advances CellGrid.hero and therefore the camera. */
static void
flush_blind_hero(void)
{
	int32_t delta[GRID_STRIDE * 2];
	int32_t *old_shadow, *new_shadow;
	int total = GRID_STRIDE * 2;

	if (!blind_hero_dirty)
		return;
	blind_hero_dirty = 0;
	if (!map_shadow_valid || last_hero_x < 0 || last_hero_y < 0)
		return;
	if (last_hero_x == playerx && last_hero_y == playery)
		return;

	old_shadow = map_shadow +
		(last_hero_y * MAXX + last_hero_x) * GRID_STRIDE;
	new_shadow = map_shadow + (playery * MAXX + playerx) * GRID_STRIDE;
	memcpy(delta, old_shadow, GRID_STRIDE * sizeof(*delta));
	memcpy(delta + GRID_STRIDE, new_shadow, GRID_STRIDE * sizeof(*delta));
	delta[GRID_STRIDE + GRID_TOP_CAT] = TOP_HERO;
	delta[GRID_STRIDE + GRID_TOP_CHAR] = '@';
	delta[GRID_STRIDE + GRID_TOP_COLOR] = COLOR_HERO;

	EM_ASM({ globalThis.VectLarn.mapBatch(HEAP32.subarray($0 >> 2, ($0 >> 2) + $1)); },
		delta, total);
	last_hero_x = playerx;
	last_hero_y = playery;
}

/* ---- lflush() — Route A: replace the decoder ----
 * io.c:773 (the non-VT100 terminfo-mode lflush) is replaced at link time via
 * -Wl,--allow-multiple-definition with this definition listed before io.o.
 * It walks the same lpbuf->lpnt buffer io.c fills (the macros in header.h
 * write there), decodes the semantic bytes, and emits printable runs as
 * text(x,y,rgb,str) events. Cursor position is tracked across calls (static
 * curx/cury, matching io.c's own) so a draw that spans many lflush() calls
 * positions correctly.
 *
 * FILE OUTPUT SHARES THIS BUFFER. lcreat(fname)/lappend(fname) point
 * io_outfd at a real file and the same lprc/lwrite/lprintf calls then fill
 * lpbuf with file bytes — the save (savegame, diag.c:189), the scoreboard
 * (scores.c:155), the log and playerids. Decoding those as terminal bytes
 * would truncate every file Larn writes AND spray binary save data across
 * the grid (CLEAR=5 and CURSOR=15 are common bytes in a struct dump). So:
 * io_outfd > 2 means the buffer belongs to a file and is written raw,
 * mirroring upstream's enable_scroll <= -1 branch (io.c:784-790) — guarded
 * on the fd rather than the flag because diag() (diag.c:40) writes its file
 * without calling set_score_output(). io_outfd == 1 (the terminal, set by
 * lcreat((char*)0)) always decodes; the "literally printed" scoreboard on
 * the terminal is plain text and renders fine as text runs. */
static int curx = 0, cury = 0;
/* Wraparound type-out row for the message area, mirroring io.c:770's own
 * static: with no delete_line/insert_line capability (ours are NULL),
 * upstream's '\n'-at-bottom branch cycles rows 19-23 instead of scrolling. */
static int scrline = 18;
static int in_standout = 0, in_bold = 0;
static char runbuf[256];
static int runlen = 0;
static int runrgb = RGB_NORMAL;
static int runx = 0, runy = 0;

static void flush_run(void)
{
	if (runlen > 0) {
		runbuf[runlen] = '\0';
		wasm_text(runx, runy, runrgb, runbuf);
		runlen = 0;
	}
}

static void push_char(int ch)
{
	if (runlen >= (int)sizeof(runbuf) - 1)
		flush_run();
	if (runlen == 0) {
		runx = curx;
		runy = cury;
		runrgb = in_bold ? RGB_BOLD : (in_standout ? RGB_STANDOUT : RGB_NORMAL);
	}
	runbuf[runlen++] = (char)ch;
}

void
lflush(void)
{
	u_char *str;
	int lpoint;

	lpoint = lpnt - lpbuf;
	if (lpoint <= 0) {
		wasm_flush();
		flush_map();
		flush_status();
		flush_blind_shadow();
		flush_blind_hero();
		emit_overlay();
		return;
	}
	if (io_outfd > 2) {
		/* File bytes, not terminal output — see the header comment. */
		if (write(io_outfd, lpbuf, lpoint) != lpoint)
			fprintf(stderr, "larn: short write to output file\n");
		lpnt = lpbuf;
		return;
	}
	for (str = lpbuf; str < lpnt; str++) {
		int b = *str;
		if (b >= 32) {
			push_char(b);
			curx++;
		} else {
			switch (b) {
			case CLEAR:
				flush_run();
				/* Overlay heuristic: a CLEAR that arrives while map_dirty
				 * is NOT set means a full-screen screen started via a
				 * direct clear() call (welcome/creation/help/store/...).
				 * drawscreen's own clear() arrives with map_dirty already
				 * 1 (set by __wrap_drawscreen), so it does not trip this. */
				if (!map_dirty)
					overlay_active = 1;
				wasm_clear();
				curx = cury = 0;
				break;
			case CL_LINE:
				/* clr_eol: erase from the cursor to end of line. A real
				 * erase event, not a no-op — a shorter message would
				 * otherwise leave the previous line's tail on the grid.
				 * cl_up() starts a short inventory/listing by moving to
				 * top-left and clearing whole lines; unlike a map redraw,
				 * that arrives without either draw wrapper's dirty mark. */
				flush_run();
				if (!map_dirty && curx == 0 && cury == 0)
					overlay_active = 1;
				wasm_wipe(curx, cury, TERM_COLS - curx);
				break;
			case CL_DOWN:
				/* clr_eos: erase from the cursor to end of display —
				 * rest of this line, then every line below. */
				flush_run();
				wasm_wipe(curx, cury, TERM_COLS - curx);
				{
					int row;
					for (row = cury + 1; row < TERM_ROWS; row++)
						wasm_wipe(0, row, TERM_COLS);
				}
				break;
			case ST_START:
				flush_run();
				in_standout = 1;
				break;
			case ST_END:
				flush_run();
				in_standout = 0;
				break;
			case BOLD:
				flush_run();
				in_bold = 1;
				break;
			case END_BOLD:
				flush_run();
				in_bold = 0;
				break;
			case CURSOR:
				flush_run();
				str++;
				curx = (str < lpnt) ? (*str - 1) : curx;
				str++;
				cury = (str < lpnt) ? (*str - 1) : cury;
				break;
			case '\n':
				flush_run();
				/* io.c:826-871's bottom-row behavior, transliterated.
				 * enable_scroll must be exactly 1: upstream only reaches
				 * its decode loop with enable_scroll > -1, so truthy
				 * means 1 there — but WE also decode the ==-1 literal
				 * listings (upstream raw-writes those to stdout), and a
				 * listing must type down the page, not rotate the
				 * message region. */
				if (cury == TERM_ROWS - 1 && enable_scroll == 1) {
					/* The no-DL wraparound: advance the type-out row
					 * through 19-23, clear it and the row after, and
					 * continue there. Upstream moves only the physical
					 * cursor; we track it in cury, where the next
					 * printable run lands. */
					if (++scrline > 23) scrline = 19;
					if (++scrline > 23) scrline = 19;
					wasm_wipe(0, scrline, TERM_COLS);
					if (--scrline < 19) scrline = 23;
					wasm_wipe(0, scrline, TERM_COLS);
					cury = scrline;
				} else if (cury < TERM_ROWS - 1) {
					cury++;
				}
				/* At row 24 with scrolling off (a literal listing), the
				 * tail overwrites the bottom row — phase 1's accepted
				 * loss; the alternative is a scroll model in the grid. */
				curx = 0;
				break;
			case '\7':
				/* beep() (io.c:989, on by default): audible, not
				 * spatial. Emitting it as text shifted the next run one
				 * cell right (the bank screen beeps mid-line). A beep
				 * event is a phase-2 nicety; swallowing is correct. */
				flush_run();
				break;
			default:
				/* Other control bytes: emit literally and advance, as
				 * io.c's lflush default branch does (ttputch + curx++). */
				push_char(b);
				curx++;
				break;
			}
		}
	}
	lpnt = lpbuf;
	flush_run();
	/* Reposition the JS cursor where the engine left it, so the tty view
	 * can draw its cursor at the right cell for the next input prompt. */
	wasm_curs(curx, cury);
	wasm_flush();
	/* Pack + push the map if a showcell/drawscreen marked it dirty, then
	 * emit any overlay transition. The file-output branch returns above
	 * so this only runs on the terminal path. */
	flush_map();
	flush_status();
	flush_blind_shadow();
	flush_blind_hero();
	emit_overlay();
}

/* ---- init_term() — replaced with a no-op ----
 * io.c's init_term() calls setupterm() and sanity-checks the capability
 * globals; under WASM there is no terminfo db and our lflush() does the
 * decode, so init is a no-op. Replaced via --allow-multiple-definition. */
void
init_term(void)
{
}

/* ---- sigsetup() — replaced with a no-op ----
 * No signal handling under WASM (no tty, no SIGTSTP, no panic save on
 * SIGSEGV). The spike's netbsd_compat.h makes SIGEMT/sys_signame inert; this
 * keeps signal.c's handlers unregistered. Replaced via
 * --allow-multiple-definition. */
void
sigsetup(void)
{
}

/* ---- yylex() interception via --wrap=yylex: the command discriminator ----
 * yylex() (tok.c:38) is Larn's single command fetcher — parse() (main.c:672)
 * is its only caller (extern.h:223 is the only other mention). Every prompt
 * reads through ttgetch() instead, so "fd-0 read while inside yylex" is
 * exactly "Larn is asking for a command", the cmd flag the vector view's
 * gaze-relative movement arms on (ui/VectorView.ts; the Angband
 * commandInput pattern). Count digits also read inside yylex, so a typed
 * count prefix keeps command context for the direction key that follows.
 * The flag is a plain global: single-threaded, one Asyncify suspend at a
 * time, and a rewind re-enters __wrap_yylex without re-running its body, so
 * the value set on the first pass simply persists across the suspend. */
static int in_command_read = 0;
int __real_yylex(void);
int
__wrap_yylex(void)
{
	int r;

	in_command_read = 1;
	r = __real_yylex();
	in_command_read = 0;
	return r;
}

/* ---- read() interception via --wrap=read ----
 * fd 0 is the terminal: turn a 1-byte read into the Asyncify key wait, then
 * read back the byte wasm_gather_key delivered. Every other fd (save files,
 * score files, the help/maze data) is delegated to the real read. count is
 * 1 at every call site (ttgetch io.c:177; yylex tok.c:77/81/124; flushall
 * tok.c:124) — we return at most one byte regardless, matching read(2).
 * cmd distinguishes yylex's command read from every prompt read (above). */
ssize_t
__wrap_read(int fd, void *buf, size_t count)
{
	if (fd == 0) {
		(void)wasm_gather_key(1, in_command_read);
		if (count > 0) {
			((unsigned char *)buf)[0] = (unsigned char)wasm_key_code();
			return 1;
		}
		return 0;
	}
	return __real_read(fd, buf, count);
}

/* ---- ioctl() interception via --wrap=ioctl ----
 * tok.c's yylex() and flushall() poll fd 0 with FIONREAD to flush type-ahead.
 * Under WASM there is no kernel input queue; report none (ic = 0) so the
 * do/while in yylex falls straight through to the blocking read, and
 * flushall() returns immediately. Delegate every other ioctl to the real
 * one. */
int
__wrap_ioctl(int fd, unsigned long request, ...)
{
	if (fd == 0 && request == FIONREAD) {
		va_list ap;
		int *icp;
		va_start(ap, request);
		icp = va_arg(ap, int *);
		va_end(ap);
		if (icp) *icp = 0;
		return 0;
	}
	/* Non-FIONREAD-on-fd-0 ioctls are not used by Larn; return success
	 * rather than dragging in __real_ioctl's varargs shape. */
	return 0;
}

/* ---- died() interception via --wrap=died ----
 * died(int) (scores.c:593) is the engine's single end-of-game funnel:
 * death, win, save-and-quit, and several fault paths all go through it.
 * The S command (main.c:789-795) calls savegame(savefilename) then
 * died(-257); -257 is the save-and-quit code — scores.c:637-638 treats
 * x==257 (after negating) as `exit(0)` ("for ... saved game"), never
 * returning. The save wrapper, not this exit code, determines whether that
 * save succeeded: main.c ignores savegame()'s return value. A non--257
 * terminal path must clear any previous S-save state before exit.
 * died() is called cross-TU from main.c, monster.c, action.c, etc., so the
 * wrap catches every entry. died() CAN return (the LIFEPROT branch,
 * scores.c:625) — when it does, saved_game stays 0 and play continues,
 * which is correct (the death was averted). */
static int saved_game = 0;
void __real_died(int code);
void
__wrap_died(int code)
{
	/* Bounded before it is negated: -INT_MIN is undefined, and the table
	 * this indexes is far shorter than died()'s own x < 256 split. */
	int monst = (code > -(MAXMONST + 9) && code < MAXMONST + 9)
	    ? (code < 0 ? -code : code) : 0;

	if (code != -257)
		saved_game = 0;
	/* The killer's glyph, for the run digest (vect-hack-b5f.4).
	 * diedsub() (scores.c:734) prints "killed by a <monster[x].name>" for
	 * x < 256 and whydead[x-256] otherwise, so a small x is exactly the
	 * set of deaths a being caused, and monstnamelist[x] is the glyph the
	 * map drew that being as -- the same table, read the same way, as the
	 * map export above. Everything else (a trap, poison, a win, a quit)
	 * sends 0: the epitaph names no being, so there is no glyph to name.
	 *
	 * died()'s own split is x < 256, but monstnamelist is 129 bytes and
	 * monster[] ends at MAXMONST + 8 (data.c:220, "demon prince"); indices
	 * past it are the table's '.' filler, which would read as a glyph.
	 * The bound above is the monster table's, not died()'s.
	 *
	 * The monstnamelist[x] != ' ' test is the see-invisible rule, not a
	 * bounds guard: the engine mutates monstnamelist[INVISIBLESTALKER]
	 * between ' ' and 'I', so a space means the player never saw what
	 * killed them and the digest must not be told a glyph the screen
	 * refused to draw. The demon lords (57..64) are spaces too.
	 *
	 * Negative codes are "do not display the scores", not a different
	 * cause (died() negates them at scores.c:637), so the glyph comes off
	 * the magnitude. -257 is the save-and-quit code and falls outside the
	 * monster bound on its own.
	 *
	 * Sent before __real_died so it precedes the epitaph in the event
	 * stream, and withdrawn after: died() RETURNS in the life-protection
	 * branch (scores.c:625), and a death that was averted must not leave a
	 * killer behind. A re-entrant or repeated died() is harmless -- the
	 * digest reads the last death event, and whether the run ended at all
	 * is something it checks separately, so an interrupted withdrawal
	 * cannot promote an averted death into a killer. */
	wasm_death(monst != 0 && monstnamelist[monst] != ' ' ? monstnamelist[monst] : 0);
	__real_died(code);
	wasm_death(0);
}

/* ---- savegame() interception via --wrap=savegame ----
 * savegame(char *) (diag.c:179) writes either the checkpoint (ckpfile, every
 * CHECKPOINT_INTERVAL commands via tok.c:63) or the explicit S-save
 * (savefilename, via main.c:793). Either way the IDBFS volume must be flushed
 * after the write reaches disk so the save survives a tab close. Report only
 * a successful write: savegame() returns -1 after lcreat failure, but main.c
 * still calls died(-257) for S, so saved_game must likewise be armed only by
 * a successful write of savefilename. savegame is NO_ASYNCIFY
 * (larn-wasm.mk), so the wrapper calls __real_savegame (no unwind) then the
 * synchronous wasm_save_landed EM_JS (no suspend). Returns savegame's own int
 * (-1 on lcreat failure, 0 on success) so the caller's error path is
 * preserved. */
int __real_savegame(char *fname);
static int writing_save = 0;
int
__wrap_savegame(char *fname)
{
	int explicit_save = strcmp(fname, savefilename) == 0;
	int r;

	if (explicit_save)
		saved_game = 0;
	writing_save = 1;
	r = __real_savegame(fname);
	writing_save = 0;
	if (r == 0) {
		if (explicit_save)
			saved_game = 1;
		wasm_save_landed();
	}
	return r;
}

/* ---- portable save metadata over IDBFS ----
 * restoregame() (diag.c:313-340) treats a changed inode, ctime or mtime as
 * evidence that the player altered the save and sets `cheat`, excluding an
 * otherwise honest run from the scoreboard. IDBFS preserves file contents
 * and mtime, but reconstructs MEMFS nodes on every populate: the inode and
 * ctime therefore change on every legitimate reload.
 *
 * Keep upstream's save format and scoring rules intact while making only
 * those Unix-process-local fields portable. During savegame's fstat, report
 * inode zero; restoregame explicitly skips its inode comparison when the
 * stored value is zero. During restore's fstat, report zero ctime/mtime;
 * those cannot be later than the timestamp embedded in the save, so the two
 * volatile-time checks remain quiet. All other fstat calls see the real
 * metadata. This is deliberately source-pinned to diag.c's three checks. */
static int restoring_save = 0;
int __real_fstat(int fd, struct stat *st);
int
__wrap_fstat(int fd, struct stat *st)
{
	int r = __real_fstat(fd, st);
	if (r == 0 && writing_save && fd == io_outfd)
		st->st_ino = 0;
	if (r == 0 && restoring_save && fd == io_infd)
		st->st_ctime = st->st_mtime = 0;
	return r;
}

void __real_restoregame(char *fname);
void
__wrap_restoregame(char *fname)
{
	restoring_save = 1;
	__real_restoregame(fname);
	restoring_save = 0;
}

/* ---- readopts() interception via --wrap=readopts ----
 * .larnopts's `savefile:` strcpy()s a player-chosen path over savefilename
 * (tok.c:226-229) — the one durable path this shim does not already pin. It
 * cannot be honoured under WASM: every filesystem outside the mounted volume
 * is MEMFS that dies with the tab, and recovery is pinned to LARN_SAVEFILE
 * (main() below, and diag.c's restore at main.c:265). Left alone, an S-save
 * to a redirected path writes, returns 0, arms saved_game and reports
 * `saved: true` at exit — a success the next boot cannot honour.
 *
 * readopts() (main.c:235) is the only writer of savefilename after
 * main.c:120-121, and it runs before the restore at main.c:265 and before
 * any savegame(), so restoring the pinned path here confines every use of it.
 * Refuse the option, not the game: there is no way to edit .larnopts from
 * inside the browser, so failing the boot would leave a volume the player
 * could never open again. Every other .larnopts option still applies.
 * Announce it — silently rewriting a configured path would be the lie that
 * refusing it out loud is not. */
void __real_readopts(void);
void
__wrap_readopts(void)
{
	__real_readopts();
	if (strcmp(savefilename, LARN_SAVEFILE) != 0) {
		strcpy(savefilename, LARN_SAVEFILE);
		wasm_notice("Larn's savefile: option was ignored: saves stay in "
			    "this browser's save volume, the only storage this "
			    "game can be recovered from.");
	}
}

/* ---- exit() interception via --wrap=exit ----
 * Larn has no quit hook to install (unlike Angband's quit_aux): every
 * NORMAL, intentional ending — death and win via died() -> exit(0)
 * (scores.c:638/721/726), save-and-quit via died(-257), startup faults via
 * exit(1) — funnels through exit(2); upstream's play loop is while(1) and
 * never returns. Wrapping it is the one seam that reports "the game ended"
 * to the main thread before the runtime tears down. A wasm trap or JS error
 * bypasses this on purpose: those are faults, and they surface through the
 * worker's error handlers as the lifecycle `fatal` instead. wasm_quit is a
 * synchronous EM_JS call (no Asyncify suspend), so it is safe here; the
 * worker fills in storage state and posts the protocol `quit`. saved is 1
 * only when a successful S-save armed saved_game; the worker combines that
 * with the successful flush of the corresponding saved file. */
void __real_exit(int status);
void
__wrap_exit(int status)
{
	wasm_quit(saved_game ? 1 : 0);
	__real_exit(status);
}

/* ---- main() — the Larn startup sequence, own-main() flavour ----
 * Transliterated from external/larn/main.c:77-321 with the Unix-isms the
 * worker cannot satisfy (login-name discovery via getpwuid/getlogin, gid
 * games, HIDEBYLINK) replaced by fixed values rooted at /lib. main.c's own
 * main() is compiled out (-Dmain=larn_upstream_main) so its command
 * dispatcher (parse()) and inventory helpers (show3/qshowstr/parse2/
 * readnum) link; this main() is the entry emscripten calls.
 *
 * The writable paths (HOME=/lib/home, scores=/lib/scores) are seeded by
 * mountLarnStorage (src/modules/larn/persist.ts, Task 5) before main runs;
 * the read-only data (larn.help, larnmaze) is staged under /lib by
 * build-larn-wasm.sh's --preload-file lib@/lib. The _PATH_* overrides in
 * larn-wasm.mk point config.c's logfile/scorefile/playerids/larnlevels/
 * helpfile at those staged paths. */
/* Upstream main() is compiled as larn_upstream_main (via -Dmain=... on
 * main.c only); we call it after preparing the environment it cannot derive
 * under WASM. main.c holds parse() and the inventory helpers static to
 * itself, so reproducing the loop here would mean reproducing the whole
 * command dispatcher — delegation keeps it intact. */
int larn_upstream_main(int argc, char **argv);

int
main(int argc, char **argv)
{
	static char *restore_argv[] = { (char *)"larn", (char *)"++", NULL };

	/* Upstream main() derives the player identity from getpwuid(getuid())/
	 * getlogin and falls back to getenv("USER")/getenv("LOGNAME"); all of
	 * getpwuid/getlogin return NULL under Emscripten, and an unset USER
	 * makes upstream exit(1) at main.c:104. Put a deterministic name in the
	 * environment before delegating so the getenv branch succeeds. */
	setenv("USER", "Player", 1);
	setenv("LOGNAME", "Player", 1);
	/* Upstream builds savefilename/optsfile from getenv("HOME"); without it
	 * the save lands at ./Larn.sav (cwd-relative, outside the volume). Point
	 * HOME at /lib/home so the save and the .larnopts read/write root in the
	 * seeded writable dir (src/modules/larn/persist.ts). */
	setenv("HOME", "/lib/home", 1);

	/* Activate native checkpointing: ckpflag gates the
	 * `if ((c[BYTESIN] % CHECKPOINT_INTERVAL) == 0) savegame(ckpfile)` in
	 * yylex (tok.c:60-63). data.c initialises ckpflag to 0; readopts()
	 * (tok.c:190-191) only SETS it to 1 on `enable-checkpointing`, never
	 * clears it, so setting it here survives the .larnopts parse that
	 * larn_upstream_main runs at main.c:235. The checkpoint lands at
	 * ckpfile (/lib/home/Larn12.0.ckp, overridden above) — inside the
	 * volume — so a tab close between checkpoints keeps the last one. */
	ckpflag = 1;

	/* ++ recovery: a tab that closed without an explicit S-save has no
	 * Larn.sav but may have a checkpoint. main.c:223-232 reads argv
	 * {"larn","++"} as "restore from ckpfile": it sets restorflag/hitflag,
	 * calls restoregame(ckpfile), then `i = argc` ends the arg loop and
	 * play continues (c[HP] is non-zero after restore, so the makeplayer/
	 * newcavelevel/welcome branch at main.c:274-281 is skipped). A normal
	 * boot (Larn.sav present) lets main.c:265-269 restore from savefilename
	 * as usual; a clean boot (neither) starts fresh. Only fall back to the
	 * checkpoint when the explicit save is absent, so an S-save always
	 * wins over an older checkpoint. */
	if (access(LARN_SAVEFILE, 0) != 0 &&
	    access("/lib/home/Larn12.0.ckp", 0) == 0) {
		return larn_upstream_main(2, restore_argv);
	}
	/* argc/argv from emscripten is {""} (argc=1) — harmless for upstream,
	 * which starts its arg loop at i=1. Pass it through untouched on the
	 * non-recovery path. */
	return larn_upstream_main(argc, argv);
}

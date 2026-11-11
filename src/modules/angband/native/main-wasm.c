/**
 * \file main-wasm.c
 * \brief VectHack front end: Angband 4.2.6 in a Web Worker via Emscripten.
 *
 * Own-main() flavour (documented in upstream src/main-xxx.c): this file
 * supplies main(), so upstream main.c/main.o are simply not linked and the
 * upstream tree is never edited. Transliterated from Shelob's
 * main-emscripten.c (Angband 3.4.1) onto the 4.2.6 hook set; lives in the
 * VectHack repo and is compiled with -I external/angband/src.
 *
 * GPLv2 section 2(a) notice: this file is modified from Shelob's
 * main-emscripten.c. Changed by VectHack on 2026-08-02, 2026-08-03,
 * 2026-08-04, 2026-08-18, 2026-08-21 and 2026-11-11. Later modifiers should
 * append the date of their change here.
 *
 * The JS side of every EM_*JS block is globalThis.VectAngband, installed by
 * src/modules/angband/worker.ts (browser) or scripts/test/test-angband-boot.mjs
 * (node) before the module is instantiated.
 *
 * This work is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation, version 2.
 */
#include "angband.h"
#include "cave.h"
#include "cmd-core.h"      /* cmd_get_hook */
#include "game-event.h"
#include "game-world.h"    /* character_generated */
#include "init.h"          /* init_file_paths, create_needed_dirs, init_angband, ANGBAND_SYS */
#include "mon-desc.h"      /* monster_desc, MDESC_IND_VIS */
#include "mon-predicate.h" /* monster_is_obvious */
#include "obj-desc.h"      /* object_desc, ODESC_PREFIX, ODESC_FULL */
#include "obj-ignore.h"    /* ignore_known_item_ok */
#include "player-timed.h"  /* TMD_IMAGE */
#include "project.h"
#include "target.h"        /* look_mon_desc */
#include "trap.h"
#include "ui-display.h"    /* init_display */
#include "ui-game.h"       /* play_game, savefile_set_name, textui_get_cmd */
#include "ui-init.h"       /* textui_init */
#include "ui-input.h"      /* pause_line, inkey_flag */
#include "ui-map.h"
#include "ui-object.h"
#include "ui-output.h"     /* screen_save_depth */
#include "ui-prefs.h"      /* arg_name, display tables */
#include "ui-term.h"       /* term, Term_*, TERM_XTRA_* */
#include "borg/borg.h"     /* borg_cfg, BORG_DELAY_FACTOR, inkey_hack (ALLOW_BORG) */
#include "z-color.h"       /* angband_color_table, MAX_COLORS */
#include "z-util.h"        /* argv0, quit_aux, quit, my_strcpy */
#include "z-virt.h"        /* string_make, string_free */

#include <locale.h>
#include <emscripten/emscripten.h>

static term wasm_term;

#define VECT_MAX_COLS 198
#define VECT_MAX_ROWS 66
#define GRID_STRIDE 15

enum {
	GRID_X, GRID_Y, GRID_FEATURE, GRID_FLAGS, GRID_LIGHTING,
	GRID_TOP_COLOR, GRID_TOP_RGB, GRID_TOP_CHAR,
	GRID_TERRAIN_COLOR, GRID_TERRAIN_RGB, GRID_TERRAIN_CHAR,
	GRID_TRAP_COLOR, GRID_TRAP_RGB, GRID_TRAP_CHAR, GRID_TRAP_KIND
};

enum {
	GRID_FLAG_PLAYER = 1 << 0,
	GRID_FLAG_MONSTER = 1 << 1,
	GRID_FLAG_PILE = 1 << 2,
	GRID_FLAG_OBJECT = 1 << 3,
	GRID_FLAG_UNSEEN_OBJECT = 1 << 4,
	GRID_FLAG_UNSEEN_MONEY = 1 << 5,
	GRID_FLAG_HALLUCINATE = 1 << 6,
	GRID_FLAG_IN_VIEW = 1 << 7
};

static uint8_t dirty[VECT_MAX_ROWS][VECT_MAX_COLS];
static bool dirty_all;
static bool dirty_fallback;

/* 24-bit rgb for an attribute index; background/reverse bits folded away
 * (Shelob left the reverse-video bit as a TODO too). */
static uint32_t rgb_from_attr(int a)
{
	int idx = (a & 0x7f) % MAX_COLORS;
	return ((uint32_t)angband_color_table[idx][1] << 16)
	     | ((uint32_t)angband_color_table[idx][2] << 8)
	     |  (uint32_t)angband_color_table[idx][3];
}

static int vga_color(int a)
{
	int idx = (a & 0x7f) % MAX_COLORS;
	return color_table[idx].color_translate[ATTR_VGA];
}

/* ---- JS bridge: globalThis.VectAngband ---- */

/* Blocking (Asyncify) key wait — Angband's single suspend point: all
 * blocking funnels through Term_xtra(TERM_XTRA_EVENT, wait=true) from
 * Term_inkey (external/angband/src/ui-term.c:2686). Returns 1 when a key is
 * available via wasm_key_code/wasm_key_mods. */
EM_ASYNC_JS(int, wasm_gather_key, (int wait, int cmd), {
	return globalThis.VectAngband.gatherKey(wait, cmd);
});
EM_JS(int, wasm_key_code, (), { return globalThis.VectAngband.keyCode(); });
EM_JS(int, wasm_key_mods, (), { return globalThis.VectAngband.keyMods(); });
/* Checkpoint cadence lives in JS (src/modules/angband/angbandCheckpoint.ts):
 * synchronous both ways, so the C side can ask inside an ordinary call. */
EM_JS(int, wasm_checkpoint_due, (), {
	return globalThis.VectAngband.checkpointDue() ? 1 : 0;
});
EM_JS(void, wasm_checkpoint_landed, (int ok), {
	globalThis.VectAngband.checkpointLanded(ok);
});
/* was_null distinguishes quit(NULL) — the clean end of a played game — from an
 * empty non-NULL string, which is neither that nor a quit_fmt engine fault. */
EM_JS(void, wasm_quit_js, (const char *msg, int was_null), {
	globalThis.VectAngband.quit(msg ? UTF8ToString(msg) : "", was_null ? 1 : 0);
});

/* ---- ui-term hooks (ui-term.h:213-230). pict/view_map/dblh/bigcurs stay
 * NULL: text-only front end, no tiles ever (license hygiene), and
 * ui-term.c null-checks the optional hooks (main-test.c precedent). ---- */

static void term_init_wasm(term *t) { (void)t; }
static void term_nuke_wasm(term *t) { (void)t; }

static errr term_text_wasm(int x, int y, int n, int a, const wchar_t *s)
{
	/* wchar_t is 4 bytes under Emscripten (UTF-32): hand JS the run as a
	 * HEAPU32 view, consumed synchronously on the other side. */
	EM_ASM({
		globalThis.VectAngband.text($0, $1, $2, $3, $4,
			HEAPU32.subarray($5 >> 2, ($5 >> 2) + $2));
	}, x, y, n, a, rgb_from_attr(a), s);
	return 0;
}

static errr term_wipe_wasm(int x, int y, int n)
{
	EM_ASM({ globalThis.VectAngband.wipe($0, $1, $2); }, x, y, n);
	return 0;
}

static errr term_curs_wasm(int x, int y)
{
	EM_ASM({ globalThis.VectAngband.curs($0, $1); }, x, y);
	return 0;
}

/* ---- Public game-event observation tap ---- */

static int cave_width(void)
{
	return cave ? MIN(cave->width, VECT_MAX_COLS) : 0;
}

static int cave_height(void)
{
	return cave ? MIN(cave->height, VECT_MAX_ROWS) : 0;
}

static void on_map(game_event_type type, game_event_data *data, void *user)
{
	(void)type;
	(void)user;
	if (data->point.x < 0 || data->point.y < 0) {
		dirty_all = true;
	} else if (data->point.x < VECT_MAX_COLS && data->point.y < VECT_MAX_ROWS) {
		dirty[data->point.y][data->point.x] = 1;
	}
}

static void on_itemlist(game_event_type type, game_event_data *data, void *user)
{
	(void)type;
	(void)data;
	(void)user;
	dirty_fallback = true;
}

static void on_level(game_event_type type, game_event_data *data, void *user)
{
	(void)type;
	(void)data;
	(void)user;
	dirty_all = true;
	EM_ASM({ globalThis.VectAngband.level($0, $1); }, cave_width(), cave_height());
}

static void on_message(game_event_type type, game_event_data *data, void *user)
{
	(void)type;
	(void)user;
	EM_ASM({ globalThis.VectAngband.message(UTF8ToString($0), $1); },
		data->message.msg, data->message.type);
}

static void bolt_pict_wasm(int y, int x, int ny, int nx, int typ,
		int *a, wchar_t *c)
{
	int motion;

	if (ny == y && nx == x) motion = BOLT_NO_MOTION;
	else if (nx == x) motion = BOLT_0;
	else if (ny - y == x - nx) motion = BOLT_45;
	else if (ny == y) motion = BOLT_90;
	else if (ny - y == nx - x) motion = BOLT_135;
	else motion = BOLT_NO_MOTION;

	if (!use_graphics) {
		static const wchar_t chars[] = L"*|/-\\";
		*c = chars[motion];
		*a = projections[typ].color;
	} else {
		*a = proj_to_attr[typ][motion];
		*c = proj_to_char[typ][motion];
	}
}

/**
 * Effects are queued, not posted, and released after the map batch of the next
 * TERM_XTRA_FRESH.
 *
 * An effect Cell is the one Cell the record stream never retracts: what clears
 * it is the engine repainting that grid. Posting an effect the moment its
 * event fires puts it on the grid *before* the fresh whose flush_map() repaints
 * the same grid, so the blast is erased in the same millisecond it arrived and
 * no rendered frame ever contains it. Angband's own display handlers
 * (ui-display.c display_bolt/display_explosion) draw a step, Term_fresh(), then
 * Term_xtra(TERM_XTRA_DELAY, delay_factor) — releasing after the batch puts the
 * effect on screen for exactly that delay, and the next step's repaint clears
 * it. arm_effect_handlers() is what keeps ours running first, so the queue is
 * always full before the animation's first fresh.
 */
struct pending_effect {
	int x, y;
	uint32_t codepoint;
	int color;
	uint32_t rgb;
	bool beam;
};

/* A blast is bounded by its radius; drop the tail rather than grow or crash. */
#define VECT_MAX_EFFECTS 1024
static struct pending_effect effects[VECT_MAX_EFFECTS];
static int n_effects;

static void post_effect(int x, int y, wchar_t c, int a, bool beam)
{
	struct pending_effect *e;

	if (n_effects >= VECT_MAX_EFFECTS) return;
	e = &effects[n_effects++];
	e->x = x;
	e->y = y;
	e->codepoint = (uint32_t)c;
	e->color = vga_color(a);
	e->rgb = rgb_from_attr(a);
	e->beam = beam;
}

static void flush_effects(void)
{
	int i;

	for (i = 0; i < n_effects; i++) {
		const struct pending_effect *e = &effects[i];

		EM_ASM({ globalThis.VectAngband.effect($0, $1, $2, $3, $4, $5); },
			e->x, e->y, e->codepoint, e->color, e->rgb, e->beam ? 1 : 0);
	}
	n_effects = 0;
}

static void on_bolt(game_event_type type, game_event_data *data, void *user)
{
	int a;
	wchar_t c;
	(void)type;
	(void)user;
	if (!data->bolt.seen) return;
	bolt_pict_wasm(data->bolt.oy, data->bolt.ox, data->bolt.y,
		data->bolt.x, data->bolt.proj_type, &a, &c);
	post_effect(data->bolt.x, data->bolt.y, c, a, data->bolt.beam);
}

static void on_missile(game_event_type type, game_event_data *data, void *user)
{
	(void)type;
	(void)user;
	if (!data->missile.seen) return;
	post_effect(data->missile.x, data->missile.y,
		object_char(data->missile.obj), object_attr(data->missile.obj), false);
}

static void on_explosion(game_event_type type, game_event_data *data, void *user)
{
	int i;
	int a;
	wchar_t c;
	(void)type;
	(void)user;
	for (i = 0; i < data->explosion.num_grids; i++) {
		struct loc grid;
		if (!data->explosion.player_sees_grid[i]) continue;
		grid = data->explosion.blast_grid[i];
		bolt_pict_wasm(grid.y, grid.x, grid.y, grid.x,
			data->explosion.proj_type, &a, &c);
		post_effect(grid.x, grid.y, c, a, false);
	}
}

/**
 * Move our three effect observers to the head of their handler lists.
 *
 * Order is load-bearing here and must not be inherited from whenever main()
 * happened to register: Angband's own display handlers pace the animation
 * (draw a step, Term_fresh(), Term_xtra(TERM_XTRA_DELAY, delay_factor)), so an
 * observer that runs after them queues its effects once the animation is
 * already over — the blast reaches the semantic grid a frame after the last
 * delay and the next repaint erases it, which is exactly what the browser
 * composition check measured before this existed. Running first fills the
 * queue before the first fresh, so each of Angband's own delays is a frame the
 * effect Cells are actually on screen for.
 *
 * game-event.c adds handlers at the head, so a remove-then-add is a move to
 * the front whatever the current order is.
 *
 * Called from EVENT_ENTER_WORLD and nowhere else, because that is the only
 * place Angband undoes this: ui_enter_world re-adds display_bolt/missile/
 * explosion at the head every time it runs, and it runs at game start
 * (ui-game.c:752) and on leaving a store (ui-store.c:1322). One arming site
 * rather than a belt-and-braces second one, so the projection assertion in
 * scripts/dev/fp-controls-check.mjs is actually testing this: it fires its
 * blast in a game started that way, and would fail if the ordering here were
 * wrong. A store visit reaches the same handler.
 *
 * Both call sites are outside any effect dispatch, and that is a requirement,
 * not a coincidence: display_bolt calls Term_fresh() from inside the EVENT_BOLT
 * dispatch, so arming from the fresh hook (or from these handlers themselves)
 * would free a list entry while game_event_dispatch is walking it.
 */
static void arm_effect_handlers(void)
{
	event_remove_handler(EVENT_BOLT, on_bolt, NULL);
	event_remove_handler(EVENT_MISSILE, on_missile, NULL);
	event_remove_handler(EVENT_EXPLOSION, on_explosion, NULL);
	event_add_handler(EVENT_BOLT, on_bolt, NULL);
	event_add_handler(EVENT_MISSILE, on_missile, NULL);
	event_add_handler(EVENT_EXPLOSION, on_explosion, NULL);
}

/*
 * ?borg=<ms> pacing inside menus. The borg's only pause is once per dungeon
 * move (borg_think_dungeon, borg-think-dungeon.c:1161 and :1237); in the
 * inventory and in a store it queues a whole key sequence and hands each key
 * straight to inkey_ex through inkey_hack (ui-input.c:225), so the menu
 * flashes past at any pace. The borg installs that hook itself on activation
 * (borg.c:176) and clears it on its own way out (borg.c:179, :245), so rather
 * than patch the engine we stand in front of whatever borg hook is current,
 * re-checked on every term_xtra call. The borg reaches term_xtra itself before
 * its first key is read — its Term_fresh (borg.c:237) and its non-blocking
 * abort poll (borg.c:438) — so the wrapper is in place from its second key on.
 *
 * Only keys read while a screen is saved are paced: every inventory, object
 * and store menu opens with screen_save() (ui-object.c, ui-store.c), and the
 * dungeon already has its own pause, which this must not double. The pace is
 * the engine's own move pause, computed the way borg_think_dungeon computes
 * it, so menu and move agree by construction; borg_cfg is read per key
 * because the borg frees it (NULL) on its way out (borg-init.c:161).
 *
 * Nothing in a menu calls Term_fresh between drawing it and reading its key
 * (screen_save does not either), so the wrapper flushes the menu before it
 * sleeps — otherwise each pause would hold the frame from before the menu.
 * The sleep must stay here, after Term_fresh has returned: pace_borg_hook
 * runs under Term_fresh and Term_activate, both on the Asyncify removelist
 * (scripts/build/angband-wasm.mk), where a suspend corrupts the unwind.
 */
static struct keypress (*borg_hook)(int flush_first);
static bool borg_paced;
static int borg_menu_pauses;

static int borg_pace_ms(void)
{
	int f = borg_cfg ? borg_cfg[BORG_DELAY_FACTOR] : 0;
	int d = player->opts.delay_factor;
	return d * d + f * f;
}

static struct keypress paced_borg_hook(int flush_first)
{
	int ms = screen_save_depth > 0 ? borg_pace_ms() : 0;
	if (ms > 0) {
		Term_fresh();
		borg_menu_pauses++;
		emscripten_sleep(ms);
	}
	return borg_hook(flush_first);
}

static void pace_borg_hook(void)
{
	if (!borg_paced || !inkey_hack || inkey_hack == paced_borg_hook)
		return;
	borg_hook = inkey_hack;
	inkey_hack = paced_borg_hook;
}

/* How many menu keys were paced: the engine test's only view of the above. */
EMSCRIPTEN_KEEPALIVE int vect_angband_borg_menu_pauses(void)
{
	return borg_menu_pauses;
}

static void on_enter_world(game_event_type type, game_event_data *data, void *user)
{
	(void)type;
	(void)data;
	(void)user;
	arm_effect_handlers();

	/* ?borg=<ms> asked for a pace: the player's delay_factor (default 40)
	 * would add a 1.6s floor to every borg pause (see worker.ts), and the
	 * borg's menu keys get paced too (pace_borg_hook above). */
	borg_paced = EM_ASM_INT({ return globalThis.VectAngband.borgDelayMs === undefined ? 0 : 1; });
	if (borg_paced)
		player->opts.delay_factor = 0;
}

static int grid_flags(const struct grid_data *g)
{
	int flags = 0;
	if (g->is_player) flags |= GRID_FLAG_PLAYER;
	if (g->m_idx) flags |= GRID_FLAG_MONSTER;
	if (g->multiple_objects) flags |= GRID_FLAG_PILE;
	if (g->first_kind) flags |= GRID_FLAG_OBJECT;
	if (g->unseen_object) flags |= GRID_FLAG_UNSEEN_OBJECT;
	if (g->unseen_money) flags |= GRID_FLAG_UNSEEN_MONEY;
	if (g->hallucinate) flags |= GRID_FLAG_HALLUCINATE;
	if (g->in_view) flags |= GRID_FLAG_IN_VIEW;
	return flags;
}

static void pack_grid(int32_t *out, int x, int y)
{
	struct grid_data g;
	int a, ta;
	wchar_t c, tc;
	int trap_a = 0;
	wchar_t trap_c = 0;
	int trap_kind = 0;

	map_info(loc(x, y), &g);
	grid_data_as_text(&g, &a, &c, &ta, &tc);
	if (g.trap && (trf_has(g.trap->flags, TRF_VISIBLE) ||
			trf_has(g.trap->flags, TRF_GLYPH) ||
			trf_has(g.trap->flags, TRF_WEB))) {
		trap_kind = g.trap->kind->tidx;
		trap_a = trap_x_attr[g.lighting][trap_kind];
		trap_c = trap_x_char[g.lighting][trap_kind];
	}

	out[GRID_X] = x;
	out[GRID_Y] = y;
	out[GRID_FEATURE] = g.f_idx;
	out[GRID_FLAGS] = grid_flags(&g);
	out[GRID_LIGHTING] = g.lighting;
	out[GRID_TOP_COLOR] = vga_color(a);
	out[GRID_TOP_RGB] = rgb_from_attr(a);
	out[GRID_TOP_CHAR] = c;
	out[GRID_TERRAIN_COLOR] = vga_color(ta);
	out[GRID_TERRAIN_RGB] = rgb_from_attr(ta);
	out[GRID_TERRAIN_CHAR] = tc;
	out[GRID_TRAP_COLOR] = trap_c ? vga_color(trap_a) : 0;
	out[GRID_TRAP_RGB] = trap_c ? rgb_from_attr(trap_a) : 0;
	out[GRID_TRAP_CHAR] = trap_c;
	out[GRID_TRAP_KIND] = trap_kind;
}

/* Look HUD (spec 2026-08-18, amended after review): the engine's own name for
 * one grid, composed from exactly the calls the `l` command's
 * aux_monster/aux_trap/aux_object/aux_terrain use — and none of their side
 * effects. aux_monster also calls monster_race_track(), health_track() and
 * handle_stuff(); those change what the game is tracking and are
 * deliberately not made here. Nothing below prints, prompts, or touches the
 * RNG, with one read: map_info() calls square_memorize() for grids in view,
 * which is harmless — pack_grid() already calls map_info() on every dirty
 * grid each redraw, so a hover memorizes nothing the display had not. The
 * buffer is static, so a call allocates nothing.
 *
 * NULL means "nothing honest to say": before a level exists, out of range, or
 * hallucinating — Angband's own look would print random text and spend game
 * RNG doing it. */
EMSCRIPTEN_KEEPALIVE const char *vect_angband_describe(int x, int y)
{
	static char buf[160];
	struct grid_data g;
	struct loc grid;

	if (!character_generated || !cave || !player || !player->cave) return NULL;
	if (x < 0 || y < 0 || x >= cave_width() || y >= cave_height()) return NULL;

	/* The hero's own cell answers before either gate below: a player knows
	 * where they are standing however addled they are, which is what Larn
	 * (main-wasm.c's vect_larn_describe) and Moria (semantic-wasm.cpp's
	 * moria_describe) already answer, and what Moria's harness asserts.
	 * player->grid, not map_info's g.is_player (cave-map.c:103, the same
	 * square-owns-a-negative-mon test): reading it directly costs no map_info
	 * call, which is what lets this sit above the hallucination gate. */
	if (x == player->grid.x && y == player->grid.y) return "you";

	/* Before map_info: its hallucination tail (cave-map.c:179) spends game RNG
	 * and then usually clears g->hallucinate, so gating on that flag would both
	 * leak the true terrain and cost a roll. Upstream's aux_hallucinate gates
	 * here too. */
	if (player->timed[TMD_IMAGE]) return NULL;

	grid = loc(x, y);
	map_info(grid, &g);

	if (g.m_idx) {
		/* map_info only clears m_idx for !monster_is_visible, which still
		 * leaves camouflaged mimics (creeping coins, lurkers) whose glyph the
		 * map deliberately draws as an object — aux_monster requires
		 * monster_is_obvious for exactly that reason. Anything less falls
		 * through to the trap/object/terrain branches below, same as upstream. */
		struct monster *mon = square_monster(cave, grid);
		if (mon && monster_is_obvious(mon)) {
			char m_name[80], health[80];
			monster_desc(m_name, sizeof(m_name), mon, MDESC_IND_VIS);
			health[0] = '\0';
			look_mon_desc(health, sizeof(health), g.m_idx);
			if (health[0]) strnfmt(buf, sizeof(buf), "%s (%s)", m_name, health);
			else my_strcpy(buf, m_name, sizeof(buf));
			return buf;
		}
	}

	/* aux_trap's order: after the monster, before the object. g.trap is
	 * already populated by map_info and already read by pack_grid above.
	 * kind->desc, not kind->name: name is trap.txt's code name ("pit"),
	 * printed only on the wizard branch (ui-target.c:725); the non-wizard
	 * aux_trap the player actually sees shows kind->desc ("spiked pit",
	 * ui-target.c:734) — init.c parses `name:pit:spiked pit` into exactly
	 * those two fields. */
	if (g.trap) return g.trap->kind->desc;

	if (g.first_kind) {
		/* map_info's own skips (cave-map.c:157-170) when it chose first_kind
		 * and set multiple_objects, applied again here so the phrase names
		 * exactly the glyph the map drew — not an ignored or unknown item
		 * that merely happens to be the pile's list head. */
		struct object *head = NULL;
		int n = 0;
		for (struct object *o = square_object(player->cave, grid); o; o = o->next) {
			if (o->kind == unknown_gold_kind || o->kind == unknown_item_kind ||
					ignore_known_item_ok(player, o))
				continue;
			if (!head) head = o;
			n++;
		}
		if (!head) return NULL;
		if (g.multiple_objects && n > 1) {
			strnfmt(buf, sizeof(buf), "a pile of %d objects", n);
			return buf;
		}
		object_desc(buf, sizeof(buf), head, ODESC_PREFIX | ODESC_FULL, player);
		return buf;
	}

	if (g.unseen_object) return "unknown object";
	if (g.unseen_money) return "unknown money";

	return square_apparent_name(player->cave, grid);
}

static void flush_map(void)
{
	int width = cave_width();
	int height = cave_height();
	int count = 0;
	int i = 0;
	int x, y;
	int32_t *words;

	if (dirty_fallback) dirty_all = true;
	dirty_fallback = false;
	if (!width || !height) return;

	for (y = 0; y < height; y++) {
		for (x = 0; x < width; x++) {
			if (dirty_all || dirty[y][x]) count++;
		}
	}
	if (!count) return;

	words = mem_alloc((size_t)count * GRID_STRIDE * sizeof(*words));
	for (y = 0; y < height; y++) {
		for (x = 0; x < width; x++) {
			if (!dirty_all && !dirty[y][x]) continue;
			pack_grid(words + i * GRID_STRIDE, x, y);
			dirty[y][x] = 0;
			i++;
		}
	}
	dirty_all = false;
	EM_ASM({
		globalThis.VectAngband.mapBatch(
			HEAP32.subarray($0 >> 2, ($0 >> 2) + $1));
	}, words, count * GRID_STRIDE);
	mem_free(words);
}

static bool wasm_handle_event(int wait)
{
	int cmd = character_generated && inkey_flag && screen_save_depth == 0;

	/* Checkpoint where the engine is already quiescent: at a command prompt,
	 * immediately before the one blocking key wait. Two things make it safe
	 * to call save_game_checked() (ui-game.c:1046) from here.
	 *
	 * It opens with event_signal(EVENT_MESSAGE_FLUSH) (ui-game.c:1055), whose
	 * handler message_flush (ui-input.c:612) reaches msg_flush (ui-input.c:388)
	 * and then anykey() (ui-input.c:311) -> inkey_ex() -> a nested blocking
	 * Term_xtra(TERM_XTRA_EVENT, true): a re-entrant Asyncify suspend that
	 * would also eat the player's next keypress on the -more- prompt. Gating
	 * on !msg_flag (ui-input.h:85) makes that handler a no-op — it clears
	 * message_column and returns without flushing.
	 *
	 * The lore_save() failure branch (ui-game.c:1090-1093) queues its own
	 * message and flushes it regardless of msg_flag at entry, so auto_more is
	 * forced on for the call and restored after: msg_flush (ui-input.c:395)
	 * skips anykey() when it is set. player is non-NULL because
	 * character_generated is true. */
	if (wait && cmd && !msg_flag && wasm_checkpoint_due()) {
		bool auto_more = OPT(player, auto_more);

		OPT(player, auto_more) = true;
		wasm_checkpoint_landed(save_game_checked() ? 1 : 0);
		OPT(player, auto_more) = auto_more;
	}

	if (!wasm_gather_key(wait, cmd)) return false;
	Term_keypress(wasm_key_code(), wasm_key_mods());
	return true;
}

static errr term_xtra_wasm(int n, int v)
{
	pace_borg_hook();
	switch (n) {
	case TERM_XTRA_EVENT:
		(void)wasm_handle_event(v);
		return 0;
	case TERM_XTRA_FLUSH:
		while (wasm_handle_event(0)) continue;
		return 0;
	case TERM_XTRA_CLEAR:
		EM_ASM({ globalThis.VectAngband.clear(); });
		return 0;
	case TERM_XTRA_FRESH:
		flush_map();
		flush_effects();
		EM_ASM({ globalThis.VectAngband.overlay($0); },
			(screen_save_depth > 0 || !character_generated) ? 1 : 0);
		EM_ASM({ globalThis.VectAngband.flush(); });
		return 0;
	case TERM_XTRA_DELAY:
		if (v > 0) emscripten_sleep(v);
		return 0;
	default:
		/* SHAPE, NOISE, REACT, ... — harmless to ignore
		 * (main-test.c's term_xtra_test does the same). */
		return 0;
	}
}

static void wasm_quit_hook(const char *s)
{
	wasm_quit_js(s, s == NULL);
}

static void init_wasm_term(void)
{
	term *t = &wasm_term;

	term_init(t, 80, 24, 256);
	t->soft_cursor = true;    /* no hardware cursor; curs_hook draws it */
	t->never_bored = true;    /* skip TERM_XTRA_BORED round trips */
	t->never_frosh = true;    /* flush whole frames, not per-row FROSH */
	t->complex_input = true;  /* distinguish BS/^h, Tab/^i, ... */

	t->init_hook = term_init_wasm;
	t->nuke_hook = term_nuke_wasm;
	t->xtra_hook = term_xtra_wasm;
	t->curs_hook = term_curs_wasm;
	t->wipe_hook = term_wipe_wasm;
	t->text_hook = term_text_wasm;

	Term_activate(t);
	angband_term[0] = t;
}

int main(int argc, char *argv[])
{
	(void)argc;
	argv0 = argv[0];

	quit_aux = wasm_quit_hook;

	/* musl's default locale handles UTF-8; text_mbstowcs() (z-util.c:831)
	 * falls back to mbstowcs(), which must decode the UTF-8 gamedata into
	 * UTF-32. Deliberately no nl_langinfo(CODESET) quit-check here —
	 * Emscripten's answer to that probe is not load-bearing. */
	setlocale(LC_CTYPE, "C.UTF-8");

	/* /lib is the --preload-file mount (scripts/build/angband-wasm.mk).
	 * config, lib and data paths all root there: gamedata=/lib/gamedata,
	 * screens=/lib/screens, save=/lib/save, scores=/lib/scores, ... —
	 * see init_file_paths (init.c:311). create_needed_dirs (init.c:411)
	 * makes the writable ones in MEMFS.
	 *
	 * The user directory is the exception, and has to be corrected by hand.
	 * Emscripten is a UNIX build, so config.h:68 defines PRIVATE_USER_PATH as
	 * "~/.angband" and init_file_paths takes the private branch:
	 * ANGBAND_DIR_USER becomes "~/.angband/Angband", which tilde-expands to
	 * nothing here and lands as a bare "/Angband" in MEMFS — outside the
	 * volume, so everything the engine keeps there is discarded on reload.
	 * Save, scores and panic escape this because USE_PRIVATE_PATHS is not
	 * defined and they are built from datapath instead.
	 *
	 * That directory is not scratch space: borg.txt (borg-init.c:192), the
	 * preferences the options menu writes, and the archive of finished
	 * savefiles all live in it. Point it at /lib/user, which persist.ts has
	 * already linked into the volume, before create_needed_dirs() makes it. */
	init_file_paths("/lib/", "/lib/", "/lib/");
	string_free(ANGBAND_DIR_USER);
	ANGBAND_DIR_USER = string_make("/lib/user");
	string_free(ANGBAND_DIR_ARCHIVE);
	ANGBAND_DIR_ARCHIVE = string_make("/lib/user/archive");
	create_needed_dirs();

	/* Deterministic player + savefile name (upstream derives it from
	 * getuid/getpwuid). The savefile it names lands in /lib/save, which
	 * persist.ts links into the mounted /vect-angband volume before main(). */
	my_strcpy(arg_name, "Player", sizeof(arg_name));
	savefile_set_name("Player", false, false);

	ANGBAND_SYS = "wasm";
	init_wasm_term();

	/* The startup sequence upstream main() runs after module init
	 * (main.c:551-583), minus signals_init and the sound reinit hook. */
	cmd_get_hook = textui_get_cmd;
	/* Before init_display(), and this order is load-bearing: handlers dispatch
	 * newest-first (game-event.c), so registering first makes this the LAST
	 * EVENT_ENTER_WORLD handler to run — after ui_enter_world (ui-display.c:2718)
	 * has re-added Angband's own display handlers at the head of the effect
	 * lists, which is what arm_effect_handlers() then undoes. See its comment
	 * for why the order matters at all. */
	event_add_handler(EVENT_ENTER_WORLD, on_enter_world, NULL);
	init_display();
	init_angband();
	textui_init();

	/* Registered after the engine/text UI handlers exist: these handlers only
	 * observe public payloads and dirty local state. */
	event_add_handler(EVENT_MAP, on_map, NULL);
	event_add_handler(EVENT_ITEMLIST, on_itemlist, NULL);
	event_add_handler(EVENT_NEW_LEVEL_DISPLAY, on_level, NULL);
	event_add_handler(EVENT_MESSAGE, on_message, NULL);
	event_add_handler(EVENT_BOLT, on_bolt, NULL);
	event_add_handler(EVENT_MISSILE, on_missile, NULL);
	event_add_handler(EVENT_EXPLOSION, on_explosion, NULL);

	/* Splash (screens/news.txt) stays up until a key arrives — the smoke
	 * test's first gate. */
	pause_line(Term);
	/* GAME_LOAD, not GAME_NEW: the volume is mounted before main(), so a
	 * savefile resumes; ui-game.h:28 falls through to birth when there is
	 * none. */
	play_game(GAME_LOAD);

	quit(NULL);
	return 0;
}

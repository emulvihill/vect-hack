// Copyright (c) 1981-86 Robert A. Koeneke
// Copyright (c) 1987-94 James E. Wilson
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Modified for VectHack (WebAssembly adaptation of the pinned Umoria 5.7.15
// sources) starting 2026-08-08; change dates are recorded in this repository's
// git history (GPLv3 section 5(a)).

#pragma once

#include <cstdint>
#include <string>

// Seven-word public record. Keep this mirror in lockstep with mapRecords.ts.
enum MoriaGridWord {
    MORIA_GRID_X = 0,
    MORIA_GRID_Y,
    MORIA_GRID_TERRAIN_CAT,
    MORIA_GRID_TERRAIN_KIND,
    MORIA_GRID_TERRAIN_CHAR,
    MORIA_GRID_TOP_CAT,
    MORIA_GRID_TOP_CHAR,
    MORIA_GRID_STRIDE,
};

enum MoriaTerrainCategory {
    MORIA_TERRAIN_UNSEEN = 0,
    MORIA_TERRAIN_FLOOR,
    MORIA_TERRAIN_CORRIDOR,
    MORIA_TERRAIN_WALL,
    MORIA_TERRAIN_DOOR,
    MORIA_TERRAIN_DOOR_OPEN,
    MORIA_TERRAIN_STAIRS,
    MORIA_TERRAIN_TRAP,
    MORIA_TERRAIN_FEATURE,
};

enum MoriaTerrainKind {
    MORIA_KIND_NONE = 0,
    MORIA_KIND_FLOOR,
    MORIA_KIND_CORRIDOR,
    MORIA_KIND_WALL,
    MORIA_KIND_MAGMA_SEAM,
    MORIA_KIND_QUARTZ_SEAM,
    MORIA_KIND_RUBBLE,
    MORIA_KIND_DOOR_OPEN,
    MORIA_KIND_DOOR_CLOSED,
    MORIA_KIND_STAIRS_UP,
    MORIA_KIND_STAIRS_DOWN,
    MORIA_KIND_TRAP,
    MORIA_KIND_STORE,
};

enum MoriaTopCategory {
    MORIA_TOP_NONE = 0,
    MORIA_TOP_HERO,
    MORIA_TOP_MONSTER,
    MORIA_TOP_ITEM,
};

// Separate structured state record. The player name travels as a bounded
// string alongside these words rather than being packed into integer slots.
enum MoriaStateWord {
    MORIA_STATE_WIDTH = 0,
    MORIA_STATE_HEIGHT,
    MORIA_STATE_PANEL_TOP,
    MORIA_STATE_PANEL_BOTTOM,
    MORIA_STATE_PANEL_LEFT,
    MORIA_STATE_PANEL_RIGHT,
    MORIA_STATE_HERO_X,
    MORIA_STATE_HERO_Y,
    MORIA_STATE_DEPTH,
    MORIA_STATE_TURN,
    MORIA_STATE_PLAYER_LEVEL,
    MORIA_STATE_EXPERIENCE,
    MORIA_STATE_GOLD,
    MORIA_STATE_HP,
    MORIA_STATE_MAX_HP,
    MORIA_STATE_MANA,
    MORIA_STATE_MAX_MANA,
    MORIA_STATE_AC,
    MORIA_STATE_BLIND,
    MORIA_STATE_HALLUCINATING,
    MORIA_STATE_CONFUSED,
    MORIA_STATE_AFRAID,
    MORIA_STATE_POISONED,
    MORIA_STATE_RESTING,
    MORIA_STATE_OVERLAY,
    MORIA_STATE_STRIDE,
};

enum MoriaSemanticOverlay {
    MORIA_OVERLAY_NONE = 0,
    MORIA_OVERLAY_EQUIPMENT,
    MORIA_OVERLAY_INVENTORY,
    MORIA_OVERLAY_WEAR,
    MORIA_OVERLAY_HELP,
    MORIA_OVERLAY_STORE,
    MORIA_OVERLAY_TOMB,
    MORIA_OVERLAY_SCORE,
    MORIA_OVERLAY_MAP,
    MORIA_OVERLAY_CHARACTER,
};

// Synchronous presentation taps. No function here suspends or invokes an
// exported WASM function, so it is safe at terminal-flush and polling seams.
void moriaSemanticFlush();
void moriaSemanticMessage(const char *message);
void moriaSemanticSetCheckpointActive(bool active);
bool moriaSemanticOverlayActive();
void moriaSemanticInvalidate();

// Source-owned full-screen transitions use a stack because Umoria nests
// saved screens (for example, inventory inside a store). The default covers
// terminalSaveScreen callers whose more specific Screen state is not exposed.
void moriaSemanticOverlayPush(
        MoriaSemanticOverlay overlay = MORIA_OVERLAY_CHARACTER);
void moriaSemanticOverlayPop();

// Drop every claimed scope. Called only where no overlay can legitimately be
// up — the outer command request — because upstream does not balance its
// saved screens: inventoryExecuteCommand always saves but restores only when
// the screen it ends on is not Blank (ui_inventory.cpp), and `e` with nothing
// equipped takes exactly that branch. Without this, one such command hides the
// vector view behind the 80x24 screen for the rest of the session.
void moriaSemanticOverlayReset();

// store.cpp renames its one command read and one exit draw to these wrappers.
// The STORE scope starts at the first command prompt, survives nested actions
// and loop iterations, and clears only after the source redraws the dungeon.
bool vectMoriaStoreGetCommand(const std::string &prompt, char &command);
void vectMoriaStoreDrawCavePanel();

// The linked game_death.cpp/game_run.cpp score callers rename to this wrapper.
// The score page has no durable upstream screen flag of its own.
void vectMoriaShowScoresScreen();

// These source displays save the terminal internally but expose no durable
// Screen id. Caller-only compile seams route them through exact typed scopes.
void vectMoriaDisplayTextHelpFile(const std::string &filename);
void vectMoriaDungeonDisplayMap();

#ifdef MORIA_SEMANTIC_HOST_TEST
// Host-only reset for the exact production sanitizer/cache contract harness.
void moriaSemanticTestReset();
#endif

// Look HUD (spec 2026-08-18): a read-only query through the sanitized
// semantic seam, callable from the worker while the engine is parked.
extern "C" const char *moria_describe(int x, int y);

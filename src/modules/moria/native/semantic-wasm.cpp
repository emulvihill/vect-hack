// Copyright (c) 1981-86 Robert A. Koeneke
// Copyright (c) 1987-94 James E. Wilson
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Modified for VectHack (WebAssembly adaptation of the pinned Umoria 5.7.15
// sources) starting 2026-08-08; change dates are recorded in this repository's
// git history (GPLv3 section 5(a)).

// Source-faithful public-state adapter for the pinned Umoria display rules in
// external/umoria/src/dungeon.cpp. It deliberately reads Tile_t, Monster_t,
// Inventory_t, and Player_t state directly: the legacy symbol routine has a
// hallucination branch that advances the game's RNG and therefore is not an
// observation API. Only sanitized presentation records enter the cache.

#include "semantic-wasm.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "headers.h"

#ifndef MORIA_SEMANTIC_HOST_TEST
#include <emscripten/emscripten.h>
#else
// The host-test harness links this file with a plain native compiler
// (moria-semantic-harness.cpp), which has never heard of Emscripten's export
// attribute and does not need it — nothing here strips unused symbols.
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {
using PublicRecord = std::array<int32_t, MORIA_GRID_STRIDE>;
using StateRecord = std::array<int32_t, MORIA_STATE_STRIDE>;

std::array<int32_t, MAX_HEIGHT * MAX_WIDTH * MORIA_GRID_STRIDE> public_cache{};
std::vector<int32_t> map_batch;
bool cache_valid = false;
int cached_width = 0;
int cached_height = 0;
int cached_depth = 0;

StateRecord cached_state{};
std::string cached_name;
bool state_cache_valid = false;
bool checkpoint_active = false;

struct OverlayScope {
    MoriaSemanticOverlay overlay;
    Screen screen_at_push;
};
std::vector<OverlayScope> overlay_stack;
bool store_overlay_active = false;

#ifdef MORIA_SEMANTIC_HOST_TEST
extern "C" void moriaSemanticHostMap(const int32_t *words, int word_count, int reset);
extern "C" void moriaSemanticHostState(const int32_t *words, int word_count,
                                         const char *name);
extern "C" void moriaSemanticHostMessage(const char *message);

void emitMap(const int32_t *words, int word_count, bool reset) {
    moriaSemanticHostMap(words, word_count, reset ? 1 : 0);
}

void emitState(const int32_t *words, int word_count, const char *name) {
    moriaSemanticHostState(words, word_count, name);
}

void emitMessage(const char *message) {
    moriaSemanticHostMessage(message);
}
#else
EM_JS(void, wasm_semantic_map,
      (const int32_t *words, int word_count, int reset), {
    if (typeof Module.semanticMap === 'function') {
        Module.semanticMap(
            HEAP32.slice(words >> 2, (words >> 2) + word_count),
            Boolean(reset));
    }
});

EM_JS(void, wasm_semantic_state,
      (const int32_t *words, int word_count, const char *name), {
    if (typeof Module.semanticState === 'function') {
        Module.semanticState(
            HEAP32.slice(words >> 2, (words >> 2) + word_count),
            UTF8ToString(name));
    }
});

EM_JS(void, wasm_semantic_message, (const char *message), {
    if (typeof Module.semanticMessage === 'function') {
        Module.semanticMessage(UTF8ToString(message));
    }
});

void emitMap(const int32_t *words, int word_count, bool reset) {
    wasm_semantic_map(words, word_count, reset ? 1 : 0);
}

void emitState(const int32_t *words, int word_count, const char *name) {
    wasm_semantic_state(words, word_count, name);
}

void emitMessage(const char *message) {
    wasm_semantic_message(message);
}
#endif

bool activeDimensionsValid() {
    return dg.width > 0 && dg.width <= MAX_WIDTH &&
           dg.height > 0 && dg.height <= MAX_HEIGHT;
}

bool heroPositionValid() {
    return activeDimensionsValid() &&
           py.pos.x >= 0 && py.pos.x < dg.width &&
           py.pos.y >= 0 && py.pos.y < dg.height;
}

size_t cacheOffset(int x, int y) {
    return static_cast<size_t>(y * MAX_WIDTH + x) * MORIA_GRID_STRIDE;
}

PublicRecord unseenRecord(int x, int y) {
    PublicRecord record{};
    record[MORIA_GRID_X] = x;
    record[MORIA_GRID_Y] = y;
    return record;
}

bool tileVisible(const Tile_t &tile) {
    return tile.permanent_light || tile.temporary_light || tile.field_mark;
}

void setTerrain(PublicRecord &record, MoriaTerrainCategory category,
                MoriaTerrainKind kind, char sprite) {
    record[MORIA_GRID_TERRAIN_CAT] = category;
    record[MORIA_GRID_TERRAIN_KIND] = kind;
    record[MORIA_GRID_TERRAIN_CHAR] = static_cast<unsigned char>(sprite);
}

void sanitizeFeature(PublicRecord &record, uint8_t feature_id) {
    if (feature_id <= MAX_CAVE_ROOM) {
        setTerrain(record, MORIA_TERRAIN_FLOOR, MORIA_KIND_FLOOR, '.');
        return;
    }
    if (feature_id <= MAX_CAVE_FLOOR) {
        setTerrain(record, MORIA_TERRAIN_CORRIDOR, MORIA_KIND_CORRIDOR, '.');
        return;
    }

    if (feature_id == TILE_MAGMA_WALL && config::options::highlight_seams) {
        setTerrain(record, MORIA_TERRAIN_WALL, MORIA_KIND_MAGMA_SEAM, '%');
        return;
    }
    if (feature_id == TILE_QUARTZ_WALL && config::options::highlight_seams) {
        setTerrain(record, MORIA_TERRAIN_WALL, MORIA_KIND_QUARTZ_SEAM, '%');
        return;
    }

    // Unknown/generation-only wall values and unhighlighted veins collapse to
    // the same public wall. The raw fval never crosses the ABI.
    setTerrain(record, MORIA_TERRAIN_WALL, MORIA_KIND_WALL, '#');
}

void sanitizeTreasure(PublicRecord &record, const Inventory_t &object) {
    switch (object.category_id) {
        case TV_NOTHING:
        case TV_INVIS_TRAP:
            return;
        case TV_SECRET_DOOR:
            setTerrain(record, MORIA_TERRAIN_WALL, MORIA_KIND_WALL, '#');
            return;
        case TV_RUBBLE:
            setTerrain(record, MORIA_TERRAIN_FEATURE, MORIA_KIND_RUBBLE,
                       static_cast<char>(object.sprite));
            return;
        case TV_OPEN_DOOR:
            setTerrain(record, MORIA_TERRAIN_DOOR_OPEN, MORIA_KIND_DOOR_OPEN,
                       static_cast<char>(object.sprite));
            return;
        case TV_CLOSED_DOOR:
            setTerrain(record, MORIA_TERRAIN_DOOR, MORIA_KIND_DOOR_CLOSED,
                       static_cast<char>(object.sprite));
            return;
        case TV_UP_STAIR:
            setTerrain(record, MORIA_TERRAIN_STAIRS, MORIA_KIND_STAIRS_UP,
                       static_cast<char>(object.sprite));
            return;
        case TV_DOWN_STAIR:
            setTerrain(record, MORIA_TERRAIN_STAIRS, MORIA_KIND_STAIRS_DOWN,
                       static_cast<char>(object.sprite));
            return;
        case TV_VIS_TRAP:
            setTerrain(record, MORIA_TERRAIN_TRAP, MORIA_KIND_TRAP,
                       static_cast<char>(object.sprite));
            return;
        case TV_STORE_DOOR:
            setTerrain(record, MORIA_TERRAIN_FEATURE, MORIA_KIND_STORE,
                       static_cast<char>(object.sprite));
            return;
        default:
            // Ordinary objects reveal only their entitled sprite. Neither the
            // treasure slot nor object/category identity is a protocol word.
            record[MORIA_GRID_TOP_CAT] = MORIA_TOP_ITEM;
            record[MORIA_GRID_TOP_CHAR] = object.sprite;
            return;
    }
}

PublicRecord sanitizeCell(int x, int y) {
    PublicRecord record = unseenRecord(x, y);
    const bool hero = x == py.pos.x && y == py.pos.y;
    const bool blind =
            (py.flags.status & config::player::status::PY_BLIND) != 0;
    const bool hallucinating = py.flags.image > 0;

    // These modes are intentionally stricter than a remembered-map redraw:
    // only self-position is public, with no terrain underlay or other identity.
    if (blind || hallucinating) {
        if (hero) {
            record[MORIA_GRID_TOP_CAT] = MORIA_TOP_HERO;
            record[MORIA_GRID_TOP_CHAR] = '@';
        }
        return record;
    }

    const Tile_t &tile = dg.floor[y][x];
    const bool visible = tileVisible(tile);
    if (visible) {
        sanitizeFeature(record, tile.feature_id);

        const uint8_t treasure_id = tile.treasure_id;
        if (treasure_id > 0 && treasure_id < LEVEL_MAX_OBJECTS) {
            sanitizeTreasure(record, game.treasure.list[treasure_id]);
        }
    }

    // Upstream owns the entitlement bit. Recomputing LOS or infravision here
    // would create a second visibility model and can expose hidden monsters.
    const uint8_t monster_id = tile.creature_id;
    if (monster_id > 1 && monster_id < MON_TOTAL_ALLOCATIONS) {
        const Monster_t &monster = monsters[monster_id];
        if (monster.lit && monster.creature_id < MON_MAX_CREATURES) {
            record[MORIA_GRID_TOP_CAT] = MORIA_TOP_MONSTER;
            record[MORIA_GRID_TOP_CHAR] =
                    creatures_list[monster.creature_id].sprite;
        }
    }

    if (hero) {
        record[MORIA_GRID_TOP_CAT] = MORIA_TOP_HERO;
        record[MORIA_GRID_TOP_CHAR] = '@';
    }
    return record;
}

MoriaSemanticOverlay directScreenOverlay() {
    switch (game.screen.current_screen_id) {
        case Screen::Equipment:
            return MORIA_OVERLAY_EQUIPMENT;
        case Screen::Inventory:
            return MORIA_OVERLAY_INVENTORY;
        case Screen::Wear:
            return MORIA_OVERLAY_WEAR;
        case Screen::Help:
            return MORIA_OVERLAY_HELP;
        case Screen::Blank:
        case Screen::Wrong:
            return MORIA_OVERLAY_NONE;
    }
    return MORIA_OVERLAY_NONE;
}

MoriaSemanticOverlay activeOverlay() {
    // Before the character exists (splash, high scores, character creation)
    // there is no dungeon to render: the whole terminal is the UI.
    if (!game.character_generated) return MORIA_OVERLAY_CHARACTER;
    if (!overlay_stack.empty()) {
        const OverlayScope &scope = overlay_stack.back();
        // Inventory state deliberately survives terminalRestoreScreen so the
        // next inventory command can resume it. It describes the live display
        // only when it changed after this saved-screen scope was entered.
        if (scope.overlay == MORIA_OVERLAY_CHARACTER &&
            game.screen.current_screen_id != scope.screen_at_push) {
            const MoriaSemanticOverlay screen = directScreenOverlay();
            if (screen != MORIA_OVERLAY_NONE) return screen;
        }
        // Help/map source functions save the terminal inside their explicit
        // scope. That generic inner save must not erase the known screen type.
        for (auto it = overlay_stack.rbegin(); it != overlay_stack.rend(); ++it) {
            if (it->overlay != MORIA_OVERLAY_CHARACTER) return it->overlay;
        }
        return MORIA_OVERLAY_CHARACTER;
    }
    if (game.character_is_dead) return MORIA_OVERLAY_TOMB;
    return MORIA_OVERLAY_NONE;
}

void popThroughOverlay(MoriaSemanticOverlay marker) {
    while (!overlay_stack.empty()) {
        const MoriaSemanticOverlay overlay = overlay_stack.back().overlay;
        overlay_stack.pop_back();
        if (overlay == marker) return;
    }
}

StateRecord captureState() {
    StateRecord state{};
    const bool dimensions_valid = activeDimensionsValid();
    state[MORIA_STATE_WIDTH] = dimensions_valid ? dg.width : 0;
    state[MORIA_STATE_HEIGHT] = dimensions_valid ? dg.height : 0;
    state[MORIA_STATE_PANEL_TOP] = dimensions_valid ? dg.panel.top : 0;
    state[MORIA_STATE_PANEL_BOTTOM] = dimensions_valid ? dg.panel.bottom : 0;
    state[MORIA_STATE_PANEL_LEFT] = dimensions_valid ? dg.panel.left : 0;
    state[MORIA_STATE_PANEL_RIGHT] = dimensions_valid ? dg.panel.right : 0;
    state[MORIA_STATE_HERO_X] = heroPositionValid() ? py.pos.x : -1;
    state[MORIA_STATE_HERO_Y] = heroPositionValid() ? py.pos.y : -1;
    state[MORIA_STATE_DEPTH] = dg.current_level;
    state[MORIA_STATE_TURN] = dg.game_turn;
    state[MORIA_STATE_PLAYER_LEVEL] = py.misc.level;
    state[MORIA_STATE_EXPERIENCE] = py.misc.exp;
    state[MORIA_STATE_GOLD] = py.misc.au;
    state[MORIA_STATE_HP] = py.misc.current_hp;
    state[MORIA_STATE_MAX_HP] = py.misc.max_hp;
    state[MORIA_STATE_MANA] = py.misc.current_mana;
    state[MORIA_STATE_MAX_MANA] = py.misc.mana;
    state[MORIA_STATE_AC] = py.misc.display_ac;
    state[MORIA_STATE_BLIND] =
            (py.flags.status & config::player::status::PY_BLIND) != 0;
    state[MORIA_STATE_HALLUCINATING] = py.flags.image > 0;
    state[MORIA_STATE_CONFUSED] =
            (py.flags.status & config::player::status::PY_CONFUSED) != 0;
    state[MORIA_STATE_AFRAID] =
            (py.flags.status & config::player::status::PY_FEAR) != 0;
    state[MORIA_STATE_POISONED] =
            (py.flags.status & config::player::status::PY_POISONED) != 0;
    state[MORIA_STATE_RESTING] =
            (py.flags.status & config::player::status::PY_REST) != 0;
    state[MORIA_STATE_OVERLAY] = activeOverlay();
    return state;
}

std::string boundedPlayerName() {
    size_t length = 0;
    while (length < PLAYER_NAME_SIZE && py.misc.name[length] != '\0') ++length;
    return std::string(py.misc.name, length);
}

void flushState() {
    const StateRecord state = captureState();
    const std::string name = boundedPlayerName();
    if (state_cache_valid && state == cached_state && name == cached_name) return;

    emitState(state.data(), MORIA_STATE_STRIDE, name.c_str());
    cached_state = state;
    cached_name = name;
    state_cache_valid = true;
}

void flushMap() {
    if (!game.character_generated || dg.generate_new_level ||
        !activeDimensionsValid() || !heroPositionValid()) {
        cache_valid = false;
        return;
    }

    const bool reset = !cache_valid || cached_width != dg.width ||
                       cached_height != dg.height || cached_depth != dg.current_level;
    map_batch.clear();
    map_batch.reserve(static_cast<size_t>(dg.width * dg.height) * MORIA_GRID_STRIDE);

    for (int y = 0; y < dg.height; ++y) {
        for (int x = 0; x < dg.width; ++x) {
            const PublicRecord record = sanitizeCell(x, y);
            const size_t offset = cacheOffset(x, y);
            const bool changed = reset || !std::equal(
                    record.begin(), record.end(), public_cache.begin() + offset);
            if (!changed) continue;

            map_batch.insert(map_batch.end(), record.begin(), record.end());
            std::copy(record.begin(), record.end(), public_cache.begin() + offset);
        }
    }

    cached_width = dg.width;
    cached_height = dg.height;
    cached_depth = dg.current_level;
    cache_valid = true;
    if (!map_batch.empty()) {
        emitMap(map_batch.data(), static_cast<int>(map_batch.size()), reset);
    }
}
} // namespace

// Look HUD (spec 2026-08-18). Mirrors upstream's static lookSee()
// (external/umoria/src/dungeon_los.cpp) without any of its output, prompts or
// recall: a lit, visible monster; then a known treasure, which in Umoria also
// covers doors, stairs, rubble and store entrances; then the wall or floor the
// tile's feature says it is. The legacy symbol routine is deliberately not
// called — its hallucination branch advances the game RNG, which is why this
// file reads state directly (see the header comment).
extern "C" EMSCRIPTEN_KEEPALIVE const char *moria_describe(int x, int y) {
    static char buffer[MORIA_OBJ_DESC_SIZE];

    // The same guards the exporter already applies before it reads dg.floor;
    // activeDimensionsValid() is file-local, a few lines above.
    if (!game.character_generated || !activeDimensionsValid()) return nullptr;
    if (x < 0 || y < 0 || x >= dg.width || y >= dg.height) return nullptr;
    // A blind or hallucinating player still knows where they are standing —
    // sanitizeCell publishes the hero's own cell under both conditions
    // ("only self-position is public"), so this check runs before either
    // perception gate below. It reads only py.pos, not dg.floor.
    if (x == py.pos.x && y == py.pos.y) return "you";
    if (py.flags.image > 0) return nullptr;
    if ((py.flags.status & config::player::status::PY_BLIND) != 0) return nullptr;

    const Tile_t &tile = dg.floor[y][x];

    // Matches sanitizeCell's own order (semantic-wasm.cpp above, "Upstream
    // owns the entitlement bit"): a monster's lit flag is independent of the
    // tile's own visibility — infravision and running-with-a-light both set
    // monster.lit on an otherwise-unlit, unmarked tile (monster.cpp's
    // monsterIsVisible) — so this check runs before the tileVisible gate.
    const uint8_t monster_id = tile.creature_id;
    if (monster_id > 1 && monster_id < MON_TOTAL_ALLOCATIONS) {
        const Monster_t &monster = monsters[monster_id];
        if (monster.lit && monster.creature_id < MON_MAX_CREATURES)
            return creatures_list[monster.creature_id].name;
    }
    if (!tileVisible(tile)) return nullptr;

    const uint8_t treasure_id = tile.treasure_id;
    if (treasure_id > 0 && treasure_id < LEVEL_MAX_OBJECTS) {
        const Inventory_t &object = game.treasure.list[treasure_id];
        if (object.category_id == TV_SECRET_DOOR) return "a granite wall";
        if (object.category_id != TV_NOTHING && object.category_id != TV_INVIS_TRAP) {
            obj_desc_t description = {'\0'};
            itemDescription(description, object, true);
            std::snprintf(buffer, sizeof(buffer), "%s", description);
            return buffer;
        }
    }

    if (tile.feature_id >= MIN_CLOSED_SPACE) {
        switch (tile.feature_id) {
            case TILE_MAGMA_WALL: return "some dark rock";
            case TILE_QUARTZ_WALL: return "a quartz vein";
            default: return "a granite wall";
        }
    }
    return tile.feature_id <= MAX_CAVE_ROOM ? "a room floor" : "a corridor floor";
}

void moriaSemanticFlush() {
    if (checkpoint_active) return;
    flushState();
    flushMap();
}

void moriaSemanticMessage(const char *message) {
    if (checkpoint_active) return;
    if (message != nullptr) emitMessage(message);
}

void moriaSemanticSetCheckpointActive(bool active) {
    checkpoint_active = active;
}

bool moriaSemanticOverlayActive() {
    return activeOverlay() != MORIA_OVERLAY_NONE || store_overlay_active;
}

void moriaSemanticInvalidate() {
    cache_valid = false;
    state_cache_valid = false;
}

void moriaSemanticOverlayPush(MoriaSemanticOverlay overlay) {
    if (checkpoint_active) return;
    if (overlay != MORIA_OVERLAY_NONE) {
        overlay_stack.push_back(OverlayScope{
                overlay, game.screen.current_screen_id});
    }
}

void moriaSemanticOverlayPop() {
    if (checkpoint_active) return;
    if (!overlay_stack.empty()) overlay_stack.pop_back();
}

void moriaSemanticOverlayReset() {
    if (checkpoint_active) return;
    // store_overlay_active is deliberately left alone: the store runs its own
    // command loop through literal reads, so an outer command request cannot
    // happen inside one, and clearing a flag this call never sees set would
    // only hide it if that ever stopped being true.
    overlay_stack.clear();
}

bool vectMoriaStoreGetCommand(const std::string &prompt, char &command) {
    if (!store_overlay_active) {
        moriaSemanticOverlayPush(MORIA_OVERLAY_STORE);
        store_overlay_active = true;
    }
    return getCommand(prompt, command);
}

void vectMoriaStoreDrawCavePanel() {
    drawCavePanel();
    if (store_overlay_active) {
        // Inventory actions that consume a turn deliberately skip their
        // terminalRestoreScreen(). Unwind any such generic saved-screen scope
        // together with this store's explicit marker, preserving outer scopes.
        popThroughOverlay(MORIA_OVERLAY_STORE);
        store_overlay_active = false;
        moriaSemanticFlush();
    }
}

void vectMoriaShowScoresScreen() {
    moriaSemanticOverlayPush(MORIA_OVERLAY_SCORE);
    showScoresScreen();
    moriaSemanticOverlayPop();
}

void vectMoriaDisplayTextHelpFile(const std::string &filename) {
    moriaSemanticOverlayPush(MORIA_OVERLAY_HELP);
    displayTextHelpFile(filename);
    moriaSemanticOverlayPop();
}

void vectMoriaDungeonDisplayMap() {
    moriaSemanticOverlayPush(MORIA_OVERLAY_MAP);
    dungeonDisplayMap();
    moriaSemanticOverlayPop();
}

#ifdef MORIA_SEMANTIC_HOST_TEST
void moriaSemanticTestReset() {
    public_cache.fill(0);
    map_batch.clear();
    cache_valid = false;
    cached_width = cached_height = cached_depth = 0;
    cached_state.fill(0);
    cached_name.clear();
    state_cache_valid = false;
    overlay_stack.clear();
    store_overlay_active = false;
}
#endif

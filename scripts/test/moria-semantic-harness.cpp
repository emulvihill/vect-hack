// Host contract harness for the exact production sanitizer/cache in
// semantic-wasm.cpp. No visibility or classification rule is duplicated here.

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <set>
#include <string>
#include <vector>

#include "headers.h"
#include "semantic-wasm.h"

Dungeon_t dg{};
Game_t game{};
Player_t py{};
Creature_t creatures_list[MON_MAX_CREATURES]{};
Monster_t monsters[MON_TOTAL_ALLOCATIONS]{};

namespace config { namespace options {
bool highlight_seams = false;
} }

namespace config { namespace player { namespace status {
extern const uint32_t PY_BLIND = 0x00000004L;
extern const uint32_t PY_CONFUSED = 0x00000008L;
extern const uint32_t PY_FEAR = 0x00000010L;
extern const uint32_t PY_POISONED = 0x00000020L;
extern const uint32_t PY_REST = 0x00000200L;
} } }

namespace {
struct MapBatch {
    std::vector<int32_t> words;
    bool reset;
};

struct StateBatch {
    std::array<int32_t, MORIA_STATE_STRIDE> words;
    std::string name;
};

std::vector<MapBatch> map_batches;
std::vector<StateBatch> state_batches;
std::vector<std::string> source_messages;
std::vector<int32_t> shadow;
bool score_delegate_called = false;
bool help_delegate_called = false;
bool map_delegate_called = false;
bool store_draw_delegate_called = false;
std::vector<int32_t> store_prompt_overlays;
int32_t store_draw_overlay = MORIA_OVERLAY_NONE;

[[noreturn]] void fail(const char *message) {
    std::fprintf(stderr, "FAIL: %s\n", message);
    std::exit(1);
}

void require(bool condition, const char *message) {
    if (!condition) fail(message);
}

// moria_describe can answer nullptr; std::strcmp on that is a segfault, not a
// failed assertion — a regression would then crash the harness instead of
// naming the require() that broke. Every describe-and-compare call in
// checkDescribeContract() goes through this instead of a bare std::strcmp.
void describedAs(int x, int y, const char *expected, const char *message) {
    const char *text = moria_describe(x, y);
    require(text != nullptr && std::strcmp(text, expected) == 0, message);
}

const int32_t *recordAt(const MapBatch &batch, int x, int y) {
    for (size_t offset = 0; offset < batch.words.size(); offset += MORIA_GRID_STRIDE) {
        const int32_t *record = batch.words.data() + offset;
        if (record[MORIA_GRID_X] == x && record[MORIA_GRID_Y] == y) return record;
    }
    fail("record coordinate absent from batch");
}

const int32_t *shadowAt(int x, int y) {
    const size_t offset = static_cast<size_t>(y * dg.width + x) * MORIA_GRID_STRIDE;
    require(offset + MORIA_GRID_STRIDE <= shadow.size(), "shadow coordinate out of bounds");
    return shadow.data() + offset;
}

void applyBatch(const MapBatch &batch) {
    const size_t full_words = static_cast<size_t>(dg.width * dg.height) * MORIA_GRID_STRIDE;
    if (batch.reset) shadow.assign(full_words, 0);
    require(shadow.size() == full_words, "diff applied without a full public shadow");
    for (size_t offset = 0; offset < batch.words.size(); offset += MORIA_GRID_STRIDE) {
        const int32_t *record = batch.words.data() + offset;
        const int x = record[MORIA_GRID_X];
        const int y = record[MORIA_GRID_Y];
        require(x >= 0 && x < dg.width && y >= 0 && y < dg.height,
                "native record outside active bounds");
        std::copy(record, record + MORIA_GRID_STRIDE,
                  shadow.begin() + static_cast<size_t>(y * dg.width + x) * MORIA_GRID_STRIDE);
    }
}

void applyLatest() {
    require(!map_batches.empty(), "expected a semantic map batch");
    applyBatch(map_batches.back());
}

Tile_t &tile(int x, int y) {
    return dg.floor[y][x];
}

void setObject(int x, int y, uint8_t slot, uint8_t category, uint8_t sprite) {
    tile(x, y).treasure_id = slot;
    game.treasure.list[slot].category_id = category;
    game.treasure.list[slot].sprite = sprite;
}

void initializeFixture() {
    dg = Dungeon_t{};
    game = Game_t{};
    py = Player_t{};
    std::fill(std::begin(creatures_list), std::end(creatures_list), Creature_t{});
    std::fill(std::begin(monsters), std::end(monsters), Monster_t{});
    moriaSemanticTestReset();
    map_batches.clear();
    state_batches.clear();
    source_messages.clear();
    shadow.clear();

    dg.width = 13;
    dg.height = 3;
    dg.current_level = 7;
    dg.game_turn = 12345;
    dg.panel.top = 0;
    dg.panel.bottom = 2;
    dg.panel.left = 0;
    dg.panel.right = 12;
    game.character_generated = true;
    py.pos = Coord_t{1, 1};
    std::strcpy(py.misc.name, "Public Hero");
    py.misc.level = 9;
    py.misc.exp = 3210;
    py.misc.au = 456;
    py.misc.current_hp = 17;
    py.misc.max_hp = 23;
    py.misc.current_mana = 5;
    py.misc.mana = 8;
    py.misc.display_ac = 11;
    py.misc.display_to_ac = 4;

    for (int y = 0; y < dg.height; ++y) {
        for (int x = 0; x < dg.width; ++x) {
            tile(x, y).feature_id = TILE_DARK_FLOOR;
            tile(x, y).field_mark = true;
        }
    }

    tile(1, 0).feature_id = TILE_CORR_FLOOR;
    tile(2, 0).feature_id = TILE_GRANITE_WALL;
    tile(3, 0).feature_id = TILE_MAGMA_WALL;
    tile(4, 0).feature_id = TILE_QUARTZ_WALL;
    setObject(5, 0, 1, TV_RUBBLE, ':');
    setObject(6, 0, 2, TV_OPEN_DOOR, '\'');
    setObject(7, 0, 3, TV_CLOSED_DOOR, '+');
    setObject(8, 0, 4, TV_UP_STAIR, '<');
    setObject(9, 0, 5, TV_DOWN_STAIR, '>');
    setObject(10, 0, 6, TV_VIS_TRAP, '^');
    setObject(11, 0, 7, TV_STORE_DOOR, '4');
    setObject(12, 0, 8, TV_POTION1, '!');

    creatures_list[10].sprite = 'o';
    creatures_list[10].name = "a giant white louse"; // moria_describe's lit-monster fixture
    monsters[2].creature_id = 10;
    monsters[2].lit = true;
    monsters[2].pos = Coord_t{1, 0};
    tile(0, 1).creature_id = 2;

    // Private fixtures: their exact source category or index must not cross.
    setObject(2, 1, 9, TV_SECRET_DOOR, '#');
    setObject(3, 1, 10, TV_INVIS_TRAP, '^');
    tile(4, 1).treasure_id = 255; // invalid source index
    tile(5, 1).creature_id = 255; // invalid source index
    monsters[3].creature_id = MON_MAX_CREATURES;
    monsters[3].lit = true;
    tile(6, 1).creature_id = 3; // valid monster slot, invalid creature index

    // moria_describe's own regression fixture (Important 1, fix round 2): a
    // lit monster on a tile that is otherwise unlit. (0, 1)'s monster above
    // sits on a field_mark=true tile and so cannot tell tileVisible-first
    // order apart from monster-first order — this one can, and must not
    // reuse (0, 1) because checkInitialFullAndPrivacy depends on that cell
    // keeping its floor underlay.
    creatures_list[11].sprite = 'e';
    creatures_list[11].name = "a floating eye";
    monsters[4].creature_id = 11;
    monsters[4].lit = true;
    monsters[4].pos = Coord_t{7, 1};
    tile(7, 1).creature_id = 4;
    tile(7, 1).field_mark = false;

    config::options::highlight_seams = true;
}

void checkInitialFullAndPrivacy() {
    moriaSemanticFlush();
    require(map_batches.size() == 1, "first flush did not emit exactly one map batch");
    const MapBatch &full = map_batches.back();
    require(full.reset, "first map batch was not a reset");
    require(full.words.size() == static_cast<size_t>(dg.width * dg.height * MORIA_GRID_STRIDE),
            "first map batch was not width*height records");

    std::set<std::pair<int, int>> coordinates;
    for (size_t offset = 0; offset < full.words.size(); offset += MORIA_GRID_STRIDE) {
        const int32_t *record = full.words.data() + offset;
        require(coordinates.emplace(record[MORIA_GRID_X], record[MORIA_GRID_Y]).second,
                "full batch repeated a coordinate");
    }

    require(recordAt(full, 0, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_FLOOR,
            "floor kind absent");
    require(recordAt(full, 1, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_CORRIDOR,
            "corridor kind absent");
    require(recordAt(full, 2, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_WALL,
            "wall kind absent");
    require(recordAt(full, 3, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_MAGMA_SEAM,
            "highlighted magma kind absent");
    require(recordAt(full, 4, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_QUARTZ_SEAM,
            "highlighted quartz kind absent");
    require(recordAt(full, 5, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_RUBBLE,
            "rubble kind absent");
    require(recordAt(full, 6, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_DOOR_OPEN,
            "open-door kind absent");
    require(recordAt(full, 7, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_DOOR_CLOSED,
            "closed-door kind absent");
    require(recordAt(full, 8, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_STAIRS_UP,
            "up-stairs kind absent");
    require(recordAt(full, 9, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_STAIRS_DOWN,
            "down-stairs kind absent");
    require(recordAt(full, 10, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_TRAP,
            "trap kind absent");
    require(recordAt(full, 11, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_STORE,
            "store kind absent");

    const int32_t *item = recordAt(full, 12, 0);
    require(item[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_FLOOR &&
                    item[MORIA_GRID_TOP_CAT] == MORIA_TOP_ITEM &&
                    item[MORIA_GRID_TOP_CHAR] == '!',
            "ordinary item did not retain its terrain underlay");
    const int32_t *monster = recordAt(full, 0, 1);
    require(monster[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_FLOOR &&
                    monster[MORIA_GRID_TOP_CAT] == MORIA_TOP_MONSTER &&
                    monster[MORIA_GRID_TOP_CHAR] == 'o',
            "visible monster did not retain its terrain underlay");
    const int32_t *hero = recordAt(full, 1, 1);
    require(hero[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_FLOOR &&
                    hero[MORIA_GRID_TOP_CAT] == MORIA_TOP_HERO &&
                    hero[MORIA_GRID_TOP_CHAR] == '@',
            "hero did not retain its terrain underlay");

    require(game.treasure.list[9].category_id == TV_SECRET_DOOR,
            "secret-door fixture is vacuous");
    const int32_t *secret = recordAt(full, 2, 1);
    require(secret[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_WALL &&
                    secret[MORIA_GRID_TERRAIN_CHAR] == '#' &&
                    secret[MORIA_GRID_TOP_CAT] == MORIA_TOP_NONE,
            "secret door leaked instead of collapsing to public wall");

    require(game.treasure.list[10].category_id == TV_INVIS_TRAP &&
                    game.treasure.list[10].sprite == '^',
            "invisible-trap fixture is vacuous");
    const int32_t *invisible = recordAt(full, 3, 1);
    require(invisible[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_FLOOR &&
                    invisible[MORIA_GRID_TOP_CAT] == MORIA_TOP_NONE,
            "invisible trap leaked instead of collapsing to underlay");

    require(recordAt(full, 4, 1)[MORIA_GRID_TOP_CAT] == MORIA_TOP_NONE,
            "invalid treasure index was dereferenced");
    require(recordAt(full, 5, 1)[MORIA_GRID_TOP_CAT] == MORIA_TOP_NONE,
            "invalid monster index was dereferenced");
    require(recordAt(full, 6, 1)[MORIA_GRID_TOP_CAT] == MORIA_TOP_NONE,
            "invalid creature index was dereferenced");

    applyLatest();
    require(state_batches.size() == 1, "initial structured state absent");
    const StateBatch &state = state_batches.back();
    require(state.name == "Public Hero", "structured state lost player name");
    require(state.words[MORIA_STATE_WIDTH] == 13 &&
                    state.words[MORIA_STATE_HEIGHT] == 3 &&
                    state.words[MORIA_STATE_PANEL_TOP] == 0 &&
                    state.words[MORIA_STATE_PANEL_BOTTOM] == 2 &&
                    state.words[MORIA_STATE_PANEL_LEFT] == 0 &&
                    state.words[MORIA_STATE_PANEL_RIGHT] == 12 &&
                    state.words[MORIA_STATE_HERO_X] == 1 &&
                    state.words[MORIA_STATE_HERO_Y] == 1 &&
                    state.words[MORIA_STATE_DEPTH] == 7 &&
                    state.words[MORIA_STATE_TURN] == 12345,
            "structured dimensions/hero/depth/turn incorrect");
    require(state.words[MORIA_STATE_AC] == 11, "structured armor class double-counted bonus AC");
    require(state.words[MORIA_STATE_PLAYER_LEVEL] == 9 &&
                    state.words[MORIA_STATE_EXPERIENCE] == 3210 &&
                    state.words[MORIA_STATE_GOLD] == 456 &&
                    state.words[MORIA_STATE_HP] == 17 &&
                    state.words[MORIA_STATE_MAX_HP] == 23 &&
                    state.words[MORIA_STATE_MANA] == 5 &&
                    state.words[MORIA_STATE_MAX_MANA] == 8,
            "structured player values did not match source state");
}

void checkDiffsAndVisionPrivacy() {
    config::options::highlight_seams = false;
    moriaSemanticFlush();
    require(map_batches.size() == 2, "seam-option change did not emit a diff");
    const MapBatch &collapsed = map_batches.back();
    require(!collapsed.reset && collapsed.words.size() == 2 * MORIA_GRID_STRIDE,
            "seam collapse was not a bounded two-record diff");
    require(recordAt(collapsed, 3, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_WALL &&
                    recordAt(collapsed, 3, 0)[MORIA_GRID_TERRAIN_CHAR] == '#' &&
                    recordAt(collapsed, 4, 0)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_WALL &&
                    recordAt(collapsed, 4, 0)[MORIA_GRID_TERRAIN_CHAR] == '#',
            "disabled seam highlighting leaked source vein identity");
    applyLatest();

    config::options::highlight_seams = true;
    moriaSemanticFlush();
    applyLatest();

    tile(12, 0).field_mark = false;
    moriaSemanticFlush();
    const MapBatch &disappeared = map_batches.back();
    require(!disappeared.reset && disappeared.words.size() == MORIA_GRID_STRIDE,
            "one disappearing cell did not produce one-record diff");
    require(recordAt(disappeared, 12, 0)[MORIA_GRID_TERRAIN_CAT] == MORIA_TERRAIN_UNSEEN,
            "disappearing cell was not explicitly retracted to unseen");
    applyLatest();
    const size_t after_disappear = map_batches.size();
    moriaSemanticFlush();
    require(map_batches.size() == after_disappear, "empty map diff was emitted");

    py.flags.status |= config::player::status::PY_BLIND;
    moriaSemanticFlush();
    require(map_batches.back().words.size() <=
                    static_cast<size_t>(dg.width * dg.height * MORIA_GRID_STRIDE),
            "blind transition exceeded active-map bound");
    applyLatest();
    for (int y = 0; y < dg.height; ++y) {
        for (int x = 0; x < dg.width; ++x) {
            const int32_t *record = shadowAt(x, y);
            if (x == py.pos.x && y == py.pos.y) {
                require(record[MORIA_GRID_TERRAIN_CAT] == MORIA_TERRAIN_UNSEEN &&
                                record[MORIA_GRID_TOP_CAT] == MORIA_TOP_HERO,
                        "blind hero exposed terrain or disappeared");
            } else {
                require(record[MORIA_GRID_TERRAIN_CAT] == MORIA_TERRAIN_UNSEEN &&
                                record[MORIA_GRID_TOP_CAT] == MORIA_TOP_NONE,
                        "blind snapshot exposed a non-player cell");
            }
        }
    }

    py.flags.status &= ~config::player::status::PY_BLIND;
    moriaSemanticFlush();
    applyLatest();
    require(shadowAt(0, 1)[MORIA_GRID_TOP_CAT] == MORIA_TOP_MONSTER,
            "public cache did not restore after blindness");

    setRandomSeed(123456);
    const uint32_t seed_before = getRandomSeed();
    py.flags.image = 7;
    moriaSemanticFlush();
    const uint32_t seed_after = getRandomSeed();
    const int32_t next_after_export = rnd();
    setRandomSeed(123456);
    const int32_t next_without_export = rnd();
    require(seed_after == seed_before && next_after_export == next_without_export,
            "hallucination export advanced Umoria RNG state");
    applyLatest();
    for (int y = 0; y < dg.height; ++y) {
        for (int x = 0; x < dg.width; ++x) {
            const int32_t *record = shadowAt(x, y);
            require((x == py.pos.x && y == py.pos.y)
                            ? record[MORIA_GRID_TOP_CAT] == MORIA_TOP_HERO &&
                                      record[MORIA_GRID_TERRAIN_CAT] == MORIA_TERRAIN_UNSEEN
                            : record[MORIA_GRID_TOP_CAT] == MORIA_TOP_NONE &&
                                      record[MORIA_GRID_TERRAIN_CAT] == MORIA_TERRAIN_UNSEEN,
                    "hallucination snapshot exposed semantic identity");
        }
    }

    py.flags.image = 0;
    moriaSemanticFlush();
    applyLatest();
    require(shadowAt(2, 1)[MORIA_GRID_TERRAIN_KIND] == MORIA_KIND_WALL,
            "sanitized cache did not restore after hallucination");

    dg.current_level = 8;
    moriaSemanticFlush();
    require(map_batches.back().reset &&
                    map_batches.back().words.size() ==
                            static_cast<size_t>(dg.width * dg.height * MORIA_GRID_STRIDE),
            "depth change did not emit a bounded reset batch");
    applyLatest();

    const size_t before_invalid_dimensions = map_batches.size();
    dg.width = MAX_WIDTH + 1;
    moriaSemanticFlush();
    require(map_batches.size() == before_invalid_dimensions,
            "invalid active width produced a map batch");
    require(state_batches.back().words[MORIA_STATE_WIDTH] == 0 &&
                    state_batches.back().words[MORIA_STATE_HEIGHT] == 0,
            "invalid active dimensions crossed structured state");
    dg.width = 13;
    moriaSemanticFlush();
    require(map_batches.back().reset,
            "map did not reset after returning from invalid dimensions");
    applyLatest();
}

// moria_describe (Look HUD, spec 2026-08-18) reuses this same fixture rather
// than building its own: the lit monster and secret door from
// initializeFixture(), and (12, 0) — the cell the diff test just above
// retracted to field_mark=false, still carrying its TV_POTION1 treasure_id —
// as the unlit tile with content behind it that must stay unnamed.
void checkDescribeContract() {
    describedAs(1, 1, "you", "moria_describe did not name the hero's own tile");
    describedAs(0, 1, "a giant white louse", "moria_describe did not name a lit, visible monster");
    // (7, 1): a second lit monster, this one on a deliberately unlit tile.
    // The gate order matters here — moria_describe must check monster.lit
    // before tileVisible(), matching sanitizeCell's own order (Important 1).
    // A regression that moves the monster block back below the tileVisible
    // gate would silently pass every other check in this function, because
    // (0, 1)'s monster sits on a field_mark=true tile either way.
    describedAs(7, 1, "a floating eye",
            "moria_describe did not name a lit monster on an otherwise-unlit tile — "
            "the monster check must run before the tileVisible gate");
    describedAs(2, 1, "a granite wall", "moria_describe leaked a secret door instead of a granite wall");
    // TV_INVIS_TRAP's skip does not blank the cell — it falls through to the
    // floor beneath the invisible trap, same as sanitizeTreasure's own skip.
    // A mutant that removes the TV_INVIS_TRAP skip formats the trap as an
    // ordinary item instead, which fails this exact equality.
    describedAs(3, 1, "a room floor", "moria_describe revealed an invisible trap instead of its floor");
    require(moria_describe(12, 0) == nullptr,
            "moria_describe named an unlit tile the map has since retracted");

    // The terrain/wall fallback's four distinct outcomes, each pinned to its
    // own fixture cell: a constant-collapse or a deleted switch case changes
    // one of these without changing the others.
    describedAs(1, 0, "a corridor floor", "moria_describe misclassified an open corridor tile");
    describedAs(2, 0, "a granite wall", "moria_describe misclassified a granite wall");
    describedAs(3, 0, "some dark rock", "moria_describe misclassified a magma wall");
    describedAs(4, 0, "a quartz vein", "moria_describe misclassified a quartz vein");

    py.flags.status |= config::player::status::PY_BLIND;
    require(moria_describe(0, 1) == nullptr,
            "moria_describe named a monster while the hero is blind");
    describedAs(1, 1, "you", "a blind hero cannot even be told they are standing on their own square");
    py.flags.status &= ~config::player::status::PY_BLIND;

    py.flags.image = 7;
    require(moria_describe(0, 1) == nullptr,
            "moria_describe named a monster while the hero is hallucinating");
    describedAs(1, 1, "you", "a hallucinating hero cannot even be told they are standing on their own square");
    py.flags.image = 0;
}

void checkStateOverlaysAndMessages() {
    // Splash, high scores and character creation all run before the character
    // exists: the full terminal is the UI, so the overlay must be active.
    game.character_generated = false;
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_CHARACTER,
            "pre-birth screens did not report a full-terminal overlay");
    game.character_generated = true;
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_NONE,
            "overlay stayed active after the character was generated");

    game.screen.current_screen_id = Screen::Inventory;
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_NONE,
            "stale restored inventory state activated an overlay without a saved screen");
    moriaSemanticOverlayPush();
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_CHARACTER,
            "stale inventory id mislabeled an unrelated saved-screen overlay");
    moriaSemanticOverlayPop();
    moriaSemanticFlush();

    game.screen.current_screen_id = Screen::Blank;
    moriaSemanticOverlayPush();
    game.screen.current_screen_id = Screen::Inventory;
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_INVENTORY,
            "live source inventory transition did not label its saved screen");
    moriaSemanticOverlayPop();
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_NONE,
            "restored inventory screen left the overlay active");

    game.screen.current_screen_id = Screen::Blank;
    moriaSemanticOverlayPush(MORIA_OVERLAY_STORE);
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_STORE,
            "source store transition did not activate overlay");
    moriaSemanticOverlayPush(MORIA_OVERLAY_HELP);
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_HELP,
            "nested overlay push did not select top screen");
    moriaSemanticOverlayPop();
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_STORE,
            "nested overlay pop did not restore prior screen");
    moriaSemanticOverlayPop();
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_NONE,
            "overlay pop did not restore vector view");

    help_delegate_called = false;
    vectMoriaDisplayTextHelpFile("help.txt");
    require(help_delegate_called &&
                    state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_HELP,
            "help wrapper did not survive its source terminal-save scope");
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_NONE,
            "help wrapper did not clear after its source delegate");

    map_delegate_called = false;
    moriaSemanticOverlayPush(MORIA_OVERLAY_CHARACTER);
    vectMoriaDungeonDisplayMap();
    require(map_delegate_called &&
                    state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_MAP,
            "map wrapper did not survive its nested source terminal-save scope");
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_CHARACTER,
            "map wrapper did not restore its outer saved-screen scope");
    moriaSemanticOverlayPop();

    char store_command = '\0';
    store_prompt_overlays.clear();
    store_draw_delegate_called = false;
    const bool store_result = vectMoriaStoreGetCommand("", store_command);
    require(store_result && store_command == 'q',
            "store command wrapper did not preserve getCommand result");
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_STORE,
            "store command wrapper was not active while delegating");
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_STORE,
            "store overlay cleared between the command and its action prompt");

    char action_answer = '\0';
    (void) getCommand("Which item?", action_answer);
    require(store_prompt_overlays.size() == 2 &&
                    store_prompt_overlays[1] == MORIA_OVERLAY_STORE,
            "nested store action prompt lost the source store overlay");

    game.screen.current_screen_id = Screen::Blank;
    moriaSemanticOverlayPush();
    game.screen.current_screen_id = Screen::Inventory;
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_INVENTORY,
            "nested store inventory did not select its specific source screen");
    // inventoryExecuteCommand() intentionally skips terminalRestoreScreen()
    // after an action changes its Screen back to Blank. Preserve that exact
    // unbalanced source path so store exit must unwind through its own marker.
    game.screen.current_screen_id = Screen::Blank;
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_STORE,
            "return from a nested store action did not restore the store screen");

    const bool second_result = vectMoriaStoreGetCommand("", store_command);
    require(second_result && store_prompt_overlays.size() == 3 &&
                    store_prompt_overlays.back() == MORIA_OVERLAY_STORE,
            "second store loop command changed wrapper behavior");
    vectMoriaStoreDrawCavePanel();
    require(store_draw_delegate_called && store_draw_overlay == MORIA_OVERLAY_STORE,
            "store exit draw did not delegate while the source store was active");
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_NONE,
            "store overlay did not clear exactly after the source exit draw");

    py.flags.status |= config::player::status::PY_CONFUSED |
                       config::player::status::PY_FEAR |
                       config::player::status::PY_POISONED |
                       config::player::status::PY_REST;
    moriaSemanticFlush();
    const StateBatch &conditions = state_batches.back();
    require(conditions.words[MORIA_STATE_CONFUSED] == 1 &&
                    conditions.words[MORIA_STATE_AFRAID] == 1 &&
                    conditions.words[MORIA_STATE_POISONED] == 1 &&
                    conditions.words[MORIA_STATE_RESTING] == 1,
            "structured player conditions did not follow source status bits");

    score_delegate_called = false;
    moriaSemanticOverlayPush(MORIA_OVERLAY_CHARACTER);
    vectMoriaShowScoresScreen();
    require(score_delegate_called &&
                    state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_SCORE,
            "nested score wrapper was not active during its source delegate");
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_CHARACTER,
            "score wrapper did not restore its outer saved-screen overlay");
    moriaSemanticOverlayPop();
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_NONE,
            "outer saved-screen overlay did not clear after nested score wrapper");

    game.character_is_dead = true;
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_TOMB,
            "source death state did not activate tomb overlay");
    vectMoriaShowScoresScreen();
    require(score_delegate_called,
            "score wrapper did not delegate to the source score screen");
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_SCORE,
            "score wrapper was not active while delegating");
    moriaSemanticFlush();
    require(state_batches.back().words[MORIA_STATE_OVERLAY] == MORIA_OVERLAY_TOMB,
            "score wrapper did not restore the tomb overlay after delegating");

    moriaSemanticMessage("You hit the orc.");
    moriaSemanticMessage(nullptr);
    require(source_messages.size() == 1 && source_messages[0] == "You hit the orc.",
            "source message seam did not preserve exact non-null message");
}

void checkEveryBatchIsBoundedAndUnique() {
    for (const MapBatch &batch : map_batches) {
        require(batch.words.size() % MORIA_GRID_STRIDE == 0,
                "map batch ended in a partial public record");
        require(batch.words.size() <=
                        static_cast<size_t>(dg.width * dg.height * MORIA_GRID_STRIDE),
                "map batch exceeded active-map bound");
        std::set<std::pair<int, int>> coordinates;
        for (size_t offset = 0; offset < batch.words.size(); offset += MORIA_GRID_STRIDE) {
            const int32_t *record = batch.words.data() + offset;
            require(record[MORIA_GRID_X] >= 0 && record[MORIA_GRID_X] < dg.width &&
                            record[MORIA_GRID_Y] >= 0 && record[MORIA_GRID_Y] < dg.height,
                    "map diff contained an out-of-bounds coordinate");
            require(coordinates.emplace(record[MORIA_GRID_X], record[MORIA_GRID_Y]).second,
                    "map diff repeated a coordinate");
        }
    }
}
} // namespace

extern "C" void moriaSemanticHostMap(const int32_t *words, int word_count, int reset) {
    map_batches.push_back(MapBatch{
            std::vector<int32_t>(words, words + word_count), reset != 0});
}

extern "C" void moriaSemanticHostState(const int32_t *words, int word_count,
                                         const char *name) {
    require(word_count == MORIA_STATE_STRIDE, "native state stride mismatch");
    StateBatch state{};
    std::copy(words, words + word_count, state.words.begin());
    state.name = name == nullptr ? "" : name;
    state_batches.push_back(state);
}

extern "C" void moriaSemanticHostMessage(const char *message) {
    source_messages.emplace_back(message == nullptr ? "" : message);
}

// moria_describe's ordinary-item branch calls the real formatter in
// identification.cpp, which this minimal link does not include. A stub is
// enough to satisfy the linker; checkDescribeContract() never reaches this
// branch, and the item-description text itself is proven against the real
// engine in test-moria-map-contract.mjs.
void itemDescription(obj_desc_t description, Inventory_t const &, bool) {
    std::strcpy(description, "an item");
}

// semantic-wasm.cpp's store wrapper must make the overlay source-visible for
// the entire real getCommand delegation and preserve its result unchanged.
bool getCommand(const std::string &, char &command) {
    moriaSemanticFlush();
    store_prompt_overlays.push_back(
            state_batches.back().words[MORIA_STATE_OVERLAY]);
    command = 'q';
    return true;
}

void drawCavePanel() {
    store_draw_delegate_called = true;
    moriaSemanticFlush();
    store_draw_overlay = state_batches.back().words[MORIA_STATE_OVERLAY];
}

void showScoresScreen() {
    score_delegate_called = true;
    moriaSemanticFlush();
}

void displayTextHelpFile(const std::string &) {
    help_delegate_called = true;
    moriaSemanticOverlayPush();
    moriaSemanticFlush();
    moriaSemanticOverlayPop();
}

void dungeonDisplayMap() {
    map_delegate_called = true;
    moriaSemanticOverlayPush();
    moriaSemanticFlush();
    moriaSemanticOverlayPop();
}

int main() {
    initializeFixture();
    checkInitialFullAndPrivacy();
    checkDiffsAndVisionPrivacy();
    checkDescribeContract();
    checkStateOverlaysAndMessages();
    checkEveryBatchIsBoundedAndUnique();
    std::puts("OK: Moria production sanitizer/cache preserves public map contract");
    return 0;
}

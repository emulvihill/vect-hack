#include <cassert>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <utility>
#include <vector>
#include <sys/stat.h>
#include <unistd.h>

#include "checkpoint-wasm.h"
#include "headers.h"

Game_t game{};
Player_t py{};
Dungeon_t dg{};
Monster_t monsters[MON_TOTAL_ALLOCATIONS]{};
Store_t stores[MAX_STORES]{};
Recall_t creature_recall[MON_MAX_CREATURES]{};
uint8_t objects_identified[OBJECT_IDENT_SIZE]{};
vtype_t messages[MESSAGE_HISTORY_SIZE]{};
int16_t next_free_monster_id = config::monsters::MON_MIN_INDEX_ID;
int16_t monster_multiply_total = 0;
int16_t missiles_counter = 0;
int16_t last_message_id = 0;
bool message_ready_to_print = false;
bool screen_has_changed = false;
int eof_flag = 0;
bool panic_save = false;

namespace config {
namespace files { std::string save_game = "game.sav"; }
namespace treasure { const uint8_t MIN_TREASURE_LIST_ID = 1; }
namespace monsters { const uint8_t MON_MIN_INDEX_ID = 2; }
namespace player { namespace status { const uint32_t PY_SEARCH = 0x00000100u; } }
namespace options {
bool display_counts = true;
bool find_bound = false;
bool run_cut_corners = true;
bool run_examine_corners = true;
bool run_ignore_doors = false;
bool run_print_self = false;
bool highlight_seams = false;
bool prompt_to_pickup = false;
bool use_roguelike_keys = false;
bool show_inventory_weights = false;
bool error_beep_sound = true;
}
}

namespace {
MoriaTerminalCheckpointState terminal_state{};
int input_callbacks = 0;
int terminal_callbacks = 0;
int semantic_callbacks = 0;
int landed_callbacks = 0;
int monster_updates = 0;
bool due = false;
std::map<std::string, int> invariants;

uint32_t digestBytes(const void *value, size_t size, uint32_t hash) {
    const auto *bytes = static_cast<const uint8_t *>(value);
    for (size_t i = 0; i < size; ++i) {
        hash ^= bytes[i];
        hash *= 0x01000193u;
    }
    return hash;
}

uint32_t materialDigest() {
    uint32_t hash = 0x811c9dc5u;
    hash = digestBytes(&game, sizeof(game), hash);
    hash = digestBytes(&py, sizeof(py), hash);
    hash = digestBytes(&dg, sizeof(dg), hash);
    hash = digestBytes(monsters, sizeof(monsters), hash);
    hash = digestBytes(stores, sizeof(stores), hash);
    hash = digestBytes(creature_recall, sizeof(creature_recall), hash);
    hash = digestBytes(objects_identified, sizeof(objects_identified), hash);
    hash = digestBytes(messages, sizeof(messages), hash);
    hash = digestBytes(&next_free_monster_id, sizeof(next_free_monster_id), hash);
    hash = digestBytes(&monster_multiply_total, sizeof(monster_multiply_total), hash);
    hash = digestBytes(&missiles_counter, sizeof(missiles_counter), hash);
    hash = digestBytes(&last_message_id, sizeof(last_message_id), hash);
    hash = digestBytes(&message_ready_to_print, sizeof(message_ready_to_print), hash);
    hash = digestBytes(&screen_has_changed, sizeof(screen_has_changed), hash);
    hash = digestBytes(&terminal_state, sizeof(terminal_state), hash);
    const uint32_t seed = getRandomSeed();
    hash = digestBytes(&seed, sizeof(seed), hash);
    return hash;
}
}

extern "C" int moriaCheckpointHostCommand() { return due ? 1 : 0; }
extern "C" int moriaCheckpointHostLanded() { landed_callbacks++; return 1; }
extern "C" void moriaCheckpointHostInvariant(const char *name, int value) {
    invariants[name] = value;
}

void moriaTerminalCheckpointCapture(MoriaTerminalCheckpointState &state) { state = terminal_state; }
void moriaTerminalCheckpointRestore(const MoriaTerminalCheckpointState &state) { terminal_state = state; }
void moriaSemanticSetCheckpointActive(bool) {}
bool moriaSemanticOverlayActive() { return false; }
void moriaSemanticInvalidate() {}
void updateMonsters(bool) {
    monster_updates++;
    // Model the production visibility hazard: the first post-load update
    // clears a wizard-lit, out-of-LOS monster unless wizard mode was restored
    // before updateMonsters(false) begins.
    if (!game.wizard_mode) monsters[3].lit = false;
}
void changeCharacterName() {}

void putQIO() { if (!moriaCheckpointActive()) terminal_callbacks++; }
void playerDisturb(int, int) {
    putQIO();
    py.flags.rest = 0;
    py.flags.status &= ~config::player::status::PY_SEARCH;
}
void playerChangeSpeed(int speed) {
    py.flags.speed += speed;
    for (int i = next_free_monster_id - 1; i >= config::monsters::MON_MIN_INDEX_ID; --i) {
        monsters[i].speed += speed;
    }
}
int randomNumber(int max) { return static_cast<int>(rnd() % max) + 1; }
bool getInputConfirmation(const std::string &) { input_callbacks++; return false; }
void printMessage(const char *) { if (!moriaCheckpointActive()) semantic_callbacks++; }
uint32_t getCurrentUnixTime() { return 123456789u; }
int32_t playerCalculateTotalPoints() { return 777; }

#undef fopen
#undef open
FILE *tfopen(const char *path, const char *mode) { return std::fopen(path, mode); }
int topen(const char *path, int flags, int mode) { return ::open(path, flags, mode); }

int main() {
    assert(std::strcmp(MORIA_CHECKPOINT_MAGIC, "VHMCP001") == 0);
    assert(MORIA_CHECKPOINT_SCHEMA == 1);
    assert(MORIA_CHECKPOINT_FOOTER_SIZE == 40);
    assert(MORIA_CHECKPOINT_PAYLOAD_SIZE == 11158);
    assert(std::strcmp(MORIA_CHECKPOINT_CANDIDATE, "recover/.pending.sav") == 0);
    const uint8_t bytes[] = {0, 1, 2, 3, 0xff};
    assert(moriaCheckpointFNV1a32(bytes, sizeof(bytes)) == 0x531dfdcau);

    setRandomSeed(99172);
    const uint32_t live = getRandomSeed();
    const int32_t expected = rnd();
    setRandomSeed(live - 1);
    assert(getRandomSeed() == live && rnd() == expected);
    setRandomSeed(live);
    assert(getRandomSeed() != live); // forbidden naïve setter round trip

    char directory[] = "/tmp/vect-moria-native-XXXXXX";
    assert(mkdtemp(directory) != nullptr);
    assert(chdir(directory) == 0);
    assert(mkdir("recover", 0700) == 0);

    game.character_generated = true;
    game.character_saved = false;
    game.character_is_dead = false;
    game.wizard_mode = true;
    game.last_command = '6';
    game.use_last_direction = true;
    game.command_count = 0;
    py.prev_dir = '6';
    py.flags.status = config::player::status::PY_SEARCH;
    py.flags.rest = 19;
    py.flags.food = -7;
    py.flags.food_digested = 7;
    py.flags.speed = 4;
    py.pack.heaviness = 3;
    py.weapon_is_heavy = true;
    py.carrying_light = true;
    py.temporary_light_only = true;
    dg.current_level = 3;
    dg.game_turn = 991;
    dg.generate_new_level = false;
    dg.height = 66;
    dg.width = 198;
    dg.panel = Panel_t{2, 3, 22, 43, 99, 164, 86, 21, 4, 4};
    next_free_monster_id = 9;
    monster_multiply_total = 4;
    missiles_counter = 313;
    last_message_id = 8;
    message_ready_to_print = true;
    screen_has_changed = true;
    std::strcpy(messages[8], "checkpoint invariance");
    for (size_t i = 0; i < MON_TOTAL_ALLOCATIONS; ++i) monsters[i].speed = static_cast<int16_t>(i - 40);
    monsters[3].lit = true;
    for (size_t i = 0; i < MAX_STORES; ++i) {
        stores[i].turns_left_before_closing = static_cast<int32_t>(1000 + i);
        stores[i].insults_counter = static_cast<int16_t>(-20 - i);
        stores[i].owner_id = static_cast<uint8_t>(i + 1);
        stores[i].unique_items_counter = STORE_MAX_DISCRETE_ITEMS;
        stores[i].good_purchases = static_cast<uint16_t>(100 + i);
        stores[i].bad_purchases = static_cast<uint16_t>(200 + i);
        for (size_t j = 0; j < STORE_MAX_DISCRETE_ITEMS; ++j) {
            InventoryRecord_t &record = stores[i].inventory[j];
            Inventory_t &item = record.item;
            record.cost = static_cast<int32_t>(10000 + i * 100 + j);
            item.id = static_cast<uint16_t>(10 + i * STORE_MAX_DISCRETE_ITEMS + j);
            item.special_name_id = static_cast<uint8_t>(1 + (i + j) % 200);
            std::snprintf(item.inscription, sizeof(item.inscription), "s%zur%zu", i, j);
            item.flags = static_cast<uint32_t>(0x01020300u + i * 100 + j);
            item.category_id = static_cast<uint8_t>(20 + i);
            item.sprite = static_cast<uint8_t>('a' + (j % 26));
            item.misc_use = static_cast<int16_t>(-300 + i * 24 + j);
            item.cost = static_cast<int32_t>(20000 + i * 100 + j);
            item.sub_category_id = static_cast<uint8_t>(30 + j);
            item.items_count = static_cast<uint8_t>(1 + (j % 9));
            item.weight = static_cast<uint16_t>(400 + i * 24 + j);
            item.to_hit = static_cast<int16_t>(-10 + j);
            item.to_damage = static_cast<int16_t>(10 + j);
            item.ac = static_cast<int16_t>(20 + j);
            item.to_ac = static_cast<int16_t>(-20 + j);
            item.damage.dice = static_cast<uint8_t>(1 + (j % 8));
            item.damage.sides = static_cast<uint8_t>(2 + (j % 12));
            item.depth_first_found = static_cast<uint8_t>(40 + j);
            item.identification = static_cast<uint8_t>(0x80u | (j & 0x7fu));
        }
    }
    for (size_t i = 0; i < sizeof(terminal_state.cells); ++i) {
        (&terminal_state.cells[0][0])[i] = static_cast<uint8_t>(i);
        (&terminal_state.saved_cells[0][0])[i] = static_cast<uint8_t>(255 - i);
    }
    terminal_state.cursor_y = 7;
    terminal_state.cursor_x = 31;
    terminal_state.saved_cursor_y = 4;
    terminal_state.saved_cursor_x = 12;
    terminal_state.ready = true;
    setRandomSeed(424241);
    errno = EDOM;

    const char expected_last_command = game.last_command;
    const bool expected_wizard_mode = game.wizard_mode;
    const bool expected_use_last_direction = game.use_last_direction;
    const char expected_previous_direction = py.prev_dir;
    const bool expected_message_ready = message_ready_to_print;
    const bool expected_screen_changed = screen_has_changed;
    const Panel_t expected_panel = dg.panel;
    const uint32_t expected_status = py.flags.status;
    const int16_t expected_rest = py.flags.rest;
    const int16_t expected_food = py.flags.food;
    const int16_t expected_food_digested = py.flags.food_digested;
    const int16_t expected_speed = py.flags.speed;
    const int16_t expected_heaviness = py.pack.heaviness;
    const bool expected_weapon_heavy = py.weapon_is_heavy;
    const bool expected_carrying_light = py.carrying_light;
    const bool expected_temporary_light = py.temporary_light_only;
    const int16_t expected_next_monster = next_free_monster_id;
    const int16_t expected_multiply_total = monster_multiply_total;
    int16_t expected_monster_speeds[MON_TOTAL_ALLOCATIONS]{};
    for (size_t i = 0; i < MON_TOTAL_ALLOCATIONS; ++i) expected_monster_speeds[i] = monsters[i].speed;
    Store_t expected_stores[MAX_STORES]{};
    std::memcpy(expected_stores, stores, sizeof(stores));
    const MoriaTerminalCheckpointState expected_terminal = terminal_state;
    const uint32_t before = materialDigest();
    const uint32_t seed_before = getRandomSeed();
    const int32_t next_before = rnd();
    setRandomSeed(seed_before - 1);
    assert(moriaCheckpointTestWriteNow());
    const uint32_t after = materialDigest();
    const int32_t next_after = rnd();
    setRandomSeed(seed_before - 1);
    assert(before == after && next_before == next_after);
    assert(errno == EDOM);
    assert(py.flags.rest == 19 && py.pack.heaviness == 3);
    assert(monsters[2].speed == -38 && stores[5].turns_left_before_closing == 1005);
    assert(input_callbacks == 0 && terminal_callbacks == 0 && semantic_callbacks == 0);
    assert(landed_callbacks == 1);
    assert(invariants["state-restored"] == 1);
    assert(invariants["checkpoint-digest-before"] == invariants["checkpoint-digest-after"]);
    assert(invariants["checkpoint-rng-next"] == next_before);
    assert(invariants["checkpoint-wizard-mode"] == 1);
    assert(invariants["checkpoint-wizard-lit"] > 0);

    game.last_command = 0;
    game.wizard_mode = false;
    game.use_last_direction = false;
    py.prev_dir = 0;
    message_ready_to_print = false;
    screen_has_changed = false;
    dg.panel = Panel_t{};
    py.flags.status = 0;
    py.flags.rest = 0;
    py.flags.food = 7500;
    py.flags.food_digested = 0;
    py.flags.speed = 0;
    py.pack.heaviness = 0;
    py.weapon_is_heavy = false;
    py.carrying_light = false;
    py.temporary_light_only = false;
    next_free_monster_id = config::monsters::MON_MIN_INDEX_ID;
    monster_multiply_total = 0;
    for (Monster_t &monster : monsters) monster.speed = 99;
    monsters[3].lit = true;
    std::memset(stores, 0, sizeof(stores));
    std::memset(&terminal_state, 0, sizeof(terminal_state));
    setRandomSeed(7);
    assert(moriaCheckpointTestApplyCandidate());
    assert(game.last_command == expected_last_command
        && game.use_last_direction == expected_use_last_direction
        && py.prev_dir == expected_previous_direction);
    assert(game.wizard_mode == expected_wizard_mode && monsters[3].lit);
    assert(message_ready_to_print == expected_message_ready
        && screen_has_changed == expected_screen_changed);
    assert(dg.panel.row == expected_panel.row && dg.panel.col == expected_panel.col
        && dg.panel.top == expected_panel.top && dg.panel.bottom == expected_panel.bottom
        && dg.panel.left == expected_panel.left && dg.panel.right == expected_panel.right
        && dg.panel.col_prt == expected_panel.col_prt && dg.panel.row_prt == expected_panel.row_prt
        && dg.panel.max_rows == expected_panel.max_rows && dg.panel.max_cols == expected_panel.max_cols);
    assert(py.flags.status == expected_status && py.flags.rest == expected_rest
        && py.flags.food == expected_food && py.flags.food_digested == expected_food_digested
        && py.flags.speed == expected_speed && py.pack.heaviness == expected_heaviness);
    assert(py.weapon_is_heavy == expected_weapon_heavy
        && py.carrying_light == expected_carrying_light
        && py.temporary_light_only == expected_temporary_light);
    assert(next_free_monster_id == expected_next_monster
        && monster_multiply_total == expected_multiply_total);
    for (size_t i = 0; i < MON_TOTAL_ALLOCATIONS; ++i) {
        assert(monsters[i].speed == expected_monster_speeds[i]);
    }
    assert(std::memcmp(stores, expected_stores, sizeof(stores)) == 0);
    assert(std::memcmp(&terminal_state, &expected_terminal, sizeof(terminal_state)) == 0);
    assert(getRandomSeed() == seed_before);

    // Every footer discriminator and a late semantically-invalid payload are
    // rejected independently before applying any decoded field.
    FILE *candidate = std::fopen(MORIA_CHECKPOINT_CANDIDATE, "rb");
    assert(candidate != nullptr && std::fseek(candidate, 0, SEEK_END) == 0);
    const long candidate_size = std::ftell(candidate);
    assert(candidate_size > static_cast<long>(MORIA_CHECKPOINT_FOOTER_SIZE));
    assert(std::fseek(candidate, 0, SEEK_SET) == 0);
    std::vector<uint8_t> valid_candidate(static_cast<size_t>(candidate_size));
    assert(std::fread(valid_candidate.data(), 1, valid_candidate.size(), candidate)
        == valid_candidate.size());
    assert(std::fclose(candidate) == 0);
    const size_t footer_at = valid_candidate.size() - MORIA_CHECKPOINT_FOOTER_SIZE;
    auto setU32 = [](std::vector<uint8_t> &bytes, size_t offset, uint32_t value) {
        for (int shift = 0; shift < 32; shift += 8) {
            bytes[offset++] = static_cast<uint8_t>(value >> shift);
        }
    };
    auto expectRejected = [&](std::vector<uint8_t> bytes) {
        FILE *stream = std::fopen(MORIA_CHECKPOINT_CANDIDATE, "wb");
        assert(stream != nullptr);
        assert(std::fwrite(bytes.data(), 1, bytes.size(), stream) == bytes.size());
        assert(std::fclose(stream) == 0);
        const uint32_t before_rejection = materialDigest();
        assert(!moriaCheckpointTestApplyCandidate());
        assert(materialDigest() == before_rejection);
    };
    const uint32_t payload_size = static_cast<uint32_t>(valid_candidate[footer_at + 32])
        | (static_cast<uint32_t>(valid_candidate[footer_at + 33]) << 8)
        | (static_cast<uint32_t>(valid_candidate[footer_at + 34]) << 16)
        | (static_cast<uint32_t>(valid_candidate[footer_at + 35]) << 24);
    const size_t payload_at = footer_at - payload_size;
    auto expectPayloadRejected = [&](std::vector<uint8_t> changed) {
        setU32(changed, footer_at + 36,
               moriaCheckpointFNV1a32(changed.data() + payload_at, payload_size));
        expectRejected(std::move(changed));
    };
    for (const size_t offset : {size_t{0}, size_t{8}, size_t{12}, size_t{36}}) {
        std::vector<uint8_t> changed = valid_candidate;
        changed[footer_at + offset] ^= 0x80;
        expectRejected(std::move(changed));
    }
    {
        std::vector<uint8_t> changed = valid_candidate;
        setU32(changed, footer_at + 32,
               static_cast<uint32_t>(MORIA_CHECKPOINT_MAX_PAYLOAD + 1));
        expectRejected(std::move(changed));
    }
    {
        std::vector<uint8_t> changed = valid_candidate;
        changed[payload_at + 317 + 6] = MAX_OWNERS;
        expectPayloadRejected(std::move(changed));
    }
    {
        std::vector<uint8_t> changed = valid_candidate;
        changed[payload_at + 317 + 7] = STORE_MAX_DISCRETE_ITEMS + 1;
        expectPayloadRejected(std::move(changed));
    }
    {
        std::vector<uint8_t> changed = valid_candidate;
        setU32(changed, payload_at + 38, 99); // row_prt != top - 1
        expectPayloadRejected(std::move(changed));
    }
    {
        std::vector<uint8_t> changed = valid_candidate;
        changed[payload_at + 42] = 2; // max_rows is source-owned 0 or 4
        changed[payload_at + 43] = 0;
        expectPayloadRejected(std::move(changed));
    }
    {
        std::vector<uint8_t> changed = valid_candidate;
        const size_t item_at = payload_at + 317 + 12 + 4;
        changed[item_at] = static_cast<uint8_t>(MAX_OBJECTS_IN_GAME);
        changed[item_at + 1] = static_cast<uint8_t>(MAX_OBJECTS_IN_GAME >> 8);
        expectPayloadRejected(std::move(changed));
    }
    {
        std::vector<uint8_t> changed = valid_candidate;
        const size_t item_at = payload_at + 317 + 12 + 4;
        changed[item_at + 2] = SpecialNameIds::SN_ARRAY_SIZE;
        expectPayloadRejected(std::move(changed));
    }
    {
        std::vector<uint8_t> changed = valid_candidate;
        const size_t item_at = payload_at + 317 + 12 + 4;
        std::memset(changed.data() + item_at + 3, 1, INSCRIP_SIZE);
        expectPayloadRejected(std::move(changed));
    }
    {
        std::vector<uint8_t> changed = valid_candidate;
        changed[footer_at - 1] = 2; // terminal.ready is the final Boolean field
        expectPayloadRejected(std::move(changed));
    }

    // An exact writer failure still restores every destructive save mutation,
    // emits no callbacks, never lands, and leaves no partial candidate.
    assert(unlink(MORIA_CHECKPOINT_CANDIDATE) == 0);
    assert(rmdir("recover") == 0);
    const uint32_t failure_before = materialDigest();
    const int landed_before = landed_callbacks;
    assert(!moriaCheckpointTestWriteNow());
    assert(materialDigest() == failure_before);
    assert(landed_callbacks == landed_before);
    assert(access(MORIA_CHECKPOINT_CANDIDATE, F_OK) != 0);

    // Marker survives incidental false updates and is consumed once at the
    // same-level true tail; a level transition clears it without cadence.
    assert(mkdir("recover", 0700) == 0);
    monster_updates = 0;
    py.flags.rest = 0;
    py.flags.status &= ~config::player::status::PY_SEARCH;
    due = false;
    moriaCheckpointOuterCommandReturned();
    vectMoriaGameRunUpdateMonsters(false);
    vectMoriaGameRunUpdateMonsters(true);
    assert(monster_updates == 2);
    due = true;
    moriaCheckpointOuterCommandReturned();
    dg.generate_new_level = true;
    vectMoriaGameRunUpdateMonsters(false);
    dg.generate_new_level = false;
    vectMoriaGameRunUpdateMonsters(true);
    assert(landed_callbacks == landed_before);
    return 0;
}

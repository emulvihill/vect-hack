// Copyright (c) 1981-86 Robert A. Koeneke
// Copyright (c) 1987-94 James E. Wilson
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Modified for VectHack (WebAssembly adaptation of the pinned Umoria 5.7.15
// sources) starting 2026-08-08; change dates are recorded in this repository's
// git history (GPLv3 section 5(a)).

#include "checkpoint-wasm.h"

#include <array>
#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "headers.h"
#include "semantic-wasm.h"

#ifndef MORIA_CHECKPOINT_HOST_TEST
#include <emscripten/emscripten.h>
#endif

namespace {
constexpr std::array<uint8_t, 20> SOURCE_COMMIT{{
    0x3b, 0xf8, 0xab, 0xc4, 0xf7, 0x68, 0x12, 0x81, 0x0e, 0x59,
    0xd7, 0x38, 0x49, 0x2c, 0x7b, 0x61, 0xfb, 0x8f, 0x1b, 0xb6,
}};

bool checkpoint_active = false;
bool outer_command_returned = false;
int16_t outer_command_level = -1;
bool recovery_selected = false;
bool recovery_loaded = false;
std::string recovery_path;

struct LiveSnapshot {
    Game_t game_state;
    Player_t player_state;
    Dungeon_t dungeon_state;
    std::array<Monster_t, MON_TOTAL_ALLOCATIONS> monster_state;
    std::array<Store_t, MAX_STORES> store_state;
    std::array<Recall_t, MON_MAX_CREATURES> recall_state;
    std::array<uint8_t, OBJECT_IDENT_SIZE> identified_state;
    std::array<vtype_t, MESSAGE_HISTORY_SIZE> message_state;
    int16_t next_monster;
    int16_t multiply_total;
    int16_t last_message;
    int16_t missiles;
    bool message_ready;
    bool screen_changed;
    int eof;
    bool panic;
    uint32_t random_seed;
    int32_t next_random;
    int saved_errno;
    std::string configured_path;
    MoriaTerminalCheckpointState terminal;
};

struct RecoveryState {
    uint32_t random_seed;
    char last_command;
    bool use_last_direction;
    bool wizard_mode;
    char previous_direction;
    bool message_ready;
    bool screen_changed;
    Panel_t panel;
    uint32_t status;
    int16_t rest;
    int16_t food;
    int16_t food_digested;
    int16_t speed;
    int16_t heaviness;
    bool weapon_heavy;
    bool carrying_light;
    bool temporary_light;
    int16_t next_monster;
    int16_t multiply_total;
    std::array<int16_t, MON_TOTAL_ALLOCATIONS> monster_speeds;
    std::array<Store_t, MAX_STORES> stores;
    MoriaTerminalCheckpointState terminal;
};

RecoveryState pending_recovery{};
uint32_t pending_payload_digest = 0;

class Fields {
public:
    void u8(uint8_t value) { bytes.push_back(value); }
    void boolean(bool value) { u8(value ? 1 : 0); }
    void u16(uint16_t value) {
        u8(static_cast<uint8_t>(value));
        u8(static_cast<uint8_t>(value >> 8));
    }
    void i16(int16_t value) { u16(static_cast<uint16_t>(value)); }
    void u32(uint32_t value) {
        for (int shift = 0; shift < 32; shift += 8) {
            u8(static_cast<uint8_t>(value >> shift));
        }
    }
    void i32(int32_t value) { u32(static_cast<uint32_t>(value)); }
    void raw(const uint8_t *value, size_t count) {
        bytes.insert(bytes.end(), value, value + count);
    }
    std::vector<uint8_t> bytes;
};

class Reader {
public:
    explicit Reader(const std::vector<uint8_t> &source) : bytes(source) {}
    bool u8(uint8_t &value) {
        if (offset >= bytes.size()) return false;
        value = bytes[offset++];
        return true;
    }
    bool boolean(bool &value) {
        uint8_t raw_value;
        if (!u8(raw_value) || raw_value > 1) return false;
        value = raw_value != 0;
        return true;
    }
    bool u16(uint16_t &value) {
        uint8_t lo, hi;
        if (!u8(lo) || !u8(hi)) return false;
        value = static_cast<uint16_t>(lo | (static_cast<uint16_t>(hi) << 8));
        return true;
    }
    bool i16(int16_t &value) {
        uint16_t raw_value;
        if (!u16(raw_value)) return false;
        value = static_cast<int16_t>(raw_value);
        return true;
    }
    bool u32(uint32_t &value) {
        uint8_t part[4];
        for (auto &entry : part) if (!u8(entry)) return false;
        value = static_cast<uint32_t>(part[0])
            | (static_cast<uint32_t>(part[1]) << 8)
            | (static_cast<uint32_t>(part[2]) << 16)
            | (static_cast<uint32_t>(part[3]) << 24);
        return true;
    }
    bool i32(int32_t &value) {
        uint32_t raw_value;
        if (!u32(raw_value)) return false;
        value = static_cast<int32_t>(raw_value);
        return true;
    }
    bool raw(uint8_t *value, size_t count) {
        if (count > bytes.size() - offset) return false;
        std::memcpy(value, bytes.data() + offset, count);
        offset += count;
        return true;
    }
    bool complete() const { return offset == bytes.size(); }
private:
    const std::vector<uint8_t> &bytes;
    size_t offset = 0;
};

void encodeInventory(Fields &out, const Inventory_t &item) {
    out.u16(item.id);
    out.u8(item.special_name_id);
    out.raw(reinterpret_cast<const uint8_t *>(item.inscription), INSCRIP_SIZE);
    out.u32(item.flags);
    out.u8(item.category_id);
    out.u8(item.sprite);
    out.i16(item.misc_use);
    out.i32(item.cost);
    out.u8(item.sub_category_id);
    out.u8(item.items_count);
    out.u16(item.weight);
    out.i16(item.to_hit);
    out.i16(item.to_damage);
    out.i16(item.ac);
    out.i16(item.to_ac);
    out.u8(item.damage.dice);
    out.u8(item.damage.sides);
    out.u8(item.depth_first_found);
    out.u8(item.identification);
}

bool decodeInventory(Reader &in, Inventory_t &item) {
    const bool decoded = in.u16(item.id) && in.u8(item.special_name_id)
        && in.raw(reinterpret_cast<uint8_t *>(item.inscription), INSCRIP_SIZE)
        && in.u32(item.flags) && in.u8(item.category_id) && in.u8(item.sprite)
        && in.i16(item.misc_use) && in.i32(item.cost)
        && in.u8(item.sub_category_id) && in.u8(item.items_count)
        && in.u16(item.weight) && in.i16(item.to_hit) && in.i16(item.to_damage)
        && in.i16(item.ac) && in.i16(item.to_ac) && in.u8(item.damage.dice)
        && in.u8(item.damage.sides) && in.u8(item.depth_first_found)
        && in.u8(item.identification);
    return decoded && item.id < MAX_OBJECTS_IN_GAME
        && item.special_name_id < SpecialNameIds::SN_ARRAY_SIZE
        && std::memchr(item.inscription, '\0', INSCRIP_SIZE) != nullptr;
}

void captureSnapshot(LiveSnapshot &state) {
    const int entry_errno = errno;
    state.game_state = game;
    state.player_state = py;
    state.dungeon_state = dg;
    std::copy(std::begin(monsters), std::end(monsters), state.monster_state.begin());
    std::copy(std::begin(stores), std::end(stores), state.store_state.begin());
    std::copy(std::begin(creature_recall), std::end(creature_recall), state.recall_state.begin());
    std::copy(std::begin(objects_identified), std::end(objects_identified), state.identified_state.begin());
    std::memcpy(state.message_state.data(), messages, sizeof(messages));
    state.next_monster = next_free_monster_id;
    state.multiply_total = monster_multiply_total;
    state.last_message = last_message_id;
    state.missiles = missiles_counter;
    state.message_ready = message_ready_to_print;
    state.screen_changed = screen_has_changed;
    state.eof = eof_flag;
    state.panic = panic_save;
    state.random_seed = getRandomSeed();
    state.next_random = rnd();
    setRandomSeed(state.random_seed - 1);
    state.saved_errno = entry_errno;
    state.configured_path = config::files::save_game;
    moriaTerminalCheckpointCapture(state.terminal);
    moriaCheckpointSaveStaticsCapture();
}

void moriaCheckpointRestore(const LiveSnapshot &state) {
    game = state.game_state;
    py = state.player_state;
    dg = state.dungeon_state;
    std::copy(state.monster_state.begin(), state.monster_state.end(), std::begin(monsters));
    std::copy(state.store_state.begin(), state.store_state.end(), std::begin(stores));
    std::copy(state.recall_state.begin(), state.recall_state.end(), std::begin(creature_recall));
    std::copy(state.identified_state.begin(), state.identified_state.end(), std::begin(objects_identified));
    std::memcpy(messages, state.message_state.data(), sizeof(messages));
    next_free_monster_id = state.next_monster;
    monster_multiply_total = state.multiply_total;
    last_message_id = state.last_message;
    missiles_counter = state.missiles;
    message_ready_to_print = state.message_ready;
    screen_has_changed = state.screen_changed;
    eof_flag = state.eof;
    panic_save = state.panic;
    // setRandomSeed maps input n to n+1, so live state s is restored with s-1.
    setRandomSeed(state.random_seed - 1);
    moriaTerminalCheckpointRestore(state.terminal);
    moriaCheckpointSaveStaticsRestore();
    errno = state.saved_errno;
}

uint32_t snapshotDigest(const LiveSnapshot &state) {
    Fields fields;
    fields.raw(reinterpret_cast<const uint8_t *>(&state.game_state), sizeof(state.game_state));
    fields.raw(reinterpret_cast<const uint8_t *>(&state.player_state), sizeof(state.player_state));
    fields.raw(reinterpret_cast<const uint8_t *>(&state.dungeon_state), sizeof(state.dungeon_state));
    fields.raw(reinterpret_cast<const uint8_t *>(state.monster_state.data()), sizeof(state.monster_state));
    fields.raw(reinterpret_cast<const uint8_t *>(state.store_state.data()), sizeof(state.store_state));
    fields.raw(reinterpret_cast<const uint8_t *>(state.recall_state.data()), sizeof(state.recall_state));
    fields.raw(state.identified_state.data(), state.identified_state.size());
    fields.raw(reinterpret_cast<const uint8_t *>(state.message_state.data()), sizeof(state.message_state));
    fields.i16(state.next_monster); fields.i16(state.multiply_total);
    fields.i16(state.last_message); fields.i16(state.missiles);
    fields.boolean(state.message_ready); fields.boolean(state.screen_changed);
    fields.i32(state.eof); fields.boolean(state.panic); fields.u32(state.random_seed);
    fields.raw(&state.terminal.cells[0][0], sizeof(state.terminal.cells));
    fields.raw(&state.terminal.saved_cells[0][0], sizeof(state.terminal.saved_cells));
    fields.i32(state.terminal.cursor_y); fields.i32(state.terminal.cursor_x);
    fields.i32(state.terminal.saved_cursor_y); fields.i32(state.terminal.saved_cursor_x);
    fields.boolean(state.terminal.ready);
    fields.raw(reinterpret_cast<const uint8_t *>(state.configured_path.data()), state.configured_path.size());
    return moriaCheckpointFNV1a32(fields.bytes.data(), fields.bytes.size());
}

int wizardLitMonsterCount() {
    int count = 0;
    for (int id = config::monsters::MON_MIN_INDEX_ID; id < next_free_monster_id; ++id) {
        if (monsters[id].lit) count++;
    }
    return count;
}

bool restoredExactly(const LiveSnapshot &before, uint32_t &after_digest) {
    const bool statics_match = moriaCheckpointSaveStaticsRestored();
    std::unique_ptr<LiveSnapshot> after(new LiveSnapshot{});
    captureSnapshot(*after);
    after_digest = snapshotDigest(*after);
    const bool next_matches = after->next_random == before.next_random;
    // captureSnapshot preserves the live RNG after its one-step diagnostic.
    return after_digest == snapshotDigest(before) && next_matches
        && after->saved_errno == before.saved_errno
        && statics_match;
}

std::vector<uint8_t> encodeTrailer(const LiveSnapshot &state) {
    Fields out;
    out.u32(state.random_seed);
    out.u8(static_cast<uint8_t>(state.game_state.last_command));
    out.boolean(state.game_state.use_last_direction);
    out.boolean(state.game_state.wizard_mode);
    out.u8(static_cast<uint8_t>(state.player_state.prev_dir));
    out.boolean(state.message_ready);
    out.boolean(state.screen_changed);
    const Panel_t &panel = state.dungeon_state.panel;
    out.i32(panel.row); out.i32(panel.col); out.i32(panel.top); out.i32(panel.bottom);
    out.i32(panel.left); out.i32(panel.right); out.i32(panel.col_prt); out.i32(panel.row_prt);
    out.i16(panel.max_rows); out.i16(panel.max_cols);
    out.u32(state.player_state.flags.status);
    out.i16(state.player_state.flags.rest);
    out.i16(state.player_state.flags.food);
    out.i16(state.player_state.flags.food_digested);
    out.i16(state.player_state.flags.speed);
    out.i16(state.player_state.pack.heaviness);
    out.boolean(state.player_state.weapon_is_heavy);
    out.boolean(state.player_state.carrying_light);
    out.boolean(state.player_state.temporary_light_only);
    out.i16(state.next_monster);
    out.i16(state.multiply_total);
    for (const Monster_t &monster : state.monster_state) out.i16(monster.speed);
    for (const Store_t &store : state.store_state) {
        out.i32(store.turns_left_before_closing);
        out.i16(store.insults_counter);
        out.u8(store.owner_id);
        out.u8(store.unique_items_counter);
        out.u16(store.good_purchases);
        out.u16(store.bad_purchases);
        for (const InventoryRecord_t &record : store.inventory) {
            out.i32(record.cost);
            encodeInventory(out, record.item);
        }
    }
    out.raw(&state.terminal.cells[0][0], sizeof(state.terminal.cells));
    out.raw(&state.terminal.saved_cells[0][0], sizeof(state.terminal.saved_cells));
    out.i32(state.terminal.cursor_y); out.i32(state.terminal.cursor_x);
    out.i32(state.terminal.saved_cursor_y); out.i32(state.terminal.saved_cursor_x);
    out.boolean(state.terminal.ready);
    return out.bytes;
}

bool decodeTrailer(const std::vector<uint8_t> &payload, RecoveryState &restored) {
    Reader in(payload);
    uint8_t last_command, previous_direction;
    if (!in.u32(restored.random_seed) || restored.random_seed == 0
        || restored.random_seed >= static_cast<uint32_t>(INT_MAX)
        || !in.u8(last_command) || !in.boolean(restored.use_last_direction)
        || !in.boolean(restored.wizard_mode) || !in.u8(previous_direction)
        || !in.boolean(restored.message_ready)
        || !in.boolean(restored.screen_changed)) return false;
    restored.last_command = static_cast<char>(last_command);
    restored.previous_direction = static_cast<char>(previous_direction);
    Panel_t &panel = restored.panel;
    if (!in.i32(panel.row) || !in.i32(panel.col) || !in.i32(panel.top)
        || !in.i32(panel.bottom) || !in.i32(panel.left) || !in.i32(panel.right)
        || !in.i32(panel.col_prt) || !in.i32(panel.row_prt)
        || !in.i16(panel.max_rows) || !in.i16(panel.max_cols)
        || !in.u32(restored.status) || !in.i16(restored.rest) || !in.i16(restored.food)
        || !in.i16(restored.food_digested) || !in.i16(restored.speed)
        || !in.i16(restored.heaviness) || !in.boolean(restored.weapon_heavy)
        || !in.boolean(restored.carrying_light) || !in.boolean(restored.temporary_light)
        || !in.i16(restored.next_monster) || !in.i16(restored.multiply_total)) return false;
    for (int16_t &speed : restored.monster_speeds) if (!in.i16(speed)) return false;
    for (Store_t &store : restored.stores) {
        if (!in.i32(store.turns_left_before_closing) || !in.i16(store.insults_counter)
            || !in.u8(store.owner_id) || !in.u8(store.unique_items_counter)
            || !in.u16(store.good_purchases) || !in.u16(store.bad_purchases)) return false;
        if (store.owner_id >= MAX_OWNERS
            || store.unique_items_counter > STORE_MAX_DISCRETE_ITEMS) return false;
        for (InventoryRecord_t &record : store.inventory) {
            if (!in.i32(record.cost) || !decodeInventory(in, record.item)) return false;
        }
    }
    MoriaTerminalCheckpointState &terminal = restored.terminal;
    if (!in.raw(&terminal.cells[0][0], sizeof(terminal.cells))
        || !in.raw(&terminal.saved_cells[0][0], sizeof(terminal.saved_cells))
        || !in.i32(terminal.cursor_y) || !in.i32(terminal.cursor_x)
        || !in.i32(terminal.saved_cursor_y) || !in.i32(terminal.saved_cursor_x)
        || !in.boolean(terminal.ready) || !in.complete()) return false;
    return terminal.cursor_y >= 0 && terminal.cursor_y < 24
        && terminal.cursor_x >= 0 && terminal.cursor_x < 80
        && terminal.saved_cursor_y >= 0 && terminal.saved_cursor_y < 24
        && terminal.saved_cursor_x >= 0 && terminal.saved_cursor_x < 80
        && restored.next_monster >= config::monsters::MON_MIN_INDEX_ID
        && restored.next_monster <= MON_TOTAL_ALLOCATIONS
        && (panel.max_rows == 0 || panel.max_rows == 4)
        && (panel.max_cols == 0 || panel.max_cols == 4)
        && panel.row >= 0 && panel.row <= panel.max_rows
        && panel.col >= 0 && panel.col <= panel.max_cols
        && panel.top == panel.row * (SCREEN_HEIGHT / 2)
        && panel.bottom == panel.top + SCREEN_HEIGHT - 1
        && panel.row_prt == panel.top - 1
        && panel.left == panel.col * (SCREEN_WIDTH / 2)
        && panel.right == panel.left + SCREEN_WIDTH - 1
        && panel.col_prt == panel.left - 13;
}

void applyRecovery(const RecoveryState &restored) {
    game.last_command = restored.last_command;
    game.use_last_direction = restored.use_last_direction;
    game.wizard_mode = restored.wizard_mode;
    py.prev_dir = restored.previous_direction;
    message_ready_to_print = restored.message_ready;
    screen_has_changed = restored.screen_changed;
    dg.panel = restored.panel;
    py.flags.status = restored.status;
    py.flags.rest = restored.rest;
    py.flags.food = restored.food;
    py.flags.food_digested = restored.food_digested;
    py.flags.speed = restored.speed;
    py.pack.heaviness = restored.heaviness;
    py.weapon_is_heavy = restored.weapon_heavy;
    py.carrying_light = restored.carrying_light;
    py.temporary_light_only = restored.temporary_light;
    next_free_monster_id = restored.next_monster;
    monster_multiply_total = restored.multiply_total;
    for (size_t i = 0; i < restored.monster_speeds.size(); ++i) {
        monsters[i].speed = restored.monster_speeds[i];
    }
    std::copy(restored.stores.begin(), restored.stores.end(), std::begin(stores));
    setRandomSeed(restored.random_seed - 1);
    moriaTerminalCheckpointRestore(restored.terminal);
}

void appendU32(std::array<uint8_t, MORIA_CHECKPOINT_FOOTER_SIZE> &footer,
               size_t offset, uint32_t value) {
    for (int shift = 0; shift < 32; shift += 8) {
        footer[offset++] = static_cast<uint8_t>(value >> shift);
    }
}

uint32_t readU32(const uint8_t *bytes) {
    return static_cast<uint32_t>(bytes[0])
        | (static_cast<uint32_t>(bytes[1]) << 8)
        | (static_cast<uint32_t>(bytes[2]) << 16)
        | (static_cast<uint32_t>(bytes[3]) << 24);
}

bool appendTrailer(const char *path, const std::vector<uint8_t> &payload) {
    if (payload.size() != MORIA_CHECKPOINT_PAYLOAD_SIZE
        || payload.size() > MORIA_CHECKPOINT_MAX_PAYLOAD) return false;
    FILE *stream = tfopen(path, "ab");
    if (stream == nullptr) return false;
    std::array<uint8_t, MORIA_CHECKPOINT_FOOTER_SIZE> footer{};
    std::memcpy(footer.data(), MORIA_CHECKPOINT_MAGIC, 8);
    appendU32(footer, 8, MORIA_CHECKPOINT_SCHEMA);
    std::copy(SOURCE_COMMIT.begin(), SOURCE_COMMIT.end(), footer.begin() + 12);
    appendU32(footer, 32, static_cast<uint32_t>(payload.size()));
    appendU32(footer, 36, moriaCheckpointFNV1a32(payload.data(), payload.size()));
    bool ok = std::fwrite(payload.data(), 1, payload.size(), stream) == payload.size();
    ok = std::fwrite(footer.data(), 1, footer.size(), stream) == footer.size() && ok;
    ok = std::fflush(stream) == 0 && ok;
    return std::fclose(stream) == 0 && ok;
}

bool readTrailer(const std::string &path, std::vector<uint8_t> &payload) {
    FILE *stream = tfopen(path.c_str(), "rb");
    if (stream == nullptr || std::fseek(stream, 0, SEEK_END) != 0) {
        if (stream != nullptr) std::fclose(stream);
        return false;
    }
    const long size = std::ftell(stream);
    if (size < static_cast<long>(4 + MORIA_CHECKPOINT_FOOTER_SIZE)
        || std::fseek(stream, size - static_cast<long>(MORIA_CHECKPOINT_FOOTER_SIZE), SEEK_SET) != 0) {
        std::fclose(stream);
        return false;
    }
    std::array<uint8_t, MORIA_CHECKPOINT_FOOTER_SIZE> footer{};
    const bool footer_read = std::fread(footer.data(), 1, footer.size(), stream) == footer.size();
    const uint32_t length = readU32(footer.data() + 32);
    const bool valid = footer_read
        && std::memcmp(footer.data(), MORIA_CHECKPOINT_MAGIC, 8) == 0
        && readU32(footer.data() + 8) == MORIA_CHECKPOINT_SCHEMA
        && std::equal(SOURCE_COMMIT.begin(), SOURCE_COMMIT.end(), footer.begin() + 12)
        && length == MORIA_CHECKPOINT_PAYLOAD_SIZE
        && length <= MORIA_CHECKPOINT_MAX_PAYLOAD
        && static_cast<long>(length + MORIA_CHECKPOINT_FOOTER_SIZE + 4) <= size;
    if (!valid || std::fseek(stream, size - static_cast<long>(MORIA_CHECKPOINT_FOOTER_SIZE) - length, SEEK_SET) != 0) {
        std::fclose(stream);
        return false;
    }
    payload.resize(length);
    const bool payload_read = std::fread(payload.data(), 1, length, stream) == length;
    std::fclose(stream);
    return payload_read && moriaCheckpointFNV1a32(payload.data(), payload.size()) == readU32(footer.data() + 36);
}

bool safeTail() {
    return game.character_generated && !game.character_saved && !game.character_is_dead
        && !dg.generate_new_level && dg.game_turn >= 0 && eof_flag == 0
        && game.command_count == 0 && py.running_tracker == 0 && py.flags.rest == 0
        && game.doing_inventory_command == 0 && !moriaSemanticOverlayActive();
}

#ifndef MORIA_CHECKPOINT_HOST_TEST
EM_JS(int, wasm_checkpoint_command, (), {
    return typeof Module.checkpointCommand === 'function' && Module.checkpointCommand() ? 1 : 0;
});

// ASYNCIFY CHECKPOINT CANARY: the turn-tail wrapper must suspend until durable
// publication completes, after the candidate is closed and live state restored.
EM_ASYNC_JS(int, wasm_checkpoint_landed, (), {
    try {
        if (typeof Module.checkpointLanded !== 'function') return 0;
        return await Module.checkpointLanded() ? 1 : 0;
    } catch (error) {
        Module.moriaCheckpointFailure = error;
        return 0;
    }
});

EM_JS(int, wasm_checkpoint_recovery_path, (char *buffer, int capacity), {
    const value = typeof Module.checkpointRecoveryPath === 'function'
        ? String(Module.checkpointRecoveryPath() || "") : "";
    const length = lengthBytesUTF8(value);
    if (length >= capacity) return -1;
    stringToUTF8(value, buffer, capacity);
    return length;
});

EM_JS(void, wasm_checkpoint_invariant, (const char *name, int value), {
    if (typeof Module.checkpointInvariant === 'function') {
        Module.checkpointInvariant(UTF8ToString(name), value);
    }
});
#else
extern "C" int moriaCheckpointHostCommand();
extern "C" int moriaCheckpointHostLanded();
extern "C" void moriaCheckpointHostInvariant(const char *, int);
int wasm_checkpoint_command() { return moriaCheckpointHostCommand(); }
int wasm_checkpoint_landed() { return moriaCheckpointHostLanded(); }
int wasm_checkpoint_recovery_path(char *, int) { return 0; }
void wasm_checkpoint_invariant(const char *name, int value) {
    moriaCheckpointHostInvariant(name, value);
}
#endif

bool writeCheckpointCandidate() {
    // Dungeon_t alone is larger than Emscripten's bounded native stack. Keep
    // both full snapshots in the heap; raw HEAP/active-stack rewind is forbidden.
    std::unique_ptr<LiveSnapshot> snapshot(new LiveSnapshot{});
    captureSnapshot(*snapshot);
    const uint32_t before_digest = snapshotDigest(*snapshot);
    const std::vector<uint8_t> trailer = encodeTrailer(*snapshot);
    const uint32_t payload_digest = moriaCheckpointFNV1a32(trailer.data(), trailer.size());
    checkpoint_active = true;
    moriaSemanticSetCheckpointActive(true);
    (void) unlink(MORIA_CHECKPOINT_CANDIDATE);
    const bool stock_ok = moriaCheckpointWriteStockCandidate(MORIA_CHECKPOINT_CANDIDATE);
    const bool trailer_ok = stock_ok && appendTrailer(MORIA_CHECKPOINT_CANDIDATE, trailer);
    moriaCheckpointRestore(*snapshot);
    uint32_t after_digest = 0;
    const bool invariant_ok = restoredExactly(*snapshot, after_digest);
    moriaSemanticSetCheckpointActive(false);
    checkpoint_active = false;
    wasm_checkpoint_invariant("checkpoint-digest-before", static_cast<int>(before_digest));
    wasm_checkpoint_invariant("checkpoint-digest-after", static_cast<int>(after_digest));
    wasm_checkpoint_invariant("checkpoint-payload-digest", static_cast<int>(payload_digest));
    wasm_checkpoint_invariant("checkpoint-rng-next", snapshot->next_random);
    wasm_checkpoint_invariant("checkpoint-wizard-mode", game.wizard_mode ? 1 : 0);
    wasm_checkpoint_invariant("checkpoint-wizard-lit", wizardLitMonsterCount());
    wasm_checkpoint_invariant("state-restored", invariant_ok ? 1 : 0);
    if (!trailer_ok || !invariant_ok) {
        const int restored_errno = errno;
        (void) unlink(MORIA_CHECKPOINT_CANDIDATE);
        errno = restored_errno;
        return false;
    }
    (void) wasm_checkpoint_landed();
    return true;
}
} // namespace

uint32_t moriaCheckpointFNV1a32(const uint8_t *bytes, size_t length) {
    uint32_t hash = 0x811c9dc5u;
    for (size_t i = 0; i < length; ++i) {
        hash ^= bytes[i];
        hash *= 0x01000193u;
    }
    return hash;
}

bool moriaCheckpointActive() {
    return checkpoint_active;
}

void moriaCheckpointOuterCommandReturned() {
    outer_command_returned = true;
    outer_command_level = dg.current_level;
}

void moriaCheckpointConfigureRecovery() {
    char path[1024]{};
    const int length = wasm_checkpoint_recovery_path(path, sizeof(path));
    recovery_selected = length > 0;
    recovery_loaded = false;
    recovery_path = recovery_selected ? path : "";
    outer_command_returned = false;
    outer_command_level = -1;
    config::files::save_game = recovery_selected ? recovery_path : "game.sav";
}

bool vectMoriaCheckpointLoadGame(bool &generate) {
    if (!recovery_selected) return loadGame(generate);
    std::vector<uint8_t> payload;
    RecoveryState decoded{};
    if (!readTrailer(config::files::save_game, payload) || !decodeTrailer(payload, decoded)) {
        config::files::save_game = "game.sav";
        recovery_selected = false;
        recovery_path.clear();
        return false;
    }
    pending_recovery = decoded;
    pending_payload_digest = moriaCheckpointFNV1a32(payload.data(), payload.size());
    const bool loaded = loadGame(generate);
    config::files::save_game = "game.sav";
    recovery_loaded = loaded;
    if (loaded) {
        // Wizard sight affects the mandatory initial visibility update, so
        // this already-validated bit must be present before that update. The
        // full state remains atomically applied immediately afterward.
        game.wizard_mode = pending_recovery.wizard_mode;
    } else {
        recovery_selected = false;
    }
    return loaded;
}

void vectMoriaCheckpointChangeCharacterName() {
    if (!recovery_loaded) changeCharacterName();
}

void vectMoriaGameRunUpdateMonsters(bool attack) {
    updateMonsters(attack);

    if (!attack) {
        if (recovery_loaded) {
            // This payload was fully decoded before the destructive stock
            // loader ran, so the post-load commit cannot fail halfway.
            applyRecovery(pending_recovery);
            moriaSemanticInvalidate();
            const uint32_t seed = getRandomSeed();
            const int32_t next_random = rnd();
            setRandomSeed(seed - 1);
            wasm_checkpoint_invariant("recovery-payload-digest",
                                      static_cast<int>(pending_payload_digest));
            wasm_checkpoint_invariant("recovery-rng-next", next_random);
            wasm_checkpoint_invariant("recovery-wizard-mode", game.wizard_mode ? 1 : 0);
            wasm_checkpoint_invariant("recovery-wizard-lit", wizardLitMonsterCount());
            wasm_checkpoint_invariant("recovery-applied", 1);
            recovery_loaded = false;
            recovery_selected = false;
            recovery_path.clear();
        }
        // Incidental false updates occur inside ordinary commands. Retain the
        // marker until the sole same-level attack=true tail, but clear it once
        // a level transition is observable (that path deliberately has no
        // attack=true call).
        if (outer_command_returned &&
            (dg.generate_new_level || dg.current_level != outer_command_level)) {
            outer_command_returned = false;
            outer_command_level = -1;
        }
        return;
    }

    if (!outer_command_returned) return;
    if (dg.current_level != outer_command_level) {
        outer_command_returned = false;
        outer_command_level = -1;
        return;
    }
    outer_command_returned = false;
    outer_command_level = -1;
    const bool due = wasm_checkpoint_command() != 0;
    if (!due || !safeTail()) return;

    (void) writeCheckpointCandidate();
}

#ifdef MORIA_CHECKPOINT_HOST_TEST
bool moriaCheckpointTestWriteNow() {
    return writeCheckpointCandidate();
}

bool moriaCheckpointTestApplyCandidate() {
    std::vector<uint8_t> payload;
    RecoveryState decoded{};
    if (!readTrailer(MORIA_CHECKPOINT_CANDIDATE, payload)
        || !decodeTrailer(payload, decoded)) return false;
    game.wizard_mode = decoded.wizard_mode;
    updateMonsters(false);
    applyRecovery(decoded);
    return true;
}
#endif

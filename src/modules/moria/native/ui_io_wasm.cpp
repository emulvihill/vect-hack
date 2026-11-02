// Copyright (c) 1981-86 Robert A. Koeneke
// Copyright (c) 1987-94 James E. Wilson
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Modified for VectHack (WebAssembly adaptation of the pinned Umoria 5.7.15
// sources) starting 2026-08-08; change dates are recorded in this repository's
// git history (GPLv3 section 5(a)).

// WebAssembly terminal I/O adaptation of the pinned upstream ui_io.cpp. The
// game-facing behavior stays source-faithful while the curses/select seams are
// replaced by one fixed byte terminal and suspending Module callbacks.

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <emscripten/emscripten.h>

#include "headers.h"
#include "checkpoint-wasm.h"
#include "semantic-wasm.h"

namespace {
constexpr int TERM_COLS = 80;
constexpr int TERM_ROWS = 24;

unsigned char terminal_cells[TERM_ROWS][TERM_COLS];
unsigned char saved_cells[TERM_ROWS][TERM_COLS];
int cursor_y = 0;
int cursor_x = 0;
int saved_cursor_y = 0;
int saved_cursor_x = 0;
bool terminal_ready = false;

bool validPosition(Coord_t coord) {
    return coord.y >= 0 && coord.y < TERM_ROWS && coord.x >= 0 && coord.x < TERM_COLS;
}

void requirePosition(Coord_t coord) {
    if (!validPosition(coord)) {
        std::abort();
    }
}

void wipeFrom(Coord_t coord) {
    requirePosition(coord);
    std::memset(&terminal_cells[coord.y][coord.x], ' ',
                static_cast<size_t>(TERM_COLS - coord.x));
}

Coord_t currentCursorPosition() {
    return Coord_t{cursor_y, cursor_x};
}
} // namespace

// A key result is deliberately an object rather than a truthy number: byte 0
// is input, while a poll with no key is not. Channel failure is carried across
// Asyncify rewind and rethrown unchanged; it never enters Umoria's EOF ladder.
EM_ASYNC_JS(int, wasm_wait_key, (int outer_command, int roguelike), {
    try {
        if (typeof Module.getKeyInput !== 'function') {
            throw new Error('createMoriaModule requires a getKeyInput module option');
        }
        const result = await Module.getKeyInput({
            blocking: true,
            context: outer_command ? 'outer-command' : 'literal',
            roguelike: Boolean(roguelike),
            delayMicroseconds: 0,
        });
        if (!result || result.status !== 'key' ||
            !Number.isInteger(result.key) || result.key < 0 || result.key > 255) {
            throw new Error('blocking getKeyInput must resolve to { status: "key", key: 0..255 }');
        }
        return result.key;
    } catch (error) {
        Module.moriaInputFailure = error;
        return -1;
    }
});

EM_ASYNC_JS(int, wasm_poll_key, (int microseconds, int roguelike), {
    try {
        if (typeof Module.getKeyInput !== 'function') {
            throw new Error('createMoriaModule requires a getKeyInput module option');
        }
        const result = await Module.getKeyInput({
            blocking: false,
            context: 'poll',
            roguelike: Boolean(roguelike),
            delayMicroseconds: microseconds,
        });
        if (result && result.status === 'none') {
            return 0;
        }
        if (!result || result.status !== 'key' ||
            !Number.isInteger(result.key) || result.key < 0 || result.key > 255) {
            throw new Error('poll getKeyInput must resolve to an explicit key or no-key result');
        }
        // Reserve zero for no-key while preserving NUL as a consumed byte.
        return result.key + 1;
    } catch (error) {
        Module.moriaInputFailure = error;
        return -1;
    }
});

EM_JS(void, wasm_rethrow_input_failure, (), {
    const error = Module.moriaInputFailure;
    delete Module.moriaInputFailure;
    throw error;
});

EM_JS(void, wasm_terminal_flush, (const unsigned char *cells, int y, int x), {
    if (typeof Module.terminalFlush === 'function') {
        Module.terminalFlush(HEAPU8.slice(cells, cells + 80 * 24), y, x);
    }
});

EM_JS(int, wasm_terminal_bell, (), {
    if (typeof Module.terminalBell === 'function') {
        Module.terminalBell();
    }
    return 1;
});

EM_ASYNC_JS(int, wasm_before_exit, (int status, int outcome), {
    try {
        if (typeof Module.beforeExit !== 'function') {
            throw new Error('createMoriaModule requires a beforeExit module option');
        }
        await Module.beforeExit(status, outcome);
        Module.moriaPreExit = true;
        return 0;
    } catch (error) {
        Module.moriaExitFailure = error;
        return -1;
    }
});

EM_JS(void, wasm_rethrow_exit_failure, (), {
    const error = Module.moriaExitFailure;
    delete Module.moriaExitFailure;
    throw error;
});

extern "C" void __real_exit(int status) __attribute__((noreturn));
extern "C" void __wrap_exit(int status) __attribute__((noreturn));

extern "C" void __wrap_exit(int status) {
    const int outcome = std::strcmp(game.character_died_from, "(saved)") == 0
        ? 1 : (game.character_generated && game.character_is_dead ? 2 : 0);
    if (wasm_before_exit(status, outcome) < 0) {
        wasm_rethrow_exit_failure();
    }
    __real_exit(status);
}

int eof_flag = 0;
bool panic_save = false;

bool terminalInitialize() {
    std::memset(terminal_cells, ' ', sizeof(terminal_cells));
    std::memset(saved_cells, ' ', sizeof(saved_cells));
    cursor_y = cursor_x = 0;
    saved_cursor_y = saved_cursor_x = 0;
    terminal_ready = true;
    putQIO();
    return true;
}

void terminalRestore() {
    if (!terminal_ready) {
        return;
    }
    putQIO();
    terminal_ready = false;
}

void terminalSaveScreen() {
    std::memcpy(saved_cells, terminal_cells, sizeof(terminal_cells));
    saved_cursor_y = cursor_y;
    saved_cursor_x = cursor_x;
    moriaSemanticOverlayPush();
}

void terminalRestoreScreen() {
    std::memcpy(terminal_cells, saved_cells, sizeof(terminal_cells));
    cursor_y = saved_cursor_y;
    cursor_x = saved_cursor_x;
    moriaSemanticOverlayPop();
}

ssize_t terminalBellSound() {
    putQIO();
    if (moriaCheckpointActive()) return 0;
    return config::options::error_beep_sound ? wasm_terminal_bell() : 0;
}

void putQIO() {
    screen_has_changed = true;
    if (moriaCheckpointActive()) return;
    wasm_terminal_flush(&terminal_cells[0][0], cursor_y, cursor_x);
    moriaSemanticFlush();
}

void flushInputBuffer() {
    if (eof_flag != 0 || moriaCheckpointActive()) {
        return;
    }
    while (checkForNonBlockingKeyPress(0)) {
    }
}

void clearScreen() {
    if (message_ready_to_print) {
        printMessage(CNIL);
    }
    std::memset(terminal_cells, ' ', sizeof(terminal_cells));
    cursor_y = cursor_x = 0;
}

void clearToBottom(int row) {
    requirePosition(Coord_t{row, 0});
    for (int y = row; y < TERM_ROWS; ++y) {
        std::memset(terminal_cells[y], ' ', TERM_COLS);
    }
    cursor_y = row;
    cursor_x = 0;
}

void moveCursor(Coord_t coord) {
    requirePosition(coord);
    cursor_y = coord.y;
    cursor_x = coord.x;
}

void addChar(char ch, Coord_t coord) {
    requirePosition(coord);
    terminal_cells[coord.y][coord.x] = static_cast<unsigned char>(ch);
    cursor_y = coord.y;
    cursor_x = std::min(coord.x + 1, TERM_COLS - 1);
}

void putString(const char *out_str, Coord_t coord) {
    requirePosition(coord);
    const int limit = 79 - coord.x;
    int written = 0;
    while (written < limit && out_str[written] != '\0' &&
           out_str[written] != '\n' && out_str[written] != '\r') {
        terminal_cells[coord.y][coord.x + written] =
            static_cast<unsigned char>(out_str[written]);
        ++written;
    }
    cursor_y = coord.y;
    cursor_x = std::min(coord.x + written, TERM_COLS - 1);
}

void putStringClearToEOL(const std::string &str, Coord_t coord) {
    if (coord.y == MSG_LINE && message_ready_to_print) {
        printMessage(CNIL);
    }
    moveCursor(coord);
    wipeFrom(coord);
    putString(str.c_str(), coord);
}

void eraseLine(Coord_t coord) {
    if (coord.y == MSG_LINE && message_ready_to_print) {
        printMessage(CNIL);
    }
    moveCursor(coord);
    wipeFrom(coord);
}

void panelMoveCursor(Coord_t coord) {
    coord.y -= dg.panel.row_prt;
    coord.x -= dg.panel.col_prt;
    moveCursor(coord);
}

void panelPutTile(char ch, Coord_t coord) {
    coord.y -= dg.panel.row_prt;
    coord.x -= dg.panel.col_prt;
    addChar(ch, coord);
}

void messageLinePrintMessage(std::string message) {
    Coord_t coord = currentCursorPosition();
    std::memset(terminal_cells[MSG_LINE], ' ', TERM_COLS);
    message.resize(79);
    putString(message.c_str(), Coord_t{MSG_LINE, 0});
    moveCursor(coord);
}

void messageLineClear() {
    Coord_t coord = currentCursorPosition();
    std::memset(terminal_cells[MSG_LINE], ' ', TERM_COLS);
    moveCursor(coord);
}

void printMessage(const char *msg) {
    int new_len = 0;
    int old_len = 0;
    bool combine_messages = false;

    if (msg != nullptr) {
        moriaSemanticMessage(msg);
    }

    if (message_ready_to_print) {
        old_len = static_cast<int>(std::strlen(messages[last_message_id])) + 1;
        if (msg != nullptr) {
            new_len = static_cast<int>(std::strlen(msg));
        }
        if (msg == nullptr || new_len + old_len + 2 >= 73) {
            old_len = std::min(old_len, 73);
            putString(" -more-", Coord_t{MSG_LINE, old_len});
            char key;
            do {
                key = getKeyInput();
            } while (key != ' ' && key != ESCAPE && key != '\n' && key != '\r');
        } else {
            combine_messages = true;
        }
    }

    if (!combine_messages) {
        std::memset(terminal_cells[MSG_LINE], ' ', TERM_COLS);
    }
    if (msg == nullptr) {
        message_ready_to_print = false;
        return;
    }

    game.command_count = 0;
    message_ready_to_print = true;
    if (combine_messages) {
        putString(msg, Coord_t{MSG_LINE, old_len + 2});
        std::strcat(messages[last_message_id], "  ");
        std::strcat(messages[last_message_id], msg);
    } else {
        messageLinePrintMessage(msg);
        last_message_id++;
        if (last_message_id >= MESSAGE_HISTORY_SIZE) {
            last_message_id = 0;
        }
        std::strncpy(messages[last_message_id], msg, MORIA_MESSAGE_SIZE);
        messages[last_message_id][MORIA_MESSAGE_SIZE - 1] = '\0';
    }
}

void printMessageNoCommandInterrupt(const std::string &msg) {
    int command_count = game.command_count;
    printMessage(msg.c_str());
    game.command_count = command_count;
}

namespace {
char readBlockingKey(bool outer_command) {
    putQIO();
    game.command_count = 0;
    while (true) {
        const int key = wasm_wait_key(outer_command ? 1 : 0,
                                      config::options::use_roguelike_keys ? 1 : 0);
        if (key < 0) {
            wasm_rethrow_input_failure();
        }
        if (key != CTRL_KEY('R')) {
            return static_cast<char>(key);
        }
        putQIO();
    }
}
} // namespace

char getKeyInput() {
    return readBlockingKey(false);
}

// Only game_run.cpp sees this symbol through its compile-time rename. Its two
// count reads happen on MSG_LINE and stay literal; the direct dungeon read
// happens at the hero cursor and is the sole outer-command request.
char vectMoriaGameRunKeyInput() {
    const bool outer_command = cursor_y != MSG_LINE;
    // The dungeon is on screen and the cursor is on the hero: no full-screen
    // display can be up, so anything still claimed is a scope upstream never
    // gave back (see moriaSemanticOverlayReset). Reset before the read, so the
    // flush inside it publishes the cleared overlay with the parked request.
    if (outer_command) moriaSemanticOverlayReset();
    const char key = readBlockingKey(outer_command);
    if (outer_command) moriaCheckpointOuterCommandReturned();
    return key;
}

bool getCommand(const std::string &prompt, char &command) {
    if (!prompt.empty()) {
        putStringClearToEOL(prompt, Coord_t{0, 0});
    }
    command = getKeyInput();
    messageLineClear();
    return command != ESCAPE;
}

bool getTileCharacter(const std::string &prompt, char &command) {
    return getCommand(prompt, command);
}

bool getMenuItemId(const std::string &prompt, char &command) {
    return getCommand(prompt, command);
}

bool getStringInput(char *in_str, Coord_t coord, int slen) {
    moveCursor(coord);
    for (int i = slen; i > 0 && coord.x + slen - i < TERM_COLS; --i) {
        terminal_cells[coord.y][coord.x + slen - i] = ' ';
    }
    moveCursor(coord);

    const int start_col = coord.x;
    const int end_col = std::min(coord.x + slen - 1, TERM_COLS - 1);
    char *p = in_str;
    bool complete = false;
    bool aborted = false;

    while (!complete && !aborted) {
        const int key = static_cast<unsigned char>(getKeyInput());
        switch (key) {
            case ESCAPE:
                aborted = true;
                break;
            case CTRL_KEY('J'):
            case CTRL_KEY('M'):
                complete = true;
                break;
            case DELETE:
            case CTRL_KEY('H'):
                if (coord.x > start_col) {
                    coord.x--;
                    putString(" ", coord);
                    moveCursor(coord);
                    *--p = '\0';
                }
                break;
            default:
                if (std::isprint(key) == 0 || coord.x > end_col) {
                    terminalBellSound();
                } else {
                    addChar(static_cast<char>(key), coord);
                    *p++ = static_cast<char>(key);
                    coord.x++;
                }
                break;
        }
    }

    if (aborted) {
        return false;
    }
    while (p > in_str && p[-1] == ' ') {
        p--;
    }
    *p = '\0';
    return true;
}

bool getInputConfirmation(const std::string &prompt) {
    return getInputConfirmationWithAbort(0, prompt) == 1;
}

int getInputConfirmationWithAbort(int column, const std::string &prompt) {
    putStringClearToEOL(prompt, Coord_t{0, column});
    if (cursor_x > 73) {
        moveCursor(Coord_t{0, 73});
    }
    putString(" [y/n]", currentCursorPosition());

    char key = ' ';
    while (key == ' ') {
        key = getKeyInput();
    }
    messageLineClear();
    if (key == 'N' || key == 'n') {
        return 0;
    }
    if (key == 'Y' || key == 'y') {
        return 1;
    }
    return -1;
}

void waitForContinueKey(int line_number) {
    putStringClearToEOL("[ press any key to continue ]", Coord_t{line_number, 23});
    (void) getKeyInput();
    eraseLine(Coord_t{line_number, 0});
}

bool checkForNonBlockingKeyPress(int microseconds) {
    if (moriaCheckpointActive()) return false;
    moriaSemanticFlush();
    const int result = wasm_poll_key(microseconds,
                                     config::options::use_roguelike_keys ? 1 : 0);
    if (result < 0) {
        wasm_rethrow_input_failure();
    }
    return result > 0;
}

void moriaTerminalCheckpointCapture(MoriaTerminalCheckpointState &state) {
    std::memcpy(state.cells, terminal_cells, sizeof(terminal_cells));
    std::memcpy(state.saved_cells, saved_cells, sizeof(saved_cells));
    state.cursor_y = cursor_y;
    state.cursor_x = cursor_x;
    state.saved_cursor_y = saved_cursor_y;
    state.saved_cursor_x = saved_cursor_x;
    state.ready = terminal_ready;
}

void moriaTerminalCheckpointRestore(const MoriaTerminalCheckpointState &state) {
    std::memcpy(terminal_cells, state.cells, sizeof(terminal_cells));
    std::memcpy(saved_cells, state.saved_cells, sizeof(saved_cells));
    cursor_y = state.cursor_y;
    cursor_x = state.cursor_x;
    saved_cursor_y = state.saved_cursor_y;
    saved_cursor_x = state.saved_cursor_x;
    terminal_ready = state.ready;
}

void getDefaultPlayerName(char *buffer) {
    const char *default_name = "X";
    std::strcpy(buffer, default_name);
}

#undef fopen
#undef open

FILE *tfopen(const char *file, const char *mode) {
    char expanded[1024];
    if (tilde(file, expanded)) {
        return std::fopen(expanded, mode);
    }
    errno = ENOENT;
    return nullptr;
}

int topen(const char *file, int flags, int mode) {
    char expanded[1024];
    if (tilde(file, expanded)) {
        return ::open(expanded, flags, mode);
    }
    errno = ENOENT;
    return -1;
}

bool tilde(const char *file, char *expanded) {
    if (file == nullptr) {
        return false;
    }
    *expanded = '\0';
    if (*file == '~') {
        // Emscripten has no passwd database: getpwnam/getpwuid are hard
        // ENOENT stubs. Preserve the reachable current-user form through
        // HOME and reject ~user explicitly instead of misexpanding it.
        if (file[1] != '\0' && file[1] != '/') {
            return false;
        }
        const char *home = std::getenv("HOME");
        if (home == nullptr || home[0] == '\0') {
            return false;
        }
        std::strcpy(expanded, home);
        file++;
    }
    std::strcat(expanded, file);
    return true;
}

bool checkFilePermissions() {
    return true;
}

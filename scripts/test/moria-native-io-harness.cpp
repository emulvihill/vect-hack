// Test-only link harness for the production Moria native I/O translation
// unit. It adds observability around otherwise internal terminal state without
// adding exports or test branches to the shipped WASM module.

#include "../../src/modules/moria/native/ui_io_wasm.cpp"

extern "C" EMSCRIPTEN_KEEPALIVE int moria_test_terminal() {
    terminalInitialize();

    putString("ABCDEFGHIJ", Coord_t{5, 75});
    putQIO();

    putStringClearToEOL("XY", Coord_t{5, 76});
    putQIO();

    terminalSaveScreen();
    addChar('!', Coord_t{5, 76});
    terminalRestoreScreen();
    putQIO();

    addChar('Z', Coord_t{6, 10});
    clearToBottom(6);
    putQIO();

    return cursor_y * 100 + cursor_x;
}

extern "C" EMSCRIPTEN_KEEPALIVE int moria_test_messages() {
    terminalInitialize();
    std::memset(messages, 0, sizeof(messages));
    last_message_id = 0;
    message_ready_to_print = false;

    printMessage("alpha");
    printMessage("beta");
    putQIO();

    int result = std::strcmp(messages[1], "alpha  beta") == 0 ? 1 : 0;
    const char *long_message =
        "This message is long enough to require the source-faithful more gate.";
    printMessage(long_message);
    result |= last_message_id == 2 ? 2 : 0;
    result |= std::strcmp(messages[2], long_message) == 0 ? 4 : 0;
    putQIO();
    return result;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t moria_test_partial_line() {
    terminalInitialize();
    char input[8] = {'q', 'q', 'q', 'q', 'q', 'q', 'q', '\0'};
    const bool accepted = getStringInput(input, Coord_t{10, 10}, 5);
    return (accepted ? 1u : 0u) |
           (static_cast<uint32_t>(static_cast<uint8_t>(input[0])) << 8) |
           (static_cast<uint32_t>(static_cast<uint8_t>(input[1])) << 16) |
           (static_cast<uint32_t>(static_cast<uint8_t>(input[2])) << 24);
}

extern "C" EMSCRIPTEN_KEEPALIVE int moria_test_paths() {
    char relative[1024];
    char home[1024];
    int result = tilde("moria-relative.tmp", relative) &&
                         std::strcmp(relative, "moria-relative.tmp") == 0
                     ? 1
                     : 0;
    result |= tilde("~/moria-tilde.tmp", home) &&
                      std::strcmp(home, "/home/web_user/moria-tilde.tmp") == 0
                  ? 2
                  : 0;
    char unsupported[1024];
    result |= !tilde("~another-user/file", unsupported) ? 4 : 0;

    if (chdir("/tmp") == 0) {
        FILE *relative_file = tfopen("moria-relative.tmp", "wb");
        if (relative_file != nullptr) {
            const bool written = std::fputs("relative", relative_file) >= 0;
            const bool closed = std::fclose(relative_file) == 0;
            result |= written && closed ? 8 : 0;
        }
    }

    const int tilde_file = topen("~/moria-tilde.tmp", O_CREAT | O_TRUNC | O_WRONLY, 0600);
    if (tilde_file >= 0) {
        const bool written = ::write(tilde_file, "tilde", 5) == 5;
        const bool closed = ::close(tilde_file) == 0;
        result |= written && closed ? 16 : 0;
    }
    result |= checkFilePermissions() ? 32 : 0;
    return result;
}

extern "C" EMSCRIPTEN_KEEPALIVE int moria_test_bell() {
    terminalInitialize();
    config::options::error_beep_sound = false;
    const bool disabled = terminalBellSound() == 0;
    config::options::error_beep_sound = true;
    const bool enabled = terminalBellSound() == 1;
    return (disabled ? 1 : 0) | (enabled ? 2 : 0);
}

extern "C" EMSCRIPTEN_KEEPALIVE int moria_test_poll() {
    config::options::use_roguelike_keys = false;
    const bool no_key = !checkForNonBlockingKeyPress(0);
    const bool nul_key = checkForNonBlockingKeyPress(0);
    return (no_key ? 1 : 0) | (nul_key ? 2 : 0);
}

extern "C" EMSCRIPTEN_KEEPALIVE int moria_test_io_state() {
    return eof_flag | (panic_save ? 0x100 : 0);
}

// Copyright (c) 1981-86 Robert A. Koeneke
// Copyright (c) 1987-94 James E. Wilson
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Modified for VectHack (WebAssembly adaptation of the pinned Umoria 5.7.15
// sources) starting 2026-08-08; change dates are recorded in this repository's
// git history (GPLv3 section 5(a)).

// VectHack executable boundary for pinned Umoria 5.7.15. This is a
// source-faithful own-entry adaptation of external/umoria/src/main.cpp: the
// upstream translation unit is omitted, the official source remains clean,
// and the synchronous core is entered once from a Web Worker.

#include <emscripten/emscripten.h>
#include <cstdint>
#include <unistd.h>

#include "headers.h"
#include "checkpoint-wasm.h"

extern "C" EMSCRIPTEN_KEEPALIVE int moria_start(uint32_t seed, bool roguelike_keys) {
    // Persistence preRun selects /vect-moria before this entry. Direct native
    // harnesses have no preRun policy, so fall back to the packaged tree only
    // when the selected cwd does not contain Umoria's required score file.
    if (access(config::files::scores.c_str(), F_OK) != 0 && chdir("/moria-seed") != 0) {
        return 1;
    }

    // Preserve upstream main()'s ordering: scores must be writable before
    // terminal initialization and the real core start.
    if (!initializeScoreFile()) {
        return 2;
    }
    if (!checkFilePermissions()) {
        return 3;
    }
    if (!terminalInitialize()) {
        return 4;
    }

    moriaCheckpointConfigureRecovery();
    startMoria(seed, false, roguelike_keys);
    terminalRestore();
    return 0;
}

// Copyright (c) 1981-86 Robert A. Koeneke
// Copyright (c) 1987-94 James E. Wilson
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Modified for VectHack (WebAssembly adaptation of the pinned Umoria 5.7.15
// sources) starting 2026-08-08; change dates are recorded in this repository's
// git history (GPLv3 section 5(a)).

// The pinned serializer intentionally keeps saveChar and its stream state
// file-static. Including that unchanged source here is the narrowest way to
// reuse the exact stock format without copying its writer or exporting a new
// upstream ABI. The makefile excludes the ordinary game_save.cpp TU.
#include "../../../../external/umoria/src/game_save.cpp"

#include "checkpoint-wasm.h"

namespace {
struct SaveStatics {
    FILE *file;
    uint8_t xor_value;
    int from_save;
    uint32_t started;
    std::string configured_path;
};

SaveStatics checkpoint_save_statics{};
} // namespace

void moriaCheckpointSaveStaticsCapture() {
    checkpoint_save_statics = {
        fileptr, xor_byte, from_save_file, start_time, config::files::save_game,
    };
}

void moriaCheckpointSaveStaticsRestore() {
    fileptr = checkpoint_save_statics.file;
    xor_byte = checkpoint_save_statics.xor_value;
    from_save_file = checkpoint_save_statics.from_save;
    start_time = checkpoint_save_statics.started;
    config::files::save_game = checkpoint_save_statics.configured_path;
}

bool moriaCheckpointSaveStaticsRestored() {
    return fileptr == checkpoint_save_statics.file
        && xor_byte == checkpoint_save_statics.xor_value
        && from_save_file == checkpoint_save_statics.from_save
        && start_time == checkpoint_save_statics.started
        && config::files::save_game == checkpoint_save_statics.configured_path;
}

bool moriaCheckpointWriteStockCandidate(const char *path) {
    config::files::save_game = path;
    // The candidate is private scratch state and may replace a failed prior
    // attempt without entering the stock overwrite prompt.
    from_save_file = 1;
    return saveChar(path);
}

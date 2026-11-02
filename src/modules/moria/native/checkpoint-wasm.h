// Copyright (c) 1981-86 Robert A. Koeneke
// Copyright (c) 1987-94 James E. Wilson
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Modified for VectHack (WebAssembly adaptation of the pinned Umoria 5.7.15
// sources) starting 2026-08-08; change dates are recorded in this repository's
// git history (GPLv3 section 5(a)).

#pragma once

#include <cstddef>
#include <cstdint>

constexpr char MORIA_CHECKPOINT_MAGIC[] = "VHMCP001";
constexpr uint32_t MORIA_CHECKPOINT_SCHEMA = 1;
constexpr size_t MORIA_CHECKPOINT_FOOTER_SIZE = 40;
constexpr size_t MORIA_CHECKPOINT_MAX_PAYLOAD = 128 * 1024;
constexpr size_t MORIA_CHECKPOINT_PAYLOAD_SIZE = 11158;
constexpr char MORIA_CHECKPOINT_CANDIDATE[] = "recover/.pending.sav";

struct MoriaTerminalCheckpointState {
    uint8_t cells[24][80];
    uint8_t saved_cells[24][80];
    int32_t cursor_y;
    int32_t cursor_x;
    int32_t saved_cursor_y;
    int32_t saved_cursor_x;
    bool ready;
};

uint32_t moriaCheckpointFNV1a32(const uint8_t *bytes, size_t length);
bool moriaCheckpointActive();
void moriaCheckpointOuterCommandReturned();
void moriaCheckpointConfigureRecovery();

void moriaTerminalCheckpointCapture(MoriaTerminalCheckpointState &state);
void moriaTerminalCheckpointRestore(const MoriaTerminalCheckpointState &state);

void vectMoriaGameRunUpdateMonsters(bool attack);
bool vectMoriaCheckpointLoadGame(bool &generate);
void vectMoriaCheckpointChangeCharacterName();

// Defined by the same-TU adapter that includes pinned upstream game_save.cpp.
bool moriaCheckpointWriteStockCandidate(const char *path);
void moriaCheckpointSaveStaticsCapture();
void moriaCheckpointSaveStaticsRestore();
bool moriaCheckpointSaveStaticsRestored();

#ifdef MORIA_CHECKPOINT_HOST_TEST
bool moriaCheckpointTestWriteNow();
bool moriaCheckpointTestApplyCandidate();
#endif

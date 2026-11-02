// SPDX-License-Identifier: NGPL
//
// Copyright (c) Janet Walz, 1992 — the copyright notice of NetHack's
// util/recover.c, retained here per NGPL ¶1.
//
// NOTICE (NGPL ¶2a): this file is a TypeScript port of restore_savefile()
// from NetHack's util/recover.c — rewritten in TypeScript against the wasm32
// target's on-disk layout. Changed by VectHack on 2026-07-27, 2026-07-28,
// 2026-08-02 and 2026-08-21; later modifiers should append the date of their
// change here. As a derivative of NetHack it
// is licensed under the NetHack General Public License (LICENSE.NETHACK at
// the repository root), not the MIT license that covers the rest of this
// project.
//
// Rebuild a real NetHack save file from a set of checkpointed level files.
//
// This is a port of restore_savefile() in util/recover.c — NetHack ships that
// as a standalone program precisely so something outside the engine can turn
// orphaned level files back into a save, so this is the supported seam rather
// than a way around one.
//
// Why the port exists rather than a call to the engine's own
// recover_savefile(): getlock()'s "Recover [r]" branch reaches
// recover_savefile() (src/files.c:2861), which sets
// program_state.in_self_recover and deliberately leaves it set for its caller
// to clear (src/files.c:3074). sys/unix/unixmain.c:275 and
// sys/windows/windmain.c:464 do clear it; sys/libnh/libnhmain.c — the main the
// wasm target builds (sys/unix/hints/include/cross-pre2.500:396) — never does.
// The flag is the first guard in save_currentstate() (src/do.c:1379) and in
// savestateinlock() (src/save.c:383), so after an in-engine recovery every
// later checkpoint silently writes nothing and autosave is dead for the rest
// of the game. Handing the engine a finished save file instead means it takes
// its ordinary restore_saved_game() -> dorecover() path, which never sets the
// flag.
//
// Nothing here interprets game state. The level files are copied through as
// opaque bytes; only the small framing header at the front of level.0 is
// parsed. CROSS_TO_WASM leaves COMPRESS undefined (include/global.h:454), so
// there is no compression layer to reproduce.
//
// One deliberate difference from the in-engine path: recover_savefile()
// re-stamps the header with the running binary's store_version()
// (src/files.c:2987), while recover.c — and so this — copies the version bytes
// out of level.0 verbatim (util/recover.c:302). A mirror written by a
// different build is therefore rejected by the engine's own validate() instead
// of being silently re-stamped, which is the safer of the two.

/**
 * Layout of the framing header at the front of level.0, as savestateinlock()
 * (src/save.c) writes it and util/recover.c:242-271 reads it. Sizes are for
 * the wasm32 target and are asserted against the NetHack headers by
 * scripts/test/recover-save.test.ts, so a submodule bump that moves them
 * fails a test rather than corrupting a save.
 */
const INT_BYTES = 4;
/** SAVESIZE = PL_NSIZ + sizeof(SAVEX) + sizeof(SAVE_EXTENSION) + INDSIZE. */
export const SAVESIZE = 54;
/** struct version_info: three unsigned longs (include/global.h:348). */
export const VERSION_INFO_BYTES = 12;
/** PL_NSIZ_PLUS, the cap on the stored player-name length (global.h:406). */
export const PL_NSIZ_PLUS = 49;
/** Level numbers are xint8 in save.c, so the endlevel must be < 256. */
const MAX_LEVELS = 256;

/** Everything the framing header carries, plus where the game state starts. */
interface Level0Header {
  savelev: number;
  /** Relative path of the save file the engine would have written. */
  savename: string;
  indicator: number;
  criticalSizes: Uint8Array;
  versionInfo: Uint8Array;
  playerName: Uint8Array;
  /** Offset in level.0 where the non-level game state begins. */
  stateOffset: number;
}

export class RecoverError extends Error {}

/**
 * A save file path the engine could plausibly have produced. This decides
 * where the rebuilt save is written, and the bytes it comes from are only as
 * trustworthy as the volume, so "." and ".." segments are refused outright
 * rather than normalised.
 */
const SAVENAME_SEGMENT = /^[A-Za-z0-9._-]+$/;

function plausibleSaveName(name: string): boolean {
  if (name === "" || name.startsWith("/")) return false;
  const segments = name.split("/");
  return segments.every((s) => s !== "." && s !== ".." && SAVENAME_SEGMENT.test(s));
}

function parseLevel0(zero: Uint8Array): Level0Header {
  const view = new DataView(zero.buffer, zero.byteOffset, zero.byteLength);
  // hpid, savelev, savename, indicator, cscsize
  const fixed = INT_BYTES + INT_BYTES + SAVESIZE + 1 + 1;
  if (zero.length < fixed)
    throw new RecoverError(`level.0 is ${zero.length} bytes, short of its ${fixed}-byte prefix`);

  let at = INT_BYTES; // hpid is written but never used by the rebuild
  const savelev = view.getInt32(at, true); at += INT_BYTES;
  if (savelev < 0 || savelev >= MAX_LEVELS)
    throw new RecoverError(`level.0 names level ${savelev}, outside 0..${MAX_LEVELS - 1}`);

  const nameBytes = zero.subarray(at, at + SAVESIZE); at += SAVESIZE;
  const nul = nameBytes.indexOf(0);
  const savename = new TextDecoder().decode(nul < 0 ? nameBytes : nameBytes.subarray(0, nul));
  if (!plausibleSaveName(savename))
    throw new RecoverError(`level.0 carries an implausible save name ${JSON.stringify(savename)}`);

  const indicator = zero[at]!; at += 1;
  const cscsize = zero[at]!; at += 1;

  const rest = cscsize + VERSION_INFO_BYTES + INT_BYTES;
  if (zero.length < at + rest)
    throw new RecoverError(`level.0 ends inside its header (needs ${at + rest} bytes, has ${zero.length})`);

  const criticalSizes = zero.subarray(at, at + cscsize); at += cscsize;
  const versionInfo = zero.subarray(at, at + VERSION_INFO_BYTES); at += VERSION_INFO_BYTES;
  const plsize = view.getInt32(at, true); at += INT_BYTES;
  // recover.c:269 rejects a name longer than the buffer; so do we, and a
  // non-positive one too — both mean the header is not what we think it is.
  if (plsize <= 0 || plsize > PL_NSIZ_PLUS)
    throw new RecoverError(`level.0 claims a ${plsize}-byte player name, outside 1..${PL_NSIZ_PLUS}`);
  if (zero.length < at + plsize)
    throw new RecoverError(`level.0 ends inside the player name`);
  const playerName = zero.subarray(at, at + plsize); at += plsize;

  return { savelev, savename, indicator, criticalSizes, versionInfo, playerName, stateOffset: at };
}

export interface RecoveredSave {
  /** Relative path the engine expects, e.g. "save/0player". */
  path: string;
  bytes: Uint8Array;
  /** Ledger number of the level the hero is on. */
  savelev: number;
}

/**
 * Assemble the save file. `levels` maps ledger number to that level file's
 * bytes and must include 0 (the state file) and the hero's own level.
 *
 * The output is exactly what util/recover.c:300-386 writes: the framing header,
 * then the hero's level, then the rest of level.0, then every other level each
 * preceded by its one-byte ledger number.
 */
export function buildSaveFile(levels: Map<number, Uint8Array>): RecoveredSave {
  const zero = levels.get(0);
  if (!zero) throw new RecoverError("the set has no level.0, so there is nothing to rebuild from");
  const h = parseLevel0(zero);

  const hero = levels.get(h.savelev);
  if (!hero)
    throw new RecoverError(`the set has no level ${h.savelev}, the one the hero is on`);

  const parts: Uint8Array[] = [];
  const int32 = (v: number) => {
    const b = new Uint8Array(INT_BYTES);
    new DataView(b.buffer).setInt32(0, v, true);
    return b;
  };

  parts.push(Uint8Array.of(h.indicator));
  parts.push(Uint8Array.of(h.criticalSizes.length));
  parts.push(h.criticalSizes);
  parts.push(h.versionInfo);
  parts.push(int32(h.playerName.length));
  parts.push(h.playerName);
  // The hero's level first, then the game state that follows level.0's header.
  parts.push(hero);
  parts.push(zero.subarray(h.stateOffset));
  // Then the rest, in ledger order, each introduced by its number as an xint8.
  for (let lev = 1; lev < MAX_LEVELS; lev++) {
    if (lev === h.savelev) continue;
    const data = levels.get(lev);
    if (!data) continue; // any or all of these may be absent
    parts.push(Uint8Array.of(lev));
    parts.push(data);
  }

  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return { path: h.savename, bytes, savelev: h.savelev };
}

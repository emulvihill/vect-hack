// Autosave: checkpoints the player never asked for, and the mirror that lets
// one survive a closed tab.
//
// NetHack already writes non-destructive checkpoints. save_currentstate()
// (src/do.c:1375) rewrites the current level plus level.0 — which carries all
// non-level state — with mode = WRITING and no FREEING, so nothing is freed
// and the game stays playable; dosave0() cannot be used for this, it deletes
// every level file and ends the game. Upstream calls it on level changes only.
// We call it on a command and wall-clock interval too.
//
// The files it writes are MEMFS and die with the worker, so each checkpoint is
// mirrored into the persistent volume, manifest last. At boot
// restoreRecoverySet() rebuilds a real save file from a validated set — in the
// port, not in the engine; see src/modules/nethack/recoverSave.ts — and the ordinary
// restore path takes it from there.
//
// Two constraints shape everything here:
//  - maybe() runs inside an ASYNCIFY suspend. save_currentstate() has to be
//    reached before the first await, and the windowport calls it makes have to
//    be answered without unwinding. See maybe() and answerInPlace().
//  - a half-written set must never reach the engine: a save file it cannot
//    make sense of costs the player the game, and validate() failures are
//    reported from deep inside the restore. Hence the validation in
//    restoreRecoverySet() and the parsing checks in recoverSave.ts, which are
//    load-bearing rather than defensive.

// ".ts" for the same reason as persist.ts's import: scripts/test/*.mjs load
// this file straight from source and node's ESM resolver does not guess one.
import { entries } from "../../backplane/saveBlob.ts";
import { buildSaveFile } from "./recoverSave.ts";

/** Bumped when the mirror layout changes; a mismatch discards the set. */
export const CHECKPOINT_FORMAT = 1;
/** Subdirectory of the persistent volume holding the mirrored level files. */
export const RECOVER_DIR = "recover";
export const MANIFEST_FILE = "manifest.json";
/** getlock()'s SELF_RECOVER prompt, answered without asking the player. */
export const RECOVER_QUERY = "Old game in progress. Destroy [y], Recover [r], or Cancel [n]?";
export const DEFAULT_COMMANDS = 100;
export const DEFAULT_MIN_INTERVAL_MS = 20_000;

/** level.0's fixed header on wasm32; only savelev, an int32 at 4, is read. */
const HEADER_BYTES = 209;
const SAVELEV_OFFSET = 4;
/** Same directory as persist.ts's SAVE_DIR; importing it would make a cycle. */
const SAVE_DIR = "save";
/** Boots that consumed the set and came back for another; then stop offering it. */
const MAX_ATTEMPTS = 2;
/** One quiet checkpoint can be a coincidence, two in a row is the do.c bug. */
const MAX_MISSES = 2;
/**
 * Bounds on a manifest read back from a volume. The manifest is ours, but the
 * volume it sits in can arrive through F4 from anywhere, so a set is trusted
 * only after it has been shown to be shaped like one this build wrote: a level
 * set has at most MAXLINFO (`include/hack.h`) files, well under this cap,
 * and a manifest naming that many is a few KiB. Beyond either bound the set is
 * discarded unread, so a crafted import cannot stall the worker on JSON.parse
 * or steer a level-file read outside the recovery directory with "../".
 */
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MANIFEST_FILES = 256;

/**
 * What winshim does with the bridge's result: `userCallback(...).then(cb)`,
 * synchronously inside startAsync (win/shim/winshim.c:295). Nothing else.
 */
export interface SyncThenable {
  then(onFulfilled: (value: unknown) => void): void;
}

/** A windowport call answered without leaving the current wasm stack. */
export type ShimAnswer = (name: string, ...args: unknown[]) => SyncThenable;

export interface CheckpointFS {
  readdir(path: string): string[];
  readFile(path: string, opts?: { encoding?: "binary" | "utf8" }): Uint8Array | string;
  writeFile(path: string, data: Uint8Array | string): void;
  unlink(path: string): void;
  mkdir(path: string): void;
  stat(path: string): { size: number; mtime: Date };
  analyzePath(path: string): { exists: boolean };
}

export interface CheckpointDeps {
  FS: CheckpointFS;
  /** The mounted volume, e.g. "/vect-nethack". */
  root: string;
  /** Calls the engine's exported save_currentstate(). */
  saveCurrentState(): void;
  /**
   * Install `answer` as the windowport bridge for the duration of that call
   * and return the undo. The caller owns the bridge global — the engine
   * reaches it by the name given to shim_graphics_set_callback — so only the
   * caller can make the swap. See answerInPlace() for what it is for.
   */
  suspendBridge(answer: ShimAnswer): () => void;
  /** Force the volume out to IndexedDB. */
  flush(): Promise<void>;
  /** Called once, when autosave gives up. */
  onDead?(reason: string): void;
  commandsPerCheckpoint?: number;
  minIntervalMs?: number;
  now?(): number;
}

export interface Checkpointer {
  /** Count one player command; call at each main-loop key request. */
  command(): void;
  /** Take a checkpoint if one is due. Never throws. True if one landed. */
  maybe(): Promise<boolean>;
  /** Drop the mirror: a real save file exists, or the game is over. Never throws. */
  clear(): Promise<void>;
  /** null while healthy; the reason once autosave has given up. */
  readonly dead: string | null;
}

/** One mirrored level file, as the manifest records it. */
interface MirrorFile {
  name: string;
  size: number;
  mtimeMs: number;
}

interface Manifest {
  format: number;
  /** The lock base name, e.g. "0player". */
  lock: string;
  /** Ledger number of the level the hero is on. */
  savelev: number;
  attempts: number;
  files: MirrorFile[];
}

/**
 * The windowport, answered where it stands. save_currentstate() is not the
 * pure MEMFS call it looks like: currentlevel_rewrite() opens with
 * mark_synch() (src/do.c:1355) and savegamestate() asks for the message
 * history (save_msghistory, src/save.c:1059). Answered by the ordinary async
 * bridge, each of those makes Asyncify.handleSleep begin an unwind that runs
 * straight out of the checkpoint, which then returns having written level.0
 * and not the current level — leaving a mirror recover_savefile() cannot use,
 * since it needs the level savelev names. A thenable that resolves in place
 * calls wakeUp() before startAsync returns, which is handleSleep's
 * non-unwinding path (libasync.js:346-356).
 *
 * "" for the message history: the shim writes an "s" return over the NULL
 * char * it initialized, so an empty string arrives as NULL and ends
 * save_msghistory()'s loop. The engine's own scrollback is not ours to give.
 *
 * winshim.c:313 logs "attempting second call to 'local_callback' ... will
 * crash emscripten Asyncify" for each of these. That guard cannot tell this
 * reentrancy from the unwinding kind; nothing crashes.
 */
export const answerInPlace: ShimAnswer = (name) => {
  const value: unknown = name === "shim_getmsghistory" ? "" : undefined;
  return { then: (resolve) => resolve(value) };
};

export function createCheckpointer(deps: CheckpointDeps): Checkpointer {
  const { FS, root, saveCurrentState, suspendBridge, flush } = deps;
  const commandsPerCheckpoint = deps.commandsPerCheckpoint ?? DEFAULT_COMMANDS;
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  const dir = `${root}/${RECOVER_DIR}`;

  let commands = 0;
  /** null until one lands this session; see due(). */
  let lastMs: number | null = null;
  let misses = 0;
  let dead: string | null = null;
  /** What the manifest last recorded, so unchanged levels are not recopied. */
  let recorded: Map<string, MirrorFile> | null = null;

  const die = (reason: string) => {
    if (dead) return;
    dead = reason;
    deps.onDead?.(reason);
  };

  // The first checkpoint of a session ignores both thresholds: right after a
  // recovery or a new game nothing is mirrored, and that window — before the
  // player has typed 100 commands — is exactly when a closed tab costs most.
  const due = () =>
    lastMs === null || (commands >= commandsPerCheckpoint && now() - lastMs >= minIntervalMs);

  /** Copy what changed into the volume, then commit it with the manifest. */
  function mirror(lock: string) {
    if (!FS.analyzePath(dir).exists) FS.mkdir(dir);
    const live = levelFiles(FS, lock);
    const was = (recorded ??= loadRecorded());

    for (const f of live) {
      const old = was.get(f.name);
      if (old && old.size === f.size && old.mtimeMs === f.mtimeMs) continue;
      FS.writeFile(`${dir}/${f.name}`, readBytes(FS, `/${f.name}`));
    }
    // Levels the hero merely left behind stay mirrored; ones the engine
    // deleted must not, or recover_savefile() rebuilds a save around them.
    const names = new Set(live.map((f) => f.name));
    for (const name of entries(FS, dir))
      if (name !== MANIFEST_FILE && !names.has(name)) FS.unlink(`${dir}/${name}`);

    const manifest: Manifest = {
      format: CHECKPOINT_FORMAT,
      lock,
      savelev: savelevOf(readBytes(FS, `/${lock}.0`)),
      attempts: 0, // this set has never been handed to a boot
      files: live,
    };
    // Last, on purpose: the manifest is the commit record for everything
    // above it, and a set without a matching one is ignored at boot.
    FS.writeFile(`${dir}/${MANIFEST_FILE}`, JSON.stringify(manifest));
    recorded = new Map(live.map((f) => [f.name, f]));
  }

  /** Whatever a previous session — or this boot's recovery — committed. */
  function loadRecorded(): Map<string, MirrorFile> {
    const manifest = readManifest(FS, dir);
    return new Map(manifest ? manifest.files.map((f) => [f.name, f]) : []);
  }

  async function maybe(): Promise<boolean> {
    if (dead || !due()) return false;
    try {
      const lock = findLock(FS);
      // Zero or several level-file sets: nothing coherent to mirror. Not a
      // failure — the engine has not reached getlock() yet at boot.
      if (!lock) return false;
      const zero = `/${lock}.0`;
      const before = stamp(FS, zero);

      // Nothing above this line may await. worker.ts reaches maybe()
      // synchronously from inside Asyncify.handleSleep's startAsync
      // (win/shim/winshim.c:264 calls the bridge and only then attaches its
      // .then), while Asyncify.state is still Normal and the unwind has not
      // begun (libasync.js:331-346) — so this is an ordinary nested wasm call
      // that pushes and pops exportCallStack before anything reads it. The
      // first await starts the unwind; a nested export after that corrupts it.
      // The checkpoint's own windowport calls have to stay on that path too,
      // which is what the swapped-in bridge is for; see answerInPlace().
      const restore = suspendBridge(answerInPlace);
      try {
        saveCurrentState();
      } finally {
        restore();
      }

      const after = stamp(FS, zero);
      if (after.size === before.size && after.mtimeMs === before.mtimeMs) {
        // do.c:1388-1389 returns on a failed create_levelfile without
        // decrementing program_state.in_checkpoint, and the guard at
        // do.c:1381 then refuses every later checkpoint. Once that has
        // happened there is nothing to do but tell the player.
        if (++misses >= MAX_MISSES)
          die("NetHack stopped checkpointing; a failed level write disables it for the rest of the game");
        return false;
      }
      misses = 0;

      mirror(lock);
      commands = 0;
      lastMs = now();
      await flush();
      return true;
    } catch (err) {
      // The running game matters more than the mirror: give up quietly here
      // rather than throw back into an ASYNCIFY-suspended windowport call.
      die(`checkpointing failed: ${String(err)}`);
      return false;
    }
  }

  async function clear(): Promise<void> {
    try {
      if (FS.analyzePath(dir).exists)
        // Manifest first: without its commit record the rest is already
        // ignored at boot, so an interrupted clear cannot leave a live set.
        for (const name of [MANIFEST_FILE, ...entries(FS, dir).filter((n) => n !== MANIFEST_FILE)])
          if (FS.analyzePath(`${dir}/${name}`).exists) FS.unlink(`${dir}/${name}`);
      recorded = new Map();
      // Inside the guard with the unlinks it commits: flush() throws on every
      // IDBFS failure, and clear()'s one caller awaits it from inside an
      // ASYNCIFY-suspended exit_nhwindows — a rejection there costs the player
      // the end of their game and arrives as a bare `fatal` instead.
      await flush();
    } catch (err) {
      console.warn("[vect-hack] could not drop the recovery set:", err);
    }
  }

  return {
    command: () => void commands++,
    maybe,
    clear,
    get dead() { return dead; },
  };
}

/**
 * Turn a validated recovery set into a real save file at the path the engine
 * expects, so the ordinary restore path picks it up. Call from preRun, before
 * main(). Nothing is left at the FS root, so getlock() sees no orphaned level
 * files and never offers to recover them — see src/modules/nethack/recoverSave.ts for why
 * the engine's own recovery is the thing being avoided.
 */
export function restoreRecoverySet(
  FS: CheckpointFS, root: string,
): { restored: string[]; reason: string | null } {
  const dir = `${root}/${RECOVER_DIR}`;
  try {
    const manifest = readManifest(FS, dir);
    if (!manifest) return discard(FS, dir, "there is no committed recovery set");
    if (manifest.format !== CHECKPOINT_FORMAT)
      return discard(FS, dir, `the set is format ${manifest.format}, this build writes ${CHECKPOINT_FORMAT}`);

    for (const f of manifest.files) {
      const path = `${dir}/${f.name}`;
      if (!FS.analyzePath(path).exists) return discard(FS, dir, `${f.name} is missing`);
      const size = FS.stat(path).size;
      if (size !== f.size)
        return discard(FS, dir, `${f.name} is ${size} bytes, the manifest recorded ${f.size}`);
    }

    // A real save file always wins: it is complete, and level files beside it
    // would make getlock() offer to recover a game the player already saved.
    if (!isEmptyDir(FS, `${root}/${SAVE_DIR}`)) return discard(FS, dir, "a real save file exists");

    const zero = `${manifest.lock}.0`;
    if (!manifest.files.some((f) => f.name === zero)) return discard(FS, dir, `${zero} is not in the set`);
    const head = readBytes(FS, `${dir}/${zero}`);
    if (head.length < HEADER_BYTES)
      return discard(FS, dir, `${zero} is ${head.length} bytes, short of the ${HEADER_BYTES}-byte header`);
    const savelev = savelevOf(head);
    if (!manifest.files.some((f) => f.name === `${manifest.lock}.${savelev}`))
      return discard(FS, dir, `the hero's level (${savelev}) is not in the set`);

    // Two boots that reached the engine and came back for a third mean
    // recovery is not working. Looping forever on getlock()'s error(), which
    // kills the process, is worse than losing the game.
    if (manifest.attempts >= MAX_ATTEMPTS)
      return discard(FS, dir, `recovery was already tried ${manifest.attempts} times`);
    // Counted before the copy, not after: the boot this is about to be handed
    // to is the one that might never come back. A later checkpoint rewrites
    // the manifest with attempts back at 0.
    FS.writeFile(
      `${dir}/${MANIFEST_FILE}`, JSON.stringify({ ...manifest, attempts: manifest.attempts + 1 }),
    );

    // Hand the engine a finished save file rather than the loose level files.
    // Level files at the root would make getlock() offer "Recover [r]", and
    // the engine's own recover_savefile() leaves program_state.in_self_recover
    // set — which sys/libnh/libnhmain.c never clears, killing every later
    // checkpoint. See src/modules/nethack/recoverSave.ts.
    const levels = new Map<number, Uint8Array>();
    for (const f of manifest.files)
      levels.set(Number(f.name.slice(manifest.lock.length + 1)), readBytes(FS, `${dir}/${f.name}`));

    let save;
    try {
      save = buildSaveFile(levels);
    } catch (err) {
      // A set we cannot rebuild is a set the engine must never see.
      return discard(FS, dir, `the save file could not be rebuilt: ${String(err)}`);
    }
    // savename is the relative path the engine itself recorded, so it is what
    // restore_saved_game() will look for; "save/0player" in practice.
    const path = `/${save.path}`;
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent && !FS.analyzePath(parent).exists) FS.mkdir(parent);
    FS.writeFile(path, save.bytes);
    return { restored: [save.path], reason: null };
  } catch (err) {
    return discard(FS, dir, `the set could not be read: ${String(err)}`);
  }
}

/** Delete the whole set. A partial one must never reach getlock(). */
function discard(FS: CheckpointFS, dir: string, reason: string): { restored: string[]; reason: string } {
  try {
    if (FS.analyzePath(dir).exists)
      for (const name of entries(FS, dir)) FS.unlink(`${dir}/${name}`);
  } catch (err) {
    console.warn("[vect-hack] could not delete the recovery set:", err);
  }
  return { restored: [], reason };
}

function readManifest(FS: CheckpointFS, dir: string): Manifest | null {
  const path = `${dir}/${MANIFEST_FILE}`;
  if (!FS.analyzePath(path).exists) return null;
  try {
    if (FS.stat(path).size > MAX_MANIFEST_BYTES) return null;
    const parsed: unknown = JSON.parse(String(FS.readFile(path, { encoding: "utf8" })));
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null; // unparseable is indistinguishable from absent, and as fatal
  }
}

/**
 * Shape and bounds; the format number is checked by the caller, which reports
 * it. Every name is used as `${dir}/${name}`, so each must be a plain file
 * name inside the set: no separators, not "." or "..", nothing empty.
 */
function isManifest(v: unknown): v is Manifest {
  const m = v as Manifest | null;
  return !!m && typeof m === "object"
    && typeof m.format === "number" && isPlainName(m.lock)
    && typeof m.savelev === "number" && typeof m.attempts === "number"
    && Array.isArray(m.files) && m.files.length <= MAX_MANIFEST_FILES
    && m.files.every((f) => !!f && isPlainName(f.name)
      && typeof f.size === "number" && typeof f.mtimeMs === "number");
}

/** A single path component that stays inside its directory. */
function isPlainName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name !== "." && name !== ".."
    && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

/**
 * The lock base name is <uid><plname> regularized — getuid() is 0 under
 * emscripten, so "0player" — and level files are /<lock>.<ledger>
 * (sys/unix/unixunix.c:132-135, set_levelfile_name in src/files.c). Discover
 * it instead of rebuilding it: regularize() and plname are the engine's, not
 * ours. Anything but exactly one set with a .0 is not something to mirror.
 */
function findLock(FS: CheckpointFS): string | null {
  const bases = new Map<string, boolean>();
  for (const name of entries(FS, "/")) {
    const m = /^(.+)\.(\d+)$/.exec(name);
    if (!m) continue;
    bases.set(m[1]!, (bases.get(m[1]!) ?? false) || m[2] === "0");
  }
  const found = [...bases].filter(([, hasZero]) => hasZero).map(([base]) => base);
  return found.length === 1 ? found[0]! : null;
}

/** Every /<lock>.<ledger> at the root, in ledger order. */
function levelFiles(FS: CheckpointFS, lock: string): MirrorFile[] {
  const ledger = (name: string) => Number(name.slice(lock.length + 1));
  return entries(FS, "/")
    .filter((name) => name.startsWith(`${lock}.`) && /^\d+$/.test(name.slice(lock.length + 1)))
    .sort((a, b) => ledger(a) - ledger(b))
    .map((name) => ({ name, ...stamp(FS, `/${name}`) }));
}


function isEmptyDir(FS: CheckpointFS, path: string): boolean {
  return !FS.analyzePath(path).exists || entries(FS, path).length === 0;
}

function readBytes(FS: CheckpointFS, path: string): Uint8Array {
  return FS.readFile(path, { encoding: "binary" }) as Uint8Array;
}

function stamp(FS: CheckpointFS, path: string): { size: number; mtimeMs: number } {
  const st = FS.stat(path);
  return { size: st.size, mtimeMs: st.mtime.getTime() };
}

/** The ledger number of the level the hero is on: int32 at offset 4 of level.0. */
function savelevOf(head: Uint8Array): number {
  if (head.length < HEADER_BYTES)
    throw new Error(`level.0 is ${head.length} bytes, short of the ${HEADER_BYTES}-byte header`);
  return new DataView(head.buffer, head.byteOffset, head.byteLength).getInt32(SAVELEV_OFFSET, true);
}

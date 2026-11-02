// NetHack's storage policy over the Backplane's shared IDBFS lifecycle.
//
// The wasm build opens saves and scores at the Emscripten FS root, beside its
// embedded read-only data. The writable paths are therefore kept inside the
// Module's volume and exposed through a symlink farm. Dynamic bones names are
// mirrored separately because the engine constructs them at the root.
import {
  MANIFEST_FILE, RECOVER_DIR, restoreRecoverySet, type CheckpointFS,
} from "./checkpoint.ts";
import {
  clearDanglingLink,
  mountVolume,
  type LockManagerLike as SharedLockManagerLike,
  type PersistFS as SharedPersistFS,
  type PersistHandle as SharedPersistHandle,
} from "../../backplane/persistFs.ts";
import { entries } from "../../backplane/saveBlob.ts";
import { VOLUMES } from "../../backplane/volumes.ts";

export const PERSIST_ROOT = VOLUMES.nethack.mountpoint;
export const SAVE_DIR = "save";
export const SCORE_FILES = ["record", "logfile", "xlogfile", "livelog"] as const;
export const BONES_DIR = "bones";

export interface PersistFS extends CheckpointFS, SharedPersistFS {}

export interface PersistModule {
  FS: PersistFS;
  addRunDependency(id: string): void;
  removeRunDependency(id: string): void;
}

export type LockManagerLike = SharedLockManagerLike;

export interface PersistOptions {
  /** Defaults to navigator.locks; null makes the session non-persistent. */
  locks?: LockManagerLike | null;
}

export interface PersistHandle extends SharedPersistHandle {
  /** True when a checkpointed game was put back for getlock() to recover. */
  readonly recovered: boolean;
}

interface NetHackState {
  recovered: boolean;
}

/**
 * Mount NetHack's volume during Emscripten preRun and install its writable
 * root paths. The returned ready promise never rejects.
 */
export function mountPersistentStorage(
  mod: PersistModule, opts: PersistOptions = {},
): PersistHandle {
  const state: NetHackState = { recovered: false };
  const base = mountVolume(mod, VOLUMES.nethack, {
    locks: opts.locks,
    seed: (FS, root) => seedGamePaths(FS as PersistFS, root ? root + "/" : "/"),
    sessionSave: { root: "/", names: sessionSaveNames() },
    beforeFlush(FS) {
      try {
        mirrorBones(FS as PersistFS);
      } catch (err) {
        // Bones are a bonus; the save sync still has to run.
        console.warn("[vect-hack] could not mirror bones:", err);
      }
    },
    onPopulated(FS) {
      const nethackFS = FS as PersistFS;
      restoreMirror(nethackFS, state);
      try {
        restoreBones(nethackFS);
      } catch (err) {
        console.warn("[vect-hack] could not restore bones:", err);
      }
    },
  });

  return {
    ready: base.ready,
    get persistent() { return base.persistent; },
    get reason() { return base.reason; },
    get recovered() { return state.recovered; },
    flush: () => base.flush(),
    exportSave: (now) => base.exportSave(now),
    release: () => base.release(),
  };
}

/** Copy every stored bones file to the FS root. */
function restoreBones(FS: PersistFS) {
  const dir = `${PERSIST_ROOT}/${BONES_DIR}`;
  if (!FS.analyzePath(dir).exists) {
    FS.mkdir(dir);
    return;
  }
  for (const name of entries(FS, dir))
    FS.writeFile("/" + name, FS.readFile(`${dir}/${name}`, { encoding: "binary" }) as Uint8Array);
}

/** Reconcile stored bones to the root's live bon* files before every flush. */
function mirrorBones(FS: PersistFS) {
  const dir = `${PERSIST_ROOT}/${BONES_DIR}`;
  if (!FS.analyzePath(dir).exists) FS.mkdir(dir);
  const live = new Set(entries(FS, "/").filter((name) => name.startsWith("bon")));
  for (const name of entries(FS, dir))
    if (!live.has(name)) FS.unlink(`${dir}/${name}`);
  for (const name of live)
    FS.writeFile(`${dir}/${name}`, FS.readFile("/" + name, { encoding: "binary" }) as Uint8Array);
}

/** Restore a validated autosave mirror before NetHack's getlock() runs. */
function restoreMirror(FS: PersistFS, state: NetHackState) {
  const dir = `${PERSIST_ROOT}/${RECOVER_DIR}`;
  try {
    if (!FS.analyzePath(dir).exists) FS.mkdir(dir);
    const committed = FS.analyzePath(`${dir}/${MANIFEST_FILE}`).exists;
    const { restored, reason } = restoreRecoverySet(FS, PERSIST_ROOT);
    state.recovered = restored.length > 0;
    if (committed && reason)
      console.warn(`[vect-hack] discarded the recovery set: ${reason}`);
  } catch (err) {
    console.warn("[vect-hack] could not restore an interrupted game:", err);
  }
}

/** Writable paths as the engine names them at the Emscripten FS root. */
function gamePaths(): string[] {
  return ["/" + SAVE_DIR, ...SCORE_FILES.map((file) => "/" + file)];
}

/**
 * The same paths as volume-relative names, which is what a session-only export
 * packs (vect-hack-47a).
 *
 * The two layouts agree by construction: seedGamePaths puts the real save
 * directory and score files at those root paths when there is no volume, and
 * under the mountpoint when there is, so `save/`, `record` and the rest name
 * the same things in a blob either way. Derived from gamePaths() rather than
 * written out again — a name that drifted apart here would export a blob
 * missing the file it forgot, silently.
 *
 * bones are deliberately absent. The engine builds bones names at the root, so
 * the volume keeps them under `bones/` and only mirrorBones knows the mapping;
 * they are a bonus that outlives a character rather than the character, and
 * the escape hatch this list exists for is the character.
 */
function sessionSaveNames(): string[] {
  return gamePaths().map((path) => path.slice(1));
}

/** Seed missing files without truncating restored data, then link the farm. */
function seedGamePaths(FS: PersistFS, prefix: string) {
  // Session-only: the farm an earlier attempt linked outlives its volume.
  if (prefix === "/") for (const path of gamePaths()) clearDanglingLink(FS, path);
  if (!FS.analyzePath(prefix + SAVE_DIR).exists) FS.mkdir(prefix + SAVE_DIR);
  for (const file of SCORE_FILES)
    if (!FS.analyzePath(prefix + file).exists) FS.writeFile(prefix + file, "");

  if (prefix === "/") return;
  for (const path of gamePaths()) FS.symlink(prefix.slice(0, -1) + path, path);
}

// Umoria's volume policy over the Backplane IDBFS lifecycle. The official
// engine opens every runtime and writable file relative to cwd, so unlike the
// other Modules it needs no symlink farm: the elected writer runs directly in
// /vect-moria and a losing tab stays in its private packaged /moria-seed.
import {
  mountVolume,
  type LockManagerLike,
  type PersistFS,
  type PersistHandle,
  type PersistModule,
} from "../../backplane/persistFs.ts";
import { VOLUMES } from "../../backplane/volumes.ts";
import {
  createMoriaRecovery,
  type MoriaRecovery,
  type MoriaRecoveryFS,
} from "./recovery.ts";
// Cyclic with this file (saveImport reads MORIA_RUNTIME_FILES back), and safe
// to be: neither module touches the other at evaluation time.
import { validateMoriaImport, type MoriaImportFS } from "./saveImport.ts";

export const MORIA_SEED_ROOT = "/moria-seed";

/** Literal stage-moria-seed.sh allow-list. Keep the build and runtime copy
 * contracts identical: extra build output must never become user data merely
 * because it happened to appear beside the seed. */
export const MORIA_RUNTIME_FILES = [
  "AUTHORS",
  "LICENSE",
  "data/death_royal.txt",
  "data/death_tomb.txt",
  "data/help.txt",
  "data/help_wizard.txt",
  "data/rl_help.txt",
  "data/rl_help_wizard.txt",
  "data/splash.txt",
  "data/versions.txt",
  "data/welcome.txt",
  "scores.dat",
] as const;

/** config.cpp's save_game. The one file in the volume that is a character
 *  rather than a copy of the build, and the only writable name the import gate
 *  allows beside the runtime set — declared here with the rest of the layout
 *  so the gate and the session-only export cannot name it differently. */
export const MORIA_GAME_SAVE = "game.sav";

/**
 * What a session-only Moria tab's save is made of (vect-hack-47a).
 *
 * Moria is the awkward one. It has no symlink farm, so a tab with no volume
 * simply chdirs into the packaged seed and plays there, mixing the character
 * in among read-only build data — /moria-seed is the game's own installation,
 * not a volume. Naming the files is what separates them again, and the names
 * chosen are exactly validateMoriaImport's allow-list, so a blob packed from a
 * session-only tab is by construction one that gate accepts: the immutable
 * runtime files are the packaged bytes it compares against, because they are
 * literally the same files.
 *
 * recover/ is absent because a session-only tab has no recovery — the
 * checkpointer is built in onPopulated, which only the volume's owner reaches.
 */
export const MORIA_SESSION_SAVE_NAMES: readonly string[] =
  [...MORIA_RUNTIME_FILES, MORIA_GAME_SAVE];

export interface MoriaSeedFS {
  analyzePath(path: string): { exists: boolean };
  mkdirTree(path: string): void;
  readFile(path: string, opts: { encoding: "binary" }): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  chdir(path: string): void;
}

export interface MoriaPersistFS extends PersistFS, MoriaSeedFS, MoriaRecoveryFS {}

export interface MoriaPersistModule extends PersistModule {
  FS: MoriaPersistFS;
}

export interface MoriaPersistHandle extends PersistHandle {
  readonly checkpointRecoveryPath: string;
  publishCheckpoint(): void;
  clearRecovery(): void;
  recordTerminal(): void;
}

export function seedMoriaPaths(FS: MoriaSeedFS, root: string): void {
  FS.mkdirTree(`${root}/data`);
  for (const relative of MORIA_RUNTIME_FILES) {
    const target = `${root}/${relative}`;
    if (FS.analyzePath(target).exists) continue;
    FS.writeFile(
      target,
      FS.readFile(`${MORIA_SEED_ROOT}/${relative}`, { encoding: "binary" }),
    );
  }
  FS.chdir(root);
}

export function mountMoriaStorage(
  mod: MoriaPersistModule,
  options: { locks?: LockManagerLike | null } = {},
): MoriaPersistHandle {
  let recovery: MoriaRecovery | undefined;
  const base = mountVolume(mod, VOLUMES.moria, {
    locks: options.locks,
    seed(FS, root) {
      if (root === null) {
        (FS as MoriaPersistFS).chdir(MORIA_SEED_ROOT);
        return;
      }
      seedMoriaPaths(FS as MoriaPersistFS, root);
    },
    onPopulated(FS) {
      recovery = createMoriaRecovery(FS as MoriaPersistFS, VOLUMES.moria.mountpoint);
    },
    // Umoria's own archive gate on an imported volume: the same checks the
    // portable-import tests drive, run before the Backplane replaces anything.
    // The manifest's game id is the Backplane's business; that the blob is a
    // whole Umoria volume built by this build is only this Module's to know.
    validateImport(FS, contents) {
      validateMoriaImport(FS as unknown as MoriaImportFS, contents);
    },
    sessionSave: { root: MORIA_SEED_ROOT, names: MORIA_SESSION_SAVE_NAMES },
  });
  const writerRecovery = (): MoriaRecovery => {
    if (!base.persistent || recovery === undefined)
      throw new Error("this tab does not own the Moria save volume");
    return recovery;
  };
  return {
    get ready() { return base.ready; },
    get persistent() { return base.persistent; },
    get reason() { return base.reason; },
    get checkpointRecoveryPath() {
      return base.persistent ? recovery?.recoveryPath ?? "" : "";
    },
    flush: () => base.flush(),
    exportSave: (now) => base.exportSave(now),
    release: () => base.release(),
    publishCheckpoint: () => writerRecovery().publishPending(),
    clearRecovery: () => writerRecovery().clearForExplicitSave(),
    recordTerminal: () => writerRecovery().recordTerminal(),
  };
}

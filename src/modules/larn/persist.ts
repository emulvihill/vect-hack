// Larn's storage policy over the Backplane's shared IDBFS lifecycle.
// Upstream roots writable data below /lib; keep the preload tree intact and
// replace only its empty writable directories with links into our volume.
import {
  linkWritableDirs,
  mountVolume,
  type LockManagerLike,
  type PersistHandle,
  type SeedFS,
  type SeedModule,
} from "../../backplane/persistFs.ts";
import { VOLUMES } from "../../backplane/volumes.ts";

const PRELOAD_BASE = "/lib";

// home: $HOME -> /lib/home (Larn.sav, .larnopts — main-wasm.c sets HOME).
// scores: llog12.0/lscore12.0/playerids (main-wasm.c's config.c overrides).
// No tmp: the only temp path is bill.c:134's _PATH_TMP = musl's /tmp/, an
// in-memory MEMFS dir that exists by default and is deliberately
// unpersisted (the mail gag has no save value).
export const LARN_WRITABLE_DIRS = ["home", "scores"] as const;

export function mountLarnStorage(
  mod: SeedModule,
  options: { locks?: LockManagerLike | null } = {},
): PersistHandle {
  return mountVolume(mod, VOLUMES.larn, {
    locks: options.locks,
    seed(FS, root) {
      linkWritableDirs(FS as SeedFS, root, PRELOAD_BASE, LARN_WRITABLE_DIRS);
    },
    // Same two directories, in the preload tree instead of the volume: a
    // session-only tab's Larn.sav and score files carry the volume's own
    // relative names, so the blob loads back (vect-hack-47a).
    sessionSave: { root: PRELOAD_BASE, names: LARN_WRITABLE_DIRS },
  });
}

// Angband's storage policy over the Backplane's shared IDBFS lifecycle.
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
export const ANGBAND_WRITABLE_DIRS = ["save", "scores", "user", "panic"] as const;

export function mountAngbandStorage(
  mod: SeedModule,
  options: { locks?: LockManagerLike | null } = {},
): PersistHandle {
  return mountVolume(mod, VOLUMES.angband, {
    locks: options.locks,
    seed(FS, root) {
      linkWritableDirs(FS as SeedFS, root, PRELOAD_BASE, ANGBAND_WRITABLE_DIRS);
    },
    // A session-only tab has the same four directories, as real directories in
    // the preload tree rather than links into a volume — linkWritableDirs makes
    // them from this same list, so their contents already carry the volume's
    // own relative names and pack straight into a loadable blob
    // (vect-hack-47a).
    sessionSave: { root: PRELOAD_BASE, names: ANGBAND_WRITABLE_DIRS },
  });
}

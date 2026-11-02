// Seed the filesystem paths NetHack's build expects before main() runs, and
// mount the persistent volume. Shared by src/modules/nethack/worker.ts and every node
// test driver under scripts/test/ that boots the wasm module directly, so a
// change to what the engine needs seeded cannot silently leave the tests
// booting a different filesystem than the app.
//
// ".ts" import extension: scripts/test/*.mjs load this file straight from
// source, and node's ESM resolver does not guess one (same as persist.ts).
import { mountPersistentStorage, type PersistHandle, type PersistModule, type PersistOptions } from "./persist.ts";

/** The slice of the emscripten module this seeding needs, beyond PersistModule. */
export interface BootModule extends PersistModule {
  ENV: Record<string, string>;
}

/** set_savefile_name(): "save/<uid><plname>". getuid() is 0 under emscripten,
 *  and every driver names its character "player" (shim_askname), so this is
 *  the one save path every test driver and worker.ts itself can share. */
export const SAVEFILE = "/save/0player";

/**
 * Call from emscripten `preRun`, before main(). Returns the persistence
 * handle so the caller can wire up autosave, report non-durable storage, etc.
 */
export function seedEngineFS(mod: BootModule, opts: PersistOptions = {}): PersistHandle {
  // The build bakes SYSCF_FILE="/sysconf"; game data (nhdat) is embedded at
  // "/". /perm is the record lock and is deliberately transient. Everything
  // else the engine writes lives on the persistent volume.
  //
  // No MAXPLAYERS on purpose. Any value makes libnhmain.c set gl.locknum,
  // which routes getlock() into its alock/block branch — and that branch has
  // no recovery path at all. Autosave needs the gl.locknum == 0 arm, where
  // getlock() offers to recover an orphaned game and the lock is named after
  // the character (/0<plname>.0). One tab already owns the volume by Web
  // Lock, so nothing is lost.
  mod.FS.writeFile("/sysconf", "WIZARDS=*\n");
  mod.FS.writeFile("/perm", "");
  mod.ENV.USER = "player";
  return mountPersistentStorage(mod, opts);
}

// The Backplane's persistence namespace: one storage volume per Module
// (platform design). The registry IS the namespace — mountpoints must
// differ because IDBFS keys its IndexedDB database by mountpoint within the
// shared origin, and the Web Lock elects the single writing tab per volume.
//
// NetHack's legacy names (/persist, vect-hack/persist) are abandoned with no
// migration (settled decision #1, 2026-08-02): saves under the old database
// are knowingly orphaned once — unreleased software. Volume *lifecycle*
// (mount, syncfs, lock election) deliberately stays Module code
// (src/modules/nethack/persist.ts) until Angband's saves make it a
// two-consumer mechanism in phase 3.
export interface ModuleVolume {
  /** Which Module's volume this is. Carried on the volume rather than left as
   *  the registry key so anything holding one can name it: it goes in an
   *  exported save's manifest and filename (saveBlob.ts), where it is what
   *  stops one game's save being restored into the other's volume. */
  id: string;
  /** IDBFS mountpoint; also the IndexedDB database name. */
  mountpoint: string;
  /** Web Lock electing the single writing tab. */
  lock: string;
  /**
   * Volume-relative names under which a CHARACTER lives — the files whose
   * presence means this volume is somebody's game rather than an empty shelf
   * (vect-hack-70x).
   *
   * Each name is a file or a directory, and a character exists when any file
   * at or under one of them has bytes. Score files, options, bones and the
   * packaged runtime data are all deliberately absent: they are real save data
   * and belong in the blob, but a volume holding only those is a volume with
   * nobody in it, and restoring one over a live game destroys a character to
   * put nothing in its place.
   *
   * Which names those are is Module knowledge, not the Backplane's — it cannot
   * tell an engine's save file from the score table beside it. It is declared
   * here rather than in each Module's persist.ts because both ends of a save
   * need it and only one of them can see a Module: the export runs in the
   * worker, and the import warning runs on the page, where pulling in
   * `modules/larn/persist.ts` would drag a Module into the shared chunk
   * (vect-hack-l11). The volume registry is what both threads already hold.
   *
   * Checkpoints count. A tab that crashed before the player ever used the
   * game's own save command still has their character, in the recovery
   * directory and nowhere else, and a blob of exactly that shape is a real
   * save the player can load back.
   */
  characterPaths: readonly string[];
}

export const VOLUMES: Record<"nethack" | "angband" | "larn" | "moria", ModuleVolume> = {
  // save/: NetHack's own save directory. recover/: the autosave mirror
  // (nethack/checkpoint.ts RECOVER_DIR), which recoverSave.ts rebuilds a real
  // save out of. The four score files are not a character, and they are the
  // whole of a fresh NetHack volume — the case vect-hack-70x is about, and the
  // one a count of files cannot see, because seedGamePaths always creates them.
  nethack: {
    id: "nethack", mountpoint: "/vect-nethack", lock: "vect-nethack/persist",
    characterPaths: ["save", "recover"],
  },
  // save/: Angband's own. panic/: a panic save is the character too, and is
  // sometimes all that is left of one. scores/ and user/ are neither.
  angband: {
    id: "angband", mountpoint: "/vect-angband", lock: "vect-angband/persist",
    characterPaths: ["save", "panic"],
  },
  // main.c:120 builds $HOME/Larn.sav for the S command, and savegame() writes
  // the checkpoint to ckpfile every so many turns — /lib/home/Larn12.0.ckp,
  // which main.c:228 restores from. `home` itself is not the name, because
  // .larnopts lives there too and options are not a game.
  larn: {
    id: "larn", mountpoint: "/vect-larn", lock: "vect-larn/persist",
    characterPaths: ["home/Larn.sav", "home/Larn12.0.ckp"],
  },
  // config.cpp's save_game, plus the turn-tail checkpoints under recover/
  // (moria/recovery.ts). scores.dat and the packaged runtime files are the
  // build, not a player: a fresh Moria volume is seeded full of them.
  moria: {
    id: "moria", mountpoint: "/vect-moria", lock: "vect-moria/persist",
    characterPaths: ["game.sav", "recover"],
  },
};

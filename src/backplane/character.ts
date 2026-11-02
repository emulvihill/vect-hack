// Does this set of save files hold a character?
//
// One question, asked at both ends of a save file (vect-hack-70x). F3 asks it
// of the volume it is about to pack, and refuses: a blob with nobody in it is
// not a save, and the player who files it away believes they have one. F4 asks
// it of the blob a player picked, and warns before the confirm, because the
// import empties the volume it lands in — a characterless file loaded over a
// live game destroys a character and puts nothing in its place.
//
// Both ends read `volume.characterPaths`, so there is one declaration per
// Module and no way for the two answers to disagree. Counting files is what
// this deliberately is not: NetHack seeds four empty score files into every
// fresh volume, so "the export has files in it" is true exactly when the
// player has nothing, which is the guard vect-hack-47a considered and rejected.
import type { ModuleVolume } from "./volumes.ts";

/** What both callers already have: the manifest's entries on the way in, and
 *  the walked volume on the way out. Sizes come from `stat`, so a file is
 *  judged by its length and never read. */
export interface SaveFileEntry {
  path: string;
  size: number;
}

/**
 * True when any file at or under one of the volume's character paths has
 * bytes.
 *
 * Zero-length is the whole point of the size test rather than a presence test:
 * every Module's seed creates its writable layout up front, so the directories
 * and the empty files inside them are there from the first boot. A save is
 * bytes somebody's play put there.
 *
 * Paths are the blob's own — volume-relative, already validated as canonical
 * by `unpackSave` before this is asked of an imported file — so a prefix test
 * is a containment test, and `saved/x` cannot pass for `save`.
 */
export function hasCharacter(
  volume: ModuleVolume, files: readonly SaveFileEntry[],
): boolean {
  return files.some((file) => file.size > 0 && volume.characterPaths.some(
    (name) => file.path === name || file.path.startsWith(`${name}/`)));
}

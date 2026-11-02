// What makes a volume somebody's game (vect-hack-70x).
//
// The rule this pins is per-Module and about bytes, not about how many files a
// blob happens to carry. Every case below that says `false` is a blob F3 must
// refuse and F4 must warn about; every case that says `true` is a real save
// that must travel without a word of complaint.
import { describe, expect, it } from "vitest";
import { hasCharacter, type SaveFileEntry } from "../../src/backplane/character";
import { VOLUMES } from "../../src/backplane/volumes";

/** A file list in the shape both callers hand over: the manifest's entries on
 *  the way in, the walked volume on the way out. */
function files(...entries: ([string] | [string, number])[]): SaveFileEntry[] {
  return entries.map(([path, size]) => ({ path, size: size ?? 64 }));
}

describe("finding a character in a save", () => {
  it("refuses an empty volume", () => {
    for (const volume of Object.values(VOLUMES)) {
      expect(hasCharacter(volume, [])).toBe(false);
    }
  });

  it("does not count NetHack's seeded score files, which is the whole bug", () => {
    // seedGamePaths writes these four on every boot, so a fresh volume is
    // never empty and a guard that counted files would pass exactly here.
    expect(hasCharacter(VOLUMES.nethack, files(
      ["record", 0], ["logfile", 0], ["xlogfile", 0], ["livelog", 0],
    ))).toBe(false);
    // Even once the player has scores, a score table is not a character.
    expect(hasCharacter(VOLUMES.nethack, files(["record"], ["logfile"]))).toBe(false);
  });

  it("does not count Moria's packaged runtime files", () => {
    // 70 % of a real Moria blob by size, and none of it is a player.
    expect(hasCharacter(VOLUMES.moria, files(
      ["LICENSE"], ["AUTHORS"], ["data/help.txt"], ["scores.dat"],
    ))).toBe(false);
  });

  it("does not count Larn's options or Angband's scores and preferences", () => {
    expect(hasCharacter(VOLUMES.larn, files(["home/.larnopts"], ["scores/llog12.0"])))
      .toBe(false);
    expect(hasCharacter(VOLUMES.angband, files(["scores/scores.raw"], ["user/borg.txt"])))
      .toBe(false);
  });

  it("finds each Module's own save", () => {
    expect(hasCharacter(VOLUMES.nethack, files(["record", 0], ["save/1player"]))).toBe(true);
    expect(hasCharacter(VOLUMES.angband, files(["save/Player"]))).toBe(true);
    expect(hasCharacter(VOLUMES.larn, files(["home/Larn.sav"]))).toBe(true);
    expect(hasCharacter(VOLUMES.moria, files(["game.sav"]))).toBe(true);
  });

  it("counts a checkpoint, which is sometimes the only copy there is", () => {
    // The shape of a real exported Moria volume: no game.sav, because the
    // player never used the game's own save command, and a character all the
    // same. A rule that named only the save file would call this one empty.
    expect(hasCharacter(VOLUMES.moria, files(
      ["LICENSE"], ["scores.dat"], ["recover/.pending.sav"],
    ))).toBe(true);
    expect(hasCharacter(VOLUMES.nethack, files(
      ["record", 0], ["recover/manifest.json"], ["recover/1player.0"],
    ))).toBe(true);
    expect(hasCharacter(VOLUMES.angband, files(["panic/Player"]))).toBe(true);
  });

  it("judges by bytes, so a created-but-unwritten save is not a character", () => {
    expect(hasCharacter(VOLUMES.moria, files(["game.sav", 0]))).toBe(false);
    expect(hasCharacter(VOLUMES.larn, files(["home/Larn.sav", 0]))).toBe(false);
    expect(hasCharacter(VOLUMES.nethack, files(["save/1player", 0]))).toBe(false);
  });

  it("matches whole path segments, not string prefixes", () => {
    // `saved/` and `game.sav.bak` start with a character path and are not one.
    expect(hasCharacter(VOLUMES.nethack, files(["saved/1player"]))).toBe(false);
    expect(hasCharacter(VOLUMES.moria, files(["game.sav.bak"]))).toBe(false);
    expect(hasCharacter(VOLUMES.larn, files(["home/Larn.savage"]))).toBe(false);
  });

  it("keeps each Module's answer to itself", () => {
    // The same paths, judged against the wrong volume. Nothing here is
    // symmetrical by accident: an import already refuses a foreign game id,
    // and this is the layer under that.
    expect(hasCharacter(VOLUMES.larn, files(["save/1player"]))).toBe(false);
    expect(hasCharacter(VOLUMES.moria, files(["home/Larn.sav"]))).toBe(false);
    expect(hasCharacter(VOLUMES.angband, files(["game.sav"]))).toBe(false);
  });
});

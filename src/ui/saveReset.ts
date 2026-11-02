// Deleting this game's stored save (vect-hack-60i).
//
// The escape hatch for a volume the engine cannot boot. A save file's bytes
// reach NetHack's restore.c, Angband's load.c, Larn's savelev.c and Umoria's
// save code, none of them written against input somebody else made up, and a
// volume that fatals the engine on every boot leaves a page with no way back:
// the import is already cleared, the character it replaced is already gone,
// and clearing site data by hand is not an affordance a game can offer.
//
// It travels the same road as a load, and for a plainer reason than a load
// does — the volume is mounted in the engine worker's filesystem, so the page
// cannot touch it — and the road works when the engine does not. The reset is
// parked here, the page reloads, and the next mount empties the volume before
// the engine looks at it (backplane/persistFs.ts).
//
// Shared, not Module code: every Module's volume is deleted the same way, and
// the only Module-shaped thing in it is the name in the sentence.
import { stashPendingReset } from "../backplane/pendingImport.ts";
import type { ModuleVolume } from "../backplane/volumes.ts";

/** The browser calls this needs, named structurally so a test can supply a
 *  fake — a dialog, a database, and a navigation. */
export interface ResetTarget {
  confirm(question: string): boolean;
  stash(volumeId: string): Promise<void>;
  reload(): void;
}

export const browserResets: ResetTarget = {
  confirm: (question) => window.confirm(question),
  stash: (volumeId) => stashPendingReset(volumeId),
  reload: () => location.reload(),
};

/**
 * The question. Written out here rather than built in the caller because it is
 * the only thing standing between a misread menu row and a deleted character,
 * and a unit test pins it.
 *
 * It says what goes, and it says the one thing that gets it back — an export
 * taken first. It does not promise the reset will fix anything: the player
 * reaching for it may simply want a fresh game.
 */
export function resetQuestion(volume: ModuleVolume): string {
  return `Delete your ${volume.id} save?\n\n`
    + "This erases the character, the checkpoints and the scores this browser is holding for "
    + `${volume.id}, and it cannot be undone. Press F3 first if you want a copy of any of it.`;
}

/**
 * Ask, park the reset, and reload.
 *
 * Returns the line to show the player, or null when they declined — the same
 * contract loadSaveFile keeps, so the save menu can run either through one
 * path. On the way to a successful reset it returns while the page is already
 * reloading, so its line is the last thing this document says.
 */
export async function resetSaveVolume(
  volume: ModuleVolume, from: ResetTarget = browserResets,
): Promise<string | null> {
  if (!from.confirm(resetQuestion(volume))) return "Left your current game alone.";

  try {
    await from.stash(volume.id);
  } catch (err) {
    // Nothing was parked, so nothing will be deleted. Reloading now would put
    // the player back in the same broken game having been told otherwise.
    return `Could not delete your ${volume.id} save — `
      + `${err instanceof Error ? err.message : String(err)}.`;
  }
  from.reload();
  return `Deleting your ${volume.id} save — restarting the game.`;
}

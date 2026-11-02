// The other direction of saveDownload: a .vhsave file the player picks, on its
// way back into this Module's volume.
//
// Not a byte is written here. The volume is mounted in the engine worker's
// filesystem and the engine holds its own handles and its own idea of the
// save, so an import cannot land in a live one. What happens instead: the file
// is validated on this thread — a truncated blob, or another game's save, is
// refused while the player's current character is still untouched — the bytes
// are parked in the Backplane's transfer store, and the page reloads. The next
// worker's mount applies them before its engine runs (backplane/persistFs.ts).
//
// Shared, not Module code: the games differ in what is in the blob, not in how
// it re-enters the browser.
import { hasCharacter } from "../backplane/character.ts";
import { stashPendingImport } from "../backplane/pendingImport.ts";
import { MAX_SAVE_BYTES, SAVE_EXTENSION, unpackSave, type SaveContents } from "../backplane/saveBlob.ts";
import type { ModuleVolume } from "../backplane/volumes.ts";

export const IMPORT_KEY = "F4";

export interface PickedSave {
  name: string;
  bytes: Uint8Array;
}

/** The browser calls this needs, named structurally so a test can supply a
 *  fake — every one of them is a dialog, a navigation, or a database. */
export interface UploadTarget {
  /** null when the player dismissed the picker. */
  pickFile(): Promise<PickedSave | null>;
  confirm(question: string): boolean;
  stash(volumeId: string, bytes: Uint8Array): Promise<void>;
  reload(): void;
}

export const browserUploads: UploadTarget = {
  pickFile: () => new Promise<PickedSave | null>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `.${SAVE_EXTENSION}`;
    // Never added to the document: a detached input still opens the picker,
    // and one that is in the page would take a click meant for the game.
    input.addEventListener("cancel", () => resolve(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      readPickedFile(file).then(resolve, reject);
    });
    input.click();
  }),
  confirm: (question) => window.confirm(question),
  stash: (volumeId, bytes) => stashPendingImport(volumeId, bytes),
  reload: () => location.reload(),
};

/** Read a picked file, refusing on its declared size before a byte is read:
 *  unpackSave checks the same limit, but only after arrayBuffer() has already
 *  pulled a multi-gigabyte file into the tab. */
export async function readPickedFile(
  file: Pick<File, "name" | "size" | "arrayBuffer">,
): Promise<PickedSave> {
  if (file.size > MAX_SAVE_BYTES) throw new Error("save file is too large");
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/**
 * Pick a save file and hand it to the next engine boot.
 *
 * Returns the line to show the player, or null when they dismissed the picker
 * — a dialog someone closed themselves needs no report. On the way to a
 * successful load it returns while the page is already reloading, so its line
 * is the last thing this document says.
 */
export async function loadSaveFile(
  volume: ModuleVolume, from: UploadTarget = browserUploads,
): Promise<string | null> {
  let picked: PickedSave | null;
  try {
    picked = await from.pickFile();
  } catch (err) {
    return `Could not read that file — ${describe(err)}.`;
  }
  if (!picked) return null;

  let contents: SaveContents;
  try {
    contents = unpackSave(picked.bytes);
  } catch (err) {
    return `${picked.name} is not a save this can load — ${describe(err)}.`;
  }
  // Refused here as well as at the mount, and deliberately: the mount's check
  // is the one that protects the volume, this one is the one that protects the
  // player from confirming away a character for a file that was never going to
  // load anyway.
  if (contents.manifest.game !== volume.id) {
    return `${picked.name} is a ${contents.manifest.game} save; this is ${volume.id}.`;
  }

  // A blob with nobody in it (vect-hack-70x). F3 will not make one any more,
  // but one made by an earlier build, or carried from another machine, still
  // loads — and loading it empties the volume and puts nothing back, which is
  // a character traded for an empty shelf. Named in the question rather than
  // refused: the player is the one who knows whether they wanted the scores
  // out of it, and this build has already taken the only step that is
  // certainly right, which was not to create the file.
  const question = hasCharacter(volume, contents.manifest.files)
    ? `Load ${picked.name}?\n\nIt replaces your ${volume.id} save in this browser. `
      + "The character stored here now cannot be brought back — export it first if you want it."
    : `${picked.name} has no saved character in it.\n\n`
      + `Loading it still replaces your ${volume.id} save in this browser, so the character `
      + "stored here now would be gone and nothing would take its place. Load it anyway?";
  if (!from.confirm(question)) {
    return "Left your current game alone.";
  }

  try {
    await from.stash(volume.id, picked.bytes);
  } catch (err) {
    return `Could not hand that save to the engine — ${describe(err)}.`;
  }
  // The engine cannot take it while it is running; the reload is what gets the
  // volume back to the one moment it can be replaced.
  from.reload();
  return `Loading ${picked.name} — restarting the game.`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

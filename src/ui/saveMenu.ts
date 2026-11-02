// The one save affordance, the same in every Module: a button, a two-row
// panel, and the two keys behind it.
//
// Shared, not Module code — the games differ in what is in the blob, not in
// how it leaves or re-enters the browser. F3 and F4 because function keys are
// this project's view chrome: no engine's key map accepts one
// (src/modules/*/keys.ts), so there is no game command to shadow. The button
// exists because a key nobody is told about is not an affordance: a downloaded
// save the player cannot find their way back from is the bug this closes
// (vect-hack-9h1).
import type { ExportedSave } from "../backplane/saveExport.ts";
import type { ModuleVolume } from "../backplane/volumes.ts";
import {
  EXPORT_KEY, browserDownloads, downloadSave,
  type DownloadTarget, type KeyTarget,
} from "./saveDownload.ts";
import { IMPORT_KEY, browserUploads, loadSaveFile, type UploadTarget } from "./saveUpload.ts";
import { browserResets, resetSaveVolume, type ResetTarget } from "./saveReset.ts";

/** Element ids in index.html. The panel and its rows are optional: a Module
 *  view that removed them still gets both keys. */
export const SAVE_BUTTON_ID = "savebtn";
export const SAVE_PANEL_ID = "savepanel";
export const SAVE_ROW_ID = "savefile";
export const LOAD_ROW_ID = "loadfile";
/** The way out of a volume the engine cannot boot (vect-hack-60i). A row and
 *  no key: F3 and F4 are chrome for actions that ask before they do anything
 *  irreversible, and this one is irreversible on purpose. A function key is
 *  reachable by a knuckle, and the panel is not. */
export const RESET_ROW_ID = "resetsave";

/** Just enough of an element to show, hide, and click — the tests run without
 *  a DOM, and this is the whole surface they would have to fake otherwise. */
export interface MenuElement {
  /** boolean out of this file, and string too on the way in: the DOM's own
   *  `hidden` carries the "until-found" values as well. */
  hidden: boolean | string;
  addEventListener(type: "click", handler: () => void): void;
}

export interface MenuDocument {
  getElementById(id: string): MenuElement | null;
}

export interface SaveMenuUi {
  /** Whose volume this page is playing: what a picked file must match. */
  volume: ModuleVolume;
  /** The export round trip to the worker that owns the volume. */
  request(): Promise<ExportedSave>;
  notify(text: string): void;
  dom?: MenuDocument | null;
  keys?: KeyTarget;
  downloads?: DownloadTarget;
  uploads?: UploadTarget;
  resets?: ResetTarget;
}

/**
 * Bind the save affordance. Both actions are serialized against each other:
 * F3 held down would otherwise queue one full copy of the volume per repeat,
 * and a second file picker over the first asks the player a question they have
 * already answered.
 */
export function installSaveMenu(ui: SaveMenuUi): void {
  const dom = ui.dom === undefined ? defaultDocument() : ui.dom;
  const panel = dom?.getElementById(SAVE_PANEL_ID) ?? null;
  const button = dom?.getElementById(SAVE_BUTTON_ID) ?? null;
  const downloads = ui.downloads ?? browserDownloads;
  const uploads = ui.uploads ?? browserUploads;
  const resets = ui.resets ?? browserResets;
  let busy = false;

  const close = () => { if (panel) panel.hidden = true; };
  const run = (action: () => Promise<string | null>) => {
    if (busy) return;
    busy = true;
    // Before the action, not after: the picker and the download dialog both
    // take the focus, and a panel left open under them stays open.
    close();
    action().then(
      (text) => { if (text !== null) ui.notify(text); },
      (err: unknown) => ui.notify(`The save menu failed: ${String(err)}`),
    ).finally(() => { busy = false; });
  };

  const save = async (): Promise<string> => {
    let saved: ExportedSave;
    try {
      saved = await ui.request();
    } catch (err) {
      return `Could not export your save — ${err instanceof Error ? err.message : String(err)}.`;
    }
    downloadSave(saved, downloads);
    return `Saved a copy to your downloads: ${saved.filename}`;
  };
  const load = () => loadSaveFile(ui.volume, uploads);
  const reset = () => resetSaveVolume(ui.volume, resets);

  button?.addEventListener("click", () => {
    if (panel) panel.hidden = !panel.hidden;
  });
  dom?.getElementById(SAVE_ROW_ID)?.addEventListener("click", () => run(save));
  dom?.getElementById(LOAD_ROW_ID)?.addEventListener("click", () => run(load));
  // Serialized with the other two through the same `run`: a delete confirmed
  // over a running export would park a reset for the volume being packed.
  dom?.getElementById(RESET_ROW_ID)?.addEventListener("click", () => run(reset));

  const keys: KeyTarget = ui.keys ?? document;
  keys.addEventListener("keydown", (e) => {
    if (e.key === EXPORT_KEY) run(save);
    else if (e.key === IMPORT_KEY) run(load);
  });
}

function defaultDocument(): MenuDocument | null {
  return typeof document === "undefined" ? null : document;
}

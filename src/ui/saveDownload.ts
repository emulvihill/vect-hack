// The last few feet of a save export: bytes to a file the player has.
//
// Shared, not Module code — the games differ in what is in the blob, not in
// how it leaves the browser. What binds F3 to it, and what the player clicks
// instead, is saveMenu.ts; saveUpload.ts is the way back in.
import type { ExportedSave } from "../backplane/saveExport.ts";

export const EXPORT_KEY = "F3";

/** The browser calls this needs, named structurally so a test can supply a
 *  fake — nothing else in this file is worth proving. */
export interface DownloadTarget {
  createElement(tag: "a"): { href: string; download: string; click(): void };
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export const browserDownloads: DownloadTarget = {
  createElement: (tag) => document.createElement(tag),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

/** Just enough of an EventTarget to bind one key — `document`'s own overloaded
 *  signature does not narrow to a KeyboardEvent handler on its own. */
export interface KeyTarget {
  addEventListener(type: "keydown", handler: (e: KeyboardEvent) => void): void;
}

export function downloadSave(save: ExportedSave, to: DownloadTarget = browserDownloads): void {
  // application/octet-stream, not a made-up type: the extension identifies it
  // and no browser should try to render it.
  const url = to.createObjectURL(new Blob([save.bytes as BufferSource], {
    type: "application/octet-stream",
  }));
  try {
    const link = to.createElement("a");
    link.href = url;
    link.download = save.filename;
    link.click();
  } finally {
    to.revokeObjectURL(url);
  }
}


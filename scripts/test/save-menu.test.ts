// The save affordance both directions travel through (vect-hack-9h1): the
// panel, the two keys, and the page-side half of a load — everything that has
// to be right before a file is either handed to the player or parked for the
// next engine boot. The volume-side half is in backplane-persist.test.ts.
import { describe, expect, it, vi } from "vitest";
import { MAX_SAVE_BYTES, packSave, type SaveFS } from "../../src/backplane/saveBlob";
import { VOLUMES } from "../../src/backplane/volumes";
import { EXPORT_KEY, type DownloadTarget, type KeyTarget } from "../../src/ui/saveDownload";
import { IMPORT_KEY, loadSaveFile, readPickedFile, type PickedSave, type UploadTarget } from "../../src/ui/saveUpload";
import { resetSaveVolume, type ResetTarget } from "../../src/ui/saveReset";
import {
  LOAD_ROW_ID, RESET_ROW_ID, SAVE_BUTTON_ID, SAVE_PANEL_ID, SAVE_ROW_ID, installSaveMenu,
  type MenuDocument, type MenuElement,
} from "../../src/ui/saveMenu";

class FakeDownloads implements DownloadTarget {
  readonly links: { href: string; download: string; clicked: boolean }[] = [];
  readonly revoked: string[] = [];
  private urls = 0;

  createElement(_tag: "a") {
    const link = { href: "", download: "", clicked: false, click: () => { link.clicked = true; } };
    this.links.push(link);
    return link;
  }
  createObjectURL(_blob: Blob) { return `blob:${this.urls++}`; }
  revokeObjectURL(url: string) { this.revoked.push(url); }
}

class FakeKeys implements KeyTarget {
  private handlers: ((e: KeyboardEvent) => void)[] = [];
  addEventListener(_type: "keydown", handler: (e: KeyboardEvent) => void) {
    this.handlers.push(handler);
  }
  press(key: string) {
    for (const handler of this.handlers) handler({ key } as KeyboardEvent);
  }
}

class FakeElement implements MenuElement {
  hidden = true;
  clicks: (() => void)[] = [];
  addEventListener(_type: "click", handler: () => void) { this.clicks.push(handler); }
  click() { for (const handler of this.clicks) handler(); }
}

class FakeDom implements MenuDocument {
  readonly els = new Map<string, FakeElement>();
  constructor(ids: string[]) {
    for (const id of ids) this.els.set(id, new FakeElement());
  }
  getElementById(id: string) { return this.els.get(id) ?? null; }
  el(id: string) { return this.els.get(id)!; }
}

/** An upload target with every dialog answered in advance. */
class FakeUploads implements UploadTarget {
  picked: PickedSave | null = null;
  pickError: Error | null = null;
  answer = true;
  stashError: Error | null = null;
  readonly asked: string[] = [];
  readonly stashed: { volumeId: string; bytes: Uint8Array }[] = [];
  reloads = 0;

  pickFile() {
    return this.pickError ? Promise.reject(this.pickError) : Promise.resolve(this.picked);
  }
  confirm(question: string) { this.asked.push(question); return this.answer; }
  stash(volumeId: string, bytes: Uint8Array) {
    if (this.stashError) return Promise.reject(this.stashError);
    this.stashed.push({ volumeId, bytes });
    return Promise.resolve();
  }
  reload() { this.reloads++; }
}

/** A reset target with the dialog answered in advance. */
class FakeResets implements ResetTarget {
  answer = true;
  stashError: Error | null = null;
  readonly asked: string[] = [];
  readonly stashed: string[] = [];
  reloads = 0;

  confirm(question: string) { this.asked.push(question); return this.answer; }
  stash(volumeId: string) {
    if (this.stashError) return Promise.reject(this.stashError);
    this.stashed.push(volumeId);
    return Promise.resolve();
  }
  reload() { this.reloads++; }
}

/**
 * A volume packed exactly as an export would pack it.
 *
 * Files are given as volume-relative paths, and the default holds a character:
 * `save/` is one of NetHack's character paths (volumes.ts), so this is the
 * blob a player who saved their game actually has. Tests that want the other
 * kind — a file with nobody in it — say so, because since vect-hack-70x the
 * two travel through different questions.
 */
function blob(
  volume: typeof VOLUMES.nethack,
  files: Record<string, string> = { "save/1player": "a real character" },
): Uint8Array {
  const bodies = new Map(Object.entries(files).map(
    ([path, body]) => [`${volume.mountpoint}/${path}`, new TextEncoder().encode(body)]));
  const dirs = new Set<string>([volume.mountpoint]);
  for (const path of bodies.keys()) {
    for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1)) {
      dirs.add(path.slice(0, cut));
    }
  }
  const fs: SaveFS = {
    readdir: (path) => {
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of [...bodies.keys(), ...dirs]) {
        if (key === path || !key.startsWith(prefix)) continue;
        names.add(key.slice(prefix.length).split("/")[0]!);
      }
      return [".", "..", ...names];
    },
    stat: (path) => {
      const body = bodies.get(path);
      if (body) return { mode: 1, size: body.length };
      if (dirs.has(path)) return { mode: 0, size: 0 };
      throw new Error(`ENOENT: ${path}`);
    },
    isDir: (mode) => mode === 0,
    isFile: (mode) => mode === 1,
    readFile: (path) => bodies.get(path)!,
    writeFile: () => {},
    mkdirTree: () => {},
  };
  return packSave(fs, volume, new Date("2026-08-11T00:00:00Z"));
}

function menu(overrides: Partial<Parameters<typeof installSaveMenu>[0]> = {}) {
  const dom = new FakeDom(
    [SAVE_BUTTON_ID, SAVE_PANEL_ID, SAVE_ROW_ID, LOAD_ROW_ID, RESET_ROW_ID]);
  const keys = new FakeKeys();
  const downloads = new FakeDownloads();
  const uploads = new FakeUploads();
  const resets = new FakeResets();
  const notices: string[] = [];
  installSaveMenu({
    volume: VOLUMES.nethack,
    dom, keys, downloads, uploads, resets,
    notify: (text) => notices.push(text),
    request: async () => ({ bytes: new Uint8Array([1]), filename: "vecthack-nethack-x.vhsave" }),
    ...overrides,
  });
  return { dom, keys, downloads, uploads, resets, notices };
}

describe("the save panel", () => {
  it("opens and closes on the button", () => {
    const { dom } = menu();
    expect(dom.el(SAVE_PANEL_ID).hidden).toBe(true);
    dom.el(SAVE_BUTTON_ID).click();
    expect(dom.el(SAVE_PANEL_ID).hidden).toBe(false);
    dom.el(SAVE_BUTTON_ID).click();
    expect(dom.el(SAVE_PANEL_ID).hidden).toBe(true);
  });

  it("closes itself when a row runs, since the dialog takes the focus", async () => {
    const { dom, downloads } = menu();
    dom.el(SAVE_BUTTON_ID).click();
    dom.el(SAVE_ROW_ID).click();
    expect(dom.el(SAVE_PANEL_ID).hidden).toBe(true);
    await vi.waitFor(() => expect(downloads.links).toHaveLength(1));
  });

  it("binds both keys even with no chrome in the page", async () => {
    const { keys, downloads, uploads } = menu({ dom: null });
    keys.press(EXPORT_KEY);
    await vi.waitFor(() => expect(downloads.links).toHaveLength(1));
    uploads.picked = { name: "x.vhsave", bytes: blob(VOLUMES.nethack) };
    keys.press(IMPORT_KEY);
    await vi.waitFor(() => expect(uploads.reloads).toBe(1));
  });
});

describe("exporting from the menu", () => {
  it("exports on the chrome key and on nothing else", async () => {
    let asked = 0;
    const { keys, notices, downloads } = menu({
      request: async () => {
        asked++;
        return { bytes: new Uint8Array([1]), filename: "vecthack-nethack-x.vhsave" };
      },
    });

    keys.press("s");
    keys.press("F2");
    expect(asked).toBe(0);

    keys.press(EXPORT_KEY);
    await vi.waitFor(() => expect(notices).toEqual(
      ["Saved a copy to your downloads: vecthack-nethack-x.vhsave"]));
    expect(downloads.links).toHaveLength(1);
  });

  it("does not stack exports while one is running", async () => {
    let release!: (save: { bytes: Uint8Array; filename: string }) => void;
    let asked = 0;
    const { keys } = menu({
      request: () => { asked++; return new Promise((resolve) => { release = resolve; }); },
    });

    keys.press(EXPORT_KEY);
    keys.press(EXPORT_KEY); // a held key repeats; one copy of the volume is enough
    expect(asked).toBe(1);

    release({ bytes: new Uint8Array(), filename: "x.vhsave" });
    await vi.waitFor(() => { keys.press(EXPORT_KEY); expect(asked).toBe(2); });
  });

  it("will not open a picker over a running export", async () => {
    const { keys, uploads } = menu({ request: () => new Promise(() => {}) });
    keys.press(EXPORT_KEY);
    keys.press(IMPORT_KEY);
    await Promise.resolve();
    expect(uploads.asked).toEqual([]);
  });

  it("tells the player when the export fails", async () => {
    const { keys, notices } = menu({
      request: () => Promise.reject(
        new Error("there is nothing to export — another tab is playing")),
    });
    keys.press(EXPORT_KEY);
    await vi.waitFor(() => expect(notices).toEqual(
      ["Could not export your save — there is nothing to export — another tab is playing."]));
  });
});

describe("loading a save file", () => {
  it("parks the bytes and reloads, since a live volume cannot take them", async () => {
    const uploads = new FakeUploads();
    const bytes = blob(VOLUMES.nethack);
    uploads.picked = { name: "vecthack-nethack-x.vhsave", bytes };

    const said = await loadSaveFile(VOLUMES.nethack, uploads);

    expect(uploads.stashed).toEqual([{ volumeId: "nethack", bytes }]);
    expect(uploads.reloads).toBe(1);
    expect(said).toMatch(/^Loading vecthack-nethack-x\.vhsave/);
  });

  it("refuses an oversized file on its size, before reading a byte of it", async () => {
    const arrayBuffer = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
    const huge = { name: "huge.vhsave", size: MAX_SAVE_BYTES + 1, arrayBuffer };
    await expect(readPickedFile(huge)).rejects.toThrow(/too large/);
    expect(arrayBuffer).not.toHaveBeenCalled();

    const atLimit = { name: "ok.vhsave", size: MAX_SAVE_BYTES, arrayBuffer };
    await expect(readPickedFile(atLimit)).resolves.toMatchObject({ name: "ok.vhsave" });
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });

  it("says nothing at all when the player dismisses the picker", async () => {
    const uploads = new FakeUploads();
    expect(await loadSaveFile(VOLUMES.nethack, uploads)).toBeNull();
    expect(uploads.asked).toEqual([]);
    expect(uploads.reloads).toBe(0);
  });

  it("refuses another game's save without asking the player anything", async () => {
    const uploads = new FakeUploads();
    uploads.picked = { name: "angband.vhsave", bytes: blob(VOLUMES.angband) };

    const said = await loadSaveFile(VOLUMES.nethack, uploads);

    expect(said).toBe("angband.vhsave is a angband save; this is nethack.");
    // Confirming away a character for a file that was never going to load is
    // the one failure this ordering exists to prevent.
    expect(uploads.asked).toEqual([]);
    expect(uploads.stashed).toEqual([]);
    expect(uploads.reloads).toBe(0);
  });

  it("refuses a file that is not a save at all", async () => {
    const uploads = new FakeUploads();
    uploads.picked = { name: "photo.png", bytes: new Uint8Array([137, 80, 78, 71]) };
    expect(await loadSaveFile(VOLUMES.nethack, uploads))
      .toBe("photo.png is not a save this can load — not a VectHack save file.");
    expect(uploads.reloads).toBe(0);
  });

  it("leaves everything alone when the overwrite is declined", async () => {
    const uploads = new FakeUploads();
    uploads.picked = { name: "x.vhsave", bytes: blob(VOLUMES.nethack) };
    uploads.answer = false;

    expect(await loadSaveFile(VOLUMES.nethack, uploads)).toBe("Left your current game alone.");
    expect(uploads.asked[0]).toMatch(/replaces your nethack save/);
    expect(uploads.stashed).toEqual([]);
    expect(uploads.reloads).toBe(0);
  });

  it("does not reload when the bytes could not be parked", async () => {
    const uploads = new FakeUploads();
    uploads.picked = { name: "x.vhsave", bytes: blob(VOLUMES.nethack) };
    uploads.stashError = new Error("IndexedDB is unavailable");

    expect(await loadSaveFile(VOLUMES.nethack, uploads))
      .toBe("Could not hand that save to the engine — IndexedDB is unavailable.");
    // A reload here would restart the game for nothing.
    expect(uploads.reloads).toBe(0);
  });

  it("reports a file it could not read", async () => {
    const uploads = new FakeUploads();
    uploads.pickError = new Error("NotReadableError");
    expect(await loadSaveFile(VOLUMES.nethack, uploads))
      .toBe("Could not read that file — NotReadableError.");
  });
});

/**
 * Loading a file with nobody in it (vect-hack-70x).
 *
 * F3 will not make one of these any more, but a file made by an earlier build
 * or carried from another machine still loads, and loading it empties the
 * volume and writes nothing back. The player is asked a different question —
 * not refused, because whether they wanted the score table out of it is theirs
 * to know, and this build already took the step that is certainly right.
 */
describe("loading a save with no character in it", () => {
  /** What a fresh NetHack volume exports: four seeded score files, empty, and
   *  no save. The blob F3 used to hand out. */
  const NOBODY = { record: "", logfile: "", xlogfile: "", livelog: "" };

  it("says so in the question, instead of the ordinary overwrite warning", async () => {
    const uploads = new FakeUploads();
    uploads.picked = { name: "empty.vhsave", bytes: blob(VOLUMES.nethack, NOBODY) };

    await loadSaveFile(VOLUMES.nethack, uploads);

    expect(uploads.asked).toHaveLength(1);
    expect(uploads.asked[0]).toMatch(/has no saved character in it/);
    // And it still has to say what is at stake, which is the whole reason the
    // warning exists: the volume is emptied either way.
    expect(uploads.asked[0]).toMatch(/replaces your nethack save/);
  });

  it("asks the ordinary question when the file does hold a character", async () => {
    const uploads = new FakeUploads();
    uploads.picked = { name: "real.vhsave", bytes: blob(VOLUMES.nethack) };

    await loadSaveFile(VOLUMES.nethack, uploads);

    expect(uploads.asked[0]).not.toMatch(/no saved character/);
    expect(uploads.asked[0]).toMatch(/^Load real\.vhsave\?/);
  });

  it("loads it anyway when the player says so", async () => {
    const uploads = new FakeUploads();
    const bytes = blob(VOLUMES.nethack, NOBODY);
    uploads.picked = { name: "empty.vhsave", bytes };

    const said = await loadSaveFile(VOLUMES.nethack, uploads);

    // A warning, not a wall: the player answered the question this build
    // asked, and the file is theirs.
    expect(uploads.stashed).toEqual([{ volumeId: "nethack", bytes }]);
    expect(uploads.reloads).toBe(1);
    expect(said).toMatch(/^Loading empty\.vhsave/);
  });

  it("keeps the volume when the player declines", async () => {
    const uploads = new FakeUploads();
    uploads.picked = { name: "empty.vhsave", bytes: blob(VOLUMES.nethack, NOBODY) };
    uploads.answer = false;

    expect(await loadSaveFile(VOLUMES.nethack, uploads)).toBe("Left your current game alone.");
    expect(uploads.stashed).toEqual([]);
    expect(uploads.reloads).toBe(0);
  });

  it("counts a checkpoint-only file as a character, whatever the game", async () => {
    // The shape of a real Moria export: the packaged runtime files, the score
    // table, and a turn-tail checkpoint. There is a character in there and the
    // player must not be told otherwise.
    const uploads = new FakeUploads();
    uploads.picked = {
      name: "moria.vhsave",
      bytes: blob(VOLUMES.moria, {
        LICENSE: "the GPL, which is not a character",
        "scores.dat": "the score table, which is not one either",
        "recover/.pending.sav": "the character, and the only copy of it",
      }),
    };

    await loadSaveFile(VOLUMES.moria, uploads);

    expect(uploads.asked[0]).not.toMatch(/no saved character/);
  });
});

/**
 * Deleting this game's stored save (vect-hack-60i).
 *
 * The escape hatch for a volume the engine cannot boot. Everything worth
 * pinning is on this side of the round trip: what the player is asked, that a
 * decline costs nothing, and that a reload never happens unless the reset is
 * actually parked — a page that reloads into the same broken game having said
 * it deleted the save is the one outcome worse than no button.
 */
describe("deleting the stored save", () => {
  it("parks the reset and reloads, since a live volume cannot be emptied", async () => {
    const resets = new FakeResets();

    const said = await resetSaveVolume(VOLUMES.larn, resets);

    expect(resets.stashed).toEqual(["larn"]);
    expect(resets.reloads).toBe(1);
    expect(said).toBe("Deleting your larn save — restarting the game.");
  });

  it("names what goes and how to keep a copy", async () => {
    const resets = new FakeResets();
    await resetSaveVolume(VOLUMES.nethack, resets);

    const asked = resets.asked[0]!;
    expect(asked).toMatch(/Delete your nethack save\?/);
    // All three, because a player who reads "save" as "the save file" would
    // not expect the scores to go with it.
    expect(asked).toMatch(/character/);
    expect(asked).toMatch(/checkpoints/);
    expect(asked).toMatch(/scores/);
    expect(asked).toMatch(/cannot be undone/);
    // The one thing that gets any of it back.
    expect(asked).toMatch(/F3/);
  });

  it("does nothing at all when the player declines", async () => {
    const resets = new FakeResets();
    resets.answer = false;

    expect(await resetSaveVolume(VOLUMES.moria, resets)).toBe("Left your current game alone.");
    expect(resets.stashed).toEqual([]);
    expect(resets.reloads).toBe(0);
  });

  it("does not reload when the reset could not be parked", async () => {
    // Reloading here would put the player back in the same broken game having
    // been told their save was deleted.
    const resets = new FakeResets();
    resets.stashError = new Error("IndexedDB is unavailable");

    expect(await resetSaveVolume(VOLUMES.angband, resets))
      .toBe("Could not delete your angband save — IndexedDB is unavailable.");
    expect(resets.reloads).toBe(0);
  });

  it("runs from its menu row", async () => {
    const { dom, resets } = menu();
    dom.el(RESET_ROW_ID).click();

    await vi.waitFor(() => expect(resets.reloads).toBe(1));
    expect(resets.stashed).toEqual(["nethack"]);
  });

  it("is bound to no key at all", async () => {
    // Every key the menu binds, and the neighbours a knuckle finds. None of
    // them may delete a character.
    const { keys, resets } = menu();
    for (const key of [EXPORT_KEY, IMPORT_KEY, "F2", "F5", "Delete", "d"]) {
      keys.press(key);
      await vi.waitFor(() => expect(resets.asked).toEqual([]));
    }
  });

  it("closes the panel and will not run over another save action", async () => {
    const { dom, keys, resets } = menu({ request: () => new Promise(() => {}) });
    dom.el(SAVE_BUTTON_ID).click();
    keys.press(EXPORT_KEY); // an export that never finishes
    dom.el(RESET_ROW_ID).click();
    await Promise.resolve();

    // A delete confirmed over a running export would park a reset for the
    // volume being packed.
    expect(resets.asked).toEqual([]);
    expect(dom.el(SAVE_PANEL_ID).hidden).toBe(true);
  });

  it("reports the failure through the menu's own notice channel", async () => {
    const { dom, notices, resets } = menu();
    resets.stashError = new Error("IndexedDB is unavailable");
    dom.el(RESET_ROW_ID).click();

    await vi.waitFor(() => expect(notices).toEqual(
      ["Could not delete your nethack save — IndexedDB is unavailable."]));
  });
});

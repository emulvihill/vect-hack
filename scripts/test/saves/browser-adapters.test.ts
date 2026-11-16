// The default adapters behind F3, F4 and the reset row: browserDownloads,
// browserUploads and browserResets. Every other save test hands its own fake
// target in, so these objects are the only part of the save path that touches
// the browser, and nothing else runs them. Here they run against the real
// globals where node has them (URL.createObjectURL, EventTarget, File) and a
// real IndexedDB implementation; only the document, window.confirm and
// location are stubbed.
import { resolveObjectURL } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { MAX_SAVE_BYTES } from "../../../src/backplane/saveBlob";
import { readPendingImport, readPendingReset } from "../../../src/backplane/pendingImport";
import { browserDownloads, downloadSave } from "../../../src/ui/saveDownload";
import { browserUploads } from "../../../src/ui/saveUpload";
import { browserResets } from "../../../src/ui/saveReset";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub `document` with one element factory; anything else it is asked fails loudly. */
function documentMaking<T>(make: (tag: string) => T): { made: { tag: string; el: T }[] } {
  const made: { tag: string; el: T }[] = [];
  vi.stubGlobal("document", {
    createElement: (tag: string) => { const el = make(tag); made.push({ tag, el }); return el; },
  });
  return { made };
}

describe("browserDownloads", () => {
  it("hands the file over through a real object URL, revoked once the link is clicked", async () => {
    let seen: { href: string; download: string; bytes: number[] } | null = null;
    let pending: Promise<void> = Promise.resolve();
    const link = {
      href: "", download: "",
      // At the click the URL has to resolve to the save's bytes.
      click() {
        const blob = resolveObjectURL(this.href)!;
        seen = { href: this.href, download: this.download, bytes: [] };
        pending = blob.arrayBuffer().then((b) => { seen!.bytes = [...new Uint8Array(b)]; });
      },
    };
    const { made } = documentMaking(() => link);

    downloadSave({ bytes: new Uint8Array([7, 8, 9]), filename: "vecthack-larn-x.vhsave" }, browserDownloads);
    await pending;

    expect(made.map((m) => m.tag)).toEqual(["a"]);
    expect(seen).toMatchObject({ download: "vecthack-larn-x.vhsave", bytes: [7, 8, 9] });
    // Revoked after the click: the whole volume is not held for the page's life.
    expect(resolveObjectURL(seen!.href)).toBeUndefined();
  });
});

/** The detached <input type=file> the picker is: an EventTarget that can be clicked. */
class FakeFileInput extends EventTarget {
  type = "";
  accept = "";
  files: ArrayLike<Pick<File, "name" | "size" | "arrayBuffer">> | null = null;
  clicks = 0;
  click() { this.clicks++; }
}

describe("browserUploads.pickFile", () => {
  function picker() {
    const { made } = documentMaking(() => new FakeFileInput());
    const picked = browserUploads.pickFile();
    expect(made).toHaveLength(1);
    return { picked, input: made[0]!.el, tag: made[0]!.tag };
  }

  it("opens a save-file picker that is never put in the page", async () => {
    // The stub document has no body: an input appended to the page would throw here.
    const { picked, input, tag } = picker();
    expect(tag).toBe("input");
    expect(input.type).toBe("file");
    expect(input.accept).toBe(".vhsave");
    expect(input.clicks).toBe(1);
    input.dispatchEvent(new Event("cancel"));
    await picked;
  });

  it("resolves the picked file's name and bytes on change", async () => {
    const { picked, input } = picker();
    input.files = [new File([new Uint8Array([1, 2, 3])], "mine.vhsave")];
    input.dispatchEvent(new Event("change"));
    expect(await picked).toEqual({ name: "mine.vhsave", bytes: new Uint8Array([1, 2, 3]) });
  });

  it("resolves null when the player dismisses the picker", async () => {
    const { picked, input } = picker();
    input.dispatchEvent(new Event("cancel"));
    expect(await picked).toBeNull();
  });

  it("resolves null on a change that picked nothing", async () => {
    const { picked, input } = picker();
    input.files = [];
    input.dispatchEvent(new Event("change"));
    expect(await picked).toBeNull();
  });

  it("rejects an oversized file without reading it", async () => {
    const { picked, input } = picker();
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    input.files = [{ name: "huge.vhsave", size: MAX_SAVE_BYTES + 1, arrayBuffer }];
    input.dispatchEvent(new Event("change"));
    await expect(picked).rejects.toThrow(/too large/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

/** confirm, IndexedDB and reload, as the two dialog-and-reload adapters see them. */
function browser(answer: boolean) {
  const confirm = vi.fn((_question: string) => answer);
  const reload = vi.fn();
  const idb = new IDBFactory();
  vi.stubGlobal("window", { confirm });
  vi.stubGlobal("location", { reload });
  vi.stubGlobal("indexedDB", idb);
  return { confirm, reload, idb };
}

describe("browserUploads", () => {
  it("asks window.confirm and returns its answer", () => {
    for (const answer of [true, false]) {
      const { confirm } = browser(answer);
      expect(browserUploads.confirm("Load it?")).toBe(answer);
      expect(confirm).toHaveBeenCalledWith("Load it?");
    }
  });

  it("parks the bytes as an import for that volume, not a reset", async () => {
    const { idb } = browser(true);
    await browserUploads.stash("angband", new Uint8Array([4, 5]));
    expect(await readPendingImport("angband", idb)).toEqual(new Uint8Array([4, 5]));
    expect(await readPendingReset("angband", idb)).toBe(false);
    expect(await readPendingImport("nethack", idb)).toBeNull();
  });

  it("reloads the page", () => {
    const { reload } = browser(true);
    browserUploads.reload();
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("browserResets", () => {
  it("asks window.confirm and returns its answer", () => {
    for (const answer of [true, false]) {
      const { confirm } = browser(answer);
      expect(browserResets.confirm("Delete it?")).toBe(answer);
      expect(confirm).toHaveBeenCalledWith("Delete it?");
    }
  });

  it("parks a reset for that volume, not an import", async () => {
    const { idb } = browser(true);
    await browserResets.stash("moria");
    expect(await readPendingReset("moria", idb)).toBe(true);
    expect(await readPendingImport("moria", idb)).toBeNull();
    expect(await readPendingReset("larn", idb)).toBe(false);
  });

  it("reloads the page", () => {
    const { reload } = browser(true);
    browserResets.reload();
    expect(reload).toHaveBeenCalledOnce();
  });
});

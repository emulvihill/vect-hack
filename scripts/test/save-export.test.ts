import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SaveExports, answerExportRequest, type SaveExportReply, type SaveExportRequest,
} from "../../src/backplane/saveExport";
import { downloadSave, type DownloadTarget } from "../../src/ui/saveDownload";

afterEach(() => vi.useRealTimers());

describe("the worker half of an export", () => {
  const posted: { msg: SaveExportReply; transfer: Transferable[] }[] = [];
  const post = (msg: SaveExportReply, transfer: Transferable[]) => { posted.push({ msg, transfer }); };
  const save = { bytes: new Uint8Array([7, 7]), filename: "vecthack-angband-x.vhsave" };

  it("answers with the handle's save, bytes transferred not copied", () => {
    answerExportRequest(3, { exportSave: () => save }, post);
    expect(posted.at(-1)!.msg).toEqual({ type: "saveBlob", id: 3, ok: true, ...save });
    expect(posted.at(-1)!.transfer).toEqual([save.bytes.buffer]);
  });

  it("turns a packing failure into a reply, not a throw", () => {
    // A throw here would be swallowed by the worker's message handler and the
    // main thread would wait out its whole timeout for a known failure.
    answerExportRequest(4, { exportSave: () => { throw new Error("volume is gone"); } }, post);
    expect(posted.at(-1)!.msg).toEqual({ type: "saveBlob", id: 4, ok: false, message: "volume is gone" });
  });

  it("answers an F3 that beats the mount, rather than dropping it", () => {
    answerExportRequest(5, undefined, post);
    expect(posted.at(-1)!.msg).toEqual({
      type: "saveBlob", id: 5, ok: false, message: "storage is still starting up",
    });
  });
});

describe("the main-thread half of an export", () => {
  const sent: SaveExportRequest[] = [];
  const exports = new SaveExports();
  const start = () => exports.request((msg) => { sent.push(msg); });

  it("resolves the request its reply names", async () => {
    const wait = start();
    const id = sent.at(-1)!.id;
    exports.settle({ type: "saveBlob", id, ok: true, bytes: new Uint8Array([1]), filename: "a.vhsave" });
    await expect(wait).resolves.toEqual({ bytes: new Uint8Array([1]), filename: "a.vhsave" });
  });

  it("rejects with the worker's own words", async () => {
    const wait = start();
    exports.settle({ type: "saveBlob", id: sent.at(-1)!.id, ok: false, message: "nothing to export" });
    await expect(wait).rejects.toThrow("nothing to export");
  });

  it("gives ids out one per request, so two exports cannot cross", () => {
    start(); start();
    expect(sent.at(-1)!.id).not.toBe(sent.at(-2)!.id);
  });

  it("drops a reply to an id it is not waiting for", () => {
    // Settling twice is the real case: a timeout already rejected the caller.
    const stale: SaveExportReply = {
      type: "saveBlob", id: 9999, ok: true, bytes: new Uint8Array(), filename: "x",
    };
    expect(() => exports.settle(stale)).not.toThrow();
  });

  it("rejects rather than hanging when the worker never answers", async () => {
    vi.useFakeTimers();
    const wait = start();
    vi.advanceTimersByTime(15_000);
    await expect(wait).rejects.toThrow(/did not answer/);
  });

  it("rejects when the request cannot even be sent", async () => {
    const dead = new SaveExports();
    await expect(dead.request(() => { throw new Error("worker is gone"); }))
      .rejects.toThrow(/could not be sent/);
  });
});

class FakeDownloads implements DownloadTarget {
  readonly links: { href: string; download: string; clicked: boolean }[] = [];
  readonly urls: string[] = [];
  readonly revoked: string[] = [];
  blobs: Blob[] = [];

  createElement(_tag: "a") {
    const link = { href: "", download: "", clicked: false, click: () => { link.clicked = true; } };
    this.links.push(link);
    return link;
  }
  createObjectURL(blob: Blob) {
    this.blobs.push(blob);
    const url = `blob:${this.urls.length}`;
    this.urls.push(url);
    return url;
  }
  revokeObjectURL(url: string) { this.revoked.push(url); }
}

describe("handing a save to the player", () => {
  it("names the file from the blob and releases the URL", () => {
    const to = new FakeDownloads();
    downloadSave({ bytes: new Uint8Array([1, 2]), filename: "vecthack-nethack-x.vhsave" }, to);
    expect(to.links[0]).toMatchObject({
      href: "blob:0", download: "vecthack-nethack-x.vhsave", clicked: true,
    });
    expect(to.blobs[0]!.type).toBe("application/octet-stream");
    // Left unrevoked, every export leaks its whole volume for the page's life.
    expect(to.revoked).toEqual(["blob:0"]);
  });
});

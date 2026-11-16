import { describe, expect, it } from "vitest";
import {
  SAVE_MAGIC, packSave, restoreSave, saveFileName, unpackSave,
} from "../../../src/backplane/saveBlob";
import { VOLUMES } from "../../../src/backplane/volumes";
import { FakeFS, S_IFREG } from "./fake-fs";

/** A tree of files under `root`, every parent directory made on the way. */
function tree(root: string, files: Record<string, Uint8Array>): FakeFS {
  const fs = new FakeFS(root);
  for (const [path, body] of Object.entries(files)) {
    fs.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    fs.writeFile(path, body);
  }
  return fs;
}

const bytes = (...values: number[]) => new Uint8Array(values);
const AT = new Date("2026-08-03T21:07:00Z");

function loaded(): FakeFS {
  return tree(VOLUMES.nethack.mountpoint, {
    "/vect-nethack/save/1player.gz": bytes(1, 2, 3, 4),
    "/vect-nethack/save/checkpoint/level.0": bytes(9),
    "/vect-nethack/record": bytes(65, 66),
  });
}

function rawBlob(files: { path: string; bytes: Uint8Array; size?: number }[]): Uint8Array {
  const manifest = {
    game: "nethack", created: AT.toISOString(),
    files: files.map(({ path, bytes, size }) => ({ path, size: size ?? bytes.length })),
  };
  const header = new TextEncoder().encode(`${SAVE_MAGIC}\n${JSON.stringify(manifest)}\n`);
  const out = new Uint8Array(header.length + files.reduce((n, file) => n + file.bytes.length, 0));
  out.set(header);
  let at = header.length;
  for (const file of files) { out.set(file.bytes, at); at += file.bytes.length; }
  return out;
}

describe("save blobs", () => {
  it("names the file after the game it came from", () => {
    expect(saveFileName(VOLUMES.nethack, new Date(2026, 7, 3, 21, 7)))
      .toBe("vecthack-nethack-20260803-2107.vhsave");
    expect(saveFileName(VOLUMES.angband, new Date(2026, 11, 25, 6, 5)))
      .toBe("vecthack-angband-20261225-0605.vhsave");
  });

  it("round-trips every file in the volume", () => {
    const blob = packSave(loaded(), VOLUMES.nethack, AT);
    const restored = new FakeFS(VOLUMES.nethack.mountpoint);
    restoreSave(restored, VOLUMES.nethack, unpackSave(blob));

    expect(restored.readFile("/vect-nethack/save/1player.gz")).toEqual(bytes(1, 2, 3, 4));
    expect(restored.readFile("/vect-nethack/save/checkpoint/level.0")).toEqual(bytes(9));
    expect(restored.readFile("/vect-nethack/record")).toEqual(bytes(65, 66));
  });

  it("carries the game id and a readable manifest", () => {
    const blob = packSave(loaded(), VOLUMES.nethack, AT);
    expect(new TextDecoder().decode(blob.subarray(0, SAVE_MAGIC.length))).toBe(SAVE_MAGIC);
    const { manifest } = unpackSave(blob);
    expect(manifest.game).toBe("nethack");
    expect(manifest.created).toBe(AT.toISOString());
    expect(manifest.files.map((f) => f.path)).toEqual([
      "record", "save/1player.gz", "save/checkpoint/level.0",
    ]);
  });

  it("refuses to restore one game's save into the other's volume", () => {
    const contents = unpackSave(packSave(loaded(), VOLUMES.nethack, AT));
    const angband = new FakeFS(VOLUMES.angband.mountpoint);
    expect(() => restoreSave(angband, VOLUMES.angband, contents))
      .toThrow(/nethack save; the angband volume cannot take it/);
    // Nothing was written on the way to that refusal.
    expect(angband.made).toEqual([VOLUMES.angband.mountpoint]);
  });

  /**
   * A session-only tab's save (vect-hack-47a). The engine's own tree is not a
   * volume — NetHack's is the Emscripten root, with /tmp and the read-only
   * embed beside the save — so the pack is told which names are the save, and
   * those names are the volume's own.
   */
  describe("packing a declared name set instead of a whole volume", () => {
    /** The FS root as a session-only NetHack tab leaves it: the save at its
     *  root paths, and everything else a running engine has around it. */
    function sessionRoot(): FakeFS {
      const fs = tree("/", {
        "/save/1player.gz": bytes(1, 2, 3, 4),
        "/save/checkpoint/level.0": bytes(9),
        "/record": bytes(65, 66),
        "/tmp/lock.0": bytes(7),
        "/nhdat": bytes(3, 3, 3),
      });
      fs.mkdirTree("/dev");
      fs.mkdev("/dev/random");
      return fs;
    }

    const NAMES = ["save", "record", "logfile"];

    it("packs the declared names and nothing else under the root", () => {
      const { manifest } = unpackSave(
        packSave(sessionRoot(), VOLUMES.nethack, AT, { root: "/", names: NAMES }));

      // The volume's own relative names, which is what makes the blob
      // loadable: an undeclared name is not save data however close it sits.
      expect(manifest.files.map((f) => f.path)).toEqual([
        "record", "save/1player.gz", "save/checkpoint/level.0",
      ]);
    });

    it("treats a declared name that is not there yet as absent, not as an error", () => {
      // logfile is declared and unwritten. A name list says what a save is
      // made of, not what this game has written.
      const { manifest } = unpackSave(
        packSave(sessionRoot(), VOLUMES.nethack, AT, { root: "/", names: NAMES }));
      expect(manifest.files.map((f) => f.path)).not.toContain("logfile");
    });

    it("restores what it packed into a volume, at the volume's paths", () => {
      const blob = packSave(sessionRoot(), VOLUMES.nethack, AT, { root: "/", names: NAMES });
      const volume = new FakeFS(VOLUMES.nethack.mountpoint);
      restoreSave(volume, VOLUMES.nethack, unpackSave(blob));

      expect(volume.readFile("/vect-nethack/save/1player.gz")).toEqual(bytes(1, 2, 3, 4));
      expect(volume.readFile("/vect-nethack/save/checkpoint/level.0")).toEqual(bytes(9));
      expect(volume.readFile("/vect-nethack/record")).toEqual(bytes(65, 66));
    });

    it("reads the bodies from the declared root, not from the volume", () => {
      // Same relative names in both places and different bytes in each: a pack
      // that sized from one root and read from the other would either throw on
      // the size check or quietly ship the volume's stale bytes as the session
      // tab's save.
      const fs = sessionRoot();
      fs.mkdirTree(VOLUMES.nethack.mountpoint);
      fs.writeFile(`${VOLUMES.nethack.mountpoint}/record`, bytes(99, 99, 99, 99, 99));
      const contents = unpackSave(
        packSave(fs, VOLUMES.nethack, AT, { root: "/", names: NAMES }));

      expect(contents.files.find((f) => f.path === "record")?.bytes).toEqual(bytes(65, 66));
    });

    it("still packs the whole volume when no names are declared", () => {
      const { manifest } = unpackSave(packSave(loaded(), VOLUMES.nethack, AT));
      expect(manifest.files.map((f) => f.path)).toEqual([
        "record", "save/1player.gz", "save/checkpoint/level.0",
      ]);
    });
  });

  it("packs regular files only, never a device", () => {
    const fs = loaded();
    fs.mkdev("/vect-nethack/elsewhere");
    const { manifest } = unpackSave(packSave(fs, VOLUMES.nethack, AT));
    expect(manifest.files.map((f) => f.path)).not.toContain("elsewhere");
  });

  it("rejects a file that is not one of ours", () => {
    expect(() => unpackSave(new TextEncoder().encode("PK zip\n")))
      .toThrow(/not a VectHack save file/);
    expect(() => unpackSave(new TextEncoder().encode(`${SAVE_MAGIC}\nnot json\n`)))
      .toThrow(/manifest is not readable/);
  });

  it("rejects a truncated blob rather than restoring half a save", () => {
    const blob = packSave(loaded(), VOLUMES.nethack, AT);
    expect(() => unpackSave(blob.subarray(0, blob.length - 2))).toThrow(/truncated/);
  });

  it("rejects a manifest whose paths would escape the volume", () => {
    const escaping = (path: string) => {
      const manifest = { game: "nethack", created: AT.toISOString(), files: [{ path, size: 1 }] };
      const header = new TextEncoder().encode(`${SAVE_MAGIC}\n${JSON.stringify(manifest)}\n`);
      const out = new Uint8Array(header.length + 1);
      out.set(header, 0);
      return out;
    };
    expect(() => unpackSave(escaping("../outside"))).toThrow(/escapes the volume/);
    expect(() => unpackSave(escaping("/etc/passwd"))).toThrow(/escapes the volume/);
    expect(() => unpackSave(escaping("save/../../outside"))).toThrow(/escapes the volume/);
  });

  it.each(["", ".", "save/./file", "save//file", "save/", "save/\0file"])(
    "rejects noncanonical save path %j", (path) => {
      expect(() => unpackSave(rawBlob([{ path, bytes: bytes(1) }]))).toThrow(/path|entry/);
    },
  );

  it("rejects duplicate and file-prefix-colliding paths", () => {
    expect(() => unpackSave(rawBlob([
      { path: "save/game", bytes: bytes(1) },
      { path: "save/game", bytes: bytes(2) },
    ]))).toThrow(/duplicate/);
    expect(() => unpackSave(rawBlob([
      { path: "save", bytes: bytes(1) },
      { path: "save/game", bytes: bytes(2) },
    ]))).toThrow(/collid/);
  });

  it("bounds the manifest and declared file count before allocating bodies", () => {
    const tooMany = Array.from({ length: 4_097 }, (_, i) => ({
      path: `save/${i}`, bytes: bytes(),
    }));
    expect(() => unpackSave(rawBlob(tooMany))).toThrow(/too many files/);

    const hugePath = "x".repeat(270_000);
    expect(() => unpackSave(rawBlob([{ path: hugePath, bytes: bytes() }])))
      .toThrow(/manifest is too large/);
  });

  it("preflights manually constructed contents before restore writes anything", () => {
    const target = new FakeFS(VOLUMES.nethack.mountpoint);
    const malformed = {
      manifest: {
        game: "nethack", created: AT.toISOString(),
        files: [{ path: "first", size: 1 }, { path: "../escape", size: 1 }],
      },
      files: [{ path: "first", bytes: bytes(1) }, { path: "../escape", bytes: bytes(2) }],
    };
    expect(() => restoreSave(target, VOLUMES.nethack, malformed)).toThrow(/escapes|canonical/);
    expect(target.made).toEqual([VOLUMES.nethack.mountpoint]);
  });

  it("bounds manually constructed restore contents before writing", () => {
    const target = new FakeFS(VOLUMES.nethack.mountpoint);
    const oversized = {
      manifest: {
        game: "nethack", created: AT.toISOString(),
        files: [{ path: "save/game", size: 128 * 1024 * 1024 + 1 }],
      },
      files: [{ path: "save/game", bytes: bytes() }],
    };
    expect(() => restoreSave(target, VOLUMES.nethack, oversized)).toThrow(/too large/);
    expect(target.made).toEqual([VOLUMES.nethack.mountpoint]);
  });

  it("bounds an exported volume before allocating its container", () => {
    const fs = tree(VOLUMES.nethack.mountpoint, { "/vect-nethack/record": bytes() });
    const stat = fs.stat.bind(fs);
    fs.stat = (path: string) => path.endsWith("/record")
      ? { mode: S_IFREG, size: 128 * 1024 * 1024, mtime: new Date(0) }
      : stat(path);
    expect(() => packSave(fs, VOLUMES.nethack, AT)).toThrow(/too large/);
  });
});

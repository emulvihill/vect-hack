import { describe, expect, it } from "vitest";
import { mountLarnStorage } from "../../../src/modules/larn/persist";
import { VOLUMES } from "../../../src/backplane/volumes";
import { FakeFS, FakeModule, fakeLocks } from "../saves/fake-fs";

const LINKS = ["home", "scores"] as const;

describe("mountLarnStorage", () => {
  it("links every writable Larn directory into its persistent volume", async () => {
    const mod = new FakeModule(new FakeFS("/lib"));
    const handle = mountLarnStorage(mod, { locks: fakeLocks(true) });
    await handle.ready;

    expect(handle.persistent).toBe(true);
    expect(mod.FS.mounts).toEqual([{
      type: mod.FS.filesystems.IDBFS,
      opts: { autoPersist: true },
      mountpoint: VOLUMES.larn.mountpoint,
    }]);
    for (const path of LINKS) {
      expect(mod.FS.readlink(`/lib/${path}`)).toBe(`/vect-larn/${path}`);
      expect(mod.FS.analyzePath(`/vect-larn/${path}`).exists).toBe(true);
    }
  });

  it("replaces only empty preload directories with links", async () => {
    const fs = new FakeFS("/lib");
    for (const path of LINKS) fs.mkdir(`/lib/${path}`);
    const handle = mountLarnStorage(new FakeModule(fs), { locks: fakeLocks(true) });
    await handle.ready;

    expect(handle.persistent).toBe(true);
    for (const path of LINKS)
      expect(fs.readlink(`/lib/${path}`)).toBe(`/vect-larn/${path}`);
  });

  it("preserves a non-empty preload directory and falls back without deleting its data", async () => {
    const fs = new FakeFS("/lib");
    fs.mkdir("/lib/home");
    fs.writeFile("/lib/home/preloaded", "keep me");
    const handle = mountLarnStorage(new FakeModule(fs), { locks: fakeLocks(true) });
    await handle.ready;

    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toMatch(/setup failed/i);
    expect(fs.text("/lib/home/preloaded")).toBe("keep me");
    expect(fs.kind("/lib/home")).toBe("dir");
  });

  // --- vect-hack-52e: the volume is unmounted under whatever links this seed
  // had already installed, so the session-only retry finds a dangling farm.
  it("re-seeds over the farm when linking fails partway through it", async () => {
    const fs = new FakeFS("/lib");
    const link = fs.symlink.bind(fs);
    fs.symlink = (target, path) => {
      if (path === "/lib/scores") throw new Error("EIO: /lib/scores");
      link(target, path);
    };
    const handle = mountLarnStorage(new FakeModule(fs), { locks: fakeLocks(true) });
    await handle.ready;

    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toMatch(/setup failed/i);
    for (const path of LINKS) expect(fs.kind(`/lib/${path}`)).toBe("dir");
  });

  it("gives a losing lock owner writable session-only directories", async () => {
    const fs = new FakeFS("/lib");
    const handle = mountLarnStorage(new FakeModule(fs), { locks: fakeLocks(false) });
    await handle.ready;

    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toMatch(/another tab/i);
    expect(fs.mounts).toEqual([]);
    for (const path of LINKS)
      expect(fs.kind(`/lib/${path}`)).toBe("dir");
  });
});
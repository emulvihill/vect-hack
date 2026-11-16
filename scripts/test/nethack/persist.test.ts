// NetHack's persistence wiring: which paths get linked and seeded, the bones
// mirror, and how each setup failure falls back. The mount lifecycle every
// Module shares (election, populate, flush, timeouts) is pinned once, in
// scripts/test/saves/backplane-persist.test.ts. The round trip through a real
// IDBFS is covered by scripts/test/nethack/test-nethack-persistence.mjs.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BONES_DIR, PERSIST_ROOT, SCORE_FILES, mountPersistentStorage,
  type LockManagerLike,
} from "../../../src/modules/nethack/persist";
import { FakeFS, FakeModule, fakeLocks } from "../saves/fake-fs";

/** Boot with the lock granted unless told otherwise. */
async function mounted(fs = new FakeFS(), locks: LockManagerLike | null = fakeLocks(true)) {
  const mod = new FakeModule(fs);
  const handle = mountPersistentStorage(mod, { locks });
  await handle.ready;
  return { mod, handle, fs };
}

afterEach(() => vi.useRealTimers());

describe("mountPersistentStorage", () => {
  it("links the paths NetHack opens relative to HACKDIR into the volume", async () => {
    const { mod, handle } = await mounted();
    expect(handle.persistent).toBe(true);
    expect(handle.reason).toBeNull();
    expect(mod.FS.readlink("/save")).toBe(`${PERSIST_ROOT}/save`);
    expect(mod.FS.kind(`${PERSIST_ROOT}/save`)).toBe("dir");
    for (const f of SCORE_FILES)
      expect(mod.FS.readlink(`/${f}`)).toBe(`${PERSIST_ROOT}/${f}`);
  });

  it("leaves restored score files alone instead of seeding over them", async () => {
    const fs = new FakeFS();
    fs.onPopulate = () => {
      fs.mkdir(`${PERSIST_ROOT}/save`);
      fs.writeFile(`${PERSIST_ROOT}/save/0player`, "savedata");
      fs.writeFile(`${PERSIST_ROOT}/record`, "top ten\n");
    };
    await mounted(fs);

    expect(fs.text(`${PERSIST_ROOT}/record`)).toBe("top ten\n");
    expect(fs.text(`${PERSIST_ROOT}/save/0player`)).toBe("savedata");
    expect(fs.text(`${PERSIST_ROOT}/logfile`)).toBe(""); // still seeded
  });

  // --- vect-hack-4ho: a second tab must not reconcile the first tab's saves away
  it("runs session-only when another tab already owns the volume", async () => {
    const locks = fakeLocks(false);
    const { mod, handle } = await mounted(new FakeFS(), locks);

    expect(locks.asked).toEqual(["vect-nethack/persist"]);
    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toMatch(/another tab/i);
    expect(mod.FS.mounts).toHaveLength(0);  // never mounted, so never syncs
    expect(mod.FS.syncs).toHaveLength(0);
    expect(mod.FS.kind("/save")).toBe("dir"); // still playable
  });

  it("gives up the lock rather than writing when the lock API fails", async () => {
    const locks: LockManagerLike = { request: () => Promise.reject(new Error("SecurityError")) };
    const { handle, mod } = await mounted(new FakeFS(), locks);
    expect(handle.persistent).toBe(false);
    expect(mod.FS.mounts).toHaveLength(0);
  });

  // --- vect-hack-rm8: a fault in setup must not strand the run dependency
  it("releases the run dependency when linking throws", async () => {
    const fs = new FakeFS();
    fs.symlink = () => { throw new Error("EEXIST: /save"); };
    const { mod, handle } = await mounted(fs);

    expect(mod.deps).toHaveLength(0);      // main() still gets to run
    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toMatch(/setup failed/i);
    expect(handle.reason?.code).toBe("setup-failed");
    expect(fs.kind("/save")).toBe("dir"); // fell back to session-only
  });

  // --- vect-hack-52e: the farm is linked before the last thing that can fail,
  // and the volume is unmounted under it on the way out.
  it("re-seeds over the farm when linking fails partway through it", async () => {
    const fs = new FakeFS();
    const link = fs.symlink.bind(fs);
    fs.symlink = (oldpath, newpath) => {
      if (newpath === "/livelog") throw new Error("EIO: /livelog");
      link(oldpath, newpath);
    };
    const { handle } = await mounted(fs);

    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toMatch(/setup failed/i);
    expect(handle.reason?.code).toBe("setup-failed");
    expect(fs.kind("/save")).toBe("dir");
    for (const f of SCORE_FILES) expect(fs.kind(`/${f}`)).toBe("file");
  });

  it("falls back to session-only paths when IDBFS is not linked in", async () => {
    const fs = new FakeFS();
    delete fs.filesystems.IDBFS;
    const { handle, mod } = await mounted(fs);

    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toMatch(/not linked/i);
    expect(mod.deps).toHaveLength(0);
    expect(fs.mounts).toHaveLength(0);
    expect(fs.kind("/save")).toBe("dir");
    for (const f of SCORE_FILES) expect(fs.kind(`/${f}`)).toBe("file");
    await expect(handle.flush()).resolves.toBeUndefined();
  });

  it("falls back when mounting throws", async () => {
    const fs = new FakeFS();
    fs.mount = () => { throw new Error("SecurityError: IndexedDB is blocked"); };
    const { handle } = await mounted(fs);

    expect(handle.persistent).toBe(false);
    expect(fs.kind("/save")).toBe("dir");
  });

  // --- vect-hack-nvx: bones live at the root under dynamic names ("bonD0.5"),
  // so there is nothing to symlink — they are copied onto the volume at flush
  // and back to the root at mount.
  it("copies stored bones back to the root at mount, where open_bonesfile looks for them", async () => {
    const fs = new FakeFS();
    fs.onPopulate = () => {
      fs.mkdir(`${PERSIST_ROOT}/${BONES_DIR}`);
      fs.writeFile(`${PERSIST_ROOT}/${BONES_DIR}/bonD0.5`, "ghost of player");
    };
    const { handle } = await mounted(fs);
    expect(handle.persistent).toBe(true);
    expect(fs.text("/bonD0.5")).toBe("ghost of player");
  });

  it("flush() mirrors bones the engine committed at the root onto the volume", async () => {
    const { mod, handle } = await mounted();
    // As commit_bonesfile() would leave them: a finished bones file, plus the
    // temp name ("<lock>.bn") and a level file that must both stay behind.
    mod.FS.writeFile("/bonD0.5", "ghost of player");
    mod.FS.writeFile("/0player.bn", "half-written bones");
    mod.FS.writeFile("/0player.1", "level one");
    await handle.flush();
    const dir = `${PERSIST_ROOT}/${BONES_DIR}`;
    expect(mod.FS.text(`${dir}/bonD0.5`)).toBe("ghost of player");
    expect(mod.FS.kind(`${dir}/0player.bn`)).toBeUndefined();
    expect(mod.FS.kind(`${dir}/0player.1`)).toBeUndefined();
    expect(mod.FS.syncs.at(-1)).toBe(false); // and the volume went out after
  });

  it("flush() drops bones a later game consumed, so the ghost is met once", async () => {
    const fs = new FakeFS();
    fs.onPopulate = () => {
      fs.mkdir(`${PERSIST_ROOT}/${BONES_DIR}`);
      fs.writeFile(`${PERSIST_ROOT}/${BONES_DIR}/bonD0.5`, "ghost of player");
    };
    const { mod, handle } = await mounted(fs);
    mod.FS.unlink("/bonD0.5"); // as getbones()'s delete_bonesfile would
    await handle.flush();
    expect(mod.FS.kind(`${PERSIST_ROOT}/${BONES_DIR}/bonD0.5`)).toBeUndefined();
  });

  it("never touches the bones mirror from a tab that does not own the volume", async () => {
    const { mod, handle } = await mounted(new FakeFS(), fakeLocks(false));
    mod.FS.writeFile("/bonD0.5", "ghost of player");
    await handle.flush();
    expect(mod.FS.kind(`${PERSIST_ROOT}/${BONES_DIR}/bonD0.5`)).toBeUndefined();
  });
});

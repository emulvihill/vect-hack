import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  clearDanglingLink,
  mountVolume,
  type LockManagerLike,
  type PersistFS,
  type PersistModule,
} from "../../src/backplane/persistFs";
import {
  readPendingImport, readPendingReset, stashPendingImport, stashPendingReset,
} from "../../src/backplane/pendingImport";
import { packSave, unpackSave, type SaveFS } from "../../src/backplane/saveBlob";
import { VOLUMES } from "../../src/backplane/volumes";

class FakeFS implements PersistFS {
  filesystems: Record<string, unknown> = { IDBFS: { id: "IDBFS" } };
  paths = new Set(["/"]);
  mounts: Array<{ type: unknown; opts: Record<string, unknown>; mountpoint: string }> = [];
  links = new Map<string, string>();
  syncs: boolean[] = [];
  syncError: unknown = null;
  syncHangs = false;
  unmounts: string[] = [];
  mountState: { idbPersistState: unknown } = { idbPersistState: 0 };

  mkdir(path: string) {
    if (this.paths.has(path)) throw new Error(`EEXIST: ${path}`);
    this.paths.add(path);
  }
  mount(type: unknown, opts: Record<string, unknown>, mountpoint: string) {
    this.mounts.push({ type, opts, mountpoint });
  }
  unmount(mountpoint: string) { this.unmounts.push(mountpoint); }
  lookupPath() { return { node: { mount: this.mountState } }; }
  symlink(oldpath: string, newpath: string) {
    this.links.set(newpath, oldpath);
  }
  syncfs(populate: boolean, callback: (err?: unknown) => void) {
    this.syncs.push(populate);
    if (!this.syncHangs) queueMicrotask(() => callback(this.syncError));
  }
}

class FakeModule implements PersistModule {
  FS: FakeFS;
  dependencies: string[] = [];

  constructor(fs = new FakeFS()) { this.FS = fs; }
  addRunDependency(id: string) { this.dependencies.push(id); }
  removeRunDependency(id: string) {
    this.dependencies.splice(this.dependencies.indexOf(id), 1);
  }
}

interface FakeLocks extends LockManagerLike {
  asked: string[];
  released: Promise<void> | null;
}

function fakeLocks(free: boolean): FakeLocks {
  const locks: FakeLocks = {
    asked: [],
    released: null,
    request(name, options, callback) {
      locks.asked.push(name);
      expect(options).toEqual({ mode: "exclusive", ifAvailable: true });
      const result = callback(free ? { name } : null);
      locks.released = result instanceof Promise ? result.then(() => undefined) : null;
      return Promise.resolve(result);
    },
  };
  return locks;
}

function seedEnginePaths(FS: PersistFS, root: string | null) {
  const prefix = root ? `${root}/` : "/";
  FS.mkdir(`${prefix}save`);
  FS.mkdir(`${prefix}scores`);
  if (root) {
    FS.symlink(`${prefix}save`, "/lib/save");
    FS.symlink(`${prefix}scores`, "/lib/scores");
  }
}

afterEach(() => vi.useRealTimers());

describe("clearDanglingLink", () => {
  /** A node's value is its link target, or null for a real directory. */
  function linkFS(nodes: Map<string, string | null>) {
    return {
      nodes,
      analyzePath(path: string, dontResolveLastLink?: boolean) {
        const target = nodes.get(path);
        if (target === undefined) return { exists: false };
        return { exists: dontResolveLastLink || target === null || nodes.has(target) };
      },
      unlink(path: string) { nodes.delete(path); },
    };
  }

  it("removes only a link whose target is gone", () => {
    const fs = linkFS(new Map([
      ["/lib/save", "/vect-angband/save"],    // the volume was unmounted under it
      ["/lib/user", "/vect-angband/user"],    // still mounted: unmount is optional
      ["/vect-angband/user", null],
      ["/lib/scores", null],                  // a preload directory, not ours to take
    ]));
    for (const path of ["/lib/save", "/lib/user", "/lib/scores", "/lib/panic"])
      clearDanglingLink(fs, path);

    expect(fs.nodes.has("/lib/save")).toBe(false);
    expect(fs.nodes.get("/lib/user")).toBe("/vect-angband/user");
    expect(fs.nodes.get("/lib/scores")).toBeNull();
  });
});

describe("mountVolume", () => {
  it("elects the volume writer, populates IDBFS, and seeds the mounted paths", async () => {
    const mod = new FakeModule();
    const locks = fakeLocks(true);
    const handle = mountVolume(mod, VOLUMES.angband, { locks, seed: seedEnginePaths });

    expect(mod.dependencies).toEqual(["angband-idbfs"]);
    await expect(handle.ready).resolves.toBe(true);
    expect(handle.persistent).toBe(true);
    expect(handle.reason).toBeNull();
    expect(locks.asked).toEqual([VOLUMES.angband.lock]);
    expect(mod.FS.mounts).toEqual([{
      type: mod.FS.filesystems.IDBFS,
      opts: { autoPersist: true },
      mountpoint: VOLUMES.angband.mountpoint,
    }]);
    expect(mod.FS.syncs).toEqual([true]);
    expect(mod.FS.paths).toContain(`${VOLUMES.angband.mountpoint}/save`);
    expect(mod.dependencies).toEqual([]);
  });

  it("runs session-only after losing election and still seeds writable engine paths", async () => {
    const mod = new FakeModule();
    const handle = mountVolume(mod, VOLUMES.angband, {
      locks: fakeLocks(false), seed: seedEnginePaths,
    });

    await expect(handle.ready).resolves.toBe(false);
    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toBe("another tab is already playing; only it can save");
    // The code is what the page is shown, and it is a different sentence from
    // the other two classes: close the other tab (vect-hack-dem).
    expect(handle.reason?.code).toBe("another-tab");
    expect(mod.FS.paths).toContain("/save");
    expect(mod.FS.mounts).toEqual([]);
    expect(mod.FS.syncs).toEqual([]);
    await handle.flush();
    expect(mod.FS.syncs).toEqual([]);
  });

  it("times out a blocked populate, reports IndexedDB unavailable, and releases boot", async () => {
    vi.useFakeTimers();
    const fs = new FakeFS();
    fs.syncHangs = true;
    const mod = new FakeModule(fs);
    const locks = fakeLocks(true);
    const handle = mountVolume(mod, VOLUMES.angband, {
      locks, seed: seedEnginePaths,
    });

    await vi.advanceTimersByTimeAsync(10_001);
    await expect(handle.ready).resolves.toBe(false);
    expect(handle.reason?.detail).toMatch(/^IndexedDB is unavailable: Error: syncfs\(populate=true\)/);
    expect(handle.reason?.code).toBe("browser-cannot");
    expect(mod.dependencies).toEqual([]);
    expect(fs.paths).toContain("/save");
    expect(fs.paths).not.toContain(`${VOLUMES.angband.mountpoint}/save`);
    expect(fs.unmounts).toEqual([VOLUMES.angband.mountpoint]);
    await expect(locks.released).resolves.toBeUndefined();
  });

  it("reports a failed populate, seeds mounted paths, and skips onPopulated", async () => {
    const fs = new FakeFS();
    fs.syncError = new Error("SecurityError");
    const onPopulated = vi.fn();
    const mod = new FakeModule(fs);
    const locks = fakeLocks(true);
    const handle = mountVolume(mod, VOLUMES.angband, {
      locks, seed: seedEnginePaths, onPopulated,
    });

    await expect(handle.ready).resolves.toBe(false);
    expect(handle.reason?.detail).toBe("IndexedDB is unavailable: Error: SecurityError");
    expect(handle.reason?.code).toBe("browser-cannot");
    expect(fs.paths).toContain("/save");
    expect(fs.paths).not.toContain(`${VOLUMES.angband.mountpoint}/save`);
    expect(fs.unmounts).toEqual([VOLUMES.angband.mountpoint]);
    expect(onPopulated).not.toHaveBeenCalled();
    expect(mod.dependencies).toEqual([]);
    await expect(locks.released).resolves.toBeUndefined();
  });

  it("calls onPopulated only after populate succeeds", async () => {
    const fs = new FakeFS();
    const onPopulated = vi.fn(() => expect(fs.syncs).toEqual([true]));
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks: fakeLocks(true), seed: seedEnginePaths, onPopulated,
    });

    await handle.ready;
    expect(onPopulated).toHaveBeenCalledOnce();
  });

  it("does not expose ready while populate-triggered auto-persist is reconciling", async () => {
    vi.useFakeTimers();
    const fs = new FakeFS();
    fs.syncfs = (populate, callback) => {
      fs.syncs.push(populate);
      if (populate) fs.mountState.idbPersistState = "idb";
      queueMicrotask(() => callback());
    };
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks: fakeLocks(true), seed: seedEnginePaths,
    });
    let ready = false;
    void handle.ready.then(() => { ready = true; });

    await vi.advanceTimersByTimeAsync(10);
    expect(ready).toBe(false);
    expect(handle.persistent).toBe(false);
    fs.mountState.idbPersistState = 0;
    await vi.advanceTimersByTimeAsync(1);
    await expect(handle.ready).resolves.toBe(true);
    expect(handle.persistent).toBe(true);
  });

  it("runs beforeFlush immediately before an owner flush", async () => {
    const fs = new FakeFS();
    const beforeFlush = vi.fn(() => expect(fs.syncs).toEqual([true]));
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks: fakeLocks(true), seed: seedEnginePaths, beforeFlush,
    });
    await handle.ready;

    await handle.flush();
    expect(beforeFlush).toHaveBeenCalledOnce();
    expect(fs.syncs).toEqual([true, false]);
  });

  it("rejects owner flush when preparation throws", async () => {
    const sentinel = new Error("prepare failed");
    const fs = new FakeFS();
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks: fakeLocks(true), seed: seedEnginePaths,
      beforeFlush: () => { throw sentinel; },
    });
    await handle.ready;

    await expect(handle.flush()).rejects.toBe(sentinel);
    expect(fs.syncs).toEqual([true]);
  });

  it("rejects owner flush when syncfs reports or throws an error", async () => {
    const callbackFailure = new Error("callback failed");
    const callbackFS = new FakeFS();
    const callbackHandle = mountVolume(new FakeModule(callbackFS), VOLUMES.angband, {
      locks: fakeLocks(true), seed: seedEnginePaths,
    });
    await callbackHandle.ready;
    callbackFS.syncError = callbackFailure;
    await expect(callbackHandle.flush()).rejects.toBe(callbackFailure);

    const thrownFailure = new Error("sync threw");
    const thrownFS = new FakeFS();
    const thrownHandle = mountVolume(new FakeModule(thrownFS), VOLUMES.angband, {
      locks: fakeLocks(true), seed: seedEnginePaths,
    });
    await thrownHandle.ready;
    thrownFS.syncfs = () => { throw thrownFailure; };
    await expect(thrownHandle.flush()).rejects.toBe(thrownFailure);
  });

  it("rejects owner flush when syncfs never answers", async () => {
    vi.useFakeTimers();
    const fs = new FakeFS();
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks: fakeLocks(true), seed: seedEnginePaths,
    });
    await handle.ready;
    fs.syncHangs = true;

    const flushing = handle.flush();
    const rejection = expect(flushing).rejects.toThrow(/syncfs\(populate=false\).*10000ms/);
    await vi.advanceTimersByTimeAsync(10_001);
    await rejection;
  });

  it("drains an older auto-persist reconcile before the strict owner flush", async () => {
    vi.useFakeTimers();
    const fs = new FakeFS();
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks: fakeLocks(true), seed: seedEnginePaths,
    });
    await handle.ready;
    fs.mountState.idbPersistState = "idb";

    const flushing = handle.flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(fs.syncs).toEqual([true]);
    fs.mountState.idbPersistState = 0;
    await vi.advanceTimersByTimeAsync(1);
    await flushing;
    expect(fs.syncs).toEqual([true, false]);
  });

  it("rejects owner flush when an older auto-persist reconcile never settles", async () => {
    vi.useFakeTimers();
    const fs = new FakeFS();
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks: fakeLocks(true), seed: seedEnginePaths,
    });
    await handle.ready;
    fs.mountState.idbPersistState = "idb";

    const flushing = handle.flush();
    const rejection = expect(flushing).rejects.toThrow(/auto-persist.*did not settle.*10000ms/);
    await vi.advanceTimersByTimeAsync(10_001);
    await rejection;
    expect(fs.syncs).toEqual([true]);
  });

  it("runs session-only when Web Locks are unavailable", async () => {
    const fs = new FakeFS();
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks: null, seed: seedEnginePaths,
    });

    await expect(handle.ready).resolves.toBe(false);
    expect(handle.reason?.detail).toMatch(/Web Locks are unavailable/);
    expect(handle.reason?.code).toBe("browser-cannot");
    expect(fs.mounts).toEqual([]);
    expect(fs.syncs).toEqual([]);
    expect(fs.paths).toContain("/save");
  });

  it("seeds session paths exactly once when IDBFS is not linked", async () => {
    const fs = new FakeFS();
    delete fs.filesystems.IDBFS;
    const seed = vi.fn();
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks: fakeLocks(true), seed,
    });

    await expect(handle.ready).resolves.toBe(false);
    expect(handle.reason?.detail).toBe("IDBFS is not linked into this build");
    expect(handle.reason?.code).toBe("browser-cannot");
    expect(seed).toHaveBeenCalledOnce();
    expect(seed).toHaveBeenCalledWith(fs, null);
  });

  it("immediately releases a lock granted after election timed out", async () => {
    vi.useFakeTimers();
    let grant!: () => void;
    let lockReleased = false;
    const locks: LockManagerLike = {
      request(_name, _options, callback) {
        grant = () => {
          const held = callback({ name: "late" });
          if (held instanceof Promise) void held.then(() => { lockReleased = true; });
          else lockReleased = true;
        };
        return Promise.resolve();
      },
    };
    const fs = new FakeFS();
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks, seed: seedEnginePaths,
    });

    await vi.advanceTimersByTimeAsync(5_001);
    await expect(handle.ready).resolves.toBe(false);
    grant();
    await Promise.resolve();
    expect(lockReleased).toBe(true);
    expect(fs.mounts).toEqual([]);
  });

  it("never runs beforeFlush for a session-only handle", async () => {
    const beforeFlush = vi.fn();
    const handle = mountVolume(new FakeModule(), VOLUMES.angband, {
      locks: fakeLocks(false), seed: seedEnginePaths, beforeFlush,
    });
    await handle.ready;

    await handle.flush();
    expect(beforeFlush).not.toHaveBeenCalled();
  });

  it("explains an export with no volume and no declared session layout", async () => {
    // No sessionSave: this is the answer for a Module that has not said where
    // its save lives without a volume. Every Module in the tree declares one
    // (vect-hack-47a); what is pinned here is that the fallback stayed honest
    // rather than packing an empty blob.
    const handle = mountVolume(new FakeModule(), VOLUMES.angband, {
      locks: fakeLocks(false), seed: seedEnginePaths,
    });
    await handle.ready;

    // The message reaches the player through the save menu, so it carries no
    // reason: five of the seven reasons are exception text (vect-hack-dem).
    // The console has the detail and the banner has the sentence.
    expect(() => handle.exportSave(new Date())).toThrow(
      "there is nothing to export — this tab has no save volume");
  });

  it("prepares the volume before packing it, as a flush would", async () => {
    const beforeFlush = vi.fn();
    const handle = mountVolume(new FakeModule(), VOLUMES.angband, {
      locks: fakeLocks(true), seed: seedEnginePaths, beforeFlush,
    });
    await handle.ready;

    // FakeFS is the mount contract only — no readdir — so packing then fails
    // by that call's name; the preparation must already have happened.
    expect(() => handle.exportSave(new Date())).toThrow(/readdir/);
    // Whatever a Module stages on its way to IndexedDB — NetHack's bones —
    // belongs in the blob the player keeps too.
    expect(beforeFlush).toHaveBeenCalledOnce();
  });

  it("rejects export when volume preparation throws", async () => {
    const sentinel = new Error("export preparation failed");
    const handle = mountVolume(new FakeModule(), VOLUMES.angband, {
      locks: fakeLocks(true), seed: seedEnginePaths,
      beforeFlush: () => { throw sentinel; },
    });
    await handle.ready;

    expect(() => handle.exportSave(new Date())).toThrow(sentinel);
  });

  it("keeps a release that lands while the volume is still being set up", async () => {
    const fs = new FakeFS();
    let finishPopulate!: () => void;
    let reachedPopulate!: () => void;
    const populating = new Promise<void>((resolve) => { reachedPopulate = resolve; });
    fs.syncfs = (populate, callback) => {
      fs.syncs.push(populate);
      finishPopulate = () => callback();
      reachedPopulate();
    };
    const locks = fakeLocks(true);
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks, seed: seedEnginePaths,
    });
    await populating;

    handle.release();
    finishPopulate();

    await expect(handle.ready).resolves.toBe(false);
    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toBe("the save volume was handed to another tab");
    expect(handle.reason?.code).toBe("another-tab");
    await expect(locks.released).resolves.toBeUndefined();
    expect(fs.unmounts).toEqual([VOLUMES.angband.mountpoint]);
    expect(fs.paths).not.toContain(`${VOLUMES.angband.mountpoint}/save`);
    expect(fs.paths).toContain("/save");
    await handle.flush();
    expect(fs.syncs).toEqual([true]);
  });

  it("keeps a release that lands while auto-persist is still draining", async () => {
    vi.useFakeTimers();
    const fs = new FakeFS();
    fs.syncfs = (populate, callback) => {
      fs.syncs.push(populate);
      if (populate) fs.mountState.idbPersistState = "idb";
      queueMicrotask(() => callback());
    };
    const locks = fakeLocks(true);
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks, seed: seedEnginePaths,
    });

    await vi.advanceTimersByTimeAsync(10);
    handle.release();
    fs.mountState.idbPersistState = 0;
    await vi.advanceTimersByTimeAsync(1);

    await expect(handle.ready).resolves.toBe(false);
    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toBe("the save volume was handed to another tab");
    expect(handle.reason?.code).toBe("another-tab");
    await expect(locks.released).resolves.toBeUndefined();
    expect(fs.unmounts).toEqual([VOLUMES.angband.mountpoint]);
  });

  it("drops a lock granted after the volume was released", async () => {
    let grant!: () => void;
    let lockHeld = true;
    const locks: LockManagerLike = {
      request(_name, _options, callback) {
        grant = () => {
          const held = callback({ name: "late" });
          if (held instanceof Promise) void held.then(() => { lockHeld = false; });
          else lockHeld = false;
        };
        return Promise.resolve();
      },
    };
    const fs = new FakeFS();
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks, seed: seedEnginePaths,
    });

    handle.release();
    grant();
    // Handed straight back inside the callback, not held until the election
    // deadline: a tab that released cannot go on owning the volume meanwhile.
    expect(lockHeld).toBe(false);

    await expect(handle.ready).resolves.toBe(false);
    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toBe("the save volume was handed to another tab");
    expect(handle.reason?.code).toBe("another-tab");
    expect(fs.mounts).toEqual([]);
    expect(fs.syncs).toEqual([]);
    expect(fs.paths).toContain("/save");
  });

  it("release resolves the held lock and prevents later flushes", async () => {
    const fs = new FakeFS();
    const locks = fakeLocks(true);
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks, seed: seedEnginePaths,
    });
    await handle.ready;
    expect(locks.released).not.toBeNull();

    handle.release();
    await expect(locks.released).resolves.toBeUndefined();
    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toBe("the save volume was handed to another tab");
    expect(handle.reason?.code).toBe("another-tab");
    await handle.flush();
    expect(fs.syncs).toEqual([true]);
  });
});

// A volume with contents, not just the mount contract FakeFS covers: an
// import replaces what is in one, so these tests need files to destroy.
class VolumeFS extends FakeFS implements SaveFS {
  files = new Map<string, Uint8Array>();

  readdir(path: string) {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = new Set<string>();
    for (const key of [...this.files.keys(), ...this.paths]) {
      if (!key.startsWith(prefix) || key === path) continue;
      names.add(key.slice(prefix.length).split("/")[0]!);
    }
    return [".", "..", ...names];
  }
  stat(path: string) {
    const body = this.files.get(path);
    if (body) return { mode: 1, size: body.length };
    if (this.paths.has(path)) return { mode: 0, size: 0 };
    throw new Error(`ENOENT: ${path}`);
  }
  isDir(mode: number) { return mode === 0; }
  isFile(mode: number) { return mode === 1; }
  readFile(path: string, _opts: { encoding: "binary" }) {
    const body = this.files.get(path);
    if (!body) throw new Error(`ENOENT: ${path}`);
    return body;
  }
  writeFile(path: string, data: Uint8Array | string) {
    this.files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
  }
  mkdirTree(path: string) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) this.paths.add("/" + parts.slice(0, i).join("/"));
  }
  unlink(path: string) {
    if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
  }
  rmdir(path: string) {
    if (!this.paths.delete(path)) throw new Error(`ENOENT: ${path}`);
  }
  /** Every path the volume holds, for asserting what an import left behind. */
  contents(root: string) {
    return [...this.files.keys()].filter((p) => p.startsWith(`${root}/`)).sort();
  }
}

/** Seeds the way a Module's does: fills in what the volume does not already
 *  have, rather than truncating what an import just restored. */
function seedVolume(FS: PersistFS, root: string | null) {
  const fs = FS as VolumeFS;
  const prefix = root ?? "";
  fs.mkdirTree(`${prefix}/save`);
  if (!fs.files.has(`${prefix}/record`)) fs.writeFile(`${prefix}/record`, "");
}

/** One volume, packed exactly as an export packs it. */
function packed(volume: typeof VOLUMES.nethack, files: Record<string, string>): Uint8Array {
  const source = new VolumeFS();
  source.mkdirTree(volume.mountpoint);
  for (const [relative, body] of Object.entries(files)) {
    const path = `${volume.mountpoint}/${relative}`;
    source.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    source.writeFile(path, body);
  }
  return packSave(source, volume, new Date("2026-08-11T00:00:00Z"));
}

/**
 * Exporting a save that is not in a volume (vect-hack-47a).
 *
 * A session-only tab is playing a real character — the mount hands the engine
 * writable session paths and the engine writes a real save into them — and it
 * is the character most at risk, because nothing behind it reaches IndexedDB.
 * It used to be the only tab the export refused.
 *
 * Every test here populates BOTH roots, with different bytes in each. "Which
 * root did it pack" then has two real answers, and an export that packed
 * nothing cannot pass for either of them.
 */
describe("exporting without a volume", () => {
  /** What a Module declares: where its save is when there is no volume, in the
   *  names the volume would give it. Angband's real one is /lib and its four
   *  writable directories. */
  const SESSION_SAVE = { root: "/lib", names: ["save", "scores"] };
  const AT = new Date(2026, 7, 26, 9, 30);

  /** The preload tree as a session-only tab leaves it, packaged data and all. */
  function sessionTree() {
    const fs = new VolumeFS();
    fs.writeFile("/lib/gamedata", "the packaged embed, which is not a save");
    fs.mkdirTree("/lib/save");
    fs.mkdirTree("/lib/scores");
    fs.writeFile("/lib/save/hero", "session-hero");
    fs.writeFile("/lib/scores/high", "session-scores");
    return fs;
  }

  /** A seed that fills the volume too, so the volume arm has bytes of its own.
   *  Fills in what is missing rather than truncating, exactly as a Module's
   *  does — the seed runs after an import, and one that overwrote would undo
   *  the load it was meant to complete. */
  function seedBothRoots(FS: PersistFS, root: string | null) {
    if (root === null) return;
    const fs = FS as VolumeFS;
    fs.mkdirTree(`${root}/save`);
    fs.mkdirTree(`${root}/scores`);
    if (!fs.files.has(`${root}/save/hero`)) fs.writeFile(`${root}/save/hero`, "volume-hero");
    if (!fs.files.has(`${root}/scores/high`)) fs.writeFile(`${root}/scores/high`, "volume-scores");
  }

  function body(bytes: Uint8Array, path: string): string | undefined {
    const file = unpackSave(bytes).files.find((f) => f.path === path);
    return file && new TextDecoder().decode(file.bytes);
  }

  it("packs the session-only paths a Module declared, and only those", async () => {
    const fs = sessionTree();
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks: fakeLocks(false), seed: seedBothRoots, sessionSave: SESSION_SAVE,
    });
    await handle.ready;
    expect(handle.persistent).toBe(false);

    const exported = handle.exportSave(AT);
    expect(exported.filename).toBe("vecthack-angband-20260826-0930.vhsave");
    const contents = unpackSave(exported.bytes);
    // The volume's own relative names, which is the whole trick: a blob is
    // relative paths plus bytes, and a session-only seed puts the same names
    // somewhere else. And nothing but those names — /lib is an installed game,
    // not a volume, so packing all of it would call the embed a save.
    expect(contents.manifest.game).toBe("angband");
    expect(contents.manifest.files.map((f) => f.path)).toEqual(["save/hero", "scores/high"].sort());
    expect(body(exported.bytes, "save/hero")).toBe("session-hero");
  });

  it("keeps packing the volume after release, because the engine still writes there", async () => {
    // release() drops the lock without unmounting and without re-seeding, so
    // the symlink farm still points into the mount and the engine's next write
    // still lands there. Where the bytes are is not the same question as
    // whether they are ours to keep, and the export follows the bytes.
    const fs = sessionTree();
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks: fakeLocks(true), seed: seedBothRoots, sessionSave: SESSION_SAVE,
    });
    await handle.ready;
    expect(handle.persistent).toBe(true);

    handle.release();
    expect(handle.persistent).toBe(false);
    expect(body(handle.exportSave(AT).bytes, "save/hero")).toBe("volume-hero");
  });

  it("never stages into a volume it has given up or does not have", async () => {
    // beforeFlush is a WRITE. A released tab has handed the volume to another
    // one, and a session-only tab has no volume at all; an export must not be
    // the one call that reaches in.
    const beforeFlush = vi.fn();
    const released = mountVolume(new FakeModule(sessionTree()), VOLUMES.angband, {
      locks: fakeLocks(true), seed: seedBothRoots, sessionSave: SESSION_SAVE, beforeFlush,
    });
    await released.ready;
    beforeFlush.mockClear();
    released.release();
    released.exportSave(AT);
    expect(beforeFlush).not.toHaveBeenCalled();

    const sessionOnly = mountVolume(new FakeModule(sessionTree()), VOLUMES.angband, {
      locks: fakeLocks(false), seed: seedBothRoots, sessionSave: SESSION_SAVE, beforeFlush,
    });
    await sessionOnly.ready;
    sessionOnly.exportSave(AT);
    expect(beforeFlush).not.toHaveBeenCalled();
  });

  it("round-trips: a session-only blob parked by F4 loads into a fresh volume", async () => {
    // The player-facing path end to end, with no test writing a file by hand:
    // a tab that cannot save exports, the blob is parked in the transfer
    // store, and the next tab that DOES own the volume mounts it. A blob that
    // cannot make this trip is worse than no blob at all.
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    (globalThis as { postMessage?: unknown }).postMessage = () => {};
    try {
      const doomed = mountVolume(new FakeModule(sessionTree()), VOLUMES.angband, {
        locks: fakeLocks(false), seed: seedBothRoots, sessionSave: SESSION_SAVE,
      });
      await doomed.ready;
      const exported = doomed.exportSave(AT);

      await stashPendingImport(VOLUMES.angband.id, exported.bytes);
      const fresh = new VolumeFS();
      const owner = mountVolume(new FakeModule(fresh), VOLUMES.angband, {
        locks: fakeLocks(true), seed: seedBothRoots, sessionSave: SESSION_SAVE,
      });
      await owner.ready;
      expect(owner.persistent).toBe(true);

      const mountpoint = VOLUMES.angband.mountpoint;
      const text = (path: string) =>
        new TextDecoder().decode(fresh.readFile(`${mountpoint}/${path}`, { encoding: "binary" }));
      expect(text("save/hero")).toBe("session-hero");
      expect(text("scores/high")).toBe("session-scores");
      // And the volume is a volume, not a copy of /lib: the embed did not ride
      // in with the character.
      expect(fresh.contents(mountpoint)).toEqual(
        [`${mountpoint}/save/hero`, `${mountpoint}/scores/high`].sort());
    } finally {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
      delete (globalThis as { postMessage?: unknown }).postMessage;
    }
  });
});

describe("importing a volume at mount time", () => {
  const volume = VOLUMES.nethack;
  let notices: string[];
  /** The other thing a mount posts: the session-only code (vect-hack-dem).
   *  Kept apart from the notices, because it is a different channel with a
   *  different destination — the banner, not the message strip. */
  let sessionOnly: string[];

  beforeEach(() => {
    notices = [];
    sessionOnly = [];
    // The transfer store both halves of a load meet in, and the notice channel
    // the mount answers on: a worker's postMessage, with no window beside it.
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    (globalThis as { postMessage?: unknown }).postMessage =
      (msg: { type: string; text?: string; code?: string }) => {
        if (msg.type === "sessionOnly") sessionOnly.push(msg.code!);
        else notices.push(msg.text!);
      };
  });
  afterEach(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    delete (globalThis as { postMessage?: unknown }).postMessage;
  });

  /** A volume with a character already in it — the one an import buries. */
  function occupied() {
    const fs = new VolumeFS();
    // Only what IDBFS's populate would bring back: the mountpoint itself is
    // mkdir'd by the mount, and a fake that already has it fails that call.
    fs.paths.add(`${volume.mountpoint}/save`);
    fs.writeFile(`${volume.mountpoint}/save/1player`, "the character playing now");
    fs.writeFile(`${volume.mountpoint}/record`, "old scores");
    return fs;
  }

  it("replaces the volume with the parked blob, then stores and clears it", async () => {
    const fs = occupied();
    await stashPendingImport(volume.id, packed(volume, {
      "save/1imported": "the character from the file", "record": "imported scores",
    }));

    const handle = mountVolume(new FakeModule(fs), volume, {
      locks: fakeLocks(true), seed: seedVolume,
    });
    await expect(handle.ready).resolves.toBe(true);

    // Replaced, not merged: the character that was here is gone, rather than
    // sitting in the save directory beside the imported one.
    expect(fs.contents(volume.mountpoint)).toEqual([
      `${volume.mountpoint}/record`, `${volume.mountpoint}/save/1imported`,
    ]);
    expect(new TextDecoder().decode(fs.files.get(`${volume.mountpoint}/record`)))
      .toBe("imported scores");
    // The player was told it landed, so it is written back before boot goes on.
    expect(fs.syncs).toEqual([true, false]);
    expect(notices).toEqual(["Loaded the save file into your nethack game."]);
    expect(await readPendingImport(volume.id)).toBeNull();
  });

  it("keeps the existing character when the blob is another game's", async () => {
    const fs = occupied();
    await stashPendingImport(volume.id, packed(VOLUMES.angband, { "save/1angband": "x" }));

    const handle = mountVolume(new FakeModule(fs), volume, {
      locks: fakeLocks(true), seed: seedVolume,
    });
    await expect(handle.ready).resolves.toBe(true);

    expect(fs.contents(volume.mountpoint)).toEqual([
      `${volume.mountpoint}/record`, `${volume.mountpoint}/save/1player`,
    ]);
    expect(notices[0]).toMatch(/Could not load that nethack save file — .*angband save/);
    // Cleared even though it was refused: a blob this build will never accept
    // must not be retried on every reload for the rest of the volume's life.
    expect(await readPendingImport(volume.id)).toBeNull();
  });

  it("lets a Module's own gate refuse a blob before anything is removed", async () => {
    const fs = occupied();
    await stashPendingImport(volume.id, packed(volume, { "save/1imported": "x" }));

    const handle = mountVolume(new FakeModule(fs), volume, {
      locks: fakeLocks(true),
      seed: seedVolume,
      validateImport: () => { throw new Error("this is not a volume this build made"); },
    });
    await expect(handle.ready).resolves.toBe(true);

    expect(fs.contents(volume.mountpoint)).toContain(`${volume.mountpoint}/save/1player`);
    expect(notices[0]).toMatch(/this is not a volume this build made/);
  });

  it("leaves the blob parked for the tab that owns the volume", async () => {
    const fs = occupied();
    const bytes = packed(volume, { "save/1imported": "x" });
    await stashPendingImport(volume.id, bytes);

    const handle = mountVolume(new FakeModule(fs), volume, {
      locks: fakeLocks(false), seed: seedVolume,
    });
    await expect(handle.ready).resolves.toBe(false);

    // No reason spliced into the strip line any more: the reason is exception
    // text in five of the seven cases, and the banner the mount raises beside
    // it says the same thing in words a player can act on (vect-hack-dem).
    expect(notices).toEqual([
      "The save file you loaded is still waiting — this tab does not own the save volume.",
    ]);
    expect(sessionOnly).toEqual(["another-tab"]);
    expect(await readPendingImport(volume.id)).toEqual(bytes);
  });

  it("boots normally when nothing is parked", async () => {
    const fs = occupied();
    const handle = mountVolume(new FakeModule(fs), volume, {
      locks: fakeLocks(true), seed: seedVolume,
    });
    await expect(handle.ready).resolves.toBe(true);

    expect(fs.contents(volume.mountpoint)).toContain(`${volume.mountpoint}/save/1player`);
    expect(fs.syncs).toEqual([true]);
    expect(notices).toEqual([]);
  });
});

/**
 * The reset a page parked, applied by the next mount (vect-hack-60i).
 *
 * The escape hatch for a volume the engine cannot boot. It lands where an
 * import lands and for the same reason — the only moment a volume's contents
 * may be replaced wholesale — and the tests that matter are about what happens
 * when things go wrong, because the tab reaching for this already has one
 * thing going wrong.
 */
describe("applying a parked reset", () => {
  const volume = VOLUMES.nethack;
  let notices: string[];

  beforeEach(() => {
    notices = [];
    // The transfer store both halves meet in, and the notice channel the mount
    // answers on: a worker's postMessage, with no window beside it.
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    (globalThis as { postMessage?: unknown }).postMessage =
      (msg: { type: string; text?: string }) => {
        if (msg.type !== "sessionOnly") notices.push(msg.text!);
      };
  });
  afterEach(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    delete (globalThis as { postMessage?: unknown }).postMessage;
  });

  /** A volume with a character in it, as IDBFS populate would bring it back. */
  function occupiedVolume() {
    const fs = new VolumeFS();
    fs.paths.add(`${volume.mountpoint}/save`);
    fs.writeFile(`${volume.mountpoint}/save/1player`, "the character playing now");
    fs.writeFile(`${volume.mountpoint}/record`, "old scores");
    return fs;
  }

  it("empties the volume, then lets the seed rebuild it, and clears the flag", async () => {
    const fs = occupiedVolume();
    await stashPendingReset(volume.id);

    const handle = mountVolume(new FakeModule(fs), volume, {
      locks: fakeLocks(true), seed: seedVolume,
    });
    await expect(handle.ready).resolves.toBe(true);

    // The character is gone and the layout is back: what the engine boots into
    // is a volume as new as a first visit, which is the point.
    expect(fs.contents(volume.mountpoint)).not.toContain(`${volume.mountpoint}/save/1player`);
    expect(fs.contents(volume.mountpoint)).toContain(`${volume.mountpoint}/record`);
    expect(notices).toEqual(["Deleted your nethack save. This is a new game."]);
    // Cleared, or every reload for the rest of the volume's life empties it.
    expect(await readPendingReset(volume.id)).toBe(false);
    // Removals reach IndexedDB before the player can close the tab on them.
    expect(fs.syncs).toEqual([true, false]);
  });

  it("removes a volume no Module gate would accept, which is why it has none", async () => {
    // The volume this exists for: bytes that fatal the engine, and a Module
    // import gate that would refuse them right back. A reset asks no gate.
    const fs = occupiedVolume();
    fs.writeFile(`${volume.mountpoint}/save/1player`, "bytes that crash restore.c");
    await stashPendingReset(volume.id);

    const handle = mountVolume(new FakeModule(fs), volume, {
      locks: fakeLocks(true),
      seed: seedVolume,
      validateImport() { throw new Error("this volume is not one of mine"); },
    });
    await expect(handle.ready).resolves.toBe(true);

    expect(fs.contents(volume.mountpoint)).not.toContain(`${volume.mountpoint}/save/1player`);
  });

  it("leaves the reset parked for the tab that owns the volume", async () => {
    const fs = occupiedVolume();
    await stashPendingReset(volume.id);

    const handle = mountVolume(new FakeModule(fs), volume, {
      locks: fakeLocks(false), seed: seedVolume,
    });
    await expect(handle.ready).resolves.toBe(false);

    expect(notices).toEqual([
      "The save you deleted is still waiting — this tab does not own the save volume.",
    ]);
    expect(await readPendingReset(volume.id)).toBe(true);
  });

  it("boots normally when nothing is parked", async () => {
    const fs = occupiedVolume();
    const handle = mountVolume(new FakeModule(fs), volume, {
      locks: fakeLocks(true), seed: seedVolume,
    });
    await expect(handle.ready).resolves.toBe(true);

    expect(fs.contents(volume.mountpoint)).toContain(`${volume.mountpoint}/save/1player`);
    expect(notices).toEqual([]);
  });
});

/**
 * F3 refuses a save with nobody in it (vect-hack-70x).
 *
 * The failure this closes: a player presses F3 before the game's own save
 * command, files the download away, and reaches for it after a real game. F4
 * then empties a volume holding a character and writes an empty shelf over it.
 * The refusal lands at the moment the useless file would be created, and it
 * says what to do instead.
 *
 * Both roots are exercised, because both are places a character can be: the
 * mounted volume, and the session-only paths of a tab that never got one —
 * which is the tab most likely to press F3 first, since its banner is what
 * sends the player to the button.
 */
describe("refusing an export with no character in it", () => {
  const AT = new Date(2026, 7, 26, 9, 30);
  const SESSION_SAVE = { root: "/lib", names: ["save", "scores"] };

  /** A volume seeded exactly as a fresh NetHack one is: the four score files
   *  exist and are empty, and no save has been written. This is the case a
   *  count of files cannot see, and the reason the rule is about bytes. */
  function freshNethack() {
    const fs = new VolumeFS();
    // Only what IDBFS's populate would bring back: the mountpoint itself is
    // mkdir'd by the mount, and a fake that already has it fails that call.
    fs.paths.add("/vect-nethack/save");
    for (const name of ["record", "logfile", "xlogfile", "livelog"]) {
      fs.writeFile("/vect-nethack/" + name, "");
    }
    return fs;
  }

  it("refuses a volume holding only seeded score files, and names the way out", async () => {
    const fs = freshNethack();
    const handle = mountVolume(new FakeModule(fs), VOLUMES.nethack, {
      locks: fakeLocks(true), seed: () => {},
    });
    await handle.ready;

    expect(() => handle.exportSave(AT)).toThrow(/no saved character in your nethack game/);
    // The wording is why this refuses here rather than silently: it has to say
    // what the player should do instead of pressing F3 again.
    expect(() => handle.exportSave(AT)).toThrow(/game's own save command first/);
  });

  it("packs the same volume once the game has written a save", async () => {
    const fs = freshNethack();
    fs.writeFile("/vect-nethack/save/1player", "a real character");
    const handle = mountVolume(new FakeModule(fs), VOLUMES.nethack, {
      locks: fakeLocks(true), seed: () => {},
    });
    await handle.ready;

    const contents = unpackSave(handle.exportSave(AT).bytes);
    const paths = contents.manifest.files.map((f) => f.path);
    // The empty score files still travel: they are save data, and the question
    // was only ever whether anybody is in there.
    expect(paths).toContain("save/1player");
    expect(paths).toContain("record");
  });

  it("counts a checkpoint, which can be the only copy a crashed tab left", async () => {
    const fs = freshNethack();
    fs.paths.add("/vect-nethack/recover");
    fs.writeFile("/vect-nethack/recover/manifest.json", "{}");
    const handle = mountVolume(new FakeModule(fs), VOLUMES.nethack, {
      locks: fakeLocks(true), seed: () => {},
    });
    await handle.ready;

    expect(() => handle.exportSave(AT)).not.toThrow();
  });

  it("refuses a session-only tab whose engine has not written a save yet", async () => {
    // The tab vect-hack-47a gave the button to. It has no character either,
    // and the honest answer is the one a volume gets.
    const fs = new VolumeFS();
    fs.writeFile("/lib/gamedata", "the packaged embed, which is not a save");
    fs.mkdirTree("/lib/save");
    fs.mkdirTree("/lib/scores");
    fs.writeFile("/lib/scores/high", "scores, but nobody to have earned them");
    const handle = mountVolume(new FakeModule(fs), VOLUMES.angband, {
      locks: fakeLocks(false), seed: () => {}, sessionSave: SESSION_SAVE,
    });
    await handle.ready;
    expect(handle.persistent).toBe(false);

    expect(() => handle.exportSave(AT)).toThrow(/no saved character in your angband game/);

    // And packs it the moment that same tab's engine writes one.
    fs.writeFile("/lib/save/hero", "session-hero");
    expect(() => handle.exportSave(AT)).not.toThrow();
  });
});

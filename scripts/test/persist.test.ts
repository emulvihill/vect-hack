// Persistence wiring: which paths get mounted, linked and seeded, who is
// allowed to write, and what happens when IndexedDB misbehaves. The round trip
// through a real IDBFS is covered by scripts/test/test-nethack-persistence.mjs.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BONES_DIR, PERSIST_ROOT, SCORE_FILES, mountPersistentStorage,
  type LockManagerLike, type PersistFS, type PersistModule,
} from "../../src/modules/nethack/persist";

type Node = { kind: "dir" | "file" | "link"; data?: string; target?: string };

/** Just enough of the emscripten FS to exercise the persistence layer. */
class FakeFS implements PersistFS {
  filesystems: Record<string, unknown> = { MEMFS: { id: "MEMFS" }, IDBFS: { id: "IDBFS" } };
  nodes = new Map<string, Node>([["/", { kind: "dir" }]]);
  mounts: { type: unknown; opts: Record<string, unknown>; mountpoint: string }[] = [];
  syncs: boolean[] = [];

  /** Error handed to the next syncfs callback, if any. */
  syncError: unknown = null;
  /** Simulate IndexedDB blocking: the callback is never invoked. */
  syncHangs = false;
  /** Runs on populate, standing in for what syncfs would materialize. */
  onPopulate: (() => void) | null = null;

  mkdir(path: string) {
    if (this.nodes.has(path)) throw new Error(`EEXIST: ${path}`);
    this.nodes.set(path, { kind: "dir" });
  }
  mount(type: unknown, opts: Record<string, unknown>, mountpoint: string) {
    if (!this.nodes.has(mountpoint)) throw new Error(`ENOENT: ${mountpoint}`);
    this.mounts.push({ type, opts, mountpoint });
  }
  /** As the real one does: the mountpoint stays, everything under it goes. */
  unmount(mountpoint: string) {
    for (const path of this.nodes.keys())
      if (path.startsWith(`${mountpoint}/`)) this.nodes.delete(path);
  }
  symlink(oldpath: string, newpath: string) {
    if (this.nodes.has(newpath)) throw new Error(`EEXIST: ${newpath}`);
    this.nodes.set(newpath, { kind: "link", target: oldpath });
  }
  writeFile(path: string, data: Uint8Array | string) {
    // Stored as text so assertions read naturally; readFile re-encodes.
    this.nodes.set(path, {
      kind: "file", data: typeof data === "string" ? data : new TextDecoder().decode(data),
    });
  }
  readdir(path: string): string[] {
    const prefix = path === "/" ? "/" : `${path}/`;
    const names = new Set<string>();
    for (const key of this.nodes.keys()) {
      if (key === path || !key.startsWith(prefix)) continue;
      const [name] = key.slice(prefix.length).split("/");
      if (name) names.add(name);
    }
    return [".", "..", ...names];
  }
  readFile(path: string, opts?: { encoding?: "binary" | "utf8" }): Uint8Array | string {
    const node = this.nodes.get(path);
    if (!node || node.kind !== "file") throw new Error(`ENOENT: ${path}`);
    const data = node.data ?? "";
    return opts?.encoding === "binary" ? new TextEncoder().encode(data) : data;
  }
  unlink(path: string) {
    if (!this.nodes.has(path)) throw new Error(`ENOENT: ${path}`);
    this.nodes.delete(path);
  }
  stat(path: string): { size: number; mtime: Date } {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`ENOENT: ${path}`);
    return { size: node.data?.length ?? 0, mtime: new Date(0) };
  }
  analyzePath(path: string, dontResolveLastLink?: boolean) {
    const node = this.nodes.get(path);
    if (node?.kind === "link" && !dontResolveLastLink)
      return { exists: this.nodes.has(node.target!) };
    return { exists: node !== undefined };
  }
  syncfs(populate: boolean, callback: (err?: unknown) => void) {
    this.syncs.push(populate);
    if (this.syncHangs) return;
    if (populate) this.onPopulate?.();
    queueMicrotask(() => callback(this.syncError));
  }
}

class FakeModule implements PersistModule {
  FS: FakeFS;
  deps: string[] = [];
  constructor(fs = new FakeFS()) { this.FS = fs; }
  addRunDependency(id: string) { this.deps.push(id); }
  removeRunDependency(id: string) { this.deps.splice(this.deps.indexOf(id), 1); }
}

/** A Web Locks stand-in that either grants the lock or reports it taken. */
function fakeLocks(free: boolean): LockManagerLike & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    request(name, options, callback) {
      asked.push(name);
      expect(options).toEqual({ mode: "exclusive", ifAvailable: true });
      return Promise.resolve(callback(free ? { name } : null));
    },
  };
}

/** Boot with the lock granted unless told otherwise. */
async function mounted(fs = new FakeFS(), locks: LockManagerLike | null = fakeLocks(true)) {
  const mod = new FakeModule(fs);
  const handle = mountPersistentStorage(mod, { locks });
  await handle.ready;
  return { mod, handle, fs };
}

afterEach(() => vi.useRealTimers());

describe("mountPersistentStorage", () => {
  it("mounts one IDBFS volume with autoPersist so writes sync themselves", async () => {
    const { mod } = await mounted();
    expect(mod.FS.mounts).toEqual([{
      type: mod.FS.filesystems.IDBFS,
      opts: { autoPersist: true },
      mountpoint: PERSIST_ROOT,
    }]);
  });

  it("holds a run dependency until the volume is populated from IndexedDB", async () => {
    const mod = new FakeModule();
    const handle = mountPersistentStorage(mod, { locks: fakeLocks(true) });

    expect(mod.deps).toHaveLength(1);   // main() must not start yet
    await handle.ready;
    expect(mod.FS.syncs[0]).toBe(true); // populate, not push
    expect(mod.deps).toHaveLength(0);
  });

  it("links the paths NetHack opens relative to HACKDIR into the volume", async () => {
    const { mod, handle } = await mounted();
    expect(handle.persistent).toBe(true);
    expect(handle.reason).toBeNull();
    expect(mod.FS.nodes.get("/save")).toEqual({ kind: "link", target: `${PERSIST_ROOT}/save` });
    expect(mod.FS.nodes.get(`${PERSIST_ROOT}/save`)?.kind).toBe("dir");
    for (const f of SCORE_FILES)
      expect(mod.FS.nodes.get(`/${f}`)).toEqual({ kind: "link", target: `${PERSIST_ROOT}/${f}` });
  });

  it("leaves restored score files alone instead of seeding over them", async () => {
    const fs = new FakeFS();
    fs.onPopulate = () => {
      fs.nodes.set(`${PERSIST_ROOT}/save`, { kind: "dir" });
      fs.nodes.set(`${PERSIST_ROOT}/save/0player`, { kind: "file", data: "savedata" });
      fs.nodes.set(`${PERSIST_ROOT}/record`, { kind: "file", data: "top ten\n" });
    };
    await mounted(fs);

    expect(fs.nodes.get(`${PERSIST_ROOT}/record`)?.data).toBe("top ten\n");
    expect(fs.nodes.get(`${PERSIST_ROOT}/save/0player`)?.data).toBe("savedata");
    expect(fs.nodes.get(`${PERSIST_ROOT}/logfile`)?.data).toBe(""); // still seeded
  });

  it("flush() pushes MEMFS back to IndexedDB", async () => {
    const { mod, handle } = await mounted();
    mod.FS.syncs.length = 0;
    await handle.flush();
    expect(mod.FS.syncs).toEqual([false]);
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
    expect(mod.FS.nodes.get("/save")?.kind).toBe("dir"); // still playable
  });

  it("never runs the destructive reconcile when it does not own the volume", async () => {
    const { mod, handle } = await mounted(new FakeFS(), fakeLocks(false));
    await handle.flush();
    // syncfs(populate=false) deletes every IndexedDB entry the local MEMFS
    // lacks, so a non-owning tab must not issue one at all.
    expect(mod.FS.syncs).toHaveLength(0);
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
    expect(fs.nodes.get("/save")?.kind).toBe("dir"); // fell back to session-only
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
    expect(fs.nodes.get("/save")?.kind).toBe("dir");
    for (const f of SCORE_FILES) expect(fs.nodes.get(`/${f}`)?.kind).toBe("file");
  });

  it("gives up and boots when the populate sync never answers", async () => {
    vi.useFakeTimers();
    const fs = new FakeFS();
    fs.syncHangs = true;
    const mod = new FakeModule(fs);
    const handle = mountPersistentStorage(mod, { locks: fakeLocks(true) });

    await vi.advanceTimersByTimeAsync(11_000);
    await handle.ready;

    expect(mod.deps).toHaveLength(0);
    expect(handle.persistent).toBe(false);
    expect(fs.nodes.get("/save")?.kind).toBe("dir"); // safe session-only fallback
  });

  // --- vect-hack-aj6: flush must not hang the engine at game over
  it("flush() gives up rather than hanging when the sync never answers", async () => {
    vi.useFakeTimers();
    const { mod, handle } = await mounted();
    mod.FS.syncHangs = true;

    const flushed = handle.flush();
    const rejection = expect(flushed).rejects.toThrow(/syncfs\(populate=false\).*10000ms/);
    await vi.advanceTimersByTimeAsync(11_000);
    await rejection;
  });

  // --- vect-hack-649: the flag must not claim durability it doesn't have
  it("reports non-durable when IndexedDB rejects the populate", async () => {
    const fs = new FakeFS();
    fs.syncError = new Error("SecurityError: IndexedDB is blocked");
    const { handle, mod } = await mounted(fs);

    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toMatch(/IndexedDB is unavailable/i);
    expect(mod.deps).toHaveLength(0);
    expect(fs.nodes.get("/save")?.kind).toBe("dir"); // safe session-only fallback
  });

  it("falls back to session-only paths when IDBFS is not linked in", async () => {
    const fs = new FakeFS();
    delete fs.filesystems.IDBFS;
    const { handle, mod } = await mounted(fs);

    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toMatch(/not linked/i);
    expect(mod.deps).toHaveLength(0);
    expect(fs.mounts).toHaveLength(0);
    expect(fs.nodes.get("/save")?.kind).toBe("dir");
    for (const f of SCORE_FILES) expect(fs.nodes.get(`/${f}`)?.kind).toBe("file");
    await expect(handle.flush()).resolves.toBeUndefined();
  });

  it("falls back when mounting throws", async () => {
    const fs = new FakeFS();
    fs.mount = () => { throw new Error("SecurityError: IndexedDB is blocked"); };
    const { handle } = await mounted(fs);

    expect(handle.persistent).toBe(false);
    expect(fs.nodes.get("/save")?.kind).toBe("dir");
  });

  // --- vect-hack-nvx: bones live at the root under dynamic names ("bonD0.5"),
  // so there is nothing to symlink — they are copied onto the volume at flush
  // and back to the root at mount.
  it("copies stored bones back to the root at mount, where open_bonesfile looks for them", async () => {
    const fs = new FakeFS();
    fs.onPopulate = () => {
      fs.nodes.set(`${PERSIST_ROOT}/${BONES_DIR}`, { kind: "dir" });
      fs.nodes.set(`${PERSIST_ROOT}/${BONES_DIR}/bonD0.5`, { kind: "file", data: "ghost of player" });
    };
    const { handle } = await mounted(fs);
    expect(handle.persistent).toBe(true);
    expect(fs.nodes.get("/bonD0.5")?.data).toBe("ghost of player");
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
    expect(mod.FS.nodes.get(`${dir}/bonD0.5`)?.data).toBe("ghost of player");
    expect(mod.FS.nodes.get(`${dir}/0player.bn`)).toBeUndefined();
    expect(mod.FS.nodes.get(`${dir}/0player.1`)).toBeUndefined();
    expect(mod.FS.syncs.at(-1)).toBe(false); // and the volume went out after
  });

  it("flush() drops bones a later game consumed, so the ghost is met once", async () => {
    const fs = new FakeFS();
    fs.onPopulate = () => {
      fs.nodes.set(`${PERSIST_ROOT}/${BONES_DIR}`, { kind: "dir" });
      fs.nodes.set(`${PERSIST_ROOT}/${BONES_DIR}/bonD0.5`, { kind: "file", data: "ghost of player" });
    };
    const { mod, handle } = await mounted(fs);
    mod.FS.unlink("/bonD0.5"); // as getbones()'s delete_bonesfile would
    await handle.flush();
    expect(mod.FS.nodes.get(`${PERSIST_ROOT}/${BONES_DIR}/bonD0.5`)).toBeUndefined();
  });

  it("never touches the bones mirror from a tab that does not own the volume", async () => {
    const { mod, handle } = await mounted(new FakeFS(), fakeLocks(false));
    mod.FS.writeFile("/bonD0.5", "ghost of player");
    await handle.flush();
    expect(mod.FS.nodes.get(`${PERSIST_ROOT}/${BONES_DIR}/bonD0.5`)).toBeUndefined();
  });

  it("stays session-only where Web Locks do not exist", async () => {
    const { handle, mod } = await mounted(new FakeFS(), null);
    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toMatch(/Web Locks are unavailable/);
    expect(mod.FS.mounts).toHaveLength(0);
    expect(mod.FS.nodes.get("/save")?.kind).toBe("dir");
  });
});

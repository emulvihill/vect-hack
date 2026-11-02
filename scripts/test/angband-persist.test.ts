import { describe, expect, it } from "vitest";
import { mountAngbandStorage } from "../../src/modules/angband/persist";
import type {
  LockManagerLike, SeedFS, SeedModule,
} from "../../src/backplane/persistFs";
import { VOLUMES } from "../../src/backplane/volumes";

type Node = { kind: "dir" | "file" | "link"; target?: string; data?: string };

class FakeFS implements SeedFS {
  filesystems: Record<string, unknown> = { IDBFS: { id: "IDBFS" } };
  nodes = new Map<string, Node>([
    ["/", { kind: "dir" }],
    ["/lib", { kind: "dir" }],
  ]);
  mounts: Array<{ type: unknown; opts: Record<string, unknown>; mountpoint: string }> = [];
  syncs: boolean[] = [];

  mkdir(path: string) {
    if (this.nodes.has(path)) throw new Error(`EEXIST: ${path}`);
    this.nodes.set(path, { kind: "dir" });
  }
  mount(type: unknown, opts: Record<string, unknown>, mountpoint: string) {
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
  readlink(path: string) {
    const node = this.nodes.get(path);
    if (node?.kind !== "link") throw new Error(`EINVAL: ${path}`);
    return node.target!;
  }
  readdir(path: string) {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const candidate of this.nodes.keys()) {
      if (!candidate.startsWith(prefix)) continue;
      const [name] = candidate.slice(prefix.length).split("/");
      if (name) names.add(name);
    }
    return [".", "..", ...names];
  }
  rmdir(path: string) {
    if (this.readdir(path).length > 2) throw new Error(`ENOTEMPTY: ${path}`);
    this.nodes.delete(path);
  }
  unlink(path: string) {
    if (!this.nodes.has(path)) throw new Error(`ENOENT: ${path}`);
    this.nodes.delete(path);
  }
  analyzePath(path: string, dontResolveLastLink?: boolean) {
    const node = this.nodes.get(path);
    if (node?.kind === "link" && !dontResolveLastLink)
      return { exists: this.nodes.has(node.target!) };
    return { exists: node !== undefined };
  }
  syncfs(populate: boolean, callback: (err?: unknown) => void) {
    this.syncs.push(populate);
    queueMicrotask(callback);
  }
}

class FakeModule implements SeedModule {
  deps: string[] = [];
  constructor(readonly FS = new FakeFS()) {}
  addRunDependency(id: string) { this.deps.push(id); }
  removeRunDependency(id: string) { this.deps.splice(this.deps.indexOf(id), 1); }
}

function locks(free: boolean): LockManagerLike {
  return {
    request(_name, _options, callback) {
      return Promise.resolve(callback(free ? {} : null));
    },
  };
}

const LINKS = ["save", "scores", "user", "panic"] as const;

describe("mountAngbandStorage", () => {
  it("links every writable Angband directory into its persistent volume", async () => {
    const mod = new FakeModule();
    const handle = mountAngbandStorage(mod, { locks: locks(true) });
    await handle.ready;

    expect(handle.persistent).toBe(true);
    expect(mod.FS.mounts).toEqual([{
      type: mod.FS.filesystems.IDBFS,
      opts: { autoPersist: true },
      mountpoint: VOLUMES.angband.mountpoint,
    }]);
    for (const path of LINKS) {
      expect(mod.FS.readlink(`/lib/${path}`)).toBe(`/vect-angband/${path}`);
      expect(mod.FS.analyzePath(`/vect-angband/${path}`).exists).toBe(true);
    }
  });

  it("replaces only empty preload directories with links", async () => {
    const fs = new FakeFS();
    for (const path of LINKS) fs.mkdir(`/lib/${path}`);
    const handle = mountAngbandStorage(new FakeModule(fs), { locks: locks(true) });
    await handle.ready;

    expect(handle.persistent).toBe(true);
    for (const path of LINKS)
      expect(fs.readlink(`/lib/${path}`)).toBe(`/vect-angband/${path}`);
  });

  it("preserves a non-empty preload directory and falls back without deleting its data", async () => {
    const fs = new FakeFS();
    fs.mkdir("/lib/save");
    fs.nodes.set("/lib/save/preloaded", { kind: "file", data: "keep me" });
    const handle = mountAngbandStorage(new FakeModule(fs), { locks: locks(true) });
    await handle.ready;

    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toMatch(/setup failed/i);
    expect(fs.nodes.get("/lib/save/preloaded")?.data).toBe("keep me");
    expect(fs.nodes.get("/lib/save")?.kind).toBe("dir");
  });

  // --- vect-hack-52e: the volume is unmounted under whatever links this seed
  // had already installed, so the session-only retry finds a dangling farm.
  it("re-seeds over the farm when linking fails partway through it", async () => {
    const fs = new FakeFS();
    const link = fs.symlink.bind(fs);
    fs.symlink = (target, path) => {
      if (path === "/lib/panic") throw new Error("EIO: /lib/panic");
      link(target, path);
    };
    const handle = mountAngbandStorage(new FakeModule(fs), { locks: locks(true) });
    await handle.ready;

    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toMatch(/setup failed/i);
    for (const path of LINKS) expect(fs.nodes.get(`/lib/${path}`)?.kind).toBe("dir");
  });

  it("gives a losing lock owner writable session-only directories", async () => {
    const fs = new FakeFS();
    const handle = mountAngbandStorage(new FakeModule(fs), { locks: locks(false) });
    await handle.ready;

    expect(handle.persistent).toBe(false);
    expect(handle.reason?.detail).toMatch(/another tab/i);
    expect(fs.mounts).toEqual([]);
    for (const path of LINKS)
      expect(fs.nodes.get(`/lib/${path}`)?.kind).toBe("dir");
  });
});

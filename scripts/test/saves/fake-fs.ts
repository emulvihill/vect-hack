// One stand-in for the Emscripten FS, shared by every test of the save path:
// mounting a volume, seeding and linking it, packing and importing it. NOT a
// .test.ts file itself, so vitest does not collect it.
//
// Its semantics are Emscripten's own (emsdk src/lib/libfs.js), because the
// production code relies on them, and a fake that drifts from them lets a test
// pass against behaviour no browser has:
//
// - modes carry the S_IF* type bits, and isDir/isFile mask with S_IFMT;
// - stat, readdir, readFile, writeFile and analyzePath follow symlinks, every
//   component of the path included; lstat, readlink, unlink, rmdir and
//   symlink act on the last component itself;
// - mkdir and symlink need the parent and refuse an existing name; mkdirTree
//   creates what is missing and passes over what is there;
// - unmount destroys every node under the mountpoint and keeps the mountpoint;
// - rmdir refuses a non-empty directory and a mountpoint, unlink a directory.
import { expect } from "vitest";
import type { LockManagerLike } from "../../../src/backplane/persistFs";

export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;
export const S_IFCHR = 0o020000;

type Node = { mode: number; data?: Uint8Array; target?: string };

/** "/" + "/save" and a trailing slash are paths Emscripten normalizes. */
function normalize(path: string): string {
  return "/" + path.split("/").filter(Boolean).join("/");
}

function parentOf(path: string): string {
  return normalize(path.slice(0, path.lastIndexOf("/")));
}

export class FakeFS {
  filesystems: Record<string, unknown> = { MEMFS: { id: "MEMFS" }, IDBFS: { id: "IDBFS" } };
  readonly nodes = new Map<string, Node>([["/", { mode: S_IFDIR }]]);
  /** Every path ever created, in order. It outlives an unmount, which is how
   *  a test tells "never written into the volume" from "unmounted since". */
  readonly made: string[] = [];
  mounts: { type: unknown; opts: Record<string, unknown>; mountpoint: string }[] = [];
  unmounts: string[] = [];
  syncs: boolean[] = [];
  /** Handed to every syncfs callback. */
  syncError: unknown = null;
  /** IndexedDB blocking: syncfs never calls back. */
  syncHangs = false;
  /** Runs on populate, standing in for what syncfs would materialize. */
  onPopulate: (() => void) | null = null;
  /** The mount object lookupPath reports, where IDBFS keeps idbPersistState. */
  mountState: { idbPersistState: unknown } = { idbPersistState: 0 };
  readonly #mounted = new Set<string>();

  /** Starts with "/" and each of `dirs`, as a preload would leave them. */
  constructor(...dirs: string[]) {
    for (const dir of dirs) this.mkdirTree(dir);
  }

  /** The node a path names, through every link but (optionally) the last. */
  #resolve(path: string, followLast = true, hops = 0): string {
    if (hops > 16) throw new Error(`ELOOP: ${path}`);
    const parts = normalize(path).split("/").filter(Boolean);
    let at = "/";
    for (const [i, part] of parts.entries()) {
      const next = at === "/" ? `/${part}` : `${at}/${part}`;
      const node = this.nodes.get(next);
      const last = i === parts.length - 1;
      at = node?.target !== undefined && (!last || followLast)
        ? this.#resolve(node.target, true, hops + 1)
        : next;
    }
    return at;
  }

  /** Where a new name lands: its parent resolved, the name itself not. */
  #place(path: string): string {
    const full = normalize(path);
    const parent = this.#resolve(parentOf(full));
    const dir = this.nodes.get(parent);
    if (!dir) throw new Error(`ENOENT: ${path}`);
    if (!this.isDir(dir.mode)) throw new Error(`ENOTDIR: ${path}`);
    const name = full.slice(full.lastIndexOf("/") + 1);
    return parent === "/" ? `/${name}` : `${parent}/${name}`;
  }

  #create(path: string, node: Node): void {
    const at = this.#place(path);
    if (this.nodes.has(at)) throw new Error(`EEXIST: ${path}`);
    this.nodes.set(at, node);
    this.made.push(at);
  }

  #existing(path: string, followLast = true): { at: string; node: Node } {
    const at = this.#resolve(path, followLast);
    const node = this.nodes.get(at);
    if (!node) throw new Error(`ENOENT: ${path}`);
    return { at, node };
  }

  #children(dir: string): string[] {
    const prefix = dir === "/" ? "/" : `${dir}/`;
    const names = new Set<string>();
    for (const key of this.nodes.keys()) {
      if (key === dir || !key.startsWith(prefix)) continue;
      names.add(key.slice(prefix.length).split("/")[0]!);
    }
    return [...names];
  }

  isDir(mode: number) { return (mode & S_IFMT) === S_IFDIR; }
  isFile(mode: number) { return (mode & S_IFMT) === S_IFREG; }

  mkdir(path: string) { this.#create(path, { mode: S_IFDIR }); }
  mkdirTree(path: string) {
    let at = "";
    for (const part of normalize(path).split("/").filter(Boolean)) {
      at += `/${part}`;
      try {
        this.mkdir(at);
      } catch (err) {
        if (!String(err).includes("EEXIST")) throw err;
      }
    }
  }
  /** A character device, which is neither a file nor a directory. */
  mkdev(path: string) { this.#create(path, { mode: S_IFCHR }); }
  symlink(oldpath: string, newpath: string) {
    this.#create(newpath, { mode: S_IFLNK, target: oldpath });
  }
  readlink(path: string): string {
    const { node } = this.#existing(path, false);
    if (node.target === undefined) throw new Error(`EINVAL: ${path}`);
    return node.target;
  }

  mount(type: unknown, opts: Record<string, unknown>, mountpoint: string) {
    const { at, node } = this.#existing(mountpoint);
    if (!this.isDir(node.mode)) throw new Error(`ENOTDIR: ${mountpoint}`);
    this.#mounted.add(at);
    this.mounts.push({ type, opts, mountpoint });
  }
  unmount(mountpoint: string) {
    this.unmounts.push(mountpoint);
    const at = this.#resolve(mountpoint, false);
    if (!this.#mounted.delete(at)) throw new Error(`EINVAL: ${mountpoint}`);
    for (const key of this.nodes.keys()) if (key.startsWith(`${at}/`)) this.nodes.delete(key);
  }
  lookupPath(_path: string) { return { node: { mount: this.mountState } }; }

  readdir(path: string): string[] {
    const { at, node } = this.#existing(path);
    if (!this.isDir(node.mode)) throw new Error(`ENOTDIR: ${path}`);
    return [".", "..", ...this.#children(at)];
  }
  rmdir(path: string) {
    const { at, node } = this.#existing(path, false);
    if (!this.isDir(node.mode)) throw new Error(`ENOTDIR: ${path}`);
    if (this.#mounted.has(at)) throw new Error(`EBUSY: ${path}`);
    if (this.#children(at).length) throw new Error(`ENOTEMPTY: ${path}`);
    this.nodes.delete(at);
  }
  unlink(path: string) {
    const { at, node } = this.#existing(path, false);
    if (this.isDir(node.mode)) throw new Error(`EISDIR: ${path}`);
    this.nodes.delete(at);
  }

  analyzePath(path: string, dontResolveLastLink?: boolean) {
    return { exists: this.nodes.has(this.#resolve(path, !dontResolveLastLink)) };
  }
  stat(path: string) {
    const { node } = this.#existing(path);
    return { mode: node.mode, size: node.data?.length ?? 0, mtime: new Date(0) };
  }
  lstat(path: string) {
    const { node } = this.#existing(path, false);
    return { mode: node.mode, size: node.data?.length ?? 0, mtime: new Date(0) };
  }

  readFile(path: string, opts: { encoding: "utf8" }): string;
  readFile(path: string, opts?: { encoding?: "binary" }): Uint8Array;
  readFile(path: string, opts?: { encoding?: "binary" | "utf8" }): Uint8Array | string;
  readFile(path: string, opts?: { encoding?: "binary" | "utf8" }): Uint8Array | string {
    const { node } = this.#existing(path);
    if (!this.isFile(node.mode)) throw new Error(`EISDIR: ${path}`);
    return opts?.encoding === "utf8" ? new TextDecoder().decode(node.data) : node.data!;
  }
  writeFile(path: string, data: Uint8Array | string) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data.slice();
    const at = this.#resolve(path);
    const node = this.nodes.get(at);
    if (node && !this.isFile(node.mode)) throw new Error(`EISDIR: ${path}`);
    if (node) node.data = bytes;
    else this.#create(at, { mode: S_IFREG, data: bytes });
  }

  syncfs(populate: boolean, callback: (err?: unknown) => void) {
    this.syncs.push(populate);
    if (this.syncHangs) return;
    if (populate) this.onPopulate?.();
    queueMicrotask(() => callback(this.syncError));
  }

  // --- for assertions: none of these is an Emscripten call ---

  /** What sits at `path` itself, without following it: the shape a seed left. */
  kind(path: string): "dir" | "file" | "link" | "device" | undefined {
    const node = this.nodes.get(this.#resolve(path, false));
    if (!node) return undefined;
    if (node.target !== undefined) return "link";
    return this.isDir(node.mode) ? "dir" : this.isFile(node.mode) ? "file" : "device";
  }
  /** A file's contents as text, or undefined when there is no such file. */
  text(path: string): string | undefined {
    const node = this.nodes.get(this.#resolve(path));
    return node && this.isFile(node.mode) ? new TextDecoder().decode(node.data) : undefined;
  }
  /** Every regular file under `root`, sorted: what an import left behind. */
  files(root: string): string[] {
    const prefix = `${normalize(root)}/`;
    return [...this.nodes].filter(([path, node]) => path.startsWith(prefix) && this.isFile(node.mode))
      .map(([path]) => path).sort();
  }
}

export class FakeModule {
  deps: string[] = [];
  FS: FakeFS;
  constructor(fs = new FakeFS()) { this.FS = fs; }
  addRunDependency(id: string) { this.deps.push(id); }
  removeRunDependency(id: string) { this.deps.splice(this.deps.indexOf(id), 1); }
}

export interface FakeLocks extends LockManagerLike {
  /** Every lock name asked for, in order. */
  asked: string[];
  /** Settles when the holder lets the lock go; null until one is granted. */
  released: Promise<void> | null;
}

/** A Web Locks stand-in that either grants the lock or reports it taken. */
export function fakeLocks(free: boolean): FakeLocks {
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

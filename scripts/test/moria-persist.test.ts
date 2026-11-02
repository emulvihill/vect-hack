import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { LockManagerLike } from "../../src/backplane/persistFs";
import {
  MORIA_RUNTIME_FILES,
  mountMoriaStorage,
  type MoriaPersistFS,
  type MoriaPersistModule,
} from "../../src/modules/moria/persist";
import { VOLUMES } from "../../src/backplane/volumes";
import {
  MORIA_CHECKPOINT_SOURCE_SHA,
  MORIA_CHECKPOINT_PAYLOAD_BYTES,
  MORIA_CHECKPOINT_TRAILER_BYTES,
  MORIA_CHECKPOINT_TRAILER_MAGIC,
  fnv1a32Hex,
} from "../../src/modules/moria/recovery";

const DIR = 0o040000, FILE = 0o100000;

class FakeFS implements MoriaPersistFS {
  filesystems: Record<string, unknown> = { IDBFS: {} };
  nodes = new Map<string, { mode: number; bytes?: Uint8Array }>([["/", { mode: DIR }]]);
  cwd = "/";
  mounted: string[] = [];
  unmounted: string[] = [];
  syncs: boolean[] = [];
  writes: string[] = [];
  populate: (() => void) | null = null;

  constructor() {
    this.mkdirTree("/moria-seed/data");
    for (const [i, path] of MORIA_RUNTIME_FILES.entries())
      this.writeFile(`/moria-seed/${path}`, new Uint8Array([i + 1]));
  }

  analyzePath(path: string) { return { exists: this.nodes.has(path) }; }
  mkdir(path: string) {
    if (this.nodes.has(path)) throw new Error(`EEXIST: ${path}`);
    this.nodes.set(path, { mode: DIR });
  }
  mkdirTree(path: string) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const part = parts.slice(0, i).join("/") || "/";
      if (!this.nodes.has(part)) this.nodes.set(part, { mode: DIR });
    }
  }
  mount(_type: unknown, _opts: Record<string, unknown>, mountpoint: string) {
    this.mounted.push(mountpoint);
  }
  unmount(mountpoint: string) { this.unmounted.push(mountpoint); }
  symlink() { throw new Error("Moria uses no symlinks"); }
  syncfs(populate: boolean, callback: (err?: unknown) => void) {
    this.syncs.push(populate);
    if (populate) this.populate?.();
    queueMicrotask(callback);
  }
  chdir(path: string) {
    if (!this.nodes.has(path)) throw new Error(`ENOENT: ${path}`);
    this.cwd = path;
  }
  readFile(path: string): Uint8Array {
    const node = this.nodes.get(path);
    if (!node?.bytes) throw new Error(`not a file: ${path}`);
    return node.bytes;
  }
  writeFile(path: string, bytes: Uint8Array) {
    const slash = path.lastIndexOf("/");
    if (slash > 0) this.mkdirTree(path.slice(0, slash));
    this.nodes.set(path, { mode: FILE, bytes: Uint8Array.from(bytes) });
    this.writes.push(path);
  }
  readdir(path: string): string[] {
    const prefix = `${path}/`, out = new Set([".", ".."]) as Set<string>;
    for (const key of this.nodes.keys()) if (key.startsWith(prefix)) {
      const rest = key.slice(prefix.length);
      if (rest) out.add(rest.split("/")[0]!);
    }
    return [...out];
  }
  stat(path: string) {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`ENOENT: ${path}`);
    return { mode: node.mode, size: node.bytes?.byteLength ?? 0 };
  }
  isFile(mode: number) { return (mode & 0o170000) === FILE; }
  rename(from: string, to: string) {
    const node = this.nodes.get(from);
    if (!node) throw new Error(`ENOENT: ${from}`);
    this.nodes.set(to, node);
    this.nodes.delete(from);
  }
  unlink(path: string) {
    if (!this.nodes.delete(path)) throw new Error(`ENOENT: ${path}`);
  }
}

function checkpoint(): Uint8Array {
  const stock = new Uint8Array([5, 7, 15, 42]);
  const payload = new Uint8Array(MORIA_CHECKPOINT_PAYLOAD_BYTES);
  const payloadView = new DataView(payload.buffer);
  payloadView.setUint32(0, 1, true);
  payloadView.setInt32(22, 21, true);
  payloadView.setInt32(30, 65, true);
  payloadView.setInt32(34, -13, true);
  payloadView.setInt32(38, -1, true);
  payloadView.setInt16(63, 2, true);
  const footer = new Uint8Array(MORIA_CHECKPOINT_TRAILER_BYTES);
  footer.set(new TextEncoder().encode(MORIA_CHECKPOINT_TRAILER_MAGIC));
  const view = new DataView(footer.buffer);
  view.setUint32(8, 1, true);
  footer.set(Buffer.from(MORIA_CHECKPOINT_SOURCE_SHA, "hex"), 12);
  view.setUint32(32, payload.byteLength, true);
  view.setUint32(36, Number.parseInt(fnv1a32Hex(payload), 16), true);
  const out = new Uint8Array(stock.byteLength + payload.byteLength + footer.byteLength);
  out.set(stock); out.set(payload, stock.byteLength); out.set(footer, stock.byteLength + payload.byteLength);
  return out;
}

class FakeModule implements MoriaPersistModule {
  dependencies: string[] = [];
  constructor(readonly FS = new FakeFS()) {}
  addRunDependency(id: string) { this.dependencies.push(id); }
  removeRunDependency(id: string) {
    this.dependencies.splice(this.dependencies.indexOf(id), 1);
  }
}

function locks(free: boolean): LockManagerLike {
  return {
    request(_name, _options, callback) {
      const answer = callback(free ? {} : null);
      return Promise.resolve(answer);
    },
  };
}

describe("Moria persistence policy", () => {
  it("lets preRun's selected cwd win and falls back only when runtime files are absent", () => {
    const source = readFileSync(new URL("../../src/modules/moria/native/main-wasm.cpp", import.meta.url), "utf8");
    expect(source).toMatch(/access\(config::files::scores\.c_str\(\), F_OK\) != 0/);
    expect(source).toMatch(/access[\s\S]*?chdir\("\/moria-seed"\)/);
    expect(source).not.toMatch(/moria_start[^]*?\{\s*\/\/[^]*?if \(chdir\("\/moria-seed"\)/);
  });

  it("copies the exact packaged seed into the writer volume and selects it as cwd", async () => {
    const mod = new FakeModule();
    const handle = mountMoriaStorage(mod, { locks: locks(true) });

    await expect(handle.ready).resolves.toBe(true);
    expect(mod.FS.cwd).toBe(VOLUMES.moria.mountpoint);
    expect(mod.FS.mounted).toEqual([VOLUMES.moria.mountpoint]);
    for (const [i, path] of MORIA_RUNTIME_FILES.entries())
      expect(mod.FS.readFile(`${VOLUMES.moria.mountpoint}/${path}`)).toEqual(new Uint8Array([i + 1]));
    expect(mod.dependencies).toEqual([]);
    handle.release();
  });

  it("preserves every existing mutable or user-created volume file", async () => {
    const mod = new FakeModule();
    mod.FS.mkdirTree(VOLUMES.moria.mountpoint);
    mod.FS.writeFile(`${VOLUMES.moria.mountpoint}/scores.dat`, new Uint8Array([9, 9]));
    mod.FS.writeFile(`${VOLUMES.moria.mountpoint}/game.sav`, new Uint8Array([8, 8]));
    mod.FS.writeFile(`${VOLUMES.moria.mountpoint}/player-note`, new Uint8Array([7]));
    const handle = mountMoriaStorage(mod, { locks: locks(true) });

    await handle.ready;
    expect(mod.FS.readFile(`${VOLUMES.moria.mountpoint}/scores.dat`)).toEqual(new Uint8Array([9, 9]));
    expect(mod.FS.readFile(`${VOLUMES.moria.mountpoint}/game.sav`)).toEqual(new Uint8Array([8, 8]));
    expect(mod.FS.readFile(`${VOLUMES.moria.mountpoint}/player-note`)).toEqual(new Uint8Array([7]));
    handle.release();
  });

  it("keeps a losing or lockless tab on the packaged session-only cwd", async () => {
    for (const unavailable of [locks(false), null]) {
      const mod = new FakeModule();
      const handle = mountMoriaStorage(mod, { locks: unavailable });
      await expect(handle.ready).resolves.toBe(false);
      expect(handle.persistent).toBe(false);
      expect(mod.FS.cwd).toBe("/moria-seed");
      expect(mod.FS.mounted).toEqual([]);
      expect(mod.FS.analyzePath(VOLUMES.moria.mountpoint).exists).toBe(false);
      const writes = mod.FS.writes.length;
      expect(handle.checkpointRecoveryPath).toBe("");
      expect(() => handle.publishCheckpoint()).toThrow(/does not own/);
      await handle.flush();
      expect(mod.FS.writes).toHaveLength(writes);
      expect(mod.FS.syncs).toEqual([]);
    }
  });

  it("selects populated recovery before ready releases native startup", async () => {
    const mod = new FakeModule();
    const bytes = checkpoint();
    mod.FS.populate = () => {
      const root = VOLUMES.moria.mountpoint;
      mod.FS.writeFile(`${root}/recover/checkpoint-1.sav`, bytes);
      mod.FS.writeFile(`${root}/recover/commit-1.json`, new TextEncoder().encode(JSON.stringify({
        schema: 1, generation: 1, file: "checkpoint-1.sav", size: bytes.byteLength,
        checksum: fnv1a32Hex(bytes), ancestor: null,
      })));
    };
    const handle = mountMoriaStorage(mod, { locks: locks(true) });
    await expect(handle.ready).resolves.toBe(true);
    expect(mod.dependencies).toEqual([]);
    expect(handle.checkpointRecoveryPath)
      .toBe(`${VOLUMES.moria.mountpoint}/recover/checkpoint-1.sav`);
    handle.release();
  });
});

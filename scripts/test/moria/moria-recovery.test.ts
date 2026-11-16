import { describe, expect, it } from "vitest";
import {
  MORIA_CHECKPOINT_PENDING,
  MORIA_RECOVERY_MAX_GENERATION,
  createMoriaRecovery,
  type MoriaRecoveryFS,
} from "../../../src/modules/moria/recovery";
import { CHECKPOINT_DEFECTS, checkpoint, commitJson, terminalJson } from "./moria-checkpoint-fixtures";

const DIR = 0o040000, FILE = 0o100000;
const ROOT = "/vect-moria";

class FakeFS implements MoriaRecoveryFS {
  nodes = new Map<string, { mode: number; bytes?: Uint8Array }>([["/", { mode: DIR }]]);
  operations: string[] = [];
  failWritePath: string | null = null;

  analyzePath(path: string) { return { exists: this.nodes.has(path) }; }
  mkdirTree(path: string) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const part = parts.slice(0, i).join("/") || "/";
      if (!this.nodes.has(part)) this.nodes.set(part, { mode: DIR });
    }
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
  readFile(path: string): Uint8Array {
    const bytes = this.nodes.get(path)?.bytes;
    if (!bytes) throw new Error(`not a file: ${path}`);
    return Uint8Array.from(bytes);
  }
  writeFile(path: string, bytes: Uint8Array | string) {
    this.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    const body = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    this.nodes.set(path, { mode: FILE, bytes: Uint8Array.from(body) });
    this.operations.push(`write:${path}`);
    if (path === this.failWritePath) throw new Error(`write failed: ${path}`);
  }
  rename(from: string, to: string) {
    const node = this.nodes.get(from);
    if (!node) throw new Error(`ENOENT: ${from}`);
    this.nodes.set(to, node);
    this.nodes.delete(from);
    this.operations.push(`rename:${from}->${to}`);
  }
  unlink(path: string) {
    if (!this.nodes.delete(path)) throw new Error(`ENOENT: ${path}`);
    this.operations.push(`unlink:${path}`);
  }
}

function addCommitted(fs: FakeFS, generation: number, bytes: Uint8Array): void {
  fs.writeFile(`${ROOT}/recover/checkpoint-${generation}.sav`, bytes);
  fs.writeFile(`${ROOT}/recover/commit-${generation}.json`, commitJson(generation, bytes));
}

function pending(fs: FakeFS, bytes: Uint8Array) {
  fs.writeFile(`${ROOT}/${MORIA_CHECKPOINT_PENDING}`, bytes);
}

describe("Moria recovery generations", () => {
  it("publishes candidate data before its unique commit and retains only two generations", () => {
    const fs = new FakeFS();
    const recovery = createMoriaRecovery(fs, ROOT);
    for (const value of [1, 2, 3]) {
      pending(fs, checkpoint(value));
      recovery.publishPending();
    }

    const names = fs.readdir(`${ROOT}/recover`).sort();
    expect(names).toEqual([
      ".", "..", "checkpoint-2.sav", "checkpoint-3.sav", "commit-2.json", "commit-3.json",
    ]);
    const renamed = fs.operations.indexOf(
      `rename:${ROOT}/recover/.pending.sav->${ROOT}/recover/checkpoint-1.sav`,
    );
    const committed = fs.operations.indexOf(`write:${ROOT}/recover/commit-1.json`);
    expect(renamed).toBeGreaterThanOrEqual(0);
    expect(committed).toBeGreaterThan(renamed);
  });

  it("falls back from a corrupt newest generation and rejects two corrupt generations", () => {
    const fs = new FakeFS();
    const recovery = createMoriaRecovery(fs, ROOT);
    pending(fs, checkpoint(1)); recovery.publishPending();
    pending(fs, checkpoint(2)); recovery.publishPending();

    const newest = `${ROOT}/recover/checkpoint-2.sav`;
    const corrupt = fs.readFile(newest); corrupt[4] = corrupt[4]! ^ 1; fs.writeFile(newest, corrupt);
    expect(createMoriaRecovery(fs, ROOT).recoveryPath)
      .toBe(`${ROOT}/recover/checkpoint-1.sav`);

    const previous = `${ROOT}/recover/checkpoint-1.sav`;
    const alsoCorrupt = fs.readFile(previous); alsoCorrupt[4] = alsoCorrupt[4]! ^ 1; fs.writeFile(previous, alsoCorrupt);
    expect(createMoriaRecovery(fs, ROOT).recoveryPath).toBe("");
  });

  // The control that keeps every defect case below from passing vacuously.
  it("selects a valid recommitted newest generation", () => {
    const fs = new FakeFS();
    const recovery = createMoriaRecovery(fs, ROOT);
    pending(fs, checkpoint(1));
    recovery.publishPending();
    addCommitted(fs, 2, checkpoint(2));

    expect(createMoriaRecovery(fs, ROOT).recoveryPath)
      .toBe(`${ROOT}/recover/checkpoint-2.sav`);
  });

  it.each(CHECKPOINT_DEFECTS)("falls back past a recommitted newest generation with %s", (_label, defective) => {
    const fs = new FakeFS();
    const recovery = createMoriaRecovery(fs, ROOT);
    pending(fs, checkpoint(1));
    recovery.publishPending();
    addCommitted(fs, 2, defective());

    expect(createMoriaRecovery(fs, ROOT).recoveryPath)
      .toBe(`${ROOT}/recover/checkpoint-1.sav`);
  });

  it("allows only a checkpoint descended from the exact explicit save to supersede it", () => {
    const fs = new FakeFS();
    fs.writeFile(`${ROOT}/game.sav`, new Uint8Array([5, 7, 15, 1]));
    const recovery = createMoriaRecovery(fs, ROOT);
    pending(fs, checkpoint(1)); recovery.publishPending();

    expect(createMoriaRecovery(fs, ROOT).recoveryPath)
      .toBe(`${ROOT}/recover/checkpoint-1.sav`);
    fs.writeFile(`${ROOT}/game.sav`, new Uint8Array([5, 7, 15, 2]));
    expect(createMoriaRecovery(fs, ROOT).recoveryPath).toBe("");
    fs.unlink(`${ROOT}/game.sav`);
    expect(createMoriaRecovery(fs, ROOT).recoveryPath).toBe("");
  });

  it("publishes a newer terminal tombstone, removes explicit state, and blocks older recovery", () => {
    const fs = new FakeFS();
    fs.writeFile(`${ROOT}/game.sav`, new Uint8Array([5, 7, 15, 1]));
    const recovery = createMoriaRecovery(fs, ROOT);
    pending(fs, checkpoint(1)); recovery.publishPending();
    recovery.recordTerminal();

    expect(fs.analyzePath(`${ROOT}/game.sav`).exists).toBe(false);
    expect(fs.analyzePath(`${ROOT}/recover/terminal-2.json`).exists).toBe(true);
    expect(fs.operations.indexOf(`unlink:${ROOT}/game.sav`)).toBeLessThan(
      fs.operations.indexOf(`write:${ROOT}/recover/terminal-2.json`),
    );
    expect(createMoriaRecovery(fs, ROOT).recoveryPath).toBe("");
  });

  it("ignores non-canonical or out-of-range names and refuses generation exhaustion", () => {
    const fs = new FakeFS();
    fs.writeFile(`${ROOT}/recover/terminal-01.json`, "{}");
    fs.writeFile(`${ROOT}/recover/commit-999999999999999999999.json`, "{}");
    fs.writeFile(`${ROOT}/recover/checkpoint-Infinity.sav`, checkpoint(9));
    const recovery = createMoriaRecovery(fs, ROOT);
    pending(fs, checkpoint(1));
    recovery.publishPending();
    expect(fs.analyzePath(`${ROOT}/recover/checkpoint-1.sav`).exists).toBe(true);

    const exhausted = new FakeFS();
    exhausted.writeFile(
      `${ROOT}/recover/terminal-${MORIA_RECOVERY_MAX_GENERATION}.json`,
      terminalJson(MORIA_RECOVERY_MAX_GENERATION),
    );
    const exhaustedRecovery = createMoriaRecovery(exhausted, ROOT);
    pending(exhausted, checkpoint(2));
    expect(() => exhaustedRecovery.publishPending()).toThrow(/generation space/);
  });

  it("rolls back a torn commit publication and prunes canonical orphan artifacts on retry", () => {
    const fs = new FakeFS();
    const recovery = createMoriaRecovery(fs, ROOT);
    pending(fs, checkpoint(1));
    fs.failWritePath = `${ROOT}/recover/commit-1.json`;
    expect(() => recovery.publishPending()).toThrow(/write failed/);
    expect(fs.analyzePath(`${ROOT}/recover/checkpoint-1.sav`).exists).toBe(false);
    expect(fs.analyzePath(`${ROOT}/recover/commit-1.json`).exists).toBe(false);

    fs.failWritePath = null;
    fs.writeFile(`${ROOT}/recover/checkpoint-7.sav`, checkpoint(7));
    fs.writeFile(`${ROOT}/recover/commit-8.json`, new TextEncoder().encode("{}"));
    pending(fs, checkpoint(2));
    recovery.publishPending();
    expect(fs.analyzePath(`${ROOT}/recover/checkpoint-7.sav`).exists).toBe(false);
    expect(fs.analyzePath(`${ROOT}/recover/commit-8.json`).exists).toBe(false);
    expect(fs.analyzePath(`${ROOT}/recover/checkpoint-9.sav`).exists).toBe(true);

    const rebooted = new FakeFS();
    rebooted.writeFile(`${ROOT}/recover/checkpoint-7.sav`, checkpoint(7));
    rebooted.writeFile(`${ROOT}/recover/commit-8.json`, new TextEncoder().encode("{}"));
    pending(rebooted, checkpoint(3));
    createMoriaRecovery(rebooted, ROOT);
    expect(rebooted.analyzePath(`${ROOT}/recover/checkpoint-7.sav`).exists).toBe(false);
    expect(rebooted.analyzePath(`${ROOT}/recover/commit-8.json`).exists).toBe(false);
    expect(rebooted.analyzePath(`${ROOT}/${MORIA_CHECKPOINT_PENDING}`).exists).toBe(false);
  });
});

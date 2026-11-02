import { describe, expect, it } from "vitest";
import {
  MORIA_CHECKPOINT_PENDING,
  MORIA_CHECKPOINT_PAYLOAD_BYTES,
  MORIA_CHECKPOINT_SOURCE_SHA,
  MORIA_CHECKPOINT_TRAILER_BYTES,
  MORIA_CHECKPOINT_TRAILER_MAGIC,
  MORIA_RECOVERY_MAX_GENERATION,
  createMoriaRecovery,
  fnv1a32Hex,
  type MoriaRecoveryFS,
} from "../../src/modules/moria/recovery";

const DIR = 0o040000, FILE = 0o100000;
const ROOT = "/vect-moria";
const STORES_AT = 317;

function validPayload(marker = 0): Uint8Array {
  const payload = new Uint8Array(MORIA_CHECKPOINT_PAYLOAD_BYTES);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 1, true); // live RNG seed
  payload[4] = marker; // last command, useful for distinguishing generations
  view.setInt32(22, 21, true); // bottom = top + screen height - 1
  view.setInt32(30, 65, true); // right = left + screen width - 1
  view.setInt32(34, -13, true); // col_prt = left - 13
  view.setInt32(38, -1, true); // row_prt = top - 1
  view.setInt16(63, 2, true); // next free monster id
  return payload;
}

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

function checkpoint(payloadByte: number, payload = validPayload(payloadByte)): Uint8Array {
  const stock = new Uint8Array([5, 7, 15, 42, 1, 2, 3]);
  const footer = new Uint8Array(MORIA_CHECKPOINT_TRAILER_BYTES);
  footer.set(new TextEncoder().encode(MORIA_CHECKPOINT_TRAILER_MAGIC), 0);
  const view = new DataView(footer.buffer);
  view.setUint32(8, 1, true);
  footer.set(Buffer.from(MORIA_CHECKPOINT_SOURCE_SHA, "hex"), 12);
  view.setUint32(32, payload.byteLength, true);
  view.setUint32(36, Number.parseInt(fnv1a32Hex(payload), 16), true);
  const bytes = new Uint8Array(stock.byteLength + payload.byteLength + footer.byteLength);
  bytes.set(stock, 0);
  bytes.set(payload, stock.byteLength);
  bytes.set(footer, stock.byteLength + payload.byteLength);
  return bytes;
}

function addCommitted(fs: FakeFS, generation: number, bytes: Uint8Array): void {
  fs.writeFile(`${ROOT}/recover/checkpoint-${generation}.sav`, bytes);
  fs.writeFile(`${ROOT}/recover/commit-${generation}.json`, new TextEncoder().encode(JSON.stringify({
    schema: 1,
    generation,
    file: `checkpoint-${generation}.sav`,
    size: bytes.byteLength,
    checksum: fnv1a32Hex(bytes),
    ancestor: null,
  })));
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

  it.each([
    ["wrong payload length", () => new Uint8Array([1, 2, 3])],
    ["invalid Boolean", () => { const payload = validPayload(2); payload[payload.length - 1] = 2; return payload; }],
    ["out-of-range store owner", () => { const payload = validPayload(2); payload[STORES_AT + 6] = 18; return payload; }],
    ["out-of-range store item count", () => { const payload = validPayload(2); payload[STORES_AT + 7] = 25; return payload; }],
    ["incoherent panel relation", () => { const payload = validPayload(2); new DataView(payload.buffer).setInt32(38, 99, true); return payload; }],
    ["non-source panel maximum", () => { const payload = validPayload(2); new DataView(payload.buffer).setInt16(42, 2, true); return payload; }],
    ["out-of-range store item id", () => {
      const payload = validPayload(2), view = new DataView(payload.buffer);
      payload[STORES_AT + 7] = 1; view.setUint16(STORES_AT + 16, 420, true); return payload;
    }],
    ["out-of-range store special name", () => {
      const payload = validPayload(2); payload[STORES_AT + 7] = 1;
      payload[STORES_AT + 18] = 56; return payload;
    }],
    ["unterminated store inscription", () => {
      const payload = validPayload(2); payload[STORES_AT + 7] = 1;
      payload.fill(1, STORES_AT + 19, STORES_AT + 32); return payload;
    }],
  ])("falls back past a recommitted newest generation with %s", (_label, invalidPayload) => {
    const fs = new FakeFS();
    const recovery = createMoriaRecovery(fs, ROOT);
    pending(fs, checkpoint(1));
    recovery.publishPending();
    addCommitted(fs, 2, checkpoint(2, invalidPayload()));

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
      JSON.stringify({ schema: 1, generation: MORIA_RECOVERY_MAX_GENERATION, terminal: true }),
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

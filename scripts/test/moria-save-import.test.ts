import { describe, expect, it } from "vitest";
import { packSave, unpackSave, type SaveContents } from "../../src/backplane/saveBlob";
import { VOLUMES } from "../../src/backplane/volumes";
import { MORIA_RUNTIME_FILES, seedMoriaPaths } from "../../src/modules/moria/persist";
import {
  installMoriaImport,
  validateMoriaImport,
  type MoriaImportFS,
} from "../../src/modules/moria/saveImport";
import {
  MORIA_CHECKPOINT_SOURCE_SHA,
  MORIA_CHECKPOINT_PAYLOAD_BYTES,
  MORIA_CHECKPOINT_PAYLOAD_MAX_BYTES,
  MORIA_CHECKPOINT_TRAILER_BYTES,
  MORIA_CHECKPOINT_TRAILER_MAGIC,
  fnv1a32Hex,
} from "../../src/modules/moria/recovery";

const DIR = 0o040000, FILE = 0o100000;
const AT = new Date("2026-08-08T12:00:00Z");
const STORES_AT = 317;

class FakeFS implements MoriaImportFS {
  nodes = new Map<string, { mode: number; bytes?: Uint8Array }>([["/", { mode: DIR }]]);
  cwd = "/";
  constructor() {
    this.mkdirTree("/moria-seed/data");
    for (const [i, path] of MORIA_RUNTIME_FILES.entries())
      this.writeFile(`/moria-seed/${path}`, new Uint8Array([i + 1]));
  }
  analyzePath(path: string) { return { exists: this.nodes.has(path) }; }
  readdir(path: string): string[] {
    const prefix = `${path}/`, out = new Set([".", ".."]) as Set<string>;
    for (const key of this.nodes.keys()) if (key.startsWith(prefix)) {
      const rest = key.slice(prefix.length); if (rest) out.add(rest.split("/")[0]!);
    }
    return [...out];
  }
  stat(path: string) {
    const node = this.nodes.get(path); if (!node) throw new Error(`ENOENT: ${path}`);
    return { mode: node.mode, size: node.bytes?.length ?? 0 };
  }
  isDir(mode: number) { return (mode & 0o170000) === DIR; }
  isFile(mode: number) { return (mode & 0o170000) === FILE; }
  readFile(path: string): Uint8Array {
    const node = this.nodes.get(path); if (!node?.bytes) throw new Error(`not a file: ${path}`);
    return node.bytes;
  }
  writeFile(path: string, bytes: Uint8Array) {
    const slash = path.lastIndexOf("/"); if (slash > 0) this.mkdirTree(path.slice(0, slash));
    this.nodes.set(path, { mode: FILE, bytes: Uint8Array.from(bytes) });
  }
  mkdir(path: string) { this.mkdirTree(path); }
  mkdirTree(path: string) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const part = parts.slice(0, i).join("/") || "/";
      if (!this.nodes.has(part)) this.nodes.set(part, { mode: DIR });
    }
  }
  chdir(path: string) { this.cwd = path; }
}

function validScores(): Uint8Array {
  const out = new Uint8Array(3 + 73);
  out.set([5, 5, 2]);
  return out;
}

function validGame(): Uint8Array {
  const out = new Uint8Array(32);
  out.set([5, 7, 15, 42]);
  return out;
}

function validPayload(): Uint8Array {
  const payload = new Uint8Array(MORIA_CHECKPOINT_PAYLOAD_BYTES);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 1, true);
  view.setInt32(22, 21, true);
  view.setInt32(30, 65, true);
  view.setInt32(34, -13, true);
  view.setInt32(38, -1, true);
  view.setInt16(63, 2, true);
  return payload;
}

function checkpoint(payload = validPayload()): Uint8Array {
  const stock = validGame();
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

function add(contents: SaveContents, path: string, bytes: Uint8Array): void {
  contents.files.push({ path, bytes });
  contents.manifest.files.push({ path, size: bytes.byteLength });
}

function addCheckpoint(
  contents: SaveContents,
  generation: number,
  ancestor: string | null,
  bytes = checkpoint(),
): void {
  const file = `recover/checkpoint-${generation}.sav`;
  add(contents, file, bytes);
  add(contents, `recover/commit-${generation}.json`, new TextEncoder().encode(JSON.stringify({
    schema: 1, generation, file: `checkpoint-${generation}.sav`,
    size: bytes.byteLength, checksum: fnv1a32Hex(bytes), ancestor,
  })));
}

function exported(): SaveContents {
  const fs = new FakeFS();
  seedMoriaPaths(fs, VOLUMES.moria.mountpoint);
  fs.writeFile(`${VOLUMES.moria.mountpoint}/scores.dat`, validScores());
  fs.writeFile(`${VOLUMES.moria.mountpoint}/game.sav`, validGame());
  return unpackSave(packSave(fs, VOLUMES.moria, AT));
}

function pristine(): FakeFS {
  const fs = new FakeFS();
  seedMoriaPaths(fs, VOLUMES.moria.mountpoint);
  return fs;
}

describe("Moria portable import", () => {
  it("validates and installs a complete exported volume into a pristine seed", () => {
    const fs = pristine(), contents = exported();
    expect(validateMoriaImport(fs, contents)).toEqual(contents);
    installMoriaImport(fs, contents);
    expect(fs.readFile(`${VOLUMES.moria.mountpoint}/game.sav`)).toEqual(validGame());
    expect(fs.readFile(`${VOLUMES.moria.mountpoint}/scores.dat`)).toEqual(validScores());
  });

  it.each([[5, 2, 2], [5, 7, 255]])("accepts supported save version %s.%s.%s", (a, b, c) => {
    const contents = exported();
    contents.files.find((file) => file.path === "game.sav")!.bytes.set([a, b, c]);
    expect(() => validateMoriaImport(pristine(), contents)).not.toThrow();
  });

  it("accepts an empty stock score file", () => {
    const contents = exported();
    const score = contents.files.find((file) => file.path === "scores.dat")!;
    score.bytes = new Uint8Array();
    contents.manifest.files.find((file) => file.path === "scores.dat")!.size = 0;
    expect(() => validateMoriaImport(pristine(), contents)).not.toThrow();
  });

  it("rejects altered immutable data, invalid versions, partial scores and unknown files", () => {
    const cases = [
      (c: SaveContents) => {
        const bytes = c.files.find((f) => f.path === "LICENSE")!.bytes;
        bytes[0] = bytes[0]! ^ 1;
      },
      (c: SaveContents) => { c.files.find((f) => f.path === "game.sav")!.bytes.set([6, 0, 0]); },
      (c: SaveContents) => {
        const f = c.files.find((x) => x.path === "scores.dat")!; f.bytes = new Uint8Array([5, 7, 15, 0]);
        c.manifest.files.find((x) => x.path === "scores.dat")!.size = 4;
      },
      (c: SaveContents) => {
        c.files.push({ path: "unknown", bytes: new Uint8Array() });
        c.manifest.files.push({ path: "unknown", size: 0 });
      },
    ];
    for (const mutate of cases) {
      const contents = exported(); mutate(contents);
      expect(() => validateMoriaImport(pristine(), contents)).toThrow();
    }
  });

  it("refuses a non-pristine target before changing any durable byte", () => {
    const fs = pristine();
    fs.writeFile(`${VOLUMES.moria.mountpoint}/game.sav`, new Uint8Array([9]));
    const before = new Map([...fs.nodes].map(([path, node]) => [path, {
      mode: node.mode, bytes: node.bytes && Uint8Array.from(node.bytes),
    }]));

    expect(() => installMoriaImport(fs, exported())).toThrow(/not pristine/);
    expect(fs.nodes).toEqual(before);
  });

  it("accepts a bounded checkpoint-only volume and an exact explicit-save descendant", () => {
    const checkpointOnly = exported();
    checkpointOnly.files = checkpointOnly.files.filter((file) => file.path !== "game.sav");
    checkpointOnly.manifest.files = checkpointOnly.manifest.files.filter((file) => file.path !== "game.sav");
    addCheckpoint(checkpointOnly, 1, null);
    expect(() => validateMoriaImport(pristine(), checkpointOnly)).not.toThrow();

    const descendant = exported();
    addCheckpoint(descendant, 1, fnv1a32Hex(validGame()));
    expect(() => validateMoriaImport(pristine(), descendant)).not.toThrow();
    const changedGame = descendant.files.find((file) => file.path === "game.sav")!.bytes;
    changedGame[4] = changedGame[4]! ^ 1;
    expect(() => validateMoriaImport(pristine(), descendant)).toThrow(/descend/);

    const missingAncestor = exported();
    missingAncestor.files = missingAncestor.files.filter((file) => file.path !== "game.sav");
    missingAncestor.manifest.files = missingAncestor.manifest.files.filter((file) => file.path !== "game.sav");
    addCheckpoint(missingAncestor, 1, fnv1a32Hex(validGame()));
    expect(() => validateMoriaImport(pristine(), missingAncestor)).toThrow(/ancestor/);
  });

  it("accepts a terminal tombstone newer than retained checkpoints but never beside game.sav", () => {
    const terminal = exported();
    terminal.files = terminal.files.filter((file) => file.path !== "game.sav");
    terminal.manifest.files = terminal.manifest.files.filter((file) => file.path !== "game.sav");
    addCheckpoint(terminal, 1, null);
    add(terminal, "recover/terminal-2.json", new TextEncoder().encode(
      JSON.stringify({ schema: 1, generation: 2, terminal: true }),
    ));
    expect(() => validateMoriaImport(pristine(), terminal)).not.toThrow();

    add(terminal, "game.sav", validGame());
    expect(() => validateMoriaImport(pristine(), terminal)).toThrow(/terminal/);
  });

  it("rejects pending, orphaned, non-canonical, corrupt, excessive, and out-of-range recovery artifacts", () => {
    const mutations: Array<(contents: SaveContents) => void> = [
      (contents) => add(contents, "recover/.pending.sav", checkpoint()),
      (contents) => add(contents, "recover/checkpoint-1.sav", checkpoint()),
      (contents) => add(contents, "recover/commit-01.json", new Uint8Array()),
      (contents) => add(contents, "recover/terminal-999999999999999999.json", new Uint8Array()),
      (contents) => { addCheckpoint(contents, 1, null); addCheckpoint(contents, 2, null); addCheckpoint(contents, 3, null); },
      (contents) => {
        addCheckpoint(contents, 1, null);
        const changed = contents.files.find((f) => f.path.endsWith("checkpoint-1.sav"))!.bytes;
        changed[5] = changed[5]! ^ 1;
      },
    ];
    for (const mutate of mutations) {
      const contents = exported();
      contents.files = contents.files.filter((file) => file.path !== "game.sav");
      contents.manifest.files = contents.manifest.files.filter((file) => file.path !== "game.sav");
      mutate(contents);
      expect(() => validateMoriaImport(pristine(), contents)).toThrow();
    }
  });

  it("rejects each independently recommitted trailer defect before installing any byte", () => {
    const mutations: Array<() => Uint8Array> = [
      () => {
        const bytes = Uint8Array.from(checkpoint());
        const at = bytes.byteLength - MORIA_CHECKPOINT_TRAILER_BYTES;
        bytes[at] = bytes[at]! ^ 0x20;
        return bytes;
      },
      () => {
        const bytes = Uint8Array.from(checkpoint());
        new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength - MORIA_CHECKPOINT_TRAILER_BYTES)
          .setUint32(8, 2, true);
        return bytes;
      },
      () => {
        const bytes = Uint8Array.from(checkpoint());
        const at = bytes.byteLength - MORIA_CHECKPOINT_TRAILER_BYTES + 12;
        bytes[at] = bytes[at]! ^ 0x80;
        return bytes;
      },
      () => {
        const bytes = Uint8Array.from(checkpoint());
        new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength - MORIA_CHECKPOINT_TRAILER_BYTES)
          .setUint32(32, 0, true);
        return bytes;
      },
      () => {
        const bytes = Uint8Array.from(checkpoint());
        const at = bytes.byteLength - 1;
        bytes[at] = bytes[at]! ^ 0xff;
        return bytes;
      },
      () => checkpoint(new Uint8Array(MORIA_CHECKPOINT_PAYLOAD_MAX_BYTES + 1)),
      () => checkpoint(new Uint8Array([4, 5, 6])),
      () => {
        const payload = validPayload(); payload[payload.length - 1] = 2;
        return checkpoint(payload);
      },
      () => {
        const payload = validPayload(); payload[STORES_AT + 6] = 18;
        return checkpoint(payload);
      },
      () => {
        const payload = validPayload(); payload[STORES_AT + 7] = 25;
        return checkpoint(payload);
      },
      () => {
        const payload = validPayload(); new DataView(payload.buffer).setInt32(38, 99, true);
        return checkpoint(payload);
      },
      () => {
        const payload = validPayload(); new DataView(payload.buffer).setInt16(42, 2, true);
        return checkpoint(payload);
      },
      () => {
        const payload = validPayload(), view = new DataView(payload.buffer);
        payload[STORES_AT + 7] = 1; view.setUint16(STORES_AT + 16, 420, true);
        return checkpoint(payload);
      },
      () => {
        const payload = validPayload(); payload[STORES_AT + 7] = 1;
        payload[STORES_AT + 18] = 56; return checkpoint(payload);
      },
      () => {
        const payload = validPayload(); payload[STORES_AT + 7] = 1;
        payload.fill(1, STORES_AT + 19, STORES_AT + 32); return checkpoint(payload);
      },
    ];

    for (const mutate of mutations) {
      const contents = exported();
      contents.files = contents.files.filter((file) => file.path !== "game.sav");
      contents.manifest.files = contents.manifest.files.filter((file) => file.path !== "game.sav");
      addCheckpoint(contents, 1, null, mutate());
      const target = pristine();
      const before = new Map([...target.nodes].map(([path, node]) => [path, {
        mode: node.mode, bytes: node.bytes && Uint8Array.from(node.bytes),
      }]));
      expect(() => installMoriaImport(target, contents)).toThrow();
      expect(target.nodes).toEqual(before);
    }
  });

  it("rejects malformed JSON at an otherwise canonical paired commit path", () => {
    const contents = exported();
    contents.files = contents.files.filter((file) => file.path !== "game.sav");
    contents.manifest.files = contents.manifest.files.filter((file) => file.path !== "game.sav");
    add(contents, "recover/checkpoint-1.sav", checkpoint());
    add(contents, "recover/commit-1.json", new TextEncoder().encode("{"));
    expect(() => installMoriaImport(pristine(), contents)).toThrow(/commit/);
  });
});

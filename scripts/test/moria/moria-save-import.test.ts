import { describe, expect, it } from "vitest";
import { packSave, unpackSave, type SaveContents } from "../../../src/backplane/saveBlob";
import { VOLUMES } from "../../../src/backplane/volumes";
import { MORIA_RUNTIME_FILES, seedMoriaPaths } from "../../../src/modules/moria/persist";
import {
  installMoriaImport,
  validateMoriaImport,
  type MoriaImportFS,
} from "../../../src/modules/moria/saveImport";
import { fnv1a32Hex } from "../../../src/modules/moria/recovery";
import { CHECKPOINT_DEFECTS, checkpoint, commitJson, terminalJson, validGame } from "./moria-checkpoint-fixtures";

const DIR = 0o040000, FILE = 0o100000;
const AT = new Date("2026-08-08T12:00:00Z");

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
  add(contents, `recover/commit-${generation}.json`, commitJson(generation, bytes, ancestor));
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
    add(terminal, "recover/terminal-2.json", terminalJson(2));
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

  it.each(CHECKPOINT_DEFECTS)("rejects a recommitted checkpoint with %s before installing any byte", (_label, defective) => {
    const contents = exported();
    contents.files = contents.files.filter((file) => file.path !== "game.sav");
    contents.manifest.files = contents.manifest.files.filter((file) => file.path !== "game.sav");
    addCheckpoint(contents, 1, null, defective());
    const target = pristine();
    const before = new Map([...target.nodes].map(([path, node]) => [path, {
      mode: node.mode, bytes: node.bytes && Uint8Array.from(node.bytes),
    }]));
    expect(() => installMoriaImport(target, contents)).toThrow();
    expect(target.nodes).toEqual(before);
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

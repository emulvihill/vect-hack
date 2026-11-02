// Preliminary format validation and safe installation for Moria portable
// volumes. Arbitrary uploads remain disabled: this accepts a complete volume
// only over the exact pristine packaged seed, so a rejected or interrupted
// import cannot destroy an existing character.
import {
  entries,
  restoreSave,
  type SaveContents,
  type SaveFS,
} from "../../backplane/saveBlob.ts";
import { VOLUMES } from "../../backplane/volumes.ts";
import {
  MORIA_GAME_SAVE,
  MORIA_RUNTIME_FILES,
  MORIA_SEED_ROOT,
  type MoriaSeedFS,
} from "./persist.ts";
import {
  equalBytes,
  isSupportedMoriaVersion,
  validateMoriaRecoveryFiles,
} from "./recovery.ts";

const SCORE_RECORD_BYTES = 73;
const MAX_SCORE_RECORDS = 1_000;
const SCORES = "scores.dat";

export interface MoriaImportFS extends SaveFS, MoriaSeedFS {}

export function validateMoriaImport(
  fs: MoriaImportFS,
  contents: SaveContents,
): SaveContents {
  if (contents.manifest.game !== VOLUMES.moria.id)
    throw new Error(`this is a ${contents.manifest.game} save, not a Moria volume`);
  if (contents.manifest.files.length !== contents.files.length)
    throw new Error("Moria save contents do not match their manifest");

  // persist.ts and this file are cyclic, so its exports are read HERE, inside
  // a function, and never at evaluation time: a module-level alias for
  // MORIA_GAME_SAVE resolves before persist.ts has run when the import graph
  // is entered from that side, and the allow-list then silently loses the one
  // file that is actually a character.
  const allowed = new Set<string>([...MORIA_RUNTIME_FILES, MORIA_GAME_SAVE]);
  const required = new Set<string>(MORIA_RUNTIME_FILES);
  const byPath = new Map<string, Uint8Array>();
  for (let i = 0; i < contents.files.length; i++) {
    const actual = contents.files[i]!;
    const declared = contents.manifest.files[i]!;
    if (actual.path !== declared.path || actual.bytes.byteLength !== declared.size)
      throw new Error("Moria save contents do not match their manifest");
    if (!allowed.has(actual.path) && !actual.path.startsWith("recover/"))
      throw new Error(`unexpected Moria volume file: ${actual.path}`);
    if (byPath.has(actual.path)) throw new Error(`duplicate Moria volume file: ${actual.path}`);
    byPath.set(actual.path, actual.bytes);
    required.delete(actual.path);
  }
  if (required.size) throw new Error(`Moria volume is missing ${[...required].join(", ")}`);

  for (const relative of MORIA_RUNTIME_FILES) {
    if (relative === SCORES) continue;
    const packaged = fs.readFile(`${MORIA_SEED_ROOT}/${relative}`, { encoding: "binary" });
    if (!equalBytes(byPath.get(relative)!, packaged))
      throw new Error(`Moria immutable runtime file differs from this build: ${relative}`);
  }

  validateScores(byPath.get(SCORES)!);
  const game = byPath.get(MORIA_GAME_SAVE);
  if (game) validateGameSave(game);
  validateMoriaRecoveryFiles(byPath);
  return contents;
}

export function installMoriaImport(fs: MoriaImportFS, contents: SaveContents): void {
  validateMoriaImport(fs, contents);
  assertPristine(fs);
  restoreSave(fs, VOLUMES.moria, contents);
}

function validateScores(bytes: Uint8Array): void {
  if (bytes.byteLength === 0) return;
  if (bytes.byteLength < 3 || !isSupportedMoriaVersion(bytes[0]!, bytes[1]!, bytes[2]!))
    throw new Error("Moria scores.dat has an unsupported version");
  const body = bytes.byteLength - 3;
  if (body % SCORE_RECORD_BYTES !== 0 || body / SCORE_RECORD_BYTES > MAX_SCORE_RECORDS)
    throw new Error("Moria scores.dat has a partial or oversized score record set");
}

function validateGameSave(bytes: Uint8Array): void {
  // saveChar resets its XOR byte before each of the first three wrByte calls,
  // so the on-disk prefix is the plain version triplet. Full structural truth
  // remains the real-engine import gate; this rejects incompatible/truncated
  // data before it reaches that disposable pristine volume.
  if (bytes.byteLength < 4 || !isSupportedMoriaVersion(bytes[0]!, bytes[1]!, bytes[2]!))
    throw new Error("Moria game.sav has an unsupported or truncated header");
}

function assertPristine(fs: MoriaImportFS): void {
  const actual = walkFiles(fs, VOLUMES.moria.mountpoint).sort();
  const expected = [...MORIA_RUNTIME_FILES].sort();
  if (actual.length !== expected.length || actual.some((path, i) => path !== expected[i]))
    throw new Error("Moria import target is not pristine");
  for (const relative of expected) {
    const target = fs.readFile(`${VOLUMES.moria.mountpoint}/${relative}`, { encoding: "binary" });
    const seed = fs.readFile(`${MORIA_SEED_ROOT}/${relative}`, { encoding: "binary" });
    if (!equalBytes(target, seed)) throw new Error("Moria import target is not pristine");
  }
}

function walkFiles(fs: SaveFS, root: string, prefix = ""): string[] {
  const here = prefix ? `${root}/${prefix}` : root;
  const out: string[] = [];
  for (const name of entries(fs, here)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.stat(`${root}/${relative}`);
    if (fs.isDir(stat.mode)) out.push(...walkFiles(fs, root, relative));
    else if (fs.isFile(stat.mode)) out.push(relative);
  }
  return out;
}

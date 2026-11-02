// A volume's contents as one self-describing blob, and back again.
//
// This is the primitive under every way a save leaves the browser: a file the
// player downloads, and — if it is ever built — a body PUT at a server. Both
// are consumers of the same pack/unpack, which is why it lives in the
// Backplane and knows nothing about either engine's save format. It moves
// bytes and paths; what those bytes mean is the engine's business.
//
// Why it exists at all: IndexedDB is evictable and origin-scoped (see
// vect-hack-9tv). A character born on localhost has no other route to
// vecthack.com, and no route at all off the machine.
//
// Container:
//
//   VECTSAVE1\n                 magic + format version
//   {"game":"nethack",...}\n    one line of UTF-8 JSON: the manifest
//   <bytes><bytes>...           each file's contents, manifest order
//
// The manifest carries the game id, so an Angband blob cannot be restored over
// a NetHack volume even if the file was renamed. Directories are not recorded:
// the mount's own seed step creates the volume's directory layout, and a blob
// that could create arbitrary directories is a blob that could create them
// outside the volume.
import type { ModuleVolume } from "./volumes.ts";

export const SAVE_MAGIC = "VECTSAVE1";
export const SAVE_EXTENSION = "vhsave";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SAVE_FILES = 4_096;
export const MAX_SAVE_BYTES = 128 * 1024 * 1024;

/** The Emscripten FS calls this needs, named structurally so a test can supply
 *  a fake and neither Module has to hand over its whole FS type. */
export interface SaveFS {
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  readFile(path: string, opts: { encoding: "binary" }): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  mkdirTree(path: string): void;
}

export interface SaveManifest {
  game: string;
  created: string;
  files: { path: string; size: number }[];
}

export interface SaveContents {
  manifest: SaveManifest;
  files: { path: string; bytes: Uint8Array }[];
}

/**
 * What a downloaded save is called. The game id is in the name so a player
 * with two of these in one downloads folder can tell them apart — the manifest
 * is what actually enforces it on the way back in.
 */
export function saveFileName(volume: ModuleVolume, now: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}`;
  return `vecthack-${volume.id}-${stamp}.${SAVE_EXTENSION}`;
}

/** readdir minus the "." and ".." Emscripten always includes. Exported for
 *  every other Backplane and Module directory scan — this filter had grown a
 *  copy per call site before it was hoisted here. */
export function entries(fs: { readdir(path: string): string[] }, path: string): string[] {
  return fs.readdir(path).filter((name) => name !== "." && name !== "..");
}

/**
 * Where a pack reads from, and — when that is not a volume — what it may read.
 *
 * A mounted volume is entirely save data, so `root` alone describes it: every
 * file under it belongs in the blob, because nothing else is ever put there.
 *
 * A session-only tab has no volume, and its save is nonetheless real: the
 * mount's `seed(FS, null)` gives the engine writable paths in the engine's own
 * tree instead (vect-hack-47a). That tree is not a volume. NetHack's is the
 * Emscripten root, beside /tmp, /dev, /proc and the read-only embed; Angband's
 * and Larn's is /lib, beside the whole packaged lib tree; Moria's is the
 * packaged seed itself. Walking any of those wholesale packs the game's own
 * data files and the platform's device nodes and calls the result a save. So a
 * Module that packs from one has to say which names are its save, and `names`
 * is that list — the same names the volume gives those files, which is what
 * makes the blob loadable back into a volume.
 */
export interface PackSource {
  /** Absolute FS path every packed path is relative to. */
  root: string;
  /** Volume-relative names of the save's files and directories. Undefined
   *  packs everything under `root`, which is right only for a volume. */
  names?: readonly string[];
}

/** A path under `root`. Written out because one real root is "/" — NetHack's
 *  session-only save sits at the Emscripten root itself — and `"/" + "/save"`
 *  is a path Emscripten normalizes and nothing else has to. */
function under(root: string, relative: string): string {
  return root.endsWith("/") ? root + relative : `${root}/${relative}`;
}

/** Every regular file under `root`, depth first, as volume-relative paths with
 *  the sizes stat already paid for — packSave sizes the blob from these. */
function walk(fs: SaveFS, root: string, prefix = ""): { path: string; size: number }[] {
  const here = prefix ? under(root, prefix) : root;
  const out: { path: string; size: number }[] = [];
  for (const name of entries(fs, here)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.stat(under(root, relative));
    if (fs.isDir(stat.mode)) out.push(...walk(fs, root, relative));
    // Symlinks and devices are not save data; a volume holds neither today,
    // and silently packing one would restore something a player never saved.
    else if (fs.isFile(stat.mode)) out.push({ path: relative, size: stat.size });
  }
  return out;
}

/**
 * The declared half: each name is a file or a directory of the save.
 *
 * A name that is not there yet is not an error. `names` says what a save is
 * made of, not what this game has written — Moria has no game.sav until the
 * player saves, and Angband may never panic. Only the declared name's own stat
 * is guarded: past it the ordinary walk runs, so nothing that exists can be
 * dropped here, and a broken FS under a name that does resolve still throws.
 */
function walkNames(
  fs: SaveFS, root: string, names: readonly string[],
): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  for (const name of names) {
    let stat: { mode: number; size: number };
    try {
      stat = fs.stat(under(root, name));
    } catch {
      continue;
    }
    if (fs.isDir(stat.mode)) out.push(...walk(fs, root, name));
    else if (fs.isFile(stat.mode)) out.push({ path: name, size: stat.size });
  }
  return out;
}

/**
 * The volume's files, in manifest order, with the sizes `stat` already paid
 * for and not a byte read.
 *
 * Split out of `packSave` because F3 has a question to ask about what it is
 * about to pack — is there a character in here at all (vect-hack-70x) — and
 * the answer must come from the same list the blob is built from. The caller
 * walking twice costs a `readdir` over a handful of files and buys one
 * traversal that both the check and the pack agree on.
 */
export function listSaveFiles(fs: SaveFS, source: PackSource): { path: string; size: number }[] {
  return (source.names === undefined
    ? walk(fs, source.root)
    : walkNames(fs, source.root, source.names)
  ).sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function packSave(
  fs: SaveFS,
  volume: ModuleVolume,
  now: Date,
  source: PackSource = { root: volume.mountpoint },
): Uint8Array {
  const files = listSaveFiles(fs, source);
  validateManifestEntries(files);
  const manifest: SaveManifest = {
    game: volume.id,
    created: now.toISOString(),
    files,
  };

  // Sized from the stats and filled one file at a time: the volume can be
  // megabytes on the thread that runs the engine, and buffering every body
  // first would hold two copies of all of it at once.
  const header = new TextEncoder().encode(`${SAVE_MAGIC}\n${JSON.stringify(manifest)}\n`);
  const packedBytes = files.reduce((n, f) => n + f.size, header.length);
  if (!Number.isSafeInteger(packedBytes) || packedBytes > MAX_SAVE_BYTES)
    throw new Error("save file contents are too large");
  const out = new Uint8Array(packedBytes);
  out.set(header, 0);
  let at = header.length;
  for (const file of files) {
    const body = fs.readFile(under(source.root, file.path), { encoding: "binary" });
    // The manifest already promised stat's size; a mismatched read would
    // silently shift every following file. Nothing writes during a pack, so
    // this is a broken FS, not a race.
    if (body.length !== file.size)
      throw new Error(`${file.path} read ${body.length} bytes, stat said ${file.size}`);
    out.set(body, at);
    at += body.length;
  }
  return out;
}

/** Parse a blob without touching a filesystem. Throws on anything it cannot
 *  vouch for: a caller that gets a SaveContents back has a whole, consistent
 *  file set, and one that throws has not written a byte anywhere. */
export function unpackSave(bytes: Uint8Array): SaveContents {
  if (bytes.byteLength > MAX_SAVE_BYTES) throw new Error("save file is too large");
  const text = new TextDecoder("utf-8", { fatal: true });
  const firstBreak = bytes.indexOf(10);
  let magic: string;
  try {
    magic = firstBreak < 0 ? "" : text.decode(bytes.subarray(0, firstBreak));
  } catch {
    magic = "";
  }
  if (firstBreak < 0 || magic !== SAVE_MAGIC) {
    throw new Error("not a VectHack save file");
  }
  const secondBreak = bytes.indexOf(10, firstBreak + 1);
  if (secondBreak < 0) throw new Error("save file has no manifest");
  if (secondBreak - firstBreak - 1 > MAX_MANIFEST_BYTES)
    throw new Error("save file manifest is too large");

  let manifest: SaveManifest;
  try {
    manifest = JSON.parse(text.decode(bytes.subarray(firstBreak + 1, secondBreak)));
  } catch {
    throw new Error("save file manifest is not readable");
  }
  if (typeof manifest?.game !== "string" || !Array.isArray(manifest.files)) {
    throw new Error("save file manifest is missing its game or file list");
  }
  // Count, shape, size, and path canonicality for every entry at once: past
  // this call the only thing left to check is that the bodies are all here.
  validateManifestEntries(manifest.files);

  const files: { path: string; bytes: Uint8Array }[] = [];
  let at = secondBreak + 1;
  for (const entry of manifest.files) {
    if (at + entry.size > bytes.length) throw new Error("save file is truncated");
    files.push({ path: entry.path, bytes: bytes.subarray(at, at + entry.size) });
    at += entry.size;
  }
  if (at !== bytes.length) throw new Error("save file has trailing data");
  return { manifest, files };
}

/**
 * Write a parsed save into `volume`. The game id must match: the manifest, not
 * the filename, is what stops an Angband save landing in NetHack's volume.
 *
 * Restoring over a live game is not this function's business to prevent, and
 * it cannot: the engine holds its own file handles and its own idea of the
 * save. Callers restore before an engine starts.
 */
export function restoreSave(fs: SaveFS, volume: ModuleVolume, contents: SaveContents): void {
  if (contents.manifest.game !== volume.id) {
    throw new Error(
      `this is a ${contents.manifest.game} save; the ${volume.id} volume cannot take it`);
  }
  if (contents.manifest.files.length !== contents.files.length)
    throw new Error("save contents do not match their manifest");
  validateManifestEntries(contents.manifest.files);
  for (let i = 0; i < contents.files.length; i++) {
    const declared = contents.manifest.files[i]!;
    const actual = contents.files[i]!;
    if (actual.path !== declared.path || actual.bytes.byteLength !== declared.size)
      throw new Error("save contents do not match their manifest");
  }
  for (const file of contents.files) {
    const full = `${volume.mountpoint}/${file.path}`;
    const slash = full.lastIndexOf("/");
    if (slash > 0) fs.mkdirTree(full.slice(0, slash));
    fs.writeFile(full, file.bytes);
  }
}

function validateManifestEntries(files: SaveManifest["files"]): void {
  if (files.length > MAX_SAVE_FILES) throw new Error("save file has too many files");
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const entry of files) {
    if (typeof entry?.path !== "string" || !Number.isInteger(entry.size) || entry.size < 0)
      throw new Error("save file manifest has a malformed entry");
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SAVE_BYTES)
      throw new Error("save file contents are too large");
    const parts = entry.path.split("/");
    if (entry.path.startsWith("/") || parts.includes(".."))
      throw new Error(`save file entry escapes the volume: ${entry.path}`);
    if (!entry.path || entry.path.includes("\0") || parts.some((part) => !part || part === "."))
      throw new Error(`save file entry has a noncanonical path: ${entry.path}`);
    if (paths.has(entry.path)) throw new Error(`save file has duplicate path: ${entry.path}`);
    for (const path of paths) {
      if (path.startsWith(`${entry.path}/`) || entry.path.startsWith(`${path}/`))
        throw new Error(`save file paths collide: ${path} and ${entry.path}`);
    }
    paths.add(entry.path);
  }
}

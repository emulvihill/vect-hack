// Durable Moria checkpoint publication and recovery selection. Native writes a
// complete candidate to recover/.pending.sav; TypeScript gives that candidate
// a unique generation and publishes its commit record last.

export const MORIA_RECOVERY_DIR = "recover";
export const MORIA_CHECKPOINT_PENDING = `${MORIA_RECOVERY_DIR}/.pending.sav`;
export const MORIA_CHECKPOINT_TRAILER_MAGIC = "VHMCP001";
export const MORIA_CHECKPOINT_TRAILER_SCHEMA = 1;
export const MORIA_CHECKPOINT_SOURCE_SHA = "3bf8abc4f76812810e59d738492c7b61fb8f1bb6";
export const MORIA_CHECKPOINT_TRAILER_BYTES = 40;
export const MORIA_CHECKPOINT_PAYLOAD_MAX_BYTES = 128 * 1024;
// Fixed field-encoded payload owned jointly with native/checkpoint-wasm.cpp.
// It is not an extensible bag: exact size and every late index-bearing field
// must validate before a generation can outrank an older recovery.
export const MORIA_CHECKPOINT_PAYLOAD_BYTES = 11_158;
export const MORIA_RECOVERY_MAX_GENERATION = 1_000_000_000;

const COMMIT_SCHEMA = 1;
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const KEEP_GENERATIONS = 2;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const sourceBytes = hexBytes(MORIA_CHECKPOINT_SOURCE_SHA);

export interface MoriaRecoveryFS {
  analyzePath(path: string): { exists: boolean };
  mkdirTree(path: string): void;
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number };
  isFile(mode: number): boolean;
  readFile(path: string, opts: { encoding: "binary" }): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

interface RecoveryCommit {
  schema: 1;
  generation: number;
  file: string;
  size: number;
  checksum: string;
  ancestor: string | null;
}

interface TerminalCommit {
  schema: 1;
  generation: number;
  terminal: true;
}

interface ValidGeneration {
  commit: RecoveryCommit;
  path: string;
}

export interface MoriaRecovery {
  readonly recoveryPath: string;
  publishPending(): void;
  clearForExplicitSave(): void;
  recordTerminal(): void;
}

export function createMoriaRecovery(FS: MoriaRecoveryFS, root: string): MoriaRecovery {
  const directory = `${root}/${MORIA_RECOVERY_DIR}`;
  FS.mkdirTree(directory);
  let scan = scanRecovery(FS, root);
  repairRecovery(FS, root, scan, true);
  scan = scanRecovery(FS, root);
  let recoveryPath = selectRecovery(FS, root, scan);
  let ancestor = recoveryPath
    ? scan.valid.find(({ path }) => path === recoveryPath)?.commit.ancestor ?? null
    : digestFile(FS, `${root}/game.sav`);

  return {
    get recoveryPath() { return recoveryPath; },

    publishPending() {
      const pending = `${root}/${MORIA_CHECKPOINT_PENDING}`;
      const bytes = readRegularFile(FS, pending);
      if (!bytes || !validateMoriaCheckpoint(bytes))
        throw new Error("Moria checkpoint candidate is missing or invalid");

      scan = scanRecovery(FS, root);
      const generation = nextGeneration(scan.maxGeneration);
      const file = `checkpoint-${generation}.sav`;
      const target = `${directory}/${file}`;
      const commit: RecoveryCommit = {
        schema: COMMIT_SCHEMA,
        generation,
        file,
        size: bytes.byteLength,
        checksum: fnv1a32Hex(bytes),
        ancestor,
      };
      FS.rename(pending, target);
      const commitPath = `${directory}/commit-${generation}.json`;
      try {
        FS.writeFile(commitPath, encoder.encode(JSON.stringify(commit)));
      } catch (error) {
        // A throwing filesystem may already have created a partial record.
        // Neither half is committed without both exact files.
        unlinkIfPresent(FS, commitPath);
        unlinkIfPresent(FS, target);
        throw error;
      }

      scan = scanRecovery(FS, root);
      pruneRecovery(FS, root, scan, generation);
      recoveryPath = target;
    },

    clearForExplicitSave() {
      for (const name of recoveryNames(FS, directory)) {
        if (isRecoveryArtifact(name)) unlinkIfPresent(FS, `${directory}/${name}`);
      }
      recoveryPath = "";
      ancestor = digestFile(FS, `${root}/game.sav`);
    },

    recordTerminal() {
      scan = scanRecovery(FS, root);
      const generation = nextGeneration(scan.maxGeneration);
      const terminal: TerminalCommit = { schema: COMMIT_SCHEMA, generation, terminal: true };
      unlinkIfPresent(FS, `${root}/game.sav`);
      unlinkIfPresent(FS, `${root}/${MORIA_CHECKPOINT_PENDING}`);
      // Like checkpoint commits, the tombstone is the publication record: all
      // state it supersedes is removed before the unique record becomes visible.
      FS.writeFile(`${directory}/terminal-${generation}.json`, encoder.encode(JSON.stringify(terminal)));
      for (const name of recoveryNames(FS, directory)) {
        const oldGeneration = artifactGeneration(name, "terminal", "json");
        if (oldGeneration !== null && oldGeneration !== generation)
          unlinkIfPresent(FS, `${directory}/${name}`);
      }
      recoveryPath = "";
      ancestor = null;
    },
  };
}

export function validateMoriaCheckpoint(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 + MORIA_CHECKPOINT_TRAILER_BYTES ||
      bytes.byteLength > MAX_CHECKPOINT_BYTES) return false;
  const footerAt = bytes.byteLength - MORIA_CHECKPOINT_TRAILER_BYTES;
  const footer = bytes.subarray(footerAt);
  if (!equalBytes(footer.subarray(0, 8), encoder.encode(MORIA_CHECKPOINT_TRAILER_MAGIC))) return false;
  const view = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
  if (view.getUint32(8, true) !== MORIA_CHECKPOINT_TRAILER_SCHEMA) return false;
  if (!equalBytes(footer.subarray(12, 32), sourceBytes)) return false;
  const payloadLength = view.getUint32(32, true);
  if (payloadLength !== MORIA_CHECKPOINT_PAYLOAD_BYTES ||
      payloadLength > MORIA_CHECKPOINT_PAYLOAD_MAX_BYTES ||
      payloadLength > footerAt - 4) return false;
  const payload = bytes.subarray(footerAt - payloadLength, footerAt);
  if (view.getUint32(36, true) !== fnv1a32(payload)) return false;
  return isSupportedMoriaVersion(bytes[0]!, bytes[1]!, bytes[2]!)
    && validateCheckpointPayload(payload);
}

function validateCheckpointPayload(payload: Uint8Array): boolean {
  if (payload.byteLength !== MORIA_CHECKPOINT_PAYLOAD_BYTES) return false;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const booleanOffsets = [5, 6, 8, 9, 60, 61, 62, 11_157];
  if (booleanOffsets.some((offset) => payload[offset]! > 1)) return false;
  const seed = view.getUint32(0, true);
  if (seed === 0 || seed >= 0x7fff_ffff) return false;
  const nextMonster = view.getInt16(63, true);
  if (nextMonster < 2 || nextMonster > 125) return false;
  const row = view.getInt32(10, true), column = view.getInt32(14, true);
  const top = view.getInt32(18, true), bottom = view.getInt32(22, true);
  const left = view.getInt32(26, true), right = view.getInt32(30, true);
  const columnPrint = view.getInt32(34, true), rowPrint = view.getInt32(38, true);
  const maxRows = view.getInt16(42, true), maxColumns = view.getInt16(44, true);
  if ((maxRows !== 0 && maxRows !== 4) || (maxColumns !== 0 && maxColumns !== 4) ||
      row < 0 || row > maxRows || column < 0 || column > maxColumns ||
      top !== row * 11 || bottom !== top + 21 || rowPrint !== top - 1 ||
      left !== column * 33 || right !== left + 65 || columnPrint !== left - 13) return false;

  const storesAt = 317, storeBytes = 1_164;
  for (let index = 0; index < 6; index++) {
    const storeAt = storesAt + index * storeBytes;
    if (payload[storeAt + 6]! >= 18 || payload[storeAt + 7]! > 24) return false;
    for (let itemIndex = 0; itemIndex < 24; itemIndex++) {
      const itemAt = storeAt + 12 + itemIndex * 48 + 4;
      if (view.getUint16(itemAt, true) >= 420 || payload[itemAt + 2]! >= 56 ||
          !payload.subarray(itemAt + 3, itemAt + 16).includes(0)) return false;
    }
  }
  for (const offset of [11_141, 11_145]) {
    const y = view.getInt32(offset, true), x = view.getInt32(offset + 4, true);
    if (y < 0 || y >= 24 || x < 0 || x >= 80) return false;
  }
  return true;
}

export function fnv1a32Hex(bytes: Uint8Array): string {
  return fnv1a32(bytes).toString(16).padStart(8, "0");
}

/** Strict validation for portable volume contents. Runtime recovery scanning
 * is deliberately tolerant so it can fall back past a torn generation; an
 * imported archive instead has to be wholly canonical and self-consistent. */
export function validateMoriaRecoveryFiles(
  files: ReadonlyMap<string, Uint8Array>,
): void {
  const recovery = [...files].filter(([path]) => path.startsWith(`${MORIA_RECOVERY_DIR}/`));
  const checkpoints = new Map<number, Uint8Array>();
  const commits = new Map<number, RecoveryCommit>();
  const terminals = new Map<number, TerminalCommit>();
  for (const [path, bytes] of recovery) {
    const name = path.slice(MORIA_RECOVERY_DIR.length + 1);
    if (name === ".pending.sav") throw new Error("Moria recovery contains an unpublished pending checkpoint");
    let generation = artifactGeneration(name, "checkpoint", "sav");
    if (generation !== null) {
      if (!validateMoriaCheckpoint(bytes)) throw new Error(`invalid Moria checkpoint: ${path}`);
      checkpoints.set(generation, bytes);
      continue;
    }
    generation = artifactGeneration(name, "commit", "json");
    if (generation !== null) {
      const value = decodeJson(bytes);
      if (!isCommit(value, generation) || !exactKeys(value, [
        "ancestor", "checksum", "file", "generation", "schema", "size",
      ])) throw new Error(`invalid Moria checkpoint commit: ${path}`);
      commits.set(generation, value);
      continue;
    }
    generation = artifactGeneration(name, "terminal", "json");
    if (generation !== null) {
      const value = decodeJson(bytes);
      if (!isTerminal(value, generation) || !exactKeys(value, ["generation", "schema", "terminal"]))
        throw new Error(`invalid Moria terminal tombstone: ${path}`);
      terminals.set(generation, value);
      continue;
    }
    throw new Error(`non-canonical Moria recovery artifact: ${path}`);
  }
  if (checkpoints.size > KEEP_GENERATIONS || commits.size > KEEP_GENERATIONS)
    throw new Error("Moria recovery contains too many checkpoint generations");
  if (terminals.size > 1) throw new Error("Moria recovery contains multiple terminal tombstones");
  if (checkpoints.size !== commits.size)
    throw new Error("Moria recovery contains an orphaned checkpoint or commit");
  for (const [generation, commit] of commits) {
    const bytes = checkpoints.get(generation);
    if (!bytes || commit.size !== bytes.byteLength || commit.checksum !== fnv1a32Hex(bytes))
      throw new Error(`Moria checkpoint generation ${generation} does not match its commit`);
  }

  const game = files.get("game.sav");
  const terminal = [...terminals.keys()][0];
  const newestCheckpoint = Math.max(0, ...commits.keys());
  if (terminal !== undefined) {
    if (game) throw new Error("a terminal Moria volume cannot contain game.sav");
    if (terminal <= newestCheckpoint)
      throw new Error("the Moria terminal tombstone is not newer than every checkpoint");
  } else if (commits.size > 0) {
    const digest = game ? fnv1a32Hex(game) : null;
    for (const commit of commits.values()) {
      if (commit.ancestor !== digest) throw new Error(game
        ? "Moria checkpoint does not descend from the exact explicit save"
        : "Moria checkpoint has an explicit-save ancestor but no explicit save");
    }
  }
}

function fnv1a32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul((hash ^ byte) >>> 0, 0x01000193) >>> 0;
  return hash;
}

function scanRecovery(FS: MoriaRecoveryFS, root: string): {
  valid: ValidGeneration[];
  terminalGeneration: number;
  maxGeneration: number;
} {
  const directory = `${root}/${MORIA_RECOVERY_DIR}`;
  const names = recoveryNames(FS, directory);
  let maxGeneration = 0;
  let terminalGeneration = 0;
  const valid: ValidGeneration[] = [];
  for (const name of names) {
    const anyGeneration = artifactGenerationAny(name);
    if (anyGeneration !== null) maxGeneration = Math.max(maxGeneration, anyGeneration);

    const terminalGenerationInName = artifactGeneration(name, "terminal", "json");
    if (terminalGenerationInName !== null) {
      const generation = terminalGenerationInName;
      const value = readJson(FS, `${directory}/${name}`);
      if (isTerminal(value, generation) && exactKeys(value, ["generation", "schema", "terminal"]))
        terminalGeneration = Math.max(terminalGeneration, generation);
      continue;
    }

    const commitGeneration = artifactGeneration(name, "commit", "json");
    if (commitGeneration === null) continue;
    const generation = commitGeneration;
    const value = readJson(FS, `${directory}/${name}`);
    if (!isCommit(value, generation) || !exactKeys(value, [
      "ancestor", "checksum", "file", "generation", "schema", "size",
    ])) continue;
    const path = `${directory}/${value.file}`;
    const bytes = readRegularFile(FS, path);
    if (!bytes || bytes.byteLength !== value.size || fnv1a32Hex(bytes) !== value.checksum ||
        !validateMoriaCheckpoint(bytes)) continue;
    valid.push({ commit: value, path });
  }
  valid.sort((a, b) => b.commit.generation - a.commit.generation);
  return { valid, terminalGeneration, maxGeneration };
}

function selectRecovery(
  FS: MoriaRecoveryFS,
  root: string,
  scan: ReturnType<typeof scanRecovery>,
): string {
  const explicit = digestFile(FS, `${root}/game.sav`);
  for (const candidate of scan.valid) {
    if (candidate.commit.generation <= scan.terminalGeneration) continue;
    if (explicit !== null && candidate.commit.ancestor !== explicit) continue;
    if (explicit === null && candidate.commit.ancestor !== null) continue;
    return candidate.path;
  }
  return "";
}

function pruneRecovery(
  FS: MoriaRecoveryFS,
  root: string,
  scan: Readonly<ReturnType<typeof scanRecovery>>,
  publishedGeneration: number,
): void {
  const directory = `${root}/${MORIA_RECOVERY_DIR}`;
  repairRecovery(FS, root, scan, false);
  for (const name of recoveryNames(FS, directory)) {
    const generation = artifactGeneration(name, "terminal", "json");
    if (generation !== null && generation < publishedGeneration)
      unlinkIfPresent(FS, `${directory}/${name}`);
  }
}

function repairRecovery(
  FS: MoriaRecoveryFS,
  root: string,
  scan: ReturnType<typeof scanRecovery>,
  removePending: boolean,
): void {
  const directory = `${root}/${MORIA_RECOVERY_DIR}`;
  const keep = new Set(scan.valid.slice(0, KEEP_GENERATIONS)
    .map(({ commit }) => commit.generation));
  const newestCheckpoint = scan.valid[0]?.commit.generation ?? 0;
  const keepTerminal = scan.terminalGeneration > newestCheckpoint
    ? scan.terminalGeneration : 0;
  for (const name of recoveryNames(FS, directory)) {
    if (removePending && name === ".pending.sav") {
      unlinkIfPresent(FS, `${directory}/${name}`);
      continue;
    }
    const checkpointGeneration = artifactGeneration(name, "checkpoint", "sav");
    const commitGeneration = artifactGeneration(name, "commit", "json");
    const generation = checkpointGeneration ?? commitGeneration;
    if (generation !== null && !keep.has(generation))
      unlinkIfPresent(FS, `${directory}/${name}`);
    const terminalGeneration = artifactGeneration(name, "terminal", "json");
    if (terminalGeneration !== null && terminalGeneration !== keepTerminal)
      unlinkIfPresent(FS, `${directory}/${name}`);
  }
}

function isCommit(value: unknown, generation: number): value is RecoveryCommit {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RecoveryCommit>;
  return item.schema === COMMIT_SCHEMA && item.generation === generation &&
    item.file === `checkpoint-${generation}.sav` && Number.isSafeInteger(item.size) &&
    (item.size ?? -1) >= 0 && typeof item.checksum === "string" &&
    /^[0-9a-f]{8}$/.test(item.checksum) &&
    (item.ancestor === null || typeof item.ancestor === "string" && /^[0-9a-f]{8}$/.test(item.ancestor));
}

function isTerminal(value: unknown, generation: number): value is TerminalCommit {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TerminalCommit>;
  return item.schema === COMMIT_SCHEMA && item.generation === generation && item.terminal === true;
}

function readJson(FS: MoriaRecoveryFS, path: string): unknown {
  const bytes = readRegularFile(FS, path);
  return bytes ? decodeJson(bytes) : null;
}

function decodeJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > 4096) return null;
  try { return JSON.parse(decoder.decode(bytes)); } catch { return null; }
}

function exactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function digestFile(FS: MoriaRecoveryFS, path: string): string | null {
  const bytes = readRegularFile(FS, path);
  return bytes ? fnv1a32Hex(bytes) : null;
}

function readRegularFile(FS: MoriaRecoveryFS, path: string): Uint8Array | null {
  try {
    if (!FS.analyzePath(path).exists || !FS.isFile(FS.stat(path).mode)) return null;
    return FS.readFile(path, { encoding: "binary" });
  } catch { return null; }
}

function recoveryNames(FS: MoriaRecoveryFS, directory: string): string[] {
  try { return FS.readdir(directory).filter((name) => name !== "." && name !== ".."); }
  catch { return []; }
}

function isRecoveryArtifact(name: string): boolean {
  return name === ".pending.sav" || artifactGenerationAny(name) !== null;
}

function artifactGenerationAny(name: string): number | null {
  return artifactGeneration(name, "checkpoint", "sav") ??
    artifactGeneration(name, "commit", "json") ??
    artifactGeneration(name, "terminal", "json");
}

function artifactGeneration(name: string, kind: string, extension: string): number | null {
  const match = new RegExp(`^${kind}-([1-9][0-9]*)\\.${extension}$`).exec(name);
  if (!match) return null;
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) && generation <= MORIA_RECOVERY_MAX_GENERATION
    ? generation : null;
}

function nextGeneration(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= MORIA_RECOVERY_MAX_GENERATION)
    throw new Error("Moria checkpoint generation space is exhausted");
  return current + 1;
}

function unlinkIfPresent(FS: MoriaRecoveryFS, path: string): void {
  if (FS.analyzePath(path).exists) FS.unlink(path);
}

/** The on-disk version triplet Umoria 5.7.15 will still read. Shared with
 * saveImport so the archive gate and the checkpoint gate cannot diverge. */
export function isSupportedMoriaVersion(major: number, minor: number, patch: number): boolean {
  return major === 5 && minor >= 2 && minor <= 7 && (minor !== 2 || patch >= 2);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((value, i) => value === b[i]);
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

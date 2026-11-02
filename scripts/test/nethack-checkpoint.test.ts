// The cadence gate in src/modules/nethack/checkpoint.ts, at its production
// thresholds. Every other caller either runs the real 20s default without ever
// reaching it (the worker) or turns the wall clock off entirely
// (scripts/test/test-nethack-autosave.mjs passes minIntervalMs: 0), so a sign
// or unit error in `now() - lastMs >= minIntervalMs` would cost the player
// every periodic checkpoint while the suite stayed green. Here the injected
// clock is the only thing that moves between a refused checkpoint and a taken
// one. The mirror itself is covered by test-nethack-autosave.mjs, against the
// real engine and a real IDBFS.
import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_FORMAT, DEFAULT_COMMANDS, DEFAULT_MIN_INTERVAL_MS, MANIFEST_FILE, RECOVER_DIR,
  createCheckpointer, restoreRecoverySet, type CheckpointFS,
} from "../../src/modules/nethack/checkpoint";

const ROOT = "/vect-nethack";
const MANIFEST = `${ROOT}/${RECOVER_DIR}/${MANIFEST_FILE}`;
const LOCK = "0player"; // getlock(): "<uid><plname>", and getuid() is 0 under emscripten
/** level.0's fixed header on wasm32; savelevOf() refuses anything shorter. */
const HEADER_BYTES = 209;

/** A level.0 the mirror can read: only savelev, an int32 at offset 4, is used. */
function level0(savelev: number): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES);
  new DataView(bytes.buffer).setInt32(4, savelev, true);
  return bytes;
}

type Node = { kind: "dir" } | { kind: "file"; data: Uint8Array; mtimeMs: number };

/**
 * Just enough of the emscripten FS to let a checkpoint land. mtimes come from
 * a write counter rather than the injected clock: the gate is what the clock
 * is allowed to decide here, and a stamp that moved with it could hide a
 * refused write behind checkpoint.ts's own "the engine wrote nothing" path.
 */
class FakeFS implements CheckpointFS {
  nodes = new Map<string, Node>([["/", { kind: "dir" }], [ROOT, { kind: "dir" }]]);
  writes = 0;

  mkdir(path: string) { this.nodes.set(path, { kind: "dir" }); }
  writeFile(path: string, data: Uint8Array | string) {
    this.nodes.set(path, {
      kind: "file",
      data: typeof data === "string" ? new TextEncoder().encode(data) : data.slice(),
      mtimeMs: ++this.writes,
    });
  }
  readFile(path: string, opts?: { encoding?: "binary" | "utf8" }): Uint8Array | string {
    const node = this.nodes.get(path);
    if (!node || node.kind !== "file") throw new Error(`ENOENT: ${path}`);
    return opts?.encoding === "utf8" ? new TextDecoder().decode(node.data) : node.data;
  }
  readdir(path: string): string[] {
    const prefix = path === "/" ? "/" : `${path}/`;
    const names = new Set<string>();
    for (const key of this.nodes.keys()) {
      if (key === path || !key.startsWith(prefix)) continue;
      const [name] = key.slice(prefix.length).split("/");
      if (name) names.add(name);
    }
    return [".", "..", ...names];
  }
  unlink(path: string) {
    if (!this.nodes.delete(path)) throw new Error(`ENOENT: ${path}`);
  }
  stat(path: string): { size: number; mtime: Date } {
    const node = this.nodes.get(path);
    if (!node || node.kind !== "file") throw new Error(`ENOENT: ${path}`);
    return { size: node.data.length, mtime: new Date(node.mtimeMs) };
  }
  analyzePath(path: string) { return { exists: this.nodes.has(path) }; }
}

/** A checkpointer on production thresholds, with the clock in the test's hand. */
function harness() {
  const FS = new FakeFS();
  // The hero is on level 1, so the set is level.0 plus the level itself.
  const writeLevels = () => {
    FS.writeFile(`/${LOCK}.0`, level0(1));
    FS.writeFile(`/${LOCK}.1`, new Uint8Array(64));
  };
  writeLevels();

  let clock = 1_000;
  const flushed: number[] = [];
  let flushError: Error | null = null;
  const cp = createCheckpointer({
    FS,
    root: ROOT,
    // Stands in for save_currentstate(): rewrites the level files, which is
    // how the real one proves to maybe() that it ran.
    saveCurrentState: writeLevels,
    suspendBridge: () => () => {},
    flush: async () => {
      if (flushError) throw flushError; // what PersistHandle.flush() does on an IDBFS failure
      flushed.push(clock);
    },
    now: () => clock,
  });

  return {
    cp, FS, flushed,
    advance: (ms: number) => { clock += ms; },
    breakFlush: (err: Error) => { flushError = err; },
  };
}

describe("NetHack checkpoint cadence", () => {
  it("gives the first checkpoint of a session away, before any command or elapsed time", async () => {
    const h = harness();
    expect(await h.cp.maybe()).toBe(true);
    expect(h.FS.analyzePath(MANIFEST).exists).toBe(true);
  });

  it("refuses a checkpoint inside the interval and takes it one ms later", async () => {
    const h = harness();
    // The free first checkpoint is what stamps the clock; without it the gate
    // is never consulted at all.
    expect(await h.cp.maybe()).toBe(true);
    for (let i = 0; i < DEFAULT_COMMANDS; i++) h.cp.command();

    h.advance(DEFAULT_MIN_INTERVAL_MS - 1);
    expect(await h.cp.maybe()).toBe(false);
    expect(h.flushed).toHaveLength(1); // the refusal wrote nothing

    h.advance(1); // the clock is the only thing that changed
    expect(await h.cp.maybe()).toBe(true);
    expect(h.flushed).toHaveLength(2);
  });

  it("needs the command count as well as the interval", async () => {
    const h = harness();
    expect(await h.cp.maybe()).toBe(true);

    h.advance(DEFAULT_MIN_INTERVAL_MS * 10);
    expect(await h.cp.maybe()).toBe(false); // long past the interval, no commands

    for (let i = 0; i < DEFAULT_COMMANDS - 1; i++) h.cp.command();
    expect(await h.cp.maybe()).toBe(false);
    h.cp.command();
    expect(await h.cp.maybe()).toBe(true);
  });

  it("restarts the interval from the checkpoint that landed", async () => {
    const h = harness();
    expect(await h.cp.maybe()).toBe(true);
    for (let i = 0; i < DEFAULT_COMMANDS; i++) h.cp.command();
    h.advance(DEFAULT_MIN_INTERVAL_MS);
    expect(await h.cp.maybe()).toBe(true);

    // The counter reset with it, so the next one needs another full count too.
    for (let i = 0; i < DEFAULT_COMMANDS; i++) h.cp.command();
    h.advance(DEFAULT_MIN_INTERVAL_MS - 1);
    expect(await h.cp.maybe()).toBe(false);
    h.advance(1);
    expect(await h.cp.maybe()).toBe(true);
  });
});

describe("NetHack checkpoint clear", () => {
  it("drops the mirror without throwing when the volume cannot sync", async () => {
    // clear()'s only caller is shim_exit_nhwindows, which awaits it from
    // inside an ASYNCIFY-suspended windowport call at the moment the player
    // has just saved or died. PersistHandle.flush() throws on every IDBFS
    // failure, so a flush outside the guard unwinds out of the exit path and
    // reaches the worker's unhandledrejection handler: the player loses the
    // end of their game to a bare `fatal`.
    const h = harness();
    expect(await h.cp.maybe()).toBe(true);
    expect(h.FS.analyzePath(MANIFEST).exists).toBe(true);

    h.breakFlush(new Error("IDBFS failed"));
    await expect(h.cp.clear()).resolves.toBeUndefined();
    // The set is still gone from the volume; only the push to IndexedDB failed.
    expect(h.FS.analyzePath(MANIFEST).exists).toBe(false);
  });
});

describe("NetHack recovery manifest trust boundary", () => {
  // The volume a manifest sits in can arrive through F4 from anywhere, so
  // restoreRecoverySet() must discard a set that is not shaped like one this
  // build wrote, before any name in it is used as a path. Each case below was
  // run against the unguarded code first: the "../" manifest read the planted
  // file outside the set and went on to the format check, and the oversized
  // one was parsed whole.
  const planted = `${ROOT}/outside`;

  function volumeWith(manifest: unknown): FakeFS {
    const FS = new FakeFS();
    FS.mkdir(`${ROOT}/${RECOVER_DIR}`);
    FS.mkdir(`${ROOT}/save`);
    FS.writeFile(planted, level0(1));
    FS.writeFile(MANIFEST, typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    return FS;
  }

  it("discards a set whose file names leave the recovery directory", () => {
    const FS = volumeWith({
      format: CHECKPOINT_FORMAT, lock: "../outside", savelev: 1, attempts: 0,
      files: [{ name: "../outside", size: HEADER_BYTES, mtimeMs: 1 }],
    });
    const r = restoreRecoverySet(FS, ROOT);
    expect(r.restored).toEqual([]);
    expect(r.reason).toBe("there is no committed recovery set");
    expect(FS.analyzePath(MANIFEST).exists).toBe(false);
    expect(FS.analyzePath(planted).exists).toBe(true); // nothing outside the set is touched
  });

  it("discards a manifest larger than any this build writes without parsing it", () => {
    const files = Array.from({ length: 4000 }, (_, i) => ({ name: `0player.${i}`, size: 1, mtimeMs: 1 }));
    const FS = volumeWith({ format: CHECKPOINT_FORMAT, lock: "0player", savelev: 1, attempts: 0, files });
    expect(FS.stat(MANIFEST).size).toBeGreaterThan(64 * 1024);
    const r = restoreRecoverySet(FS, ROOT);
    expect(r.restored).toEqual([]);
    expect(r.reason).toBe("there is no committed recovery set");
  });

  it("discards a set naming more files than a level set can hold", () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ name: `0player.${i}`, size: 1, mtimeMs: 1 }));
    const FS = volumeWith({ format: CHECKPOINT_FORMAT, lock: "0player", savelev: 1, attempts: 0, files });
    expect(FS.stat(MANIFEST).size).toBeLessThan(64 * 1024); // the count cap, not the byte cap, is what refuses this
    expect(restoreRecoverySet(FS, ROOT).reason).toBe("there is no committed recovery set");
  });

  it("still reads a well-formed manifest", () => {
    const FS = volumeWith({
      format: CHECKPOINT_FORMAT + 1, lock: "0player", savelev: 1, attempts: 0,
      files: [{ name: "0player.0", size: HEADER_BYTES, mtimeMs: 1 }],
    });
    // Past the shape check and into the caller's own format check, which names the number.
    expect(restoreRecoverySet(FS, ROOT).reason).toContain(`format ${CHECKPOINT_FORMAT + 1}`);
  });
});

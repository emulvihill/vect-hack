// The transfer store a load crosses (vect-hack-9h1): the page parks bytes on
// one thread and the next engine worker's mount reads them on another, so this
// is driven against a real IndexedDB implementation rather than a fake of the
// module's own shape — the parts worth pinning (a value that survives a close,
// a store created on first use, a miss that reads as null) are all in the
// database, not in the wrapper.
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  clearPendingImport, clearPendingReset, readPendingImport, readPendingReset,
  stashPendingImport, stashPendingReset,
} from "../../src/backplane/pendingImport";

describe("the pending-import store", () => {
  it("hands parked bytes to the next reader, keyed by volume", async () => {
    const idb = new IDBFactory();
    await stashPendingImport("nethack", new Uint8Array([1, 2, 3]), idb);
    await stashPendingImport("angband", new Uint8Array([9]), idb);

    expect(await readPendingImport("nethack", idb)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await readPendingImport("angband", idb)).toEqual(new Uint8Array([9]));
    // Each read opens the database again, exactly as a fresh worker would.
    expect(await readPendingImport("larn", idb)).toBeNull();
  });

  it("keeps only the last file parked for a volume", async () => {
    const idb = new IDBFactory();
    await stashPendingImport("moria", new Uint8Array([1]), idb);
    await stashPendingImport("moria", new Uint8Array([2]), idb);
    expect(await readPendingImport("moria", idb)).toEqual(new Uint8Array([2]));
  });

  it("clears what it applied, and tolerates clearing nothing", async () => {
    const idb = new IDBFactory();
    await stashPendingImport("larn", new Uint8Array([4]), idb);
    await clearPendingImport("larn", idb);
    expect(await readPendingImport("larn", idb)).toBeNull();
    await expect(clearPendingImport("larn", idb)).resolves.toBeUndefined();
  });

  it("reads as empty without IndexedDB, and refuses to pretend a stash worked", async () => {
    // A worker in a browser that has no IndexedDB still has to boot its game.
    expect(await readPendingImport("nethack", null)).toBeNull();
    await expect(clearPendingImport("nethack", null)).resolves.toBeUndefined();
    // The page, on the other hand, is about to reload on the strength of this.
    await expect(stashPendingImport("nethack", new Uint8Array([1]), null))
      .rejects.toThrow(/IndexedDB is unavailable/);
  });

  it("reads as empty rather than throwing when the store will not open", async () => {
    const broken = {
      open() { throw new Error("SecurityError: storage is blocked"); },
    } as unknown as IDBFactory;
    expect(await readPendingImport("nethack", broken)).toBeNull();
    await expect(stashPendingImport("nethack", new Uint8Array([1]), broken))
      .rejects.toThrow(/SecurityError/);
  });
});

/**
 * The other thing a page can park for a volume (vect-hack-60i): a reset.
 *
 * It shares the database, the timeouts and the never-throw-on-read rule with a
 * parked import, and the one rule of its own is that the two cannot both be
 * waiting — a volume must never be handed a load and a delete at once and left
 * to choose.
 */
describe("the pending-reset flag", () => {
  it("parks and clears per volume, and reads as a plain boolean", async () => {
    const idb = new IDBFactory();
    await stashPendingReset("larn", idb);

    expect(await readPendingReset("larn", idb)).toBe(true);
    expect(await readPendingReset("moria", idb)).toBe(false);

    await clearPendingReset("larn", idb);
    expect(await readPendingReset("larn", idb)).toBe(false);
    await expect(clearPendingReset("larn", idb)).resolves.toBeUndefined();
  });

  it("does not collide with the blob parked for the same volume's id", async () => {
    const idb = new IDBFactory();
    await stashPendingReset("nethack", idb);
    // The reset key is derived from the volume id; a store that keyed them the
    // same would answer this read with the reset marker.
    expect(await readPendingImport("nethack", idb)).toBeNull();
  });

  it("drops a parked import, because the player asked for the opposite", async () => {
    const idb = new IDBFactory();
    await stashPendingImport("angband", new Uint8Array([1, 2, 3]), idb);
    await stashPendingReset("angband", idb);

    expect(await readPendingReset("angband", idb)).toBe(true);
    expect(await readPendingImport("angband", idb)).toBeNull();
  });

  it("is dropped in turn when a save is parked after it", async () => {
    const idb = new IDBFactory();
    await stashPendingReset("moria", idb);
    await stashPendingImport("moria", new Uint8Array([9]), idb);

    expect(await readPendingImport("moria", idb)).toEqual(new Uint8Array([9]));
    expect(await readPendingReset("moria", idb)).toBe(false);
  });

  it("reads as false without IndexedDB, and refuses to pretend a stash worked", async () => {
    expect(await readPendingReset("nethack", null)).toBe(false);
    await expect(clearPendingReset("nethack", null)).resolves.toBeUndefined();
    // The page reloads on the strength of this one.
    await expect(stashPendingReset("nethack", null))
      .rejects.toThrow(/IndexedDB is unavailable/);
  });

  it("reads as false rather than throwing when the store will not open", async () => {
    const broken = {
      open() { throw new Error("SecurityError: storage is blocked"); },
    } as unknown as IDBFactory;
    expect(await readPendingReset("nethack", broken)).toBe(false);
    await expect(stashPendingReset("nethack", broken)).rejects.toThrow(/SecurityError/);
  });
});

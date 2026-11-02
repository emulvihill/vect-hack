// What the page has asked to happen to a volume, parked for the worker that
// can do it: a save blob to load, or a reset that empties the volume.
//
// An import cannot land in a live volume: it is mounted in the engine
// worker's filesystem, and the engine holds its own file handles and its own
// idea of the save. So the page validates the file, parks the bytes here, and
// reloads; the next worker's mount picks them up before the engine runs
// (persistFs.ts). Both ends are the same origin but not the same thread, and
// only IndexedDB is reachable from both — sessionStorage is neither shared
// with a worker nor sized for a volume's megabytes of binary.
//
// One database, one store, keyed by volume id: a blob is parked for exactly
// one game, and parking a second one for the same game replaces the first. A
// reset is parked under a second key for the same volume, and the two are
// mutually exclusive by construction — parking either drops the other in the
// same transaction, so the volume can never be handed two contradictory
// instructions and left to pick one.

const DB_NAME = "vect-hack-transfer";
const STORE = "pendingImport";
/** The reset key for a volume. A suffix rather than a second object store: a
 *  store added later needs a database version bump, and every tab that already
 *  has this one open would have to be asked to close it. */
const resetKey = (volumeId: string) => `${volumeId}:reset`;
/** The read runs inside engine boot, which is held back by a run dependency
 *  until it answers. A database another tab is blocking must not cost the
 *  player their game. */
const IMPORT_TIMEOUT_MS = 5_000;

/** The one call this needs from an IDBFactory, named structurally so a test
 *  can pass fake-indexeddb without the global. */
export interface IndexedDBLike {
  open(name: string, version?: number): IDBOpenDBRequest;
}

function defaultFactory(): IndexedDBLike | null {
  return (globalThis as { indexedDB?: IndexedDBLike }).indexedDB ?? null;
}

/** Park a validated blob for `volumeId`. The caller reloads the page after
 *  this resolves; a rejection means nothing was parked and it must not. */
export async function stashPendingImport(
  volumeId: string, bytes: Uint8Array, idb: IndexedDBLike | null = defaultFactory(),
): Promise<void> {
  if (!idb) throw new Error("IndexedDB is unavailable, so a save cannot be handed to the engine");
  const db = await openTransfer(idb);
  try {
    await write(db, (store) => {
      store.delete(resetKey(volumeId));
      return store.put(bytes, volumeId);
    });
  } finally {
    db.close();
  }
}

/**
 * Park a reset: the next mount of this volume empties it (vect-hack-60i).
 *
 * The same round trip a load takes, and for the same reason — a volume cannot
 * be emptied while an engine is reading it — but this one exists for the tab
 * that cannot reach its engine at all. A save file the engine's own C code
 * chokes on leaves a game that fatals on every boot, with the volume that
 * caused it still in place and nothing on the page able to remove it. The
 * reset runs in the mount, before the engine looks at anything, so it works
 * exactly when the engine does not.
 *
 * Rejects rather than resolving quietly when there is nowhere to park it: the
 * caller reloads the page next, and reloading into the same broken volume
 * having promised the player a reset is worse than saying it failed.
 */
export async function stashPendingReset(
  volumeId: string, idb: IndexedDBLike | null = defaultFactory(),
): Promise<void> {
  if (!idb) throw new Error("IndexedDB is unavailable, so the save cannot be deleted");
  const db = await openTransfer(idb);
  try {
    await write(db, (store) => {
      store.delete(volumeId);
      return store.put(1, resetKey(volumeId));
    });
  } finally {
    db.close();
  }
}

/** Is a reset parked for `volumeId`? Never throws, for the reason
 *  readPendingImport does not: this runs inside engine boot. */
export async function readPendingReset(
  volumeId: string, idb: IndexedDBLike | null = defaultFactory(),
): Promise<boolean> {
  if (!idb) return false;
  try {
    const db = await openTransfer(idb);
    try {
      return await deadline(read(db, resetKey(volumeId)), "read") !== undefined;
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[vect-hack] could not read the pending save reset:", err);
    return false;
  }
}

/** Drop the parked reset, applied or not — a reset that failed must not empty
 *  the volume again on every reload for the rest of its life. */
export async function clearPendingReset(
  volumeId: string, idb: IndexedDBLike | null = defaultFactory(),
): Promise<void> {
  if (!idb) return;
  try {
    const db = await openTransfer(idb);
    try {
      await write(db, (store) => store.delete(resetKey(volumeId)));
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[vect-hack] could not clear the pending save reset:", err);
  }
}

/** The blob parked for `volumeId`, or null. Never throws: this runs in the
 *  boot path, where a transfer store that cannot be read is a missing feature,
 *  not a reason to refuse to start the game. */
export async function readPendingImport(
  volumeId: string, idb: IndexedDBLike | null = defaultFactory(),
): Promise<Uint8Array | null> {
  if (!idb) return null;
  try {
    const db = await openTransfer(idb);
    try {
      const value = await deadline(read(db, volumeId), "read");
      return value instanceof Uint8Array ? value : null;
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[vect-hack] could not read the pending save import:", err);
    return null;
  }
}

/** Drop the parked blob. Called once it has been applied — or once it has been
 *  refused, so a blob this build will never accept cannot be retried on every
 *  reload for the rest of the volume's life. */
export async function clearPendingImport(
  volumeId: string, idb: IndexedDBLike | null = defaultFactory(),
): Promise<void> {
  if (!idb) return;
  try {
    const db = await openTransfer(idb);
    try {
      await write(db, (store) => store.delete(volumeId));
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[vect-hack] could not clear the pending save import:", err);
  }
}

function openTransfer(idb: IndexedDBLike): Promise<IDBDatabase> {
  return deadline(new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the transfer store would not open"));
    // A tab still holding an older version of the database open. Rejecting is
    // right: waiting for it would stall whatever is behind this call.
    request.onblocked = () => reject(new Error("another tab is holding the transfer store open"));
  }), "open");
}

function read(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the parked save could not be read"));
  });
}

/** Settled on the transaction, not the request: a put whose request succeeded
 *  inside a transaction that then aborts was never written, and the caller of
 *  a stash goes straight on to reload the page. */
function write(db: IDBDatabase, run: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return deadline(new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("the transfer transaction was aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("the transfer transaction failed"));
  }), "write");
}

function deadline<T>(work: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the transfer store did not answer the ${what} in ${IMPORT_TIMEOUT_MS}ms`)),
      IMPORT_TIMEOUT_MS,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

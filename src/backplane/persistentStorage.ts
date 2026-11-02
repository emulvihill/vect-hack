// The origin-wide storage grant, the one thing that keeps a save volume out of
// the browser's eviction pool. It is granted to the origin, not to a volume, so
// it is asked for exactly once per page (src/main.ts) rather than once per
// Module or once per worker: four workers asking would be four requests for one
// grant, and StorageManager.persist() is Window-only anyway (lib.webworker.d.ts
// declares persisted() and not persist()), so a worker could not ask at all.
//
// Chrome grants silently on its engagement heuristics, Firefox prompts, and
// Safari does not really honour it. Every one of those answers — including no
// storage manager at all, on older Safari or in an insecure context — is
// reported and otherwise ignored: nothing here may delay or fail engine boot.

/** The two calls this needs, so a test can supply them and a browser without
 *  `navigator.storage` can supply nothing. */
export interface StorageManagerLike {
  persisted(): Promise<boolean>;
  persist(): Promise<boolean>;
}

/** Ask the browser to exempt this origin's storage from eviction. Idempotent:
 *  an already-persisted origin is never asked again, so a reload cannot spend a
 *  second Firefox prompt. Resolves to whether the origin is persisted; never
 *  rejects, and the result is the only thing a caller may act on. */
export async function requestPersistentStorage(
  storage: StorageManagerLike | null = navigatorStorage(),
): Promise<boolean> {
  if (!storage) {
    console.warn("[vect-hack] saves may be evicted: this browser has no storage manager");
    return false;
  }
  try {
    const persistent = await storage.persisted() || await storage.persist();
    if (persistent)
      console.info("[vect-hack] storage is persistent: saves are exempt from eviction");
    else
      console.warn("[vect-hack] saves may be evicted: the browser declined persistence");
    return persistent;
  } catch (err) {
    console.warn("[vect-hack] saves may be evicted: the persistence request failed:", err);
    return false;
  }
}

function navigatorStorage(): StorageManagerLike | null {
  const nav = (globalThis as { navigator?: { storage?: StorageManagerLike } }).navigator;
  return nav?.storage ?? null;
}

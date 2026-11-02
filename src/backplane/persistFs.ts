// Shared Emscripten IDBFS lifecycle: elect one writer, populate its volume,
// and keep engine boot moving when browser persistence is unavailable. It is
// also where an imported save lands: the one moment in a volume's life when
// its contents may be replaced wholesale is between the populate syncfs and
// the engine's first look at it.
import {
  entries, listSaveFiles, packSave, restoreSave, saveFileName, unpackSave,
  type PackSource, type SaveContents, type SaveFS,
} from "./saveBlob.ts";
import { hasCharacter } from "./character.ts";
import {
  clearPendingImport, clearPendingReset, readPendingImport, readPendingReset,
} from "./pendingImport.ts";
import type { ExportedSave } from "./saveExport.ts";
import type { ModuleVolume } from "./volumes.ts";

const SYNC_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

export interface PersistFS {
  filesystems: Record<string, unknown>;
  mkdir(path: string): void;
  mount(type: unknown, opts: Record<string, unknown>, mountpoint: string): void;
  unmount?(mountpoint: string): void;
  symlink(oldpath: string, newpath: string): void;
  syncfs(populate: boolean, callback: (err?: unknown) => void): void;
  lookupPath?(path: string): { node?: { mount?: { idbPersistState?: unknown } } };
}

export interface PersistModule {
  FS: PersistFS;
  addRunDependency(id: string): void;
  removeRunDependency(id: string): void;
}

/** What the canned linkWritableDirs seed needs on top of PersistFS. Every
 *  Engine Build's FS has all of it; a Module that seeds this way declares no
 *  FS interface of its own. */
export interface SeedFS extends PersistFS {
  analyzePath(path: string, dontResolveLastLink?: boolean): { exists: boolean };
  readdir(path: string): string[];
  rmdir(path: string): void;
  unlink(path: string): void;
}

export interface SeedModule extends PersistModule {
  FS: SeedFS;
}

export interface LockManagerLike {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: boolean },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
}

/**
 * Why this tab cannot save, as one of three classes a player can act on
 * (vect-hack-dem).
 *
 * The prose that used to be all there was cannot carry copy: "IDBFS is not
 * linked into this build" and "IndexedDB is unavailable: TypeError: ..." are
 * two developer facts and one player fact — this browser will not keep your
 * game — and no function can turn the first into the second by reading it. So
 * the class is decided here, at the site that knows which failure it was, and
 * the sentence is chosen on the page (src/ui/saveRisk.ts).
 *
 * Three, not seven, because what the player does about it differs three ways:
 * close the other tab, use a browser that can, or reload and try again.
 */
export type SessionOnlyCode = "another-tab" | "browser-cannot" | "setup-failed";

export interface SessionOnlyReason {
  code: SessionOnlyCode;
  /** The developer sentence, spliced exception text and all. console.warn's,
   *  and nothing else's: the screen is shown the code, never this. */
  detail: string;
}

/** Five of the seven sites are one class — every way a browser can refuse to
 *  hold bytes for us reads the same to the player. */
function browserCannot(detail: string): SessionOnlyReason {
  return { code: "browser-cannot", detail };
}

export interface PersistHandle {
  readonly ready: Promise<boolean>;
  readonly persistent: boolean;
  /** null exactly when this tab owns a durable volume. */
  readonly reason: SessionOnlyReason | null;
  flush(): Promise<void>;
  /** Pack this tab's save as it stands — the volume when there is one, and the
   *  Module's session-only paths when there is not (vect-hack-47a). Throws
   *  when this tab has nothing to export; answerExportRequest (saveExport.ts)
   *  shapes that into the reply, keeping the wire envelope out of the
   *  persistence layer. */
  exportSave(now: Date): ExportedSave;
  release(): void;
}

export interface MountOptions {
  locks?: LockManagerLike | null;
  /** root is the mounted volume, or null for session-only engine paths. */
  seed(FS: PersistFS, root: string | null): void;
  beforeFlush?(FS: PersistFS): void;
  onPopulated?(FS: PersistFS): void;
  /** A Module's own gate on an imported volume, run before a byte of the
   *  existing one is touched. The manifest's game id is checked here for every
   *  Module; anything beyond that — Moria's exact runtime-file archive gate —
   *  is knowledge only the Module has. Throw to refuse the import. */
  validateImport?(FS: SaveFS, contents: SaveContents): void;
  /**
   * Where this Module's save lives when there is no volume, in the names the
   * volume would give it (vect-hack-47a).
   *
   * A session-only tab is not a tab without a game. `seed(FS, null)` hands the
   * engine real writable paths in its own tree and the player then plays a
   * real character there for hours — the character most at risk, because
   * nothing behind it is being written to IndexedDB. Declaring the layout here
   * is what lets F3 pack that character into a blob F4 can load, and it is a
   * declaration only the Module can make: the Backplane cannot tell an
   * engine's save directory from the read-only data sitting beside it.
   *
   * The names must be the volume's own, because that is the whole trick — a
   * blob is relative paths plus bytes, and every Module's session-only seed
   * puts the same relative names in a different place. A Module that declares
   * nothing here keeps the old answer: there is nothing to export.
   */
  sessionSave?: PackSource;
}

interface State {
  persistent: boolean;
  /** Is the volume mounted under this FS? Not the same question as
   *  `persistent`, and exportSave is where they come apart: release() gives
   *  the volume up without unmounting it or re-seeding, so the engine goes on
   *  writing through the symlink farm into a mount this tab no longer owns.
   *  Where the bytes ARE is this flag; whether they are ours to write is
   *  `persistent`. */
  mounted: boolean;
  reason: SessionOnlyReason | null;
  releaseLock: (() => void) | null;
  /** release() ran: this tab has given the volume up, whatever setUp is
   *  still awaiting. Nothing may claim persistence again after it is set. */
  released: boolean;
}

export function mountVolume(
  mod: PersistModule, volume: ModuleVolume, options: MountOptions,
): PersistHandle {
  const state: State = {
    persistent: false,
    mounted: false,
    // Never reported: setUp's `finally` overwrites it on every path that can
    // reach the report. It is a real reason rather than null because
    // exportSave can be called against it before `ready` settles, and the
    // class that fits a mount still in flight is the one whose answer is
    // "try again".
    reason: { code: "setup-failed", detail: "storage is still starting up" },
    releaseLock: null,
    released: false,
  };
  const runDependency = `${volume.mountpoint.slice(volume.mountpoint.lastIndexOf("-") + 1)}-idbfs`;
  mod.addRunDependency(runDependency);
  const ready = setUp(mod, volume, options, state, runDependency);

  return {
    ready,
    get persistent() { return state.persistent; },
    get reason() { return state.reason; },
    async flush() {
      if (!state.persistent) return;
      try {
        options.beforeFlush?.(mod.FS);
      } catch (err) {
        console.warn(`[vect-hack] could not prepare ${volume.mountpoint} for persistence:`, err);
        throw err;
      }
      const queuedErr = await waitForAutoPersist(mod.FS, volume.mountpoint);
      if (queuedErr) {
        console.warn(`[vect-hack] could not drain ${volume.mountpoint} auto-persist:`, queuedErr);
        throw queuedErr;
      }
      const err = await syncOnce(mod.FS, false);
      if (err) {
        console.warn(`[vect-hack] could not persist ${volume.mountpoint}:`, err);
        throw err;
      }
    },
    exportSave(now) {
      // Where this tab's save actually is. The mounted volume when there is
      // one — which outlives release(), because release neither unmounts nor
      // re-seeds and the engine keeps writing there. Otherwise the Module's
      // session-only paths, which is the whole of vect-hack-47a: that tab is
      // playing a real character and used to be the only one refused.
      const source: PackSource | undefined =
        state.mounted ? { root: volume.mountpoint } : options.sessionSave;
      if (!source) {
        // Reached only by a Module that declares no session-only layout. No
        // reason spliced in: the save menu shows this message to the player,
        // and a reason carries exception text (vect-hack-dem). The console
        // keeps the detail, and the banner has already said which of the three
        // things went wrong, in words that name an action.
        throw new Error("there is nothing to export — this tab has no save volume");
      }
      // The same preparation a flush does, under the same condition flush
      // imposes: whatever the Module stages into the volume on its way to
      // IndexedDB belongs in the exported blob too — but staging is a WRITE,
      // and a tab that is not persistent has either no volume to write to or
      // no right to write to it. Exporting must never be the one call that
      // reaches into a volume this tab has handed to another.
      if (state.persistent) {
        try {
          options.beforeFlush?.(mod.FS);
        } catch (err) {
          console.warn(`[vect-hack] could not prepare ${volume.mountpoint} for export:`, err);
          throw err;
        }
      }
      // PersistFS and SaveFS are two views of one object — Emscripten's FS —
      // that cannot be stated as one interface: each Module extends PersistFS
      // with its own declarations of `stat` and `readFile`, and TypeScript
      // requires inherited members to be identical, not merely compatible. A
      // build whose FS were missing a call would fail on that call by name
      // ("fs.readdir is not a function"), so probing first would add nothing.
      const fs = mod.FS as unknown as SaveFS;
      // F3 refuses a save with nobody in it (vect-hack-70x). Asked here rather
      // than inside packSave because packing is the one thing that must stay
      // able to copy a volume exactly as it is — the checkpoint tests pack
      // volumes that are deliberately half-built — and because this is the
      // seam the player pressed a key on: the message goes back through
      // answerExportRequest as the export's own failure and the save menu
      // shows it. A file the player files away believing it holds their game
      // is worse than no file, and it is the one they reach for later.
      if (!hasCharacter(volume, listSaveFiles(fs, source))) {
        // No dash in it: the save menu splices this into "Could not export
        // your save — ...", and a second dash reads as a stutter.
        throw new Error(
          `there is no saved character in your ${volume.id} game yet;`
          + " use the game's own save command first, then press F3");
      }
      return {
        bytes: packSave(fs, volume, now, source),
        filename: saveFileName(volume, now),
      };
    },
    release() {
      state.released = true;
      state.persistent = false;
      state.reason = {
        code: "another-tab", detail: "the save volume was handed to another tab",
      };
      state.releaseLock?.();
      state.releaseLock = null;
    },
  };
}

/** The two calls clearDanglingLink needs; every built FS has both. */
interface LinkFS {
  analyzePath(path: string, dontResolveLastLink?: boolean): { exists: boolean };
  unlink(path: string): void;
}

/** Retire an engine-root link left pointing into an unmounted volume. A seed
 *  that fails after linking — and the `finally` that unmounts under one that
 *  succeeded — leaves the farm dangling, and the session-only retry then reads
 *  those paths as absent (analyzePath follows the link) and hits EEXIST on the
 *  link node. Only a link that no longer resolves is removed: a real preload
 *  directory is left for the Module's own policy to refuse. */
export function clearDanglingLink(FS: LinkFS, path: string): void {
  if (FS.analyzePath(path).exists) return;
  if (!FS.analyzePath(path, true).exists) return;
  FS.unlink(path);
}

/** The canned seed for an engine that roots its writable data in a preload
 *  tree: keep that tree intact and replace only its empty writable
 *  directories with links into the volume. Session-only (root === null)
 *  leaves plain directories in their place instead. A Module declares this
 *  behaviour with two facts — the preload base and the directory names. */
export function linkWritableDirs(
  FS: SeedFS, root: string | null, base: string, dirs: readonly string[],
): void {
  if (root === null) {
    for (const dir of dirs) {
      const path = `${base}/${dir}`;
      // The link an earlier attempt installed here outlived its volume.
      clearDanglingLink(FS, path);
      if (!FS.analyzePath(path).exists) FS.mkdir(path);
    }
    return;
  }

  // Check every preload collision before changing any of them. A packaged
  // file is user/game data from this policy's point of view: never remove it.
  for (const dir of dirs) {
    const path = `${base}/${dir}`;
    if (!FS.analyzePath(path).exists) continue;
    if (entries(FS, path).length) throw new Error(`${path} is not empty`);
  }

  for (const dir of dirs) {
    const target = `${root}/${dir}`;
    const link = `${base}/${dir}`;
    if (!FS.analyzePath(target).exists) FS.mkdir(target);
    if (FS.analyzePath(link).exists) FS.rmdir(link);
    FS.symlink(target, link);
  }
}

/** What replacing a volume needs on top of reading and writing one. Every
 *  Engine Build's FS has both calls; they are declared apart from SaveFS
 *  because packing a volume must never be able to remove anything from it. */
export interface ImportFS extends SaveFS {
  unlink(path: string): void;
  rmdir(path: string): void;
}

/**
 * Replace the volume's contents with an imported blob.
 *
 * Replace, not merge: a blob is a whole volume, and merging one over another
 * leaves two characters interleaved — one game's save beside the other's score
 * file, each of them true and the pair of them nonsense.
 *
 * Nothing is removed until the blob has been matched to this volume and has
 * passed the Module's own gate, so a refused import costs the player nothing.
 * Past that point the volume is briefly neither one save nor the other; the
 * caller runs before the engine, and a write that fails there fails a volume
 * the player has already agreed to give up.
 */
export function applyImport(
  FS: ImportFS,
  volume: ModuleVolume,
  contents: SaveContents,
  validate?: (FS: SaveFS, contents: SaveContents) => void,
): void {
  if (contents.manifest.game !== volume.id) {
    throw new Error(
      `this is a ${contents.manifest.game} save; the ${volume.id} volume cannot take it`);
  }
  validate?.(FS, contents);
  emptyVolume(FS, volume.mountpoint);
  restoreSave(FS, volume, contents);
}

function emptyVolume(FS: ImportFS, root: string): void {
  for (const name of entries(FS, root)) {
    const path = `${root}/${name}`;
    if (FS.isDir(FS.stat(path).mode)) {
      emptyVolume(FS, path);
      FS.rmdir(path);
    } else {
      FS.unlink(path);
    }
  }
}

/**
 * Tell the player something from inside the mount.
 *
 * An import is settled before the Module has a view, a session, or a protocol
 * message of its own in flight, so the outcome has no other way out. Every
 * Module's worker->main union carries the Backplane's `notice` and
 * EngineSession routes it, which is exactly what makes this the Backplane's to
 * post.
 */
function notifyPlayer(text: string): void {
  console.warn("[vect-hack]", text);
  postToPage({ type: "notice", text }, "could not report the import");
}

/**
 * Tell the page this tab cannot save at all (vect-hack-dem).
 *
 * Deliberately not notifyPlayer: that is the message strip, which is where
 * this warning used to be and where it scrolled away behind the engine's own
 * first messages. What crosses here is the code alone — main.ts turns it into
 * a sentence and a banner (src/ui/saveRisk.ts) — and the detail stays on the
 * console line below, which is unchanged. A player never reads
 * "TypeError: ..."; a developer with the console open reads exactly what they
 * read before.
 */
function reportSessionOnly(reason: SessionOnlyReason | null): void {
  console.warn(`[vect-hack] saves are session-only: ${reason?.detail ?? "no reason recorded"}`);
  if (!reason) return;
  postToPage(
    { type: "sessionOnly", code: reason.code }, "could not report the session-only state");
}

/** Post from inside the mount, or don't. Guarded on the absence of a window
 *  because the node test harnesses import this file outside a worker, where
 *  there is nobody to post to. */
function postToPage(message: unknown, what: string): void {
  const scope = globalThis as { postMessage?: (msg: unknown) => void; window?: unknown };
  if (scope.window !== undefined || typeof scope.postMessage !== "function") return;
  try {
    scope.postMessage(message);
  } catch (err) {
    console.warn(`[vect-hack] ${what}:`, err);
  }
}

/** Apply a parked blob, and clear it either way: an import this build refuses
 *  must not be retried on every reload for the rest of the volume's life.
 *  Returns whether the volume changed, which is what owes IndexedDB a sync. */
async function consumePendingImport(
  mod: PersistModule, volume: ModuleVolume, options: MountOptions, bytes: Uint8Array,
): Promise<boolean> {
  let applied = false;
  try {
    // The same "two views of one FS" cast exportSave documents below.
    applyImport(
      mod.FS as unknown as ImportFS, volume, unpackSave(bytes), options.validateImport);
    applied = true;
    notifyPlayer(`Loaded the save file into your ${volume.id} game.`);
  } catch (err) {
    notifyPlayer(`Could not load that ${volume.id} save file — ${String(err)}`);
  }
  await clearPendingImport(volume.id);
  return applied;
}

/**
 * Empty a volume the player asked to be rid of, and clear the request either
 * way (vect-hack-60i).
 *
 * Runs at the same point an import does and for the same reason: this is the
 * one moment the volume's contents may be replaced wholesale. The seed that
 * follows rebuilds the empty layout, so what the engine then boots into is a
 * volume as new as a first visit — which is the point, because the reason to
 * ask for this is an engine that will not boot into the old one.
 *
 * Deliberately not gated on `validateImport`: a Module's import gate exists to
 * refuse other people's bytes, and there are no bytes here. A volume so broken
 * that its own Module's gate rejects it is exactly the volume this must be
 * able to remove.
 */
async function consumePendingReset(
  mod: PersistModule, volume: ModuleVolume,
): Promise<boolean> {
  let emptied = false;
  try {
    emptyVolume(mod.FS as unknown as ImportFS, volume.mountpoint);
    emptied = true;
    notifyPlayer(`Deleted your ${volume.id} save. This is a new game.`);
  } catch (err) {
    notifyPlayer(`Could not delete your ${volume.id} save — ${String(err)}`);
  }
  await clearPendingReset(volume.id);
  return emptied;
}

async function setUp(
  mod: PersistModule,
  volume: ModuleVolume,
  options: MountOptions,
  state: State,
  runDependency: string,
): Promise<boolean> {
  // Started here, awaited at the one point a volume can be replaced. Not
  // awaited yet: the election below is synchronous with the mount call, and a
  // tab that loses it still has to answer for the file the player picked.
  const parkedRead = readPendingImport(volume.id);
  const resetRead = readPendingReset(volume.id);
  let consumed = false;
  try {
    const idbfs = mod.FS.filesystems.IDBFS;
    if (!idbfs) {
      state.reason = browserCannot("IDBFS is not linked into this build");
      return false;
    }

    const locks = options.locks === undefined ? navigatorLocks() : options.locks;
    if (!locks) {
      state.reason = browserCannot("Web Locks are unavailable; this tab cannot safely save");
      return false;
    }
    // release() can land at any await below — every caller of it reaches the
    // handle without awaiting `ready`. A tab that has handed the volume off
    // must not go on to claim it: stop, keep release's own reason rather than
    // a storage one that would misreport why, and let `finally` run the
    // session-only cleanup, dropping a lock a late grant installed.
    const won = await acquireWriter(locks, volume.lock, state);
    if (state.released) return false;
    if (!won) {
      state.reason = {
        code: "another-tab", detail: "another tab is already playing; only it can save",
      };
      return false;
    }

    mod.FS.mkdir(volume.mountpoint);
    mod.FS.mount(idbfs, { autoPersist: true }, volume.mountpoint);
    state.mounted = true;
    const err = await syncOnce(mod.FS, true);
    if (state.released) return false;

    if (err) {
      state.reason = browserCannot(`IndexedDB is unavailable: ${String(err)}`);
      return false;
    }

    // Between the populate and the seed: the volume holds what IndexedDB
    // holds, and nothing has looked at it yet — the only moment its contents
    // can be swapped for another save's. The seed that follows fills in
    // whatever the imported volume did not carry.
    const parked = await parkedRead;
    const resetting = await resetRead;
    if (state.released) return false;
    consumed = true;
    // A reset and an import cannot both be parked — stashing either drops the
    // other — so this is an ordering between two things only one of which can
    // be true, written out rather than left to a reader to work out.
    const emptied = resetting && await consumePendingReset(mod, volume);
    if (state.released) return false;
    const imported = !resetting && parked !== null
      && await consumePendingImport(mod, volume, options, parked);
    if (state.released) return false;

    options.seed(mod.FS, volume.mountpoint);
    options.onPopulated?.(mod.FS);
    // An import both writes and removes files; autoPersist reconciles on its
    // own, but the player was told their save was loaded, so make it true now
    // rather than at whatever the next flush turns out to be. A reset is the
    // same promise about removals: the volume the player deleted must be gone
    // from IndexedDB before they can close the tab on it.
    if (imported || emptied) {
      const importErr = await syncOnce(mod.FS, false);
      if (state.released) return false;
      if (importErr) {
        notifyPlayer(emptied
          ? `Your ${volume.id} save is deleted here but not stored yet: ${String(importErr)}`
          : `The loaded save is not stored yet: ${String(importErr)}`);
      }
    }
    const queuedErr = await waitForAutoPersist(mod.FS, volume.mountpoint);
    if (state.released) return false;
    if (queuedErr) {
      state.reason = browserCannot(`IndexedDB auto-persist is unavailable: ${String(queuedErr)}`);
      return false;
    }
    state.persistent = true;
    state.reason = null;
  } catch (err) {
    state.persistent = false;
    state.reason = {
      code: "setup-failed", detail: `storage setup failed: ${String(err)}`,
    };
  } finally {
    if (!state.persistent) {
      if (state.mounted) {
        try {
          mod.FS.unmount?.(volume.mountpoint);
        } catch (unmountErr) {
          console.warn(`[vect-hack] could not unmount failed ${volume.mountpoint}:`, unmountErr);
        }
        // Cleared whether or not the unmount threw. The seed below points the
        // engine at its session-only paths either way, so that is where the
        // save is from here on, and packing the volume would pack the empty
        // shell the engine has stopped writing to.
        state.mounted = false;
      }
      state.releaseLock?.();
      state.releaseLock = null;
      try {
        options.seed(mod.FS, null);
      } catch (seedErr) {
        console.error("[vect-hack] no writable game paths:", seedErr);
      }
      reportSessionOnly(state.reason);
      // Still parked: this tab never reached the one point where a volume can
      // be replaced. Leave it for the tab that owns the volume rather than
      // dropping the file the player picked. The reason is not spliced in —
      // this one is a player message, and the banner reportSessionOnly just
      // raised is where the why belongs (vect-hack-dem).
      if (!consumed && await parkedRead !== null) {
        notifyPlayer("The save file you loaded is still waiting — this tab does not own the save volume.");
      }
      if (!consumed && await resetRead) {
        notifyPlayer("The save you deleted is still waiting — this tab does not own the save volume.");
      }
    }
    mod.removeRunDependency(runDependency);
  }
  return state.persistent;
}

function acquireWriter(
  locks: LockManagerLike, name: string, state: State,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const decide = (won: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(won);
    };
    const timer = setTimeout(() => decide(false), LOCK_TIMEOUT_MS);
    try {
      void locks
        .request(name, { mode: "exclusive", ifAvailable: true }, (lock) => {
          // A grant that arrives after release() is dropped exactly like one
          // that arrives after the timeout: returning without a hold hands the
          // lock straight back, and deciding now spares boot the full wait.
          if (!lock || state.released) return void decide(false);
          if (settled) return;
          return new Promise<void>((releaseLock) => {
            state.releaseLock = releaseLock;
            decide(true);
          });
        })
        .catch((err: unknown) => {
          console.warn("[vect-hack] could not claim the save volume:", err);
          decide(false);
        });
    } catch (err) {
      console.warn("[vect-hack] Web Locks unavailable:", err);
      decide(false);
    }
  });
}

function syncOnce(FS: PersistFS, populate: boolean): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(err ?? null);
    };
    const timer = setTimeout(
      () => finish(new Error(`syncfs(populate=${populate}) did not answer in ${SYNC_TIMEOUT_MS}ms`)),
      SYNC_TIMEOUT_MS,
    );
    try {
      FS.syncfs(populate, finish);
    } catch (err) {
      finish(err);
    }
  });
}

/** IDBFS autoPersist starts its own reconcile on file close. An explicit
 * final sync racing an older queued snapshot can resolve first and then be
 * overwritten by that older reconcile, falsely reporting durability. Drain
 * the mount's documented queue state before issuing the strict sync. */
function waitForAutoPersist(FS: PersistFS, mountpoint: string): Promise<unknown> {
  const mount = FS.lookupPath?.(mountpoint).node?.mount;
  if (!mount?.idbPersistState) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const finish = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (poll !== undefined) clearTimeout(poll);
      resolve(err);
    };
    const check = () => {
      if (!mount.idbPersistState) return finish(null);
      poll = setTimeout(check, 1);
    };
    const deadline = setTimeout(
      () => finish(new Error(`IDBFS auto-persist did not settle in ${SYNC_TIMEOUT_MS}ms`)),
      SYNC_TIMEOUT_MS,
    );
    check();
  });
}

function navigatorLocks(): LockManagerLike | null {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return nav?.locks ?? null;
}

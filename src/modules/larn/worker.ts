// Web Worker entry for the Larn Module: boots the Engine Build and
// translates the shim's terminal callbacks (globalThis.VectLarn, called from
// EM_JS in src/modules/larn/native/main-wasm.c) into typed protocol messages.
// Display events are one-way; the single blocking request/reply is the key
// wait — Larn's one suspend point, the read(0,&b,1) the shim wraps.
import type { LarnKey, LarnMainToWorker, LarnWorkerToMain } from "./protocol";
import { mountLarnStorage } from "./persist";
import type { PersistHandle, SeedModule } from "../../backplane/persistFs";
import { answerExportRequest } from "../../backplane/saveExport";
import { answerDescribeRequest } from "../../backplane/describe";
import { LarnPersistenceLifecycle } from "./persistenceLifecycle";
import { installLarnShim } from "./shimBridge.ts";

const post = (m: LarnWorkerToMain, transfer?: Transferable[]) => postMessage(m, transfer ?? []);

/** Set when the engine announced its own end (quit). Larn terminates through
 * exit(2) — there is no return to a main loop — and with EXIT_RUNTIME unset
 * the teardown after __real_exit can surface as a worker error. That noise
 * must not chase the quit notice with a phantom "engine died". */
let quitting = false;

self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  if (!quitting) post({ type: "fatal", message: "unhandled rejection: " + String(e.reason) });
});
self.addEventListener("error", (e: ErrorEvent) => {
  if (!quitting) post({ type: "fatal", message: "worker error: " + e.message });
});

let nextId = 1;
const pending = new Map<number, (k: LarnKey) => void>();
let persist: PersistHandle | undefined;
const persistence = new LarnPersistenceLifecycle(() => persist);
/** The engine module, published once the factory resolves — the message
 *  handler needs it, and boot()'s local does not reach here. */
let engine: { ccall: (name: string, ret: string | null, argTypes: string[], args: unknown[]) => unknown } | undefined;

/** Larn's own name for a grid. NULL from C arrives as "" through ccall's
 *  string return, which is the same "nothing to say" the seam wants as null. */
function describeCell(x: number, y: number): string | null {
  if (!engine) return null;
  const text = engine.ccall("vect_larn_describe", "string", ["number", "number"], [x, y]);
  return typeof text === "string" && text ? text : null;
}

onmessage = (e: MessageEvent<LarnMainToWorker>) => {
  if (e.data.type === "describe") {
    answerDescribeRequest(e.data, describeCell, post);
    return;
  }
  if (e.data.type === "release") {
    void persistence.release().then(() => post({ type: "released" }));
    return;
  }
  if (e.data.type === "exportSave") {
    answerExportRequest(e.data.id, persist, post);
    return;
  }
  if (e.data.type === "key") {
    const key = e.data;
    const r = pending.get(key.id);
    pending.delete(key.id);
    persistence.deliverKey(() => r?.({ code: key.code, mods: key.mods }));
  }
};

// Installed before the module boots. The C-side signatures, the heap
// copy-outs and the key register all live in the shared bridge
// (./shimBridge.ts); what is left here is only what this host does with the
// stream — post it. The bridge owns keyCode()/keyMods(), so the
// async-gather / sync-getter split (the same one as the Angband worker) is no
// longer written out per host.
installLarnShim({
  name: "src/modules/larn/worker.ts",
  onEvent: (ev) => {
    // The two batches are freshly copied arrays the bridge made for this
    // host alone, so they transfer rather than structured-clone.
    if (ev.name === "map") post({ type: "event", ev }, [ev.records.buffer]);
    else if (ev.name === "status") post({ type: "event", ev }, [ev.record.buffer, ev.names.buffer]);
    else post({ type: "event", ev });
  },
  /** __wrap_readopts (main-wasm.c): a .larnopts option the shim refused.
   * Out-of-band because it is settled before the engine owns a screen — the
   * Backplane notice lands in the HUD's message list, which survives boot. */
  notice: (text) => post({ type: "notice", text }),
  /** __wrap_savegame (main-wasm.c) calls this only after a successful
   * checkpoint or explicit S-save write. Flush the IDBFS volume so it
   * survives a tab close. Called synchronously from C (savegame is
   * NO_ASYNCIFY), so this must not suspend. The flush is fire-and-forget
   * here; quit() awaits it before reporting. */
  saveLanded: () => persistence.saveLanded(),
  /** __wrap_exit (main-wasm.c): the engine's own end — death, win,
   * save-and-quit, a startup fault — reported before the runtime tears
   * down. savedArg is 1 only when the native S-save write succeeded;
   * `saved` is whether its saveLanded flush (or a checkpoint flush) resolved.
   * Require both: upstream deletes checkpoints on every terminal died(), so
   * a non-save end must never inherit a stale checkpoint report. */
  quit: (savedArg) => {
    quitting = true;
    void persistence.quit(savedArg).then((message) => post(message));
  },
  /** A code-0 reply is "no key", which the shim must see as 0 — a LarnKey
   * carrying it is not a key. */
  gatherKey: async (wait, cmd) => {
    const id = nextId++;
    const key = await new Promise<LarnKey>((resolve) => {
      pending.set(id, resolve);
      post({ type: "getKey", id, wait, cmd });
    });
    return key.code === 0 ? null : key;
  },
});

async function boot() {
  // Served from public/modules/larn/ (copied by scripts/build/build-larn-wasm.sh).
  // Same URL construction as the other three workers: keeps Vite's import
  // analysis off the emscripten artifact while resolving under a non-root
  // --base.
  const coreDir = new URL(import.meta.env.BASE_URL + "modules/larn/", self.location.origin).href;
  const { default: createLarnModule } = (await import(/* @vite-ignore */ coreDir + "larn.js")) as {
    default: (opts: Record<string, unknown>) => Promise<unknown>;
  };
  try {
    const options = {
      // Not optional (the Angband worker's hard-won comment applies verbatim):
      // without locateFile the preload package fetches "larn.data" relative to
      // the worker URL and a dev server answers it with index.html at 200.
      locateFile: (p: string) => coreDir + p,
      // stdout is not discarded (unlike Angband's news noise): the few
      // upstream paths that print() directly — missing maze data, usage —
      // bypass lflush entirely, and losing them would hide a broken install.
      print: (t: string) => console.warn("[larn stdout]", t),
      printErr: (t: string) => console.warn("[larn stderr]", t),
      preRun: [
        (mod: SeedModule) => {
          persist = mountLarnStorage(mod);
        },
      ],
      onRuntimeInitialized: () => {
        // The run dependency already held main() back; awaiting here only
        // orders `ready` after the mount has settled one way or the other, so
        // a tab that cannot save has already said so (the Backplane's
        // `sessionOnly`) by the time the view calls itself ready.
        void persist?.ready.then(() => {
          post({ type: "ready" });
        });
      },
    };
    await createLarnModule(options);
    engine = options as unknown as typeof engine;
  } catch (e) {
    if (!quitting) post({ type: "fatal", message: String(e) });
  }
}

void boot();

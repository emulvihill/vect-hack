// Web Worker entry for the Angband Module: boots the Engine Build and
// translates ui-term hook callbacks (globalThis.VectAngband, called from
// EM_ASM/EM_JS in src/modules/angband/native/main-wasm.c) into typed protocol
// messages. Display events are one-way; the single blocking request/reply
// is the key wait — Angband's one suspend point,
// Term_xtra(TERM_XTRA_EVENT, true).
import {
  quitMessage, savedOnQuit,
  type AngbandKey, type AngbandMainToWorker, type AngbandWorkerToMain,
} from "./protocol";
import { createAngbandCheckpoint } from "./angbandCheckpoint";
import { mountAngbandStorage } from "./persist";
import type { PersistHandle, SeedModule } from "../../backplane/persistFs";
import { answerExportRequest } from "../../backplane/saveExport";
import { answerDescribeRequest } from "../../backplane/describe";
import { applyBorgDelay, type BorgConfigFS } from "./borgConfig";

const post = (m: AngbandWorkerToMain, transfer?: Transferable[]) => postMessage(m, transfer ?? []);

self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) =>
  post({ type: "fatal", message: "unhandled rejection: " + String(e.reason) }));
self.addEventListener("error", (e: ErrorEvent) =>
  post({ type: "fatal", message: "worker error: " + e.message }));

let nextId = 1;
const pending = new Map<number, (k: AngbandKey) => void>();
let persist: PersistHandle | undefined;
/** The engine module, published once the factory resolves — the message
 *  handler needs it, and boot()'s local does not reach here. */
let engine: { ccall: (name: string, ret: string | null, argTypes: string[], args: unknown[]) => unknown } | undefined;

/** Angband's own name for a grid. NULL from C arrives as "" through ccall's
 *  string return, which is the same "nothing to say" the seam wants as null. */
function describeCell(x: number, y: number): string | null {
  if (!engine) return null;
  const text = engine.ccall("vect_angband_describe", "string", ["number", "number"], [x, y]);
  return typeof text === "string" && text ? text : null;
}

/** ?borg pacing, held until the volume is populated. The borg reads borg.txt
 * at activation — several prompt round trips after ready — so applying at
 * whichever of message-arrival and ready comes second is always in time. */
let borgDelayMs: number | null = null;
let configFS: BorgConfigFS | undefined;
function applyBorgDelayWhenReady() {
  if (borgDelayMs === null || !configFS) return;
  applyBorgDelay(configFS, borgDelayMs);
  borgDelayMs = null;
}

const checkpoint = createAngbandCheckpoint();
/** The in-flight mirror of the last landed checkpoint. Awaited on quit so a
 * checkpoint taken moments before the end still reaches the volume. */
let flushing: Promise<void> | undefined;
/** Whether a checkpoint's save has reached the volume. Deliberately only set
 * by a checkpoint flush: the quit-path flush cannot tell an engine save
 * (Ctrl-X) from a quit at the birth screen, and understating "your run is
 * safe" is the harmless direction to be wrong in. */
let saved = false;

onmessage = (e: MessageEvent<AngbandMainToWorker>) => {
  if (e.data.type === "describe") {
    answerDescribeRequest(e.data, describeCell, post);
    return;
  }
  if (e.data.type === "release") {
    persist?.release();
    post({ type: "released" });
    return;
  }
  if (e.data.type === "exportSave") {
    answerExportRequest(e.data.id, persist, post);
    return;
  }
  if (e.data.type === "borgDelay") {
    borgDelayMs = e.data.ms;
    // Also visible to C: on_enter_world (native/main-wasm.c) zeroes the
    // player's delay_factor when a pace was asked for, because the borg's
    // pause is delay_factor² + borg_delay_factor² and delay_factor defaults
    // to 40 — a 1.6s floor borg.txt alone cannot go under.
    (globalThis as unknown as { VectAngband: Record<string, unknown> })
      .VectAngband.borgDelayMs = e.data.ms;
    applyBorgDelayWhenReady();
    return;
  }
  if (e.data.type === "key") {
    const r = pending.get(e.data.id);
    pending.delete(e.data.id);
    r?.({ code: e.data.code, mods: e.data.mods });
  }
};

/** The key the engine is about to consume; read back synchronously by
 * wasm_key_code()/wasm_key_mods() after gatherKey resolves (Shelob kept the
 * same split: an async gather, then sync getters). */
let currentKey: AngbandKey = { code: 0, mods: 0 };

// Installed before the module boots; every function is called from C.
(globalThis as Record<string, unknown>).VectAngband = {
  /** cps is a HEAPU32 view over the wchar_t run (UTF-32 under Emscripten);
   * converted to a string here, synchronously, before the view can go
   * stale — only plain data crosses to the main thread. */
  text(x: number, y: number, _n: number, attr: number, rgb: number, cps: Uint32Array) {
    post({ type: "event", ev: { name: "text", x, y, attr, rgb, text: String.fromCodePoint(...cps) } });
  },
  wipe(x: number, y: number, n: number) {
    post({ type: "event", ev: { name: "wipe", x, y, n } });
  },
  curs(x: number, y: number) {
    post({ type: "event", ev: { name: "curs", x, y } });
  },
  clear() { post({ type: "event", ev: { name: "clear" } }); },
  flush() { post({ type: "event", ev: { name: "flush" } }); },
  mapBatch(words: Int32Array) {
    const records = new Int32Array(words);
    post({ type: "event", ev: { name: "map", records } }, [records.buffer]);
  },
  level(width: number, height: number) {
    post({ type: "event", ev: { name: "level", width, height } });
  },
  message(text: string, messageType: number) {
    post({ type: "event", ev: { name: "message", text, messageType } });
  },
  overlay(active: number) {
    post({ type: "event", ev: { name: "overlay", active: active !== 0 } });
  },
  effect(x: number, y: number, codepoint: number, color: number, rgb: number, beam: number) {
    post({
      type: "event",
      ev: { name: "effect", x, y, ch: String.fromCodePoint(codepoint), color, rgb, beam: beam !== 0 },
    });
  },
  async gatherKey(wait: number, cmd: number): Promise<number> {
    // Only command-level requests pace the checkpoint: the engine also polls
    // for keys inside menus and -more- prompts, which are not player turns.
    if (cmd !== 0) checkpoint.command();
    const id = nextId++;
    const key = await new Promise<AngbandKey>((resolve) => {
      pending.set(id, resolve);
      post({ type: "getKey", id, wait: wait !== 0, cmd: cmd !== 0 });
    });
    currentKey = key;
    return key.code === 0 ? 0 : 1;
  },
  keyCode: () => currentKey.code,
  keyMods: () => currentKey.mods,
  /** Asked synchronously from C, immediately before the blocking key wait —
   * it must answer without suspending and without throwing, or it throws
   * across the Asyncify boundary. Checkpointing into a volume that is not
   * persistent would cost a full save_game_checked() for nothing. */
  checkpointDue: () => (persist?.persistent && checkpoint.due() ? 1 : 0),
  /** The engine's verdict on the save it just wrote. A failed save leaves the
   * cadence due on purpose, so the next command boundary retries it. */
  checkpointLanded(ok: number) {
    if (!ok) return;
    checkpoint.landed();
    flushing = (persist?.flush() ?? Promise.resolve()).then(
      () => { saved = true; },
      () => { saved = false; },
    );
  },
  /** quit_aux (native/main-wasm.c's wasm_quit_js): NULL-ness arrives
   * separately from the text, because quit("") is a fault the text alone
   * cannot distinguish from a clean exit. */
  quit(message: string, wasNull: number) {
    void (async () => {
      await flushing;
      const landed = await savedOnQuit(saved, () => persist?.flush() ?? Promise.resolve());
      const classified = quitMessage(message, wasNull !== 0, landed);
      post(classified.type === "quit"
        // The developer sentence, not the code: `quit`'s reason is a
        // console/diagnostic field, and the player-facing half of the
        // session-only state travels as its own message (vect-hack-dem).
        ? {
          ...classified,
          persistent: persist?.persistent ?? false,
          reason: persist?.reason?.detail ?? null,
        }
        : classified);
    })();
  },
};

async function boot() {
  // Served from public/modules/angband/ (copied by scripts/build/build-angband-wasm.sh).
  // Same URL construction as src/modules/nethack/worker.ts: keeps Vite's import
  // analysis off the emscripten artifact while resolving under a non-root
  // --base.
  const coreDir = new URL(import.meta.env.BASE_URL + "modules/angband/", self.location.origin).href;
  const { default: createAngbandModule } = (await import(/* @vite-ignore */ coreDir + "angband.js")) as {
    default: (opts: Record<string, unknown>) => Promise<unknown>;
  };
  try {
    const options: Record<string, unknown> = {
      // Not optional, and the failure without it is silent: the preload
      // package resolves as the bare name "angband.data" (the generated
      // loader is literally `Module["locateFile"] ? locateFile(base, "") :
      // base`), so it fetches relative to the *worker* URL, and a dev server
      // answers /src/modules/angband/angband.data with index.html at status 200. The
      // engine then unpacks 4 KB of HTML as lib/ and dies parsing visuals.
      // .wasm routes through locateFile too once it exists, which this
      // directory form keeps correct.
      locateFile: (p: string) => coreDir + p,
      print: () => {},
      printErr: (t: string) => console.warn("[angband stderr]", t),
      preRun: [
        (mod: SeedModule) => {
          persist = mountAngbandStorage(mod);
        },
      ],
      onRuntimeInitialized: () => {
        // The run dependency already held main() back; awaiting here orders
        // the borg.txt patch after populate, and `ready` after the mount has
        // settled one way or the other.
        void persist?.ready.then(() => {
          // After populate, so the patch lands on the stored borg.txt rather
          // than under it; autoPersist then keeps the two in step.
          configFS = options.FS as unknown as BorgConfigFS;
          applyBorgDelayWhenReady();
          post({ type: "ready" });
        });
      },
    };
    await createAngbandModule(options);
    engine = options as unknown as typeof engine;
  } catch (e) {
    post({ type: "fatal", message: String(e) });
  }
}

void boot();

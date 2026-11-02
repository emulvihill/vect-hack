// The one implementation of the Larn shim's JS side: the object every host
// installs as globalThis.VectLarn, called from the EM_JS blocks in
// src/modules/larn/native/main-wasm.c.
//
// Six hosts install it — src/modules/larn/worker.ts, scripts/dev/bot-gym-larn.mjs,
// scripts/test/larn-play.mjs, scripts/test/test-larn-boot.mjs,
// scripts/test/test-larn-seed.mjs, scripts/test/test-larn-status-tap.mjs — and
// before this file each carried its own literal copy of the contract. Adding
// statusBatch in Phase 1a Task 7 therefore broke four gates at once, at
// runtime, and the fix was a no-op stub pasted into each (vect-hack-dwb).
// A host now DECORATES this bridge instead: it says what it does with the
// event stream and with the four lifecycle callbacks, and the bridge owns
// every C-side signature, every heap copy-out and the key register.
//
// Erasable-only TypeScript with relative .ts import specifiers, because five
// of the six hosts are .mjs files node loads straight from source with no
// bundler (scripts/test/bot-node-import.test.ts is the guard).
//
// Three rules the refactor exists to preserve, all of them load-bearing:
//
//  1. The DISPLAY callbacks fail LOUDLY. A host that answers none of them
//     gets a throw naming the callback and itself, which is exactly what
//     surfaced the missing statusBatch stubs in minutes. A silent no-op
//     default here would hide the next such bug, so there is none.
//  2. The GYM hooks are absent, not defaulted. main-wasm.c reads gymSeed and
//     gymFast through `typeof v.gymSeed === "function"`, so an absent method
//     reads as "off" — and a default would make every host's answer "on".
//     The bridge installs those two properties only when a host supplies them.
//  3. A new DISPLAY callback is a new LarnEvent and an edit to this file
//     alone. Hosts that do not care about it ignore an event name, which is
//     not an edit. A new LIFECYCLE callback (the notice/saveLanded/quit/
//     gatherKey tier) is deliberately still per-host and still loud: those
//     four carry a decision no default can make.
import type { LarnEvent } from "./protocol.ts";

/** What a host answers a key wait with. `null` is "no key" — the reply the
 *  shim reads as code 0. `mods` defaults to 0, the shape the .mjs hosts
 *  already wrote by hand. */
export interface LarnShimKey { code: number; mods?: number }

export interface LarnShimHost {
  /** This host's name, as the message a missing callback throws will print. */
  name: string;
  /** Every display callback, decoded into one typed event stream. Absent
   *  means the host answers none of them, and each one throws when C calls
   *  it — see rule 1 in the header. */
  onEvent?: (ev: LarnEvent) => void;
  /** __wrap_readopts (main-wasm.c): a .larnopts option the shim refused. */
  notice?: (text: string) => void;
  /** __wrap_savegame (main-wasm.c): a checkpoint or S-save reached disk.
   *  Called synchronously from C — savegame() is NO_ASYNCIFY. */
  saveLanded?: () => void;
  /** __wrap_exit (main-wasm.c): the engine's own end. `saved` is 1 only when
   *  the native S-save write itself succeeded. */
  quit?: (saved: number) => void;
  /** The single Asyncify suspend point (the read(0,&b,1) the shim wraps).
   *  The bridge stores what this returns and answers keyCode()/keyMods()
   *  from it, so no host keeps its own key register. */
  gatherKey?: (wait: boolean, cmd: boolean) => LarnShimKey | null | Promise<LarnShimKey | null>;
  /** Gym mode (main-wasm.c __wrap_newgame): the seed, or 0 for "from the
   *  clock". Omit it entirely to leave gym seeding off. */
  gymSeed?: () => number;
  /** Gym mode (main-wasm.c __wrap_sleep): non-zero drops the animation
   *  waits. Omit it entirely to leave them in place. */
  gymFast?: () => number;
}

/** The shape main-wasm.c calls. Loose on purpose: the .mjs hosts are not
 *  typechecked, and C is not either. */
export type LarnShim = Record<string, unknown>;

function missing(host: string, callback: string): never {
  throw new Error(
    `VectLarn.${callback}: ${host} installed no handler for it. Every Larn shim `
    + `display callback must be answered (src/modules/larn/shimBridge.ts).`,
  );
}

/** Build the bridge without installing it — for tests that want to call a
 *  callback directly. Hosts want installLarnShim. */
export function createLarnShim(host: LarnShimHost): LarnShim {
  const onEvent = host.onEvent;
  /** Every display callback lands here, so the loud default is written once
   *  and still names the callback C actually called. */
  const send = (callback: string, ev: LarnEvent): void => {
    if (!onEvent) missing(host.name, callback);
    onEvent(ev);
  };
  /** The key the engine is about to consume, read back synchronously by
   *  wasm_key_code()/wasm_key_mods() after gatherKey resolves. */
  let current = { code: 0, mods: 0 };

  const shim: LarnShim = {
    // Display: signatures match main-wasm.c's EM_JS blocks exactly. `text`
    // arrives already decoded (the shim calls UTF8ToString C-side), and the
    // two batches arrive as live HEAP views — the copy out is the bridge's.
    text: (x: number, y: number, rgb: number, s: string) =>
      send("text", { name: "text", x, y, rgb, text: String(s) }),
    wipe: (x: number, y: number, n: number) => send("wipe", { name: "wipe", x, y, n }),
    curs: (x: number, y: number) => send("curs", { name: "curs", x, y }),
    clear: () => send("clear", { name: "clear" }),
    flush: () => send("flush", { name: "flush" }),
    mapBatch: (view: Int32Array) =>
      send("mapBatch", { name: "map", records: new Int32Array(view) }),
    statusBatch: (view: Int32Array, names: Uint8Array) =>
      send("statusBatch", {
        name: "status", record: new Int32Array(view), names: new Uint8Array(names),
      }),
    level: (width: number, height: number) => send("level", { name: "level", width, height }),
    overlay: (active: number) => send("overlay", { name: "overlay", active: active !== 0 }),
    // __wrap_died: the killer's map glyph as one character code, 0 for none.
    death: (ch: number) =>
      send("death", { name: "death", ch: ch === 0 ? "" : String.fromCharCode(ch) }),

    // Lifecycle: loud too, for the same reason, but per-host by design.
    notice: (text: string) =>
      host.notice ? host.notice(String(text)) : missing(host.name, "notice"),
    saveLanded: () => (host.saveLanded ? host.saveLanded() : missing(host.name, "saveLanded")),
    quit: (saved: number) => (host.quit ? host.quit(saved) : missing(host.name, "quit")),

    gatherKey: async (wait: number, cmd: number): Promise<number> => {
      if (!host.gatherKey) missing(host.name, "gatherKey");
      const key = await host.gatherKey(wait !== 0, cmd !== 0);
      current = key ? { code: key.code, mods: key.mods ?? 0 } : { code: 0, mods: 0 };
      return key ? 1 : 0;
    },
    keyCode: () => current.code,
    keyMods: () => current.mods,
  };

  // Rule 2: present only when the host asked for them. main-wasm.c's typeof
  // check is what makes an absent hook mean "off", and a default would make
  // it mean "on for everyone".
  if (host.gymSeed) shim.gymSeed = host.gymSeed;
  if (host.gymFast) shim.gymFast = host.gymFast;
  return shim;
}

/** Install the bridge as globalThis.VectLarn, which is where every EM_JS
 *  block in main-wasm.c looks for it. Must happen before the module boots. */
export function installLarnShim(host: LarnShimHost): LarnShim {
  const shim = createLarnShim(host);
  (globalThis as Record<string, unknown>).VectLarn = shim;
  return shim;
}

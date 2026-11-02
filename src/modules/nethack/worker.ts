// Web Worker entry: boots the NetHack WASM engine and translates shim
// windowport calls into protocol messages. All wasm-memory decoding happens
// here; the main thread only ever sees plain data.
import type {
  ExtCmd, GlyphCell, MainToWorker, MenuItemData, SelectMenuReply, ShimEvent, WorkerToMain,
} from "./protocol";
import {
  answerInPlace, createCheckpointer, RECOVER_QUERY,
  type Checkpointer, type ShimAnswer,
} from "./checkpoint";
import { installEvalShim } from "./evalShim";
import { answerExportRequest } from "../../backplane/saveExport";
import { answerDescribeRequest } from "../../backplane/describe";
import { PERSIST_ROOT, type PersistFS, type PersistHandle } from "./persist";
import { seedEngineFS } from "./engineBoot";
import { decodeExtCmds, describeScreenCell, writeMenuPicks } from "./wasmAbi";

interface EmModule {
  ccall: (name: string, ret: string | null, argTypes: string[], args: unknown[]) => unknown;
  getValue: (ptr: number, type: string) => number;
  setValue: (ptr: number, value: number, type: string) => void;
  stringToUTF8: (str: string, ptr: number, max: number) => void;
  UTF8ToString: (ptr: number) => string;
  _malloc: (bytes: number) => number;
  /** INSURANCE checkpoint: rewrites the current level and level.0, frees nothing. */
  _save_currentstate: () => void;
  _free: (ptr: number) => void;
  /** pager.c's read-only screen description; see wasmAbi.describeScreenCell. */
  _do_screen_description: (cc: number, looked: number, sym: number, out: number,
                           firstmatch: number, forSupplement: number) => number;
  FS: PersistFS;
  ENV: Record<string, string>;
  addRunDependency: (id: string) => void;
  removeRunDependency: (id: string) => void;
  [k: string]: unknown;
}

// Before the glue is imported, so get_nhuuid()'s eval cannot hit the CSP and
// hang the engine at newgame; see evalShim.ts.
installEvalShim();

const post = (m: WorkerToMain, transfer?: Transferable[]) => postMessage(m, transfer ?? []);

/** The global the shim dispatcher calls by name; see shim_graphics_set_callback. */
const SHIM_BRIDGE = "nethackShimBridge";

/**
 * Point the shim dispatcher at another answering function for the length of
 * one nested wasm call, and hand back the undo. The engine reaches the bridge
 * by name, so the swap has to be a global one.
 *
 * Both callers need the same thing: a windowport call made from inside their
 * nested call must be answered without a round trip to the main thread. The
 * outer bridge returns a real Promise, and Asyncify.handleSleep would take
 * that as a second unwind and overwrite currData — destroying the parked
 * suspension the engine is going to resume from (checkpoint.ts's answerInPlace
 * and the note above maybe()).
 */
function suspendBridge(answer: ShimAnswer): () => void {
  const g = globalThis as Record<string, unknown>;
  const outer = g[SHIM_BRIDGE];
  g[SHIM_BRIDGE] = answer;
  return () => { g[SHIM_BRIDGE] = outer; };
}

self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) =>
  post({ type: "fatal", message: "unhandled rejection: " + String(e.reason) }));
self.addEventListener("error", (e: ErrorEvent) =>
  post({ type: "fatal", message: "worker error: " + e.message }));

let nextId = 1;
const pending = new Map<number, (v: unknown) => void>();
/** Module scope, not boot()'s, because the message handler needs it too: an
 *  export request is answered from the volume, not from the engine. */
let persist: PersistHandle | undefined;
/** The engine module, for the message handler. boot()'s own `mod` stays where
 *  it is; this is the same object, published once the runtime is up. */
let engine: EmModule | undefined;
/** Nothing can be named before the first glyph is drawn or after the windows
 *  come down — the two windows where do_screen_description has no map to
 *  read. */
let mapDrawn = false;
let enginePresent = false;

/**
 * The engine's own name for a map cell, or null when there is nothing honest
 * to say.
 *
 * Not read-only in the strict sense, and the spec says so (the amended
 * read-only bullet, docs/specs/2026-08-18-look-hud-design.md):
 * do_screen_description makes no windowport call on its normal path, but its
 * didlook: tail can construct a temporary object for a remembered glyph that
 * has gone — which costs rnd(2) on the *game* RNG and bumps svc.context.ident
 * (mkobj.c:521) — and marks a named trap seen. That is accepted because it is
 * exactly what NetHack's own autodescribe cursor spends per cell it crosses,
 * and a hover asks at the same rate.
 *
 * The bridge swap covers the one escape hatch: a defensive impossible() inside
 * lookat() would reach pline(), and the outer bridge answers that with a real
 * Promise — a second Asyncify unwind over the suspension this call is nested
 * inside. answerInPlace resolves it without unwinding.
 */
function describeCell(x: number, y: number): string | null {
  if (!engine || !mapDrawn || !enginePresent) return null;
  const restore = suspendBridge(answerInPlace);
  try {
    return describeScreenCell(engine, x, y);
  } finally {
    restore();
  }
}

onmessage = (e: MessageEvent<MainToWorker>) => {
  if (e.data.type === "describe") {
    answerDescribeRequest(e.data, describeCell, post);
    return;
  }
  if (e.data.type === "exportSave") {
    answerExportRequest(e.data.id, persist, post);
    return;
  }
  if (e.data.type === "reply") {
    const r = pending.get(e.data.id);
    pending.delete(e.data.id);
    r?.(e.data.value);
  }
};

function ask(ev: ShimEvent): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    post({ type: "call", id, ev });
  });
}

/* glyph_info layout on wasm32 (include/wintype.h):
   0 glyph i32 | 4 ttychar i32 | 8 framecolor u32 |
   gm: 12 glyphflags u32 | 16 sym.color i32 | 20 sym.symidx i32 |
       24 customcolor u32 | 28 color256idx u16 | 30 tileidx i16 | 32 u ptr */
function decodeGlyph(mod: EmModule, ptr: number): GlyphCell | null {
  if (!ptr) return null;
  const glyph = mod.getValue(ptr, "i32");
  if (glyph < 0) return null; // NO_GLYPH sentinel
  return {
    glyph,
    ch: String.fromCharCode(mod.getValue(ptr + 4, "i32")),
    color: mod.getValue(ptr + 16, "i32"),
    glyphflags: mod.getValue(ptr + 12, "i32"),
  };
}

async function boot() {
  // Served from public/modules/nethack/ (copied by scripts/build/build-nethack-wasm.sh).
  // Absolute runtime URL built off Vite's base (import.meta.env.BASE_URL):
  // keeps vite's import-analysis hands off the module (it's a plain
  // emscripten artifact served from public/modules/, not source) while still
  // resolving correctly under a non-root --base, e.g. /play/ (vect-hack-8xn).
  const coreUrl = new URL(
    import.meta.env.BASE_URL + "modules/nethack/nethack.js",
    self.location.origin,
  ).href;
  const { default: createModule } = (await import(/* @vite-ignore */ coreUrl)) as {
    default: (opts: Record<string, unknown>) => Promise<unknown>;
  };

  let mod: EmModule;
  let blCondition = -1; // STATUS_FIELD.BL_CONDITION, learned after runtime init
  let extCmds: ExtCmd[] | undefined;
  let checkpoint: Checkpointer | undefined;

  // libnhmain.c fills nethackGlobal.constants from js_constants_init(), which
  // main() calls — so at onRuntimeInitialized the object is still empty. The
  // first windowport call is the earliest moment the values exist; announcing
  // before then leaves the map with no glyph offsets (everything classifies as
  // "none" and the 3D view stays black) and BL_CONDITION undecodable.
  let announced = false;
  const announceReady = () => {
    if (announced) return;
    announced = true;
    const ng = (globalThis as Record<string, any>).nethackGlobal;
    blCondition = ng?.constants?.STATUS_FIELD?.BL_CONDITION ?? -1;
    post({ type: "ready", constants: ng?.constants ?? {} });
  };

  // The shim dispatcher calls globalThis[<name>] with pre-converted args;
  // only "p"-typed args arrive as raw wasm pointers (decoded per-call below).
  (globalThis as Record<string, unknown>)[SHIM_BRIDGE] = async (
    name: string, ...args: unknown[]
  ): Promise<unknown> => {
    announceReady();
    const a = args as number[];
    switch (name) {
      case "shim_create_nhwindow":
        return ask({ name: "create_nhwindow", wintype: a[0]! });
      case "shim_clear_nhwindow":
        return ask({ name: "clear_nhwindow", win: a[0]! });
      case "shim_display_nhwindow":
        return ask({ name: "display_nhwindow", win: a[0]!, blocking: args[1] as unknown as boolean });
      case "shim_destroy_nhwindow":
        return ask({ name: "destroy_nhwindow", win: a[0]! });
      case "shim_curs":
        return ask({ name: "curs", win: a[0]!, x: a[1]!, y: a[2]! });
      case "shim_putstr":
        return ask({ name: "putstr", win: a[0]!, attr: a[1]!, text: String(args[2]) });
      case "shim_print_glyph":
        mapDrawn = true;
        return ask({
          name: "print_glyph", win: a[0]!, x: a[1]!, y: a[2]!,
          cell: decodeGlyph(mod, a[3]!)!, bg: decodeGlyph(mod, a[4]!),
        });
      case "shim_start_menu":
        return ask({ name: "start_menu", win: a[0]!, mbehavior: a[1]! });
      case "shim_add_menu": {
        // (win, glyphinfo*, identifier, ch, gch, attr, clr, str, itemflags)
        // fmt "vipi00iisi" types identifier as "i": the EM_JS dispatcher has
        // already dereferenced ANY_P->a_int, so it arrives as a value.
        const item: MenuItemData = {
          glyph: decodeGlyph(mod, a[1]!),
          identifier: a[2] ?? 0,
          accelerator: a[3] ? String.fromCharCode(a[3]!) : "",
          groupAccel: a[4] ? String.fromCharCode(a[4]!) : "",
          attr: a[5]!,
          color: a[6]!,
          text: String(args[7]),
          itemflags: a[8]!,
        };
        return ask({ name: "add_menu", win: a[0]!, item });
      }
      case "shim_end_menu":
        return ask({ name: "end_menu", win: a[0]!, prompt: String(args[1]) });
      case "shim_select_menu": {
        // (win, how, MENU_ITEM_P **menu_list) -> count; *menu_list = malloc'd array
        const reply = (await ask({ name: "select_menu", win: a[0]!, how: a[1]! })) as SelectMenuReply;
        const picks = reply?.picks ?? [];
        const listPtr = a[2]!;
        if (picks.length === 0) {
          mod.setValue(listPtr, 0, "*");
          return picks.length === 0 && reply === null ? -1 : 0;
        }
        mod.setValue(listPtr, writeMenuPicks(mod, picks), "*");
        return picks.length;
      }
      case "shim_yn_function": {
        const query = String(args[0]);
        // getlock() asks this when autosave's mirror is back on disk. The
        // player closed a tab and reopened it; they should find their game,
        // not a question about NetHack's file locking.
        if (query === RECOVER_QUERY) return "r".charCodeAt(0);
        return ask({ name: "yn_function", query, choices: String(args[1]), def: a[2]! });
      }
      case "shim_getlin": {
        const line = (await ask({ name: "getlin", query: String(args[0]) })) as string | null;
        // ESC/cancel convention: buffer set to "\033"
        mod.stringToUTF8(line === null ? "\x1b" : line, a[1]!, 256);
        return undefined;
      }
      case "shim_nhgetch":
        return ask({ name: "nhgetch" });
      case "shim_nh_poskey": {
        // The main loop asking for a key is the one moment the engine is
        // between commands, so autosave rides along here. Nothing may await
        // above these two lines: maybe() calls save_currentstate() before its
        // own first await, and that is only a legal nested wasm call while
        // Asyncify is still Normal. See checkpoint.ts's maybe().
        checkpoint?.command();
        await checkpoint?.maybe();
        const key = (await ask({ name: "nh_poskey" })) as number;
        mod.setValue(a[2]!, 0, "i32"); // mod: keyboard, not click
        return key;
      }
      case "shim_get_ext_cmd":
        return ask({ name: "get_ext_cmd", commands: (extCmds ??= decodeExtCmds(mod)) });
      case "shim_player_selection_or_tty":
        // true => engine drives character creation through generic menus
        return true;
      case "shim_raw_print":
        return ask({ name: "raw_print", text: String(args[0]), bold: false });
      case "shim_raw_print_bold":
        return ask({ name: "raw_print", text: String(args[0]), bold: true });
      case "shim_status_enablefield":
        return ask({
          name: "status_enablefield", fieldidx: a[0]!,
          nm: a[1] ? mod.UTF8ToString(a[1]!) : "",
          fmt: a[2] ? mod.UTF8ToString(a[2]!) : "",
          enable: args[3] as unknown as boolean,
        });
      case "shim_status_update": {
        // ptr arg is a string except for BL_CONDITION where it's a bitmask ptr
        const isCond = a[0] === blCondition;
        return ask({
          name: "status_update", fldidx: a[0]!,
          text: !isCond && a[1] ? mod.UTF8ToString(a[1]!) : null,
          condbits: isCond && a[1] ? mod.getValue(a[1]!, "i32") : 0,
          chg: a[2]!, percent: a[3]!, color: a[4]!,
        });
      }
      case "shim_getmsghistory":
        return (await ask({ name: "getmsghistory", init: args[0] as unknown as boolean })) ?? "";
      case "shim_putmsghistory":
        return ask({ name: "putmsghistory", text: String(args[0]), restoring: args[1] as unknown as boolean });
      case "shim_init_nhwindows": {
        enginePresent = true;
        const r = await ask({ name: "init_nhwindows" });
        // Each windowport sets this itself (see win/tty/wintty.c); the shim
        // only forwards, so we set it through the exposed global. Without it
        // NetHack skips exit_nhwindows() at game over and dumps the score
        // list to raw_print instead.
        const ng = (globalThis as Record<string, any>).nethackGlobal;
        if (ng?.globals?.iflags) ng.globals.iflags.window_inited = true;
        return r;
      }
      case "shim_askname": {
        // name is returned via the exposed svp.plname global, not a buffer
        const nm = (await ask({ name: "askname" })) as string;
        const ng = (globalThis as Record<string, any>).nethackGlobal;
        if (ng?.globals?.svp) ng.globals.svp.plname = nm || "player";
        return undefined;
      }
      case "shim_exit_nhwindows": {
        enginePresent = false;
        // Reached on #save and on death, after the save and the score file
        // have been written. autoPersist has queued those already; this makes
        // sure they have landed before the player can close the tab.
        const r = await ask({ name: "exit_nhwindows", text: String(args[0]) });
        // This one hook covers #save, death and quit alike, and in every case
        // a real save file exists or the game is over — so the mirror is
        // stale, and getlock() must not offer it at the next boot.
        await checkpoint?.clear();
        try {
          await persist?.flush();
        } catch (err) {
          // The engine has already written the save and the score file; only
          // the push to IndexedDB failed. Telling the player is all that is
          // left — the rejection would otherwise unwind out of this suspended
          // windowport call and reach the unhandledrejection handler above,
          // ending the run in a `fatal` at the moment they saved or died.
          post({ type: "notice", text: `Your game may not have been saved — ${String(err)}.` });
        }
        return r;
      }
      case "shim_cliparound":
        return ask({ name: "cliparound", x: a[0]!, y: a[1]! });
      case "shim_status_init":
        return ask({ name: "status_init" });
      case "shim_delay_output":
        return ask({ name: "delay_output" });
      case "shim_nhbell":
        return ask({ name: "nhbell" });
      case "shim_message_menu": {
        // (let, how, mesg) -> the selected letter, 0 for no selection, ESC to
        // cancel. `let` is dropped: winshim.c:139 types the char as "i", so
        // the dispatcher reads a 32-bit word at its unaligned address and
        // emscripten's getValue() rounds that address down to HEAP32 — the
        // letter lands in whichever byte lane the frame layout put it in
        // (0x66000004 for 'f'), and the bridge cannot tell which. mesg
        // carries the letter anyway ("f - 5 lembas wafers"), and getobj()
        // validates whatever comes back (src/invent.c:1979), so the view
        // answers with the key the player pressed.
        return ask({ name: "message_menu", how: a[1]!, text: String(args[2]) });
      }
      case "set_shim_font_name":
        return 0;
      case "shim_get_color_string":
        return "";
      case "shim_doprev_message":
        return 0;
      // sync/no-op family: reply locally, skip a main-thread round trip
      case "shim_get_nh_event": case "shim_mark_synch": case "shim_wait_synch":
      case "shim_suspend_nhwindows": case "shim_resume_nhwindows":
      case "shim_update_positionbar": case "shim_number_pad":
      case "shim_change_color": case "shim_change_background":
      case "shim_preference_update": case "shim_update_inventory":
        return undefined;
      default:
        return ask({ name: "other", shim: name, args: args.map(String) });
    }
  };

  const opts: Record<string, unknown> = {
    print: () => {},
    printErr: (t: string) => console.warn("[nethack stderr]", t),
    preRun: [
      (m: EmModule) => {
        persist = seedEngineFS(m);
        void persist.ready.then((durable) => {
          // Losing a game to storage the player was never told about is worse
          // than the warning — but the warning is the Backplane's banner now,
          // raised from the mount itself (vect-hack-dem). It used to be a
          // message-strip line here carrying the developer sentence, exception
          // text and all, and the strip is where NetHack's own opening
          // messages immediately buried it.
          if (!durable) return; // no volume to mirror into, so no autosave either
          checkpoint = createCheckpointer({
            FS: m.FS,
            root: PERSIST_ROOT,
            // mod only exists from onRuntimeInitialized on; read it per call.
            saveCurrentState: () => mod._save_currentstate(),
            // The checkpoint makes windowport calls of its own, and they must
            // be answered without a round trip to the main thread — anything
            // async there unwinds Asyncify out of the checkpoint. Shared with
            // describeCell(), which needs the same protection.
            suspendBridge,
            flush: () => persist!.flush(),
            onDead: (reason) => post({ type: "notice", text: `Autosave stopped — ${reason}.` }),
          });
        });
      },
    ],
    onRuntimeInitialized: () => {
      mod = opts as unknown as EmModule; // MODULARIZE attaches exports to the opts object
      engine = mod;
      // Constants are announced from the first shim call; see announceReady().
      mod.ccall("shim_graphics_set_callback", null, ["string"], [SHIM_BRIDGE]);
    },
  };

  try {
    await createModule(opts);
  } catch (e) {
    post({ type: "fatal", message: String(e) });
  }
}

void boot();

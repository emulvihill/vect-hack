// Acceptance test for durable saves: drive real NetHack through character
// creation and #save, then reload the page and require the engine to restore
// that game. Everything here goes through the same windowport calls the UI
// answers, so a break in the shim decoding shows up as a stalled session.
//
// node has no IndexedDB, so fake-indexeddb supplies one; it outlives both
// module instances, which is what makes the second boot a genuine reload.
import "fake-indexeddb/auto";
import createModule from "../../external/NetHack/targets/wasm/nethack.js";
import { SAVEFILE, seedEngineFS } from "../../src/modules/nethack/engineBoot.ts";
import { decodeExtCmds, describeScreenCell, writeMenuPicks } from "../../src/modules/nethack/wasmAbi.ts";

// The friendlier first line, not the real bound: this fires only while the
// engine is still yielding to the event loop. A wedged wasm engine never
// yields, so npm runs every engine test under `timeout` (see package.json).
const TIMEOUT_MS = 60000;

const fail = (msg, session) => {
  console.error("FAIL: " + msg);
  if (session) console.error(session.messages.slice(-25).join("\n"));
  process.exit(1);
};

/** Answers to the questions a fresh game asks, matched against the prompt. */
const ANSWER_YES = /Shall I pick|Really save|Is this ok/i;
const ANSWER_NO = /tutorial/i;

/**
 * Load a page and play until the engine tears the windows down. `keys` are fed
 * to nhgetch in order (ESC once exhausted); `command` is the extended command
 * to run when the game asks for one.
 */
function play(label, { keys = [], command = "save" } = {}) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const shim = `driveShim_${label}`;
    let mod, persist, prompt = "", items = [], next = 0;
    let lastWin = 0, mapWin = -1, cursor = null, described = null;
    const globals = () => globalThis.nethackGlobal;

    globalThis[shim] = async (name, ...args) => {
      const a = args;
      switch (name) {
        // --- startup -----------------------------------------------------
        case "shim_init_nhwindows":
          // Ports set this themselves; without it the engine skips
          // exit_nhwindows() at game over. See src/modules/nethack/worker.ts.
          if (globals()?.globals?.iflags) globals().globals.iflags.window_inited = true;
          return 0;
        case "shim_player_selection_or_tty":
          return true; // let the engine drive creation through generic menus
        case "shim_askname":
          if (globals()?.globals?.svp) globals().globals.svp.plname = "player";
          return undefined;

        // --- questions ---------------------------------------------------
        case "shim_yn_function": {
          const q = String(args[0]);
          messages.push(`? ${q}`);
          return ANSWER_YES.test(q) ? "y".charCodeAt(0) : (a[2] || "y".charCodeAt(0));
        }
        case "shim_start_menu": items = []; return 0;
        case "shim_add_menu":
          // fmt "vipi00iisi" types the identifier as a value, not a pointer.
          items.push({ id: a[2], accel: a[3], text: String(args[7]) });
          return 0;
        case "shim_end_menu": prompt = String(args[1]); return 0;
        case "shim_select_menu": {
          const want = (ANSWER_NO.test(prompt) ? "n" : "y").charCodeAt(0);
          const pick = items.find((i) => i.accel === want) ?? items.find((i) => i.id);
          messages.push(`? ${prompt} -> ${pick ? pick.text : "(nothing)"}`);
          if (!pick) { mod.setValue(a[2], 0, "*"); return 0; }
          const list = writeMenuPicks(mod, [{ identifier: pick.id, count: -1, itemflags: 0 }]);
          mod.setValue(a[2], list, "*");
          return 1;
        }
        case "shim_get_ext_cmd": {
          const index = decodeExtCmds(mod).findIndex((c) => c.name === command);
          if (index < 0) fail(`no #${command} in extcmdlist`);
          messages.push(`# ${command}`);
          return index;
        }
        case "shim_nhgetch": case "shim_nh_poskey": {
          if (name === "shim_nh_poskey") mod.setValue(a[2], 0, "i32");
          // Look HUD (spec 2026-08-18): name the cell the engine just parked
          // its cursor on — the hero, at the command prompt. This proves the
          // marshalling against a real heap, which the unit test cannot: it
          // pins the two-int16 layout against a fake one.
          //
          // It does not cover production's calling window. This runs inside
          // the bridge callback before its first await — Asyncify Normal,
          // exportCallStack non-empty, the checkpointer's window — while the
          // worker calls describeCell() from onmessage, on an empty JS stack
          // after the unwind has completed. Both are legal nested calls; only
          // a browser run exercises the second one.
          if (described === null && cursor) {
            described = describeScreenCell(mod, cursor.x, cursor.y);
          }
          return next < keys.length ? keys[next++] : 27; // ESC
        }
        case "shim_getlin": mod.stringToUTF8("\x1b", a[1], 256); return undefined;
        case "shim_getmsghistory": return "";
        case "shim_get_color_string": return "";

        // --- output ------------------------------------------------------
        case "shim_create_nhwindow": {
          // Distinct ids, so shim_curs below can tell the map apart from the
          // message and status windows; every window used to come back 0
          // through the default case, which made that gate meaningless.
          const win = ++lastWin;
          if (a[0] === globals()?.constants?.WIN_TYPE?.NHW_MAP) mapWin = win;
          return win;
        }
        case "shim_curs":
          // Only the map window carries map coordinates; a curs on the
          // message or status line would otherwise seed a bogus cell.
          if (a[0] === mapWin) cursor = { x: a[1], y: a[2] };
          return undefined;
        case "shim_putstr": messages.push(String(args[2])); return undefined;
        case "shim_raw_print": case "shim_raw_print_bold":
          messages.push(String(args[0])); return undefined;
        case "shim_exit_nhwindows": {
          messages.push(String(args[0]));
          await persist.flush();
          const durable = persist.persistent;
          // Both loads share one process; a browser would drop the writer lock
          // when the tab went away, so the reload can claim the volume.
          persist.release();
          resolve({ messages, FS: mod.FS, persistent: durable, described });
          return undefined;
        }

        default: return 0;
      }
    };

    const opts = {
      print: () => {},
      printErr: (t) => messages.push("[stderr] " + t),
      preRun: [(m) => { persist = seedEngineFS(m); }],
      onRuntimeInitialized: () => {
        mod = opts; // MODULARIZE attaches exports to the opts object
        opts.ccall("shim_graphics_set_callback", null, ["string"], [shim]);
      },
    };
    createModule(opts).catch(reject);
    setTimeout(() => reject(new Error(
      `${label}: engine never reached exit_nhwindows\n${messages.slice(-25).join("\n")}`,
    )), TIMEOUT_MS);
  });
}

const find = (session, re) => session.messages.find((m) => re.test(m));

// --- first load: create a character, then #save ---------------------------
const first = await play("first", { keys: ["#".charCodeAt(0)], command: "save" });
if (!first.persistent) fail("first session did not get persistent storage", first);

const hello = find(first, /welcome to NetHack/);
if (!hello) fail("no new-game welcome message", first);
if (!find(first, /Saving\.\.\./)) fail("the engine never saved", first);
if (!first.FS.analyzePath(SAVEFILE).exists) fail("#save left no save file", first);

// "You are a lawful male human Knight." -> "human Knight"
const created = hello.match(/You are an? .*?(\S+ \S+)\.\s*$/)?.[1];
if (!created) fail(`could not read the character from: ${hello}`);

// Look HUD (spec 2026-08-18). Truthiness alone would pass on the name of the
// wrong square — which is the failure a coordinate bug actually produces, and
// the one thing the marshalling's own unit test can never see. self_lookat()
// and welcome() both write gu.urace.adj (pager.c:115, allmain.c:947), so the
// engine's name for the hero's cell must carry the race the welcome line
// announced: "human valkyrie called player" against "human Valkyrie".
const race = created.split(" ")[0].toLowerCase();
if (!first.described || !first.described.toLowerCase().includes(race))
  fail(`do_screen_description named ${JSON.stringify(first.described)} at the hero's `
       + `cell, which does not name a ${race}`, first);

// --- second load: same IndexedDB, so the engine must find that game -------
const second = await play("second", { keys: ["#".charCodeAt(0)], command: "save" });

if (!find(second, /Restoring save file/)) fail("the engine started a new game instead of restoring", second);
const back = find(second, /welcome back to NetHack/);
if (!back) fail("no welcome-back message", second);

// "Konnichi wa player, the human Samurai, welcome back to NetHack!"
const restored = back.match(/, the ([^,]+), welcome back/)?.[1];
if (restored !== created)
  fail(`restored a different character: saved ${created}, got ${restored ?? back}`, second);
if (!second.FS.analyzePath(SAVEFILE).exists) fail("re-saving left no save file", second);

console.log(`OK: #save survived a reload and restored the ${created} (real IDBFS)`);
process.exit(0);

// Smoke test: boot the NetHack WASM module in node and prove the game engine
// reaches the windowport (shim) callback boundary. Success = the engine makes
// >= LIMIT windowport calls into JS (init, window creation, menus, ...).
//
// Boots with the real persistence layer installed, so this also covers the
// engine starting up on top of the symlinked /save and score files (getlock()
// and restore_saved_game() both run before the first menu appears).
import "fake-indexeddb/auto";
import createModule from "../../external/NetHack/targets/wasm/nethack.js";
import { seedEngineFS } from "../../src/modules/nethack/engineBoot.ts";

const LIMIT = 15;
const seen = [];
let constantsAtInit = null;

const fail = (msg) => { console.error("FAIL: " + msg); process.exit(1); };

globalThis.smokeShimCallback = async (name, ..._args) => {
  if (seen.length === 0) {
    // Why src/modules/nethack/worker.ts announces "ready" from the first shim
    // call rather than from onRuntimeInitialized: libnhmain.c fills
    // nethackGlobal.constants in js_constants_init(), which main() calls.
    // Announce too early and the map gets no glyph offsets — every cell
    // classifies as "none" and the 3D view renders nothing at all.
    const c = globalThis.nethackGlobal?.constants ?? {};
    if (constantsAtInit.length !== 0)
      fail(`constants already populated at onRuntimeInitialized: ${constantsAtInit}`);
    if (!(c.GLYPH?.GLYPH_CMAP_OFF > 0))
      fail("GLYPH offsets missing at the first windowport call");
    if (!(c.STATUS_FIELD?.BL_CONDITION >= 0))
      fail("STATUS_FIELD.BL_CONDITION missing at the first windowport call");
  }
  seen.push(name);
  if (seen.length === LIMIT) {
    console.log(`OK: windowport boundary reached (${LIMIT} calls):`);
    console.log("  " + seen.join(", "));
    process.exit(0);
  }
  // The shim validates return types per call; boolean-returning calls get one.
  if (name === "shim_player_selection_or_tty") return false;
  return 0;
};

const opts = {
  print: () => {},
  printErr: () => {},
  preRun: [(mod) => { seedEngineFS(mod); }],
  // Runs after the runtime is up but before main(): the only safe window to
  // register the shim callback (callMain isn't exported by upstream flags).
  onRuntimeInitialized: () => {
    constantsAtInit = Object.keys(globalThis.nethackGlobal?.constants ?? {});
    opts.ccall("shim_graphics_set_callback", null, ["string"], [
      "smokeShimCallback",
    ]);
  },
};

await createModule(opts);

// The friendlier first line, not the real bound: this fires only while the
// engine is still yielding to the event loop. A wedged wasm engine never
// yields, so npm runs every engine test under `timeout` (see package.json).
setTimeout(() => {
  console.error(`FAIL: only ${seen.length}/${LIMIT} windowport calls: ${seen.join(", ")}`);
  process.exit(1);
}, 15000);

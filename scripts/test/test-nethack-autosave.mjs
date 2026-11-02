// Acceptance test for autosave: a game whose tab was closed without saving must
// come back. Real windowport calls, the real checkpointer, and a real IDBFS —
// node has no IndexedDB, so fake-indexeddb supplies one and it outlives every
// module instance, which is what makes each boot a genuine page load.
//
// Sessions are abandoned mid-command on purpose: the handler stops answering
// and the engine stays ASYNCIFY-suspended forever, which is exactly the state a
// closed tab leaves it in. Nothing in that module ever runs again, so the
// process only ends at the process.exit() below.
import "fake-indexeddb/auto";
import createModule from "../../external/NetHack/targets/wasm/nethack.js";
import { PERSIST_ROOT } from "../../src/modules/nethack/persist.ts";
import { seedEngineFS } from "../../src/modules/nethack/engineBoot.ts";
import {
  CHECKPOINT_FORMAT, MANIFEST_FILE, RECOVER_DIR, RECOVER_QUERY, createCheckpointer,
} from "../../src/modules/nethack/checkpoint.ts";

const RECOVER = `${PERSIST_ROOT}/${RECOVER_DIR}`;
const MANIFEST = `${RECOVER}/${MANIFEST_FILE}`;
const LOCK = "0player"; // getlock(): "<uid><plname>", and getuid() is 0 here
// The friendlier first line, not the real bound: this fires only while the
// engine is still yielding to the event loop. A wedged wasm engine never
// yields, so npm runs every engine test under `timeout` (see package.json).
const TIMEOUT_MS = 60000;

const fail = (msg, session) => {
  console.error("FAIL: " + msg);
  if (session) console.error(session.messages.slice(-25).join("\n"));
  process.exit(1);
};

const find = (session, re) => session.messages.find((m) => re.test(m));
const read = (FS, path) => new TextDecoder().decode(FS.readFile(path));

/** Answers to the questions a fresh game asks, matched against the prompt. */
const ANSWER_YES = /Shall I pick|Really save|Is this ok/i;
const ANSWER_NO = /tutorial/i;
/** One safe command per turn: search prompts for nothing and always exists. */
const SEARCH = "s".charCodeAt(0);

/**
 * Load a page, create a character, and search until `checkpoints` mirrors have
 * landed — then abandon the engine where it stands. `checkpoints: 0` stops at
 * the first command, before this session has written anything of its own.
 */
function play(label, { checkpoints = 2 } = {}) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const shim = `driveShim_${label}`;
    let mod, persist, cp, prompt = "", items = [], landed = 0, askedRecover = false;
    const reentered = [];
    const globals = () => globalThis.nethackGlobal;
    const timer = setTimeout(() => reject(new Error(
      `${label}: never reached ${checkpoints} checkpoints\n${messages.slice(-25).join("\n")}`,
    )), TIMEOUT_MS);

    /** Walk away mid-call: hand the session back, and leave the engine waiting
     *  on an answer that never comes. */
    const abandon = () => {
      clearTimeout(timer);
      resolve({ messages, FS: mod.FS, persist, cp, askedRecover, reentered });
      return new Promise(() => {});
    };

    globalThis[shim] = async (name, ...args) => {
      const a = args;
      switch (name) {
        // --- startup -----------------------------------------------------
        case "shim_init_nhwindows":
          // Ports set this themselves. getlock() only offers "Recover [r]"
          // through yn_function when it is set (sys/unix/unixunix.c).
          if (globals()?.globals?.iflags) globals().globals.iflags.window_inited = true;
          return 0;
        case "shim_player_selection_or_tty":
          return true; // let the engine drive creation through generic menus
        case "shim_askname":
          // The lock file and the mirror are named after the character, so
          // every load has to ask for the same one.
          if (globals()?.globals?.svp) globals().globals.svp.plname = "player";
          return undefined;

        // --- questions ---------------------------------------------------
        case "shim_yn_function": {
          const q = String(args[0]);
          messages.push(`? ${q}`);
          // What worker.ts answers itself: the player closed a tab and reopened
          // it, so recover rather than asking them about NetHack's locking.
          if (q === RECOVER_QUERY) { askedRecover = true; return "r".charCodeAt(0); }
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
          const list = mod._malloc(12); // menu_item: identifier, count, itemflags
          mod.setValue(list, pick.id, "i32");
          mod.setValue(list + 4, -1, "i32");
          mod.setValue(list + 8, 0, "i32");
          mod.setValue(a[2], list, "*");
          return 1;
        }
        case "shim_nhgetch": return 27; // ESC: dismisses --More-- and any stray prompt
        case "shim_nh_poskey": {
          mod.setValue(a[2], 0, "i32"); // keyboard, not a click
          if (landed >= checkpoints) return abandon();
          // Mirrors worker.ts: the command is counted and the checkpoint taken
          // before the main thread is awaited. _save_currentstate() may only
          // nest while Asyncify.state is still Normal, so nothing above this
          // line may await.
          cp.command();
          if (await cp.maybe()) landed++;
          // Give up as soon as autosave does, so a session that can no longer
          // checkpoint fails its assertion by name instead of by timeout.
          if (cp.dead) return abandon();
          return SEARCH;
        }
        case "shim_getlin": mod.stringToUTF8("\x1b", a[1], 256); return undefined;
        case "shim_getmsghistory": return "";
        case "shim_get_color_string": return "";

        // --- output ------------------------------------------------------
        case "shim_putstr": messages.push(String(args[2])); return undefined;
        case "shim_raw_print": case "shim_raw_print_bold":
          messages.push(String(args[0])); return undefined;
        case "shim_exit_nhwindows":
          // A closed tab never gets here. If the engine tore the windows down
          // the game ended — died, quit, escaped — and nothing below is
          // measuring what it thinks it is.
          messages.push(String(args[0]));
          clearTimeout(timer);
          reject(new Error(`${label}: the game ended\n${messages.slice(-25).join("\n")}`));
          return undefined;

        default: return 0;
      }
    };

    const opts = {
      print: () => {},
      printErr: (t) => messages.push("[stderr] " + t),
      preRun: [(m) => { persist = seedEngineFS(m); }],
      onRuntimeInitialized: () => {
        mod = opts; // MODULARIZE attaches exports to the opts object
        // The driver owns the shim callback, so it owns the checkpointer too,
        // wired as worker.ts wires it but with thresholds a test can reach: no
        // clock gate, and 5 commands instead of 100.
        cp = createCheckpointer({
          FS: mod.FS,
          root: PERSIST_ROOT,
          saveCurrentState: () => mod._save_currentstate(),
          flush: () => persist.flush(),
          onDead: (why) => messages.push(`[autosave dead] ${why}`),
          // save_currentstate() re-enters the windowport — mark_synch() and
          // getmsghistory() — and the async handler above would answer those
          // on a microtask, unwinding straight out of the checkpoint. Only the
          // owner of the bridge global can swap in an answerer that resolves in
          // place, so the checkpointer asks for it; this is worker.ts's half.
          suspendBridge: (answer) => {
            const real = globalThis[shim];
            globalThis[shim] = (...call) => {
              reentered.push(call[0]);
              return answer(...call);
            };
            return () => { globalThis[shim] = real; };
          },
          commandsPerCheckpoint: 5,
          minIntervalMs: 0,
        });
        opts.ccall("shim_graphics_set_callback", null, ["string"], [shim]);
      },
    };
    createModule(opts).catch(reject);
  });
}

/** A second page load that only wants the volume, as test-nethack-tabs does. */
async function tab() {
  let persist;
  const opts = {
    noInitialRun: true,
    print: () => {},
    printErr: (t) => console.warn("[nethack stderr]", t),
    preRun: [(m) => { persist = seedEngineFS(m); }],
  };
  await createModule(opts);
  await persist.ready;
  return { FS: opts.FS, persist };
}

const sync = (FS, populate) =>
  new Promise((done, die) => FS.syncfs(populate, (e) => (e ? die(e) : done())));

/**
 * Open the volume with nothing but IDBFS. persist.ts consumes a recovery set
 * while it mounts, so a pass that wants to leave one behind has to stay out of
 * its way — and there is no writer lock to take, since nobody else is reading.
 */
async function editVolume(edit) {
  const opts = { noInitialRun: true, print: () => {}, printErr: () => {} };
  await createModule(opts);
  const FS = opts.FS;
  FS.mkdir(PERSIST_ROOT);
  FS.mount(FS.filesystems.IDBFS, {}, PERSIST_ROOT);
  await sync(FS, true);
  edit(FS);
  await sync(FS, false);
  opts.IDBFS.quit();
}

/** The mirror as bytes, so a later case can put a known-good set back. */
const snapshot = (FS) =>
  FS.readdir(RECOVER)
    .filter((n) => n !== "." && n !== "..")
    .map((name) => ({ name, data: FS.readFile(`${RECOVER}/${name}`) }));

// --- 1. a closed tab's game comes back ------------------------------------
const first = await play("first", { checkpoints: 2 });
if (!first.persist.persistent) fail("first session did not get persistent storage", first);
if (first.cp.dead) fail(`autosave gave up mid-game: ${first.cp.dead}`, first);

const hello = find(first, /welcome to NetHack/);
if (!hello) fail("no new-game welcome message", first);
// "You are a lawful male human Knight." -> "human Knight"
const created = hello.match(/You are an? .*?(\S+ \S+)\.\s*$/)?.[1];
if (!created) fail(`could not read the character from: ${hello}`);

for (const p of [RECOVER, MANIFEST, `${RECOVER}/${LOCK}.0`])
  if (!first.FS.analyzePath(p).exists) fail(`two checkpoints left no ${p}`, first);

const manifest = JSON.parse(read(first.FS, MANIFEST));
if (manifest.format !== CHECKPOINT_FORMAT)
  fail(`manifest claims format ${manifest.format}, not ${CHECKPOINT_FORMAT}`, first);
if (!manifest.files?.length) fail(`manifest lists no files: ${read(first.FS, MANIFEST)}`, first);

// A set without the level the hero is on cannot be recovered at all:
// recover_savefile() rebuilds the save around level savelev (src/files.c:2978).
// This is what a checkpoint that unwound out of save_currentstate() leaves —
// level.0 alone, and nothing said it failed.
const heroLevel = `${LOCK}.${manifest.savelev}`;
if (!first.FS.analyzePath(`${RECOVER}/${heroLevel}`).exists)
  fail(`the mirror has no ${heroLevel}, the level its own manifest points at`
    + ` (re-entered: ${[...new Set(first.reentered)].join(", ") || "nothing"})`, first);

// Case 2 needs a known-good set, and the boot below consumes this one.
const mirror = snapshot(first.FS);

// The tab goes away: the game was never saved, but the volume is free again.
first.persist.release();

// --- the reload finds it, without the player being asked ------------------
// This session keeps checkpointing after the restore, which is the part that
// matters: the mirror is rebuilt into a save file by
// src/modules/nethack/recoverSave.ts rather than handed to getlock(),
// precisely so the engine never runs recover_savefile() and never leaves
// program_state.in_self_recover set. With that flag stuck,
// save_currentstate() (src/do.c:1379) writes nothing and
// autosave dies two commands into the recovered game — the player then plays on
// against a stale mirror and silently loses everything since. See the
// vect-hack-b1l comments in src/modules/nethack/recoverSave.ts.
const second = await play("second", { checkpoints: 2 });
if (second.askedRecover)
  fail("getlock() was handed loose level files; the port must rebuild the save itself", second);
if (!find(second, /Restoring save file/)) fail("no save file was recovered", second);
const back = find(second, /welcome back to NetHack/);
if (!back) fail("no welcome-back message", second);
// "Konnichi wa player, the human Samurai, welcome back to NetHack!"
const restored = back.match(/, the ([^,]+), welcome back/)?.[1];
if (restored !== created)
  fail(`recovered a different character: left a ${created}, got ${restored ?? back}`, second);
if (!second.persist.recovered) fail("the handle did not report a consumed recovery set", second);
if (second.cp.dead)
  fail(`autosave died in the recovered game: ${second.cp.dead}`, second);
second.persist.release();
console.log(`OK: a closed tab's ${created} came back, and kept checkpointing (real IDBFS)`);

// --- 2. a corrupt set must not brick the boot -----------------------------
// A half-written mirror must never become a save file: the engine would fail
// to restore it from deep inside dorecover(), costing the player the game. The
// validation in restoreRecoverySet() and the parsing checks in recoverSave.ts
// have to catch this one and throw the set away.
await editVolume((FS) => {
  if (!FS.analyzePath(RECOVER).exists) FS.mkdir(RECOVER);
  for (const f of mirror) FS.writeFile(`${RECOVER}/${f.name}`, f.data);
  FS.truncate(`${RECOVER}/${LOCK}.0`, 100); // under the 209-byte level.0 header
});

const third = await play("third", { checkpoints: 0 });
if (third.askedRecover) fail("a truncated mirror was handed to getlock()", third);
if (!find(third, /welcome to NetHack/)) fail("the boot did not reach a new game", third);
for (const p of [MANIFEST, `${RECOVER}/${LOCK}.0`])
  if (third.FS.analyzePath(p).exists) fail(`the bad set was left to be retried: ${p}`, third);
third.persist.release();
console.log("OK: a truncated recovery set is discarded and the game boots fresh");

// --- 3. a tab that lost the volume never mirrors --------------------------
const writer = await play("writer", { checkpoints: 1 });
if (!writer.persist.persistent) fail("the writing tab was denied the volume", writer);
const before = read(writer.FS, MANIFEST);

const loser = await tab();
if (loser.persist.persistent) fail("a second concurrent load owns the volume too");
if (loser.FS.analyzePath(PERSIST_ROOT).exists) fail("the second load mounted the volume anyway");
if (loser.FS.analyzePath(RECOVER).exists) fail("the second load created a recovery mirror");
// It plays on its own session-only filesystem; its flush must not reconcile.
loser.FS.writeFile("/record", "second tab's scores\n");
await loser.persist.flush();
await new Promise((done) => setTimeout(done, 50)); // let any stray autoPersist land

// The damage this case exists to rule out lands in IndexedDB: a stray
// reconcile from the losing tab deletes every entry its session-only
// filesystem lacks, and the writer — whose MEMFS still holds the mirror —
// sees nothing. Reading writer.FS here would be an assertion no behaviour
// could ever falsify (docs/DECISIONS.md, vect-hack-azf). So both handles go
// first and the mirror is read back off the persisted volume, the way
// test-nethack-tabs.mjs opens a third tab to check what actually survived.
loser.persist.release();
writer.persist.release();
await editVolume((FS) => {
  for (const p of [MANIFEST, `${RECOVER}/${LOCK}.0`])
    if (!FS.analyzePath(p).exists) fail(`a non-writing tab destroyed ${p}`, writer);
  if (read(FS, MANIFEST) !== before)
    fail("a non-writing tab changed the stored mirror manifest", writer);
});
console.log("OK: a non-writing tab never touches the mirror (real Web Locks)");

process.exit(0);

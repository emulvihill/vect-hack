// The borg gate, headless: -DALLOW_BORG is compiled in, the decorator starts
// the borg, and it then plays on its own without wedging the Asyncify engine.
// The unit test pins the decorator's keys in isolation; only this one proves
// the composition — that the borg's inkey_hack actually takes over, which is
// invisible from the TypeScript side.
//
// What "playing" means here is deliberately NOT our command count. Once the
// borg is running it answers the engine itself, so blocking command waits stop
// arriving; counting them would measure the opposite of success. Sustained map
// traffic and a hero that moves are the observable evidence.
//
// This is the automated half of the epic's merge gate (vect-hack-3vk.4); the
// other half is a sustained run in the real 3D view, which needs a GPU.
import "fake-indexeddb/auto";
import { existsSync } from "node:fs";
import { GRID_FLAGS, GRID_PLAYER, GRID_STRIDE, bootAngband, fail, until } from "./angband-play.mjs";
import { BorgPlayer } from "../../src/modules/angband/ui/BorgPlayer.ts";

const SAMPLE_MS = 15000;   // sustained-play window once the borg is up
const MIN_MAPS = 100;      // map batches that must land inside it

if (!existsSync(new URL("../../public/modules/angband/angband.data", import.meta.url)))
  fail("public/modules/angband/angband.{js,wasm,data} missing — run scripts/build/build-angband-wasm.sh");

// The decorator drives a stub view: this test is about the engine, and the
// real views need a DOM. Everything it forwards is counted here.
let maps = 0, messages = 0, levels = 0;
let fatal = null;
const heroSeen = new Set();
// The current hero grid, not just every grid ever seen — heroSeen alone can
// only prove the hero moved, not tell describe() where "now" is.
let heroAt = null;

const view = {
  onReady: () => {},
  onNotice: (text) => { if (/died|engine/i.test(text)) fatal = text; },
  handle: (ev) => {
    if (ev.name === "level") levels++;
    if (ev.name === "message") messages++;
    if (ev.name !== "map") return;
    maps++;
    for (let i = 0; i < ev.records.length; i += GRID_STRIDE)
      if (ev.records[i + GRID_FLAGS] & GRID_PLAYER) {
        heroSeen.add(`${ev.records[i]},${ev.records[i + 1]}`);
        heroAt = { x: ev.records[i], y: ev.records[i + 1] };
      }
  },
  nextKey: () => fail("the decorator must answer every key itself"),
};

const borg = new BorgPlayer(view);
let commandWaits = 0;
let badPoll = false;

const session = await bootAngband({
  // The decorator answers every blocking wait, birth included: this test is
  // about the composition, so nothing else may put keys into the engine.
  keys: async (wait, cmd) => {
    if (cmd) commandWaits++;
    const key = await borg.nextKey(wait, cmd);
    if (!key) fail("the decorator returned no key for a blocking wait");
    return key;
  },
  onEvent: (ev) => borg.handle(ev),
  // A poll must be answered with "no key", synchronously — anything else
  // feeds a phantom press into TERM_XTRA_FLUSH's drain and it never ends.
  onPoll: () => { if (borg.nextKey(false, false) !== null) badPoll = true; },
});

// The borg is up once it is generating map traffic on its own.
await until(() => maps > 0 && levels > 0, 60000, "the borg to start playing");
const at = { maps, messages, hero: heroSeen.size };
await new Promise((r) => setTimeout(r, SAMPLE_MS));

if (fatal) fail("engine reported a fatal during borg play: " + fatal);
if (!session.sawBirth) fail("no character was born — the borg had nothing to play");
if (badPoll) fail("a wait:false poll was not answered immediately with 'no key'");
if (commandWaits !== 1)
  fail(`expected exactly one command wait (the ^Z that starts the borg), got ${commandWaits}`);

// The borg writes borg.txt into ANGBAND_DIR_USER on its first run
// (borg-init.c:192), which makes it the one thing that proves where that
// directory actually points. Emscripten is a UNIX build, so upstream's
// PRIVATE_USER_PATH branch would put it at a bare /Angband in MEMFS — outside
// the volume and gone on reload — and main-wasm.c corrects it to /lib/user,
// which persist.ts links into /vect-angband.
const VOLUME_BORG_TXT = "/vect-angband/user/borg.txt";
if (!session.FS.analyzePath(VOLUME_BORG_TXT).exists) {
  const stray = session.FS.analyzePath("/Angband/borg.txt").exists ? " (it is at /Angband instead)" : "";
  fail(`the borg's config did not reach the volume at ${VOLUME_BORG_TXT}${stray}`);
}

const grew = maps - at.maps;
if (grew < MIN_MAPS)
  fail(`map traffic stalled: only ${grew} batches in ${SAMPLE_MS}ms, expected ${MIN_MAPS}`);
if (heroSeen.size <= at.hero)
  fail(`the hero never moved during ${SAMPLE_MS}ms of borg play (${heroSeen.size} positions)`);

// Look HUD (spec 2026-08-18): the describer answers from a message handler
// while the engine is suspended, which is the state this test leaves it in.
//
// Truthiness alone would pass on the name of the wrong square — the failure a
// coordinate bug (an x/y swap, an off-by-one) actually produces, and the one
// thing the marshalling's own unit test can never see. describe() at the
// hero's own current grid must answer exactly "you" (see
// scripts/test/test-nethack-save-restore.mjs's sibling check), which also
// pins the spec's "the hero's own cell answers `you`" bullet — otherwise
// untested anywhere.
if (!heroAt) fail("no hero grid was ever recorded to describe");
const describe = (x, y) =>
  session.mod.ccall("vect_angband_describe", "string", ["number", "number"], [x, y]);
if (describe(heroAt.x, heroAt.y) !== "you")
  fail(`vect_angband_describe named ${JSON.stringify(describe(heroAt.x, heroAt.y))} `
       + `at the hero's own grid (${heroAt.x},${heroAt.y}), expected "you"`);
if (describe(-1, -1)) fail("vect_angband_describe answered an out-of-range grid");

// The describe calls above are nested exports into an engine parked at its
// Asyncify suspend point, and the risk they carry is leaving it unable to go
// on. There is no `fatal` check here, because there could not be an honest
// one: bootAngband is handed keys/onEvent/onPoll and no notice channel, so
// view.onNotice never runs and the flag it writes can never be set — reading
// it would be an assertion that cannot fail (vect-hack-azf).
// An engine that died would stop playing, so the wait below is the assertion:
// it proves the engine survived being asked, which is the whole risk.
//
// A wait, not a fixed window: the borg runs long synchronous stretches and
// only yields to the JS event loop between them, so its map batches arrive in
// bursts up to ~2.5s apart (measured). A 500ms sample of "did traffic grow"
// reads zero on a healthy engine as often as on a wedged one.
const AFTER_DESCRIBE_MS = 15000;
const beforeDescribe = maps;
await until(() => maps > beforeDescribe, AFTER_DESCRIBE_MS,
  "the borg to keep playing after the describe");
const after = maps - beforeDescribe;

console.log(`OK: borg played unattended — ${grew} map batches in ${SAMPLE_MS / 1000}s, `
  + `${heroSeen.size} hero positions, ${messages} messages, no fatal; `
  + `${after} more batches after the describe; `
  + `its config reached ${VOLUME_BORG_TXT}`);
process.exit(0);

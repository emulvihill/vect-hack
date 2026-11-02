// Real engine: the gym seed hook makes a Larn game deterministic. Boots the
// engine three times with a canned key script — twice on one seed, once on
// another — and compares a digest of everything the engine drew. Same seed
// must produce the same game; a different seed must not.
//
// One game per child process (`--play <seed>`), the shape bot-gym.mjs already
// uses. Two reasons, both forced by the shim: __wrap_read ignores gatherKey's
// return and always delivers wasm_key_code(), so an engine whose driver has
// stopped answering does not stop — it spins on NUL keys and starves the event
// loop; and __wrap_exit tails into __real_exit, which in node ends the whole
// process. A child per game means the digest is closed by killing the engine,
// and no game can ever draw into another's hash.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fail = (msg) => { console.error("FAIL: " + msg); process.exit(1); };
const CORE = (name) => fileURLToPath(new URL(`../../public/modules/larn/${name}`, import.meta.url));
if (!existsSync(CORE("larn.js"))) fail("public/modules/larn/larn.{js,wasm,data} missing — run npm run build:larn");

// Enough keys to leave the welcome page and walk the level the seed built. The
// bot is deliberately not involved: this test is about the engine, not the
// policy. LF first — retcont() (help.c:103) advances on nothing else.
const SCRIPT = ["\n", ...("hhhhjjjjllllkkkkhjkl".repeat(6).split(""))];
const KEYS = 96;
const PLAY_TIMEOUT_MS = 60000;

/** Boot one game under `seed`, answer KEYS keys from SCRIPT, digest the draw. */
async function play(seed) {
  const createLarnModule = (await import("../../public/modules/larn/larn.js")).default;
  const { mountLarnStorage } = await import("../../src/modules/larn/persist.ts");
  const { installLarnShim } = await import("../../src/modules/larn/shimBridge.ts");
  const h = createHash("sha256");
  let answered = 0;

  // The digest closes where the engine asks for one key past the budget: the
  // process is the only thing that can stop a running Larn, so report first.
  const report = () => {
    process.stdout.write(`DIGEST ${h.digest("hex")}\n`);
    process.exit(0);
  };
  const watchdog = setTimeout(() => {
    console.error(`FAIL: seed ${seed} answered only ${answered}/${KEYS} keys in ${PLAY_TIMEOUT_MS}ms`);
    process.exit(1);
  }, PLAY_TIMEOUT_MS);
  watchdog.unref();

  installLarnShim({
    name: "scripts/test/test-larn-seed.mjs",
    gymSeed: () => seed,
    // What the engine DREW, in the order it drew it. curs, flush, overlay and
    // death are deliberately outside the digest, and so is the status record:
    // the digest pins the SEEDED GAME, and the status record is a redundant
    // projection of state the text and map events already hash.
    onEvent: (ev) => {
      if (ev.name === "text") h.update(`t ${ev.x} ${ev.y} ${ev.rgb} ${ev.text}\n`);
      else if (ev.name === "wipe") h.update(`w ${ev.x} ${ev.y} ${ev.n}\n`);
      else if (ev.name === "clear") h.update("c\n");
      else if (ev.name === "map") h.update(Buffer.from(ev.records.buffer));
      else if (ev.name === "level") h.update(`l ${ev.width} ${ev.height}\n`);
    },
    saveLanded: () => {},
    notice: () => {},
    quit: () => report(), // the game ended on its own (death, quit): still a digest
    gatherKey: async (wait) => {
      if (!wait) return null;
      if (answered >= KEYS) report();
      const key = { code: SCRIPT[answered % SCRIPT.length].charCodeAt(0) };
      answered++;
      return key;
    },
  });

  await createLarnModule({
    locateFile: (p) => CORE(p),
    arguments: [],
    print: () => {},
    printErr: () => {},
    preRun: [(m) => {
      m.addRunDependency("seed-mount");
      queueMicrotask(() => { mountLarnStorage(m, { locks: null }); m.removeRunDependency("seed-mount"); });
    }],
  });
}

/** Run one game in its own process and return the digest it printed. */
function playChild(seed) {
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(process.execPath, [self, "--play", String(seed)], {
    encoding: "utf8",
    timeout: PLAY_TIMEOUT_MS + 30000,
  });
  const line = (r.stdout || "").split("\n").find((s) => s.startsWith("DIGEST "));
  if (!line) fail(`seed ${seed}: child produced no digest (status ${r.status})\n${r.stdout}${r.stderr}`);
  return line.slice("DIGEST ".length).trim();
}

/* Straddle a wall-clock second between the two same-seed children. NOT dead
 * time: without the hook Larn seeds from time(), whose resolution is one
 * second, so two children inside the same second seed alike and `a === b`
 * holds with no seeding at all — and if the third child then crossed into the
 * next second, `a !== c` would hold too and a REMOVED hook would pass this
 * test. Crossing a second boundary here makes that regression fail every
 * time. Synchronous on purpose: playChild is spawnSync. */
const straddleASecond = () =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);

const playFlag = process.argv.indexOf("--play");
if (playFlag !== -1) {
  await play(Number(process.argv[playFlag + 1]));
} else {
  const a = playChild(12345);
  straddleASecond();
  const b = playChild(12345);
  const c = playChild(999);

  if (a !== b) fail(`seed 12345 produced two different games:\n  ${a}\n  ${b}`);
  if (a === c) fail(`seed 999 produced the same game as seed 12345 (${a}) — the seed is not reaching the RNG`);
  console.log(`OK: seeded Larn is deterministic (12345 -> ${a.slice(0, 16)}, 999 -> ${c.slice(0, 16)})`);
}

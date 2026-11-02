// Real engine + real IDBFS: a `savefile:` line in the volume's .larnopts
// cannot move Larn's explicit save off the volume, is refused out loud, and
// the save it did not redirect really does restore.
//
// Upstream reads $HOME/.larnopts (main.c:123, tok.c:177) and lets `savefile:`
// strcpy any path over savefilename (tok.c:226-229). Under WASM everything
// outside the mounted volume is MEMFS that dies with the tab, so an
// unconfined redirect writes, reports success (main.c:793 -> died(-257)) and
// is gone on reload. main-wasm.c's __wrap_readopts pins the path back.
import "fake-indexeddb/auto";
import { existsSync } from "node:fs";
import createLarnModule from "../../public/modules/larn/larn.js";
import { mountLarnStorage } from "../../src/modules/larn/persist.ts";
import { VOLUMES } from "../../src/backplane/volumes.ts";
import { bootLarn, coreFile, fail, park, until } from "./larn-play.mjs";

if (!existsSync(new URL("../../public/modules/larn/larn.data", import.meta.url)))
  fail("public/modules/larn/larn.{js,wasm,data} missing — run scripts/build/build-larn-wasm.sh");

const ESCAPE = "/tmp/escaped.sav";
const saveDir = `${VOLUMES.larn.mountpoint}/home`;
const ls = (FS, path) => FS.readdir(path).filter((name) => name !== "." && name !== "..");

// --- Plant the hostile options file, engine never running. ---------------
// noInitialRun mounts the volume without starting main(), which is how the
// file gets into the volume before the boot that reads it — the shape any
// out-of-band writer (a restored .vhsave, browser storage surgery) has.
{
  let persist;
  const opts = {
    noInitialRun: true,
    locateFile: coreFile,
    print: () => {},
    printErr: (text) => console.warn("[larn stderr]", text),
    preRun: [(mod) => { persist = mountLarnStorage(mod); }],
  };
  await createLarnModule(opts);
  await persist.ready;
  if (!persist.persistent)
    fail(`planting session did not own storage: ${persist.reason?.detail}`);
  opts.FS.writeFile("/lib/home/.larnopts", `savefile: ${ESCAPE}\n`);
  await persist.flush();
  persist.release();
  opts.FS.filesystems.IDBFS.quit();
}

// --- Visit 1: the redirect is refused, and the save is honest. -----------
let quit = false;
let saved = false;
let saveSent = false;
const first = await bootLarn({
  onQuit: (wasSaved) => { quit = true; saved = wasSaved === 1; },
  play: ({ press }) => {
    if (saveSent) return park();
    saveSent = true;
    return press("S");
  },
});
await until(() => quit, 30000, "the S-save under a redirected .larnopts to exit");
await first.persist.flush();

if (!first.notices.some((text) => /savefile:/.test(text)))
  fail(`the refused savefile: option was not reported: ${JSON.stringify(first.notices)}`);
if (first.FS.analyzePath(ESCAPE).exists)
  fail(`the save escaped the volume to ${ESCAPE}`);
const savedFiles = ls(first.FS, saveDir);
if (!savedFiles.includes("Larn.sav"))
  fail(`no save at ${saveDir}/Larn.sav: ${JSON.stringify(savedFiles)}`);
if (!saved) fail("a save that landed on the recoverable path reported saved=false");
first.release();
first.FS.filesystems.IDBFS.quit();

// --- Visit 2: that save is what the next boot actually restores. ---------
const second = await bootLarn({ play: park });
await until(() => second.postRestoreMap, 30000, "the map batch after the restored command boundary");
if (second.sawBirth)
  fail("the confined S-save was not restored — the second visit entered Larn birth");
if (!second.notices.some((text) => /savefile:/.test(text)))
  fail("the second boot read the same .larnopts and did not report the refusal");

await second.persist.flush();
second.release();
second.FS.filesystems.IDBFS.quit();
console.log(
  `OK: savefile: ${ESCAPE} was refused out loud, the save stayed at`
  + ` ${saveDir}/Larn.sav, and the next boot restored it`);

// Real fixed-seed save/restore gate: movement and the engine's saved command
// mode come back without birth, then the restored character moves and saves.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { VOLUMES } from "../../src/backplane/volumes.ts";
import {
  bootMoria,
  bytesEqual,
  closeIdbfs,
  createAndSave,
  restoreMoveAndSave,
  waitForExit,
} from "./moria-persist-play.mjs";

const gamePath = `${VOLUMES.moria.mountpoint}/game.sav`;
const firstDriver = createAndSave({ roguelike: false });
const first = await bootMoria({ roguelike: false, input: firstDriver.input });
await waitForExit(first);
assert.equal(first.quitState?.saved, true, first.quitState?.reason ?? "initial Ctrl-X was not durable");
const firstSave = Uint8Array.from(first.FS.readFile(gamePath));
const before = firstDriver.snapshot;
assert.ok(before && firstDriver.moved, "initial fixed-seed character did not make a real movement");
await first.lifecycle.release();
closeIdbfs(first);

// Pass the opposite startup mode. loadGame must restore original commands
// from game.sav, not leak the caller option or silently roll another hero.
const secondDriver = restoreMoveAndSave();
const second = await bootMoria({ roguelike: true, input: secondDriver.input });
await waitForExit(second);
assert.equal(secondDriver.sawBirth, false, "restore entered character creation");
assert.equal(secondDriver.restored.name, before.name, "restore changed the character name");
assert.deepEqual(secondDriver.restored.hero, before.hero, "restore changed the saved hero position");
assert.equal(secondDriver.restored.fingerprint, before.fingerprint,
  "restore changed the saved dungeon panel");
assert.equal(secondDriver.restored.roguelike, before.roguelike,
  "restore changed the saved command mode");
assert.equal(secondDriver.restored.roguelike, false,
  "opposite startup option overrode the original-mode save");
assert.equal(second.quitState?.saved, true, second.quitState?.reason ?? "restored Ctrl-X was not durable");
assert.ok(secondDriver.moved, "restored character did not continue play with a real movement");
const secondSave = Uint8Array.from(second.FS.readFile(gamePath));
assert.ok(secondSave.byteLength > 4, "restored Ctrl-X did not retain game.sav");
assert.equal(bytesEqual(secondSave, firstSave), false,
  "continued play did not overwrite game.sav with the new state");
await second.lifecycle.release();
closeIdbfs(second);

console.log("OK: fixed-seed Moria movement, Ctrl-X durability, exact restore and overwrite pass");

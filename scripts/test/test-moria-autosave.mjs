// Real Umoria + real IDBFS autosave gate. A checkpoint must be a completed
// source turn which is already durable before native asks for the next key;
// no lifecycle/final flush is allowed to rescue a simulated crash.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { unpackSave } from "../../src/backplane/saveBlob.ts";
import { VOLUMES } from "../../src/backplane/volumes.ts";
import { installMoriaImport, validateMoriaImport } from "../../src/modules/moria/saveImport.ts";
import { fnv1a32Hex } from "../../src/modules/moria/recovery.ts";
import {
  bootMoria,
  bytesEqual,
  captureSnapshot,
  chooseOpenDirection,
  closeIdbfs,
  listFiles,
  park,
  readDurableFiles,
  waitForExit,
} from "./moria-persist-play.mjs";

const root = VOLUMES.moria.mountpoint;
const gamePath = `${root}/game.sav`;
const recoveryRoot = `${root}/recover`;
const checkpointOptions = { commands: 1, minIntervalMs: 0 };
const birth = [
  13, // splash
  code("a"), // race
  code("m"), // sex
  27, // accept rolled stats
  code("a"), // class
  13, // empty name -> source fallback X
  32, // enter town
];

// --- Two rapid, distinguishable, awaited generations ---------------------
const firstDriver = checkpointDriver({ newGame: true, generations: 2, enterWizard: true });
const first = await bootMoria({
  roguelike: true,
  checkpointOptions,
  input: firstDriver.input,
});
await withTimeout(firstDriver.reached, 15_000, "two durable real Moria checkpoints");

assert.equal(firstDriver.birthKeysConsumed, birth.length,
  "fixed-seed autosave gate did not complete real character birth");
assert.equal(first.FS.analyzePath(gamePath).exists, false,
  "background checkpoint created the player's explicit game.sav");
assert.equal(first.checkpointAttempts, 2, "two completed turns did not attempt exactly two checkpoints");
assert.equal(first.checkpointLandings, 2, "two real checkpoint candidates were not durably landed");
assert.equal(firstDriver.snapshots.length, 2, "real gate did not observe both landed generations");
assert.notEqual(firstDriver.snapshots[0].semantic.turn, firstDriver.snapshots[1].semantic.turn,
  "rapid generations did not represent distinguishable completed turns");
for (const diagnostic of firstDriver.diagnostics) assertCandidateDiagnostic(diagnostic);
for (const diagnostic of firstDriver.diagnostics) {
  assert.equal(diagnostic.wizardMode, 1, "real checkpoint omitted live wizard mode");
  assert.ok(diagnostic.wizardLit > 0,
    "fixed-seed wizard checkpoint had no lit monster to prove first-update preservation");
}
assert.notEqual(firstDriver.diagnostics[0].payload, firstDriver.diagnostics[1].payload,
  "two distinguishable turns produced the same checkpoint payload digest");

const checkpointNames = recoveryFiles(first.FS);
assert.equal(checkpointNames.filter((name) => /^checkpoint-/.test(name)).length, 2,
  "rapid same-millisecond writes did not retain two unique checkpoint paths");
assert.equal(checkpointNames.filter((name) => /^commit-/.test(name)).length, 2,
  "checkpoint data did not retain two matching commit records");

const checkpointExport = first.persist.exportSave(new Date(2026, 7, 8, 13, 1));
const checkpointContents = validateMoriaImport(first.FS, unpackSave(checkpointExport.bytes));
assert.equal(checkpointContents.files.some(({ path }) => path === "game.sav"), false,
  "checkpoint-only portable volume smuggled in an explicit save");
assert.equal(checkpointContents.files.filter(({ path }) => /^recover\/checkpoint-/.test(path)).length, 2,
  "portable checkpoint volume omitted a retained generation");

// A concurrent losing real engine remains playable, but its completed source
// turn cannot even reach the candidate/landing callback or alter owner bytes.
const writerRecoveryBeforeLoser = await durableRecoveryBytes();
// An empty baseline would make every comparison below vacuous.
assert.deepEqual([...writerRecoveryBeforeLoser.keys()].sort(), [...checkpointNames].sort(),
  "the durable volume is missing recovery generations the writer's heap holds");
const loserDriver = losingTabDriver();
const loser = await bootMoria({
  roguelike: true,
  checkpointOptions,
  input: loserDriver.input,
});
assert.equal(loser.persist.persistent, false, "concurrent Moria engine won the writer lock");
await waitForExit(loser);
assert.equal(loserDriver.moved, true, "session-only real engine never completed its test turn");
assert.equal(loser.checkpointAttempts, 0,
  "session-only engine attempted to write or publish a checkpoint");
assert.equal(loser.checkpointLandings, 0,
  "session-only engine claimed a durable checkpoint");
assert.equal(loser.FS.analyzePath("/moria-seed/recover/.pending.sav").exists, false,
  "session-only native engine wrote a private checkpoint candidate");
await loser.lifecycle.release();
closeIdbfs(loser);
// Reading the writer's own MEMFS here would prove only that two Emscripten
// heaps are separate. IndexedDB is the one thing both engines share, and the
// writer has not flushed since native awaited the second landing, so nothing
// can have repaired what the loser did.
await assertDurableRecovery(writerRecoveryBeforeLoser,
  "session-only engine altered the owner's durable recovery generations");

// Primary crash proof: no lifecycle release and no test-side final/manual
// flush has occurred since native awaited the second landing.
crash(first);
await assertDurableRecovery(writerRecoveryBeforeLoser,
  "releasing both engines altered the owner's durable recovery generations");
const exactCrashDriver = recoveryDriver();
const exactCrash = await bootMoria({ roguelike: false, input: exactCrashDriver.input });
await withTimeout(exactCrashDriver.reached, 15_000, "exact recovery after bare checkpoint crash");
assert.equal(exactCrashDriver.sawBirth, false, "durable checkpoint crash entered birth");
assertExactRecovery(exactCrashDriver.restored, firstDriver.snapshots[1],
  "bare release + IDBFS quit");
assertRecoveryDiagnostic(exactCrash.checkpointInvariants, firstDriver.diagnostics[1]);

// Corrupt newest after it was durable. Publication selection must fall back
// to the prior valid commit rather than trusting the newest filename/mtime.
const dataNames = checkpointNames.filter((name) => /^checkpoint-/.test(name)).sort(byGeneration);
const olderData = dataNames[0];
const newestData = dataNames[1];
corrupt(exactCrash.FS, `${recoveryRoot}/${newestData}`, "flip");
await exactCrash.persist.flush();
crash(exactCrash);

const fallbackDriver = recoveryDriver();
const fallback = await bootMoria({ roguelike: false, input: fallbackDriver.input });
await withTimeout(fallbackDriver.reached, 15_000, "fallback to the previous checkpoint");
assert.equal(fallbackDriver.sawBirth, false, "valid previous checkpoint fell through to birth");
assertExactRecovery(fallbackDriver.restored, firstDriver.snapshots[0],
  "corrupt-newest fallback");
assertRecoveryDiagnostic(fallback.checkpointInvariants, firstDriver.diagnostics[0]);

// Make the remaining candidate partial as well. With no committed valid
// checkpoint, startup must fail closed into fresh birth without a fatal.
corrupt(fallback.FS, `${recoveryRoot}/${olderData}`, "truncate");
await fallback.persist.flush();
crash(fallback);
const corruptBirthDriver = freshBirthDriver();
const corruptBirth = await bootMoria({ input: corruptBirthDriver.input });
await withTimeout(corruptBirthDriver.reached, 15_000, "safe birth after both checkpoints corrupt");
assert.equal(corruptBirthDriver.sawBirth, true,
  "two invalid checkpoint generations did not fail closed into fresh birth");
assert.equal(corruptBirth.checkpointInvariants.some(({ name }) => name === "recovery-applied"), false,
  "invalid checkpoint applied recovery state before fresh birth");
crash(corruptBirth);

// --- Portable checkpoint import, exact recovery, continued Ctrl-X --------
await resetDatabase();
await installPortable(checkpointContents);
const importedDriver = recoveryDriver({ continueAndSave: true });
const imported = await bootMoria({ roguelike: false, input: importedDriver.input });
await withTimeout(importedDriver.reached, 15_000, "imported checkpoint continuation");
assert.equal(importedDriver.sawBirth, false, "checkpoint-only import entered birth");
assertExactRecovery(importedDriver.restored, firstDriver.snapshots[1],
  "checkpoint-only portable import");
assertRecoveryDiagnostic(imported.checkpointInvariants, firstDriver.diagnostics[1]);
await waitForExit(imported);
assert.equal(importedDriver.moved, true, "imported checkpoint could not continue a real turn");
assert.equal(imported.quitState?.saved, true,
  imported.quitState?.reason ?? "imported checkpoint continuation was not explicitly saved");
assert.equal(imported.FS.analyzePath(gamePath).exists, true,
  "continued imported checkpoint did not create game.sav through Ctrl-X");
assert.equal(recoveryFiles(imported.FS).some((name) => /^(checkpoint|commit)-/.test(name)), false,
  "ordinary Ctrl-X did not clear checkpoint generations");
await imported.lifecycle.release();
closeIdbfs(imported);

// --- Explicit-save ancestry and changed-save precedence ------------------
// The imported Ctrl-X is now an older explicit ancestor. A completed turn
// may checkpoint above that exact digest and must supersede it on a crash.
const descendantDriver = checkpointDriver({ newGame: false, generations: 1 });
const descendant = await bootMoria({
  roguelike: true,
  checkpointOptions,
  input: descendantDriver.input,
});
await withTimeout(descendantDriver.reached, 15_000, "checkpoint descended from explicit save");
assert.equal(descendant.FS.analyzePath(gamePath).exists, true,
  "descendant checkpoint removed its explicit ancestor");
const archived = archiveRecovery(descendant.FS);
const descendantSnapshot = descendantDriver.snapshots[0];
const descendantDiagnostic = descendantDriver.diagnostics[0];
crash(descendant);

const descendantRestoreDriver = recoveryDriver({ continueAndSave: true });
const descendantRestore = await bootMoria({ input: descendantRestoreDriver.input });
await withTimeout(descendantRestoreDriver.reached, 15_000, "matching descendant recovery");
assertExactRecovery(descendantRestoreDriver.restored, descendantSnapshot,
  "matching explicit descendant");
assertRecoveryDiagnostic(descendantRestore.checkpointInvariants, descendantDiagnostic);
await waitForExit(descendantRestore);
assert.equal(descendantRestore.quitState?.saved, true,
  "continued descendant checkpoint did not produce a changed explicit save");

// Reinsert the older checkpoint under a newer canonical generation. Its
// ancestor digest no longer matches the changed game.sav, so explicit wins.
installAsNewerStale(descendantRestore.FS, archived);
await descendantRestore.persist.flush();
await descendantRestore.lifecycle.release();
closeIdbfs(descendantRestore);

const explicitDriver = recoveryDriver();
const explicit = await bootMoria({ input: explicitDriver.input });
await withTimeout(explicitDriver.reached, 15_000, "changed explicit save precedence");
assert.equal(explicit.persist.checkpointRecoveryPath, "",
  "nonmatching newer checkpoint outranked a changed explicit game.sav");
assert.equal(explicit.checkpointInvariants.some(({ name }) => name === "recovery-applied"), false,
  "native applied a checkpoint rejected by explicit-save ancestry");
assert.equal(explicitDriver.restored.name, descendantRestoreDriver.continued.name,
  "changed explicit precedence restored a different character");
assert.deepEqual(explicitDriver.restored.hero, descendantRestoreDriver.continued.hero,
  "changed explicit precedence restored the stale checkpoint position");
await explicit.lifecycle.release();
closeIdbfs(explicit);

// --- Confirmed non-save terminal tombstone and portable arbitration ------
await resetDatabase();
const terminalDriver = checkpointDriver({ newGame: true, generations: 1, finish: "quit" });
const terminal = await bootMoria({
  roguelike: true,
  checkpointOptions,
  input: terminalDriver.input,
});
await waitForExit(terminal);
assert.equal(terminalDriver.confirmedQuit, true, "real Q confirmation did not reach the source prompt");
assert.equal(terminal.quitState?.saved, false, "confirmed Q was misclassified as an explicit save");
assert.equal(terminal.FS.analyzePath(gamePath).exists, false,
  "terminal exit left an explicit game.sav capable of resurrection");
const terminalNames = recoveryFiles(terminal.FS);
assert.equal(terminalNames.filter((name) => /^terminal-/.test(name)).length, 1,
  "confirmed terminal exit did not record one unique tombstone");
assert.ok(terminalNames.some((name) => /^checkpoint-/.test(name)),
  "terminal arbitration was not tested against an older living checkpoint");
const terminalExport = terminal.persist.exportSave(new Date(2026, 7, 8, 13, 2));
const terminalContents = validateMoriaImport(terminal.FS, unpackSave(terminalExport.bytes));
await terminal.lifecycle.release();
closeIdbfs(terminal);

const terminalBirthDriver = freshBirthDriver();
const terminalBirth = await bootMoria({ input: terminalBirthDriver.input });
await withTimeout(terminalBirthDriver.reached, 15_000, "fresh birth after terminal tombstone");
assert.equal(terminalBirthDriver.sawBirth, true,
  "terminal tombstone allowed the older living checkpoint to resurrect");
crash(terminalBirth);

await resetDatabase();
await installPortable(terminalContents);
const importedTerminalDriver = freshBirthDriver();
const importedTerminal = await bootMoria({ input: importedTerminalDriver.input });
await withTimeout(importedTerminalDriver.reached, 15_000,
  "fresh birth after portable terminal tombstone import");
assert.equal(importedTerminalDriver.sawBirth, true,
  "portable terminal tombstone import resurrected its older checkpoint");
crash(importedTerminal);

console.log("OK: Moria real autosave exactness, generations, precedence, tabs and portable tombstones pass");

function checkpointDriver({ newGame, generations, finish = "park", enterWizard = false }) {
  let birthAt = newGame ? 0 : birth.length;
  let opening = !newGame;
  let commands = 0;
  let invariantAt = 0;
  let ending = null;
  let confirmedQuit = false;
  let sawBirth = false;
  let wizardSetup = enterWizard ? 0 : 2;
  let resolveReached;
  const reached = new Promise((resolve) => { resolveReached = resolve; });
  const snapshots = [];
  const diagnostics = [];

  return {
    reached,
    snapshots,
    diagnostics,
    get birthKeysConsumed() { return birthAt; },
    get confirmedQuit() { return confirmedQuit; },
    input: async (request, session) => {
      sawBirth ||= isBirthScreen(session.text);
      if (birthAt < birth.length) {
        assert.equal(request.context, "literal", "Moria birth input was command-mapped");
        return key(birth[birthAt++]);
      }
      if (request.context === "literal") {
        if (opening) {
          opening = false;
          return key(13);
        }
        if (session.text.includes(" -more-")) return key(32);
        if (/Wizard mode.*sure|Are you sure\?/.test(session.text)) return key(code("y"));
        if (/character description.*character name/i.test(session.text)) return key(13);
        if (/press any key|continue/i.test(session.text)) return key(32);
        if (ending === "quit") {
          if (/Do you really want to quit\?/.test(session.text)) {
            confirmedQuit = true;
            return key(code("y"));
          }
          if (/Character record\?|Rank\s+Points\s+Name|press any key/i.test(session.text))
            return key(27);
        }
        if (ending === "save") return key(27);
        assert.fail(`unexpected checkpoint literal prompt:\n${visibleText(session.text)}`);
      }
      assert.equal(request.context, "outer-command", "checkpoint turn did not return to outer input");

      if (commands > 0) {
        assert.equal(session.checkpointLandings, commands,
          "native requested another command before the completed checkpoint was durable");
        snapshots.push(captureSnapshot(session, request));
        const events = session.checkpointInvariants.slice(invariantAt);
        invariantAt = session.checkpointInvariants.length;
        diagnostics.push(candidateDiagnostic(events));
      }
      if (wizardSetup === 0) {
        wizardSetup = 1;
        return key(23); // Ctrl-W, source wizard-mode command
      }
      if (wizardSetup === 1) {
        wizardSetup = 2;
        return key(code("&")); // source wizard summon, guaranteed nearby lit monster
      }
      if (commands < generations) {
        const direction = chooseOpenDirection(session.frame, request.roguelike);
        commands += 1;
        return key(code(direction.key));
      }

      resolveReached();
      if (finish === "park") return park();
      ending = finish;
      return key(finish === "quit" ? code("Q") : 24);
    },
  };
}

function recoveryDriver({ continueAndSave = false } = {}) {
  let opening = true;
  let ending = false;
  let sawBirth = false;
  let restored = null;
  let continued = null;
  let direction = null;
  let moved = false;
  let resolveReached;
  const reached = new Promise((resolve) => { resolveReached = resolve; });
  return {
    reached,
    get sawBirth() { return sawBirth; },
    get restored() { return restored; },
    get continued() { return continued; },
    get moved() { return moved; },
    input: async (request, session) => {
      sawBirth ||= isBirthScreen(session.text);
      if (request.context === "literal") {
        if (opening) {
          opening = false;
          return key(13);
        }
        if (session.text.includes(" -more-")) return key(32);
        if (/character description.*character name/i.test(session.text)) return key(13);
        if (/press any key|continue/i.test(session.text)) return key(32);
        if (ending) return key(27);
        assert.fail(`unexpected recovery literal prompt:\n${visibleText(session.text)}`);
      }
      assert.equal(request.context, "outer-command", "recovery did not reach an outer command");
      if (restored === null) {
        restored = captureSnapshot(session, request);
        if (!continueAndSave) {
          resolveReached();
          return park();
        }
        direction = chooseOpenDirection(session.frame, request.roguelike);
        return key(code(direction.key));
      }
      continued = captureSnapshot(session, request);
      moved = continued.hero.row !== restored.hero.row || continued.hero.col !== restored.hero.col;
      assert.equal(moved, true, "recovered engine did not complete a continued real move");
      ending = true;
      resolveReached();
      return key(24);
    },
  };
}

function losingTabDriver() {
  let birthAt = 0;
  let direction = null;
  let moved = false;
  let ending = false;
  return {
    get moved() { return moved; },
    input: async (request, session) => {
      if (birthAt < birth.length) return key(birth[birthAt++]);
      if (request.context === "literal") {
        if (session.text.includes(" -more-")) return key(32);
        if (ending) return key(27);
        assert.fail(`unexpected losing-tab prompt:\n${visibleText(session.text)}`);
      }
      if (direction === null) {
        direction = chooseOpenDirection(session.frame, request.roguelike);
        return key(code(direction.key));
      }
      moved = session.frame[direction.target] === code("@");
      assert.equal(moved, true, "session-only Moria turn did not move the hero");
      assert.equal(session.checkpointAttempts, 0,
        "session-only engine attempted checkpoint publication at turn tail");
      ending = true;
      return key(24);
    },
  };
}

function freshBirthDriver() {
  let sawBirth = false;
  let resolveReached;
  const reached = new Promise((resolve) => { resolveReached = resolve; });
  return {
    reached,
    get sawBirth() { return sawBirth; },
    input: async (request, session) => {
      if (isBirthScreen(session.text)) {
        sawBirth = true;
        resolveReached();
        return park();
      }
      assert.equal(request.context, "literal", "invalid recovery reached live play instead of birth");
      return key(13); // splash
    },
  };
}

function candidateDiagnostic(events) {
  const before = unsigned(lastInvariant(events, "checkpoint-digest-before"));
  const after = unsigned(lastInvariant(events, "checkpoint-digest-after"));
  return {
    before,
    after,
    payload: unsigned(lastInvariant(events, "checkpoint-payload-digest")),
    rng: unsigned(lastInvariant(events, "checkpoint-rng-next")),
    restored: lastInvariant(events, "state-restored"),
    wizardMode: lastInvariant(events, "checkpoint-wizard-mode"),
    wizardLit: lastInvariant(events, "checkpoint-wizard-lit"),
  };
}

function assertCandidateDiagnostic(diagnostic) {
  assert.equal(diagnostic.restored, 1, "native checkpoint did not truthfully restore all named state");
  assert.equal(diagnostic.after, diagnostic.before,
    "native checkpoint changed its aggregate state digest while the engine remained live");
}

function assertRecoveryDiagnostic(events, candidate) {
  assert.equal(lastInvariant(events, "recovery-applied"), 1,
    "native did not atomically apply the validated recovery trailer");
  assert.equal(unsigned(lastInvariant(events, "recovery-payload-digest")), candidate.payload,
    "recovery applied a payload other than the selected checkpoint generation");
  assert.equal(unsigned(lastInvariant(events, "recovery-rng-next")), candidate.rng,
    "recovery changed the exact compensated next RNG result");
  assert.equal(lastInvariant(events, "recovery-wizard-mode"), candidate.wizardMode,
    "recovery changed wizard mode before the initial monster update");
  assert.equal(lastInvariant(events, "recovery-wizard-lit"), candidate.wizardLit,
    "recovery changed wizard-lit monster visibility during the initial update");
}

function assertExactRecovery(actual, expected, label) {
  assert.equal(actual.name, expected.name, `${label} changed the character name`);
  assert.deepEqual(actual.hero, expected.hero, `${label} changed the terminal hero position`);
  assert.equal(actual.fingerprint, expected.fingerprint, `${label} changed terminal panel bytes`);
  assert.equal(actual.roguelike, expected.roguelike, `${label} changed command mode`);
  assert.equal(actual.semantic.playerName, expected.semantic.playerName,
    `${label} changed semantic character name`);
  assert.deepEqual(actual.semantic.hero, expected.semantic.hero,
    `${label} changed semantic hero position`);
  assert.deepEqual(actual.semantic.panel, expected.semantic.panel,
    `${label} changed semantic panel bounds`);
  assert.equal(actual.semantic.turn, expected.semantic.turn, `${label} changed exact turn`);
  assert.equal(actual.semantic.state, expected.semantic.state, `${label} changed semantic state`);
  assert.equal(actual.semantic.map, expected.semantic.map, `${label} changed semantic map`);
  assert.deepEqual(actual, expected, `${label} changed exact recovery snapshot`);
}

function lastInvariant(events, name) {
  const event = events.findLast((entry) => entry.name === name);
  assert.ok(event, `real checkpoint omitted ${name} diagnostic`);
  return event.value;
}

function recoveryFiles(FS) {
  return listFiles(FS, root).filter((name) => name.startsWith("recover/"))
    .map((name) => name.slice("recover/".length));
}

function recoveryBytes(FS) {
  return new Map(recoveryFiles(FS).map((name) => [
    name,
    Uint8Array.from(FS.readFile(`${recoveryRoot}/${name}`)),
  ]));
}

/** The recovery generations as IndexedDB holds them, not as the writer's own
 *  heap remembers them. */
function durableRecoveryBytes() {
  return readDurableFiles(root, "recover");
}

async function assertDurableRecovery(expected, message) {
  const actual = await durableRecoveryBytes();
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), message);
  for (const [name, bytes] of expected)
    assert.ok(bytesEqual(actual.get(name), bytes), `${message}: ${name}`);
}

function archiveRecovery(FS) {
  const files = recoveryBytes(FS);
  const commitName = [...files.keys()].find((name) => /^commit-/.test(name));
  const dataName = [...files.keys()].find((name) => /^checkpoint-/.test(name));
  assert.ok(commitName && dataName, "descendant checkpoint omitted its committed pair");
  return { commit: files.get(commitName), data: files.get(dataName) };
}

function installAsNewerStale(FS, archive) {
  const original = JSON.parse(new TextDecoder().decode(archive.commit));
  const generation = original.generation + 100;
  const file = `checkpoint-${generation}.sav`;
  const commit = {
    ...original,
    generation,
    file,
    size: archive.data.byteLength,
    checksum: fnv1a32Hex(archive.data),
  };
  FS.mkdirTree(recoveryRoot);
  FS.writeFile(`${recoveryRoot}/${file}`, archive.data);
  FS.writeFile(`${recoveryRoot}/commit-${generation}.json`,
    new TextEncoder().encode(JSON.stringify(commit)));
}

function corrupt(FS, path, mode) {
  const bytes = Uint8Array.from(FS.readFile(path));
  assert.ok(bytes.byteLength > 80, `checkpoint corruption target is too short: ${path}`);
  if (mode === "truncate") {
    FS.writeFile(path, bytes.subarray(0, Math.floor(bytes.byteLength / 2)));
    return;
  }
  bytes[bytes.byteLength - 1] ^= 0xff;
  FS.writeFile(path, bytes);
}

async function installPortable(contents) {
  const installer = await bootMoria({ startEngine: false });
  assert.equal(installer.persist.persistent, true,
    installer.persist.reason?.detail ?? "portable import could not claim pristine Moria volume");
  installMoriaImport(installer.FS, contents);
  await installer.persist.flush();
  installer.persist.release();
  closeIdbfs(installer);
}

function crash(session) {
  // Deliberately do not call lifecycle.release() or persist.flush(). Native's
  // awaited checkpoint transaction must already be the only durable source.
  session.persist.release();
  closeIdbfs(session);
}

async function resetDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(root);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`fake IDB database ${root} remained open`));
  });
}

function byGeneration(a, b) { return generation(a) - generation(b); }
function generation(name) { return Number(name.match(/-(\d+)\./)?.[1] ?? 0); }
function unsigned(value) { return value >>> 0; }

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isBirthScreen(text) {
  return /choose a race|choose a class|your sex|reroll/i.test(text);
}

function visibleText(text) {
  return text.match(/.{1,80}/gs)?.filter((row) => row.trim()).join("\n") ?? text;
}

function code(character) { return character.charCodeAt(0); }
function key(keyCode) { return { status: "key", key: keyCode }; }

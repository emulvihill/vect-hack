// Real-engine proof for the project-owned Umoria terminal, input, polling and
// controlled-exit boundary. The Worker bridge supplies the same Module option
// shapes in Task 3; this test keeps the native half executable in isolation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const COLS = 80;
const ROWS = 24;
const FRAME_BYTES = COLS * ROWS;
const TIMEOUT_MS = 15_000;
const FIXED_SEED = 1;
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const publicModuleUrl = new URL("../../public/modules/moria/", import.meta.url);

for (const extension of ["js", "wasm", "data"]) {
  const artifactUrl = new URL(`moria.${extension}`, publicModuleUrl);
  assert.ok(existsSync(artifactUrl) && statSync(artifactUrl).isFile() && statSync(artifactUrl).size > 0,
    `public/modules/moria/moria.${extension} is missing or empty — run npm run build:moria`);
}

const createMoriaModule = (await import(
  `${new URL("moria.js", publicModuleUrl).href}?native-io=${Date.now()}`
)).default;

const creationKeys = [
  13, // canonical splash
  "a".charCodeAt(0), // race
  "m".charCodeAt(0), // sex
  27, // accept rolled stats
  "a".charCodeAt(0), // class
  13, // empty name: exact X fallback
  32, // enter the dungeon
];

async function runNativeScenario(roguelike) {
  const frames = [];
  const requests = [];
  const events = [];
  /** Every delay the native side asked for, in request order. Deliberately
   *  not the elapsed time: the wait is the setTimeout below, created by this
   *  driver from that same number, so "it took >= 9ms" measured node's timer
   *  and could not fail whatever the engine did (vect-hack-8r0). What the
   *  engine chooses is the delay it requests, and that is what is asserted. */
  const pollRequests = [];
  const birthKeys = creationKeys.slice();
  let sawDungeonFrame = false;
  let sawNamedCharacter = false;
  let sawMovement = false;
  let sawAlternateCtrl = false;
  let sawCtrlRRedraw = false;
  let sawDirectionPrompt = false;
  let sawConfirmationPrompt = false;
  let sawHelpPrompt = false;
  let sawRestInterrupt = false;
  let sawRunInterrupt = false;
  let sawTomb = false;
  let sawScore = false;
  let liveStep = 0;
  let movementTarget = -1;
  let activeDirection;
  let awaitingRestPoll = false;
  let awaitingRunPoll = false;
  let ending = false;
  let beforeExitCalls = 0;

  const chooseOpenDirection = (frame, run = false) => {
    const player = frame.indexOf("@".charCodeAt(0));
    assert.ok(player >= 0, "live town frame omitted the player glyph");
    const row = Math.floor(player / COLS);
    const col = player % COLS;
    const candidates = [
      { dy: -1, dx: 0, original: "8", rogue: "k", run: "K" },
      { dy: 1, dx: 0, original: "2", rogue: "j", run: "J" },
      { dy: 0, dx: -1, original: "4", rogue: "h", run: "H" },
      { dy: 0, dx: 1, original: "6", rogue: "l", run: "L" },
      { dy: -1, dx: -1, original: "7", rogue: "y", run: "Y" },
      { dy: -1, dx: 1, original: "9", rogue: "u", run: "U" },
      { dy: 1, dx: -1, original: "1", rogue: "b", run: "B" },
      { dy: 1, dx: 1, original: "3", rogue: "n", run: "N" },
    ];
    const open = (candidate, distance) => {
      const y = row + candidate.dy * distance;
      const x = col + candidate.dx * distance;
      return y >= 1 && y < 23 && x >= 13 && x < 79 &&
        frame[y * COLS + x] === ".".charCodeAt(0);
    };
    const direction = candidates.find((candidate) => open(candidate, 1) && (!run || open(candidate, 2)))
      ?? candidates.find((candidate) => open(candidate, 1));
    assert.ok(direction, `fixed-seed town has no visible open neighbor around ${row},${col}`);
    return { ...direction, player, target: player + direction.dy * COLS + direction.dx };
  };

  const module = await createMoriaModule({
    locateFile: (path) => fileURLToPath(new URL(path, publicModuleUrl)),
    terminalFlush: (cells, y, x) => {
      const copy = Uint8Array.from(cells);
      assert.equal(copy.byteLength, FRAME_BYTES,
        "terminalFlush did not provide an exact 80x24 / 1,920-byte frame");
      assert.ok(Number.isInteger(y) && y >= 0 && y < ROWS, `invalid terminal cursor row ${y}`);
      assert.ok(Number.isInteger(x) && x >= 0 && x < COLS, `invalid terminal cursor column ${x}`);
      frames.push(copy);
      events.push("frame");
    },
    terminalBell: () => events.push("bell"),
    getKeyInput: async (request) => {
      assert.ok(request && typeof request === "object", "native key import omitted request metadata");
      assert.equal(request.roguelike, roguelike, "native key request omitted the live key mode");
      requests.push({ ...request });
      assert.ok(requests.length <= 5_000,
        `fixed-seed native run exceeded 5,000 input requests at live step ${liveStep}`);

      if (request.blocking) {
        assert.ok(request.context === "literal" || request.context === "outer-command",
          `blocking request used invalid context ${request.context}`);
        assert.equal(request.delayMicroseconds, 0,
          "blocking request unexpectedly carried a poll delay");
        const frame = frames.at(-1);
        assert.ok(frame, "native core requested a key before its terminal flush");
        const text = Buffer.from(frame).toString("latin1");
        sawNamedCharacter ||= /Name\s*: X\b/.test(text);
        if (request.context === "outer-command") {
          assert.match(text, /Town level/, "outer command request did not follow the live town frame");
          assert.ok(text.includes("@"), "outer command request did not follow a frame containing the player");
          sawDungeonFrame = true;
        }

        let key;
        if (birthKeys.length > 0) {
          assert.equal(request.context, "literal", "character creation requested command-mapped input");
          key = birthKeys.shift();
        } else if (request.context === "literal" && text.includes(" -more-")) {
          key = 32;
        } else if (ending) {
          if (/Do you really want to quit\?/.test(text)) {
            sawConfirmationPrompt = true;
            key = "y".charCodeAt(0);
          } else if (/Character record\?/.test(text)) {
            sawTomb = /Quitting/.test(text);
            key = 27;
          } else if (/Rank\s+Points\s+Name/.test(text)) {
            sawScore = true;
            key = 27;
          } else if (!roguelike) {
            key = 27;
          } else {
            assert.fail(`unexpected confirmed-quit input frame:\n${text
              .match(/.{1,80}/gs)?.filter((row) => row.trim()).join("\n")}`);
          }
        } else if (liveStep === 0) {
          assert.equal(request.context, "outer-command", "eighth blocking read was not the first live command");
          assert.equal(requests.filter((entry) => entry.blocking).length, 8,
            "fixed creation script did not reach town on the eighth blocking read");
          assert.match(text, /\bLEV\s*:\s*1\b/, "live town frame omitted the level status field");
          assert.match(text, /\bMHP\s*:/, "live town frame omitted the hit-point status field");
          activeDirection = chooseOpenDirection(frame);
          movementTarget = activeDirection.target;
          liveStep = 1;
          key = (roguelike ? activeDirection.rogue : activeDirection.original).charCodeAt(0);
        } else if (liveStep === 1) {
          assert.equal(request.context, "outer-command", "ordinary movement entered a nested command context");
          sawMovement = frame[movementTarget] === "@".charCodeAt(0);
          liveStep = 2;
          key = "^".charCodeAt(0);
        } else if (liveStep === 2) {
          assert.equal(request.context, "literal", "alternate Ctrl suffix was command-mapped");
          assert.match(text, /Control-/, "alternate Ctrl input omitted its literal prompt");
          sawAlternateCtrl = true;
          liveStep = 3;
          key = "P".charCodeAt(0);
        } else if (liveStep === 3) {
          assert.equal(request.context, "outer-command", "post-Ctrl command did not return to the outer read");
          liveStep = 31;
          key = 18;
        } else if (liveStep === 31) {
          assert.equal(request.context, "outer-command", "Ctrl-R redraw changed the pending command context");
          sawCtrlRRedraw = true;
          liveStep = 4;
          key = (roguelike ? "f" : "B").charCodeAt(0);
        } else if (liveStep === 4) {
          assert.equal(request.context, "literal", "direction prompt was command-mapped");
          assert.match(text, /Which direction\?/, "bash did not expose the nested direction prompt");
          sawDirectionPrompt = true;
          liveStep = 5;
          key = (roguelike ? activeDirection.rogue : activeDirection.original).charCodeAt(0);
        } else if (liveStep === 5) {
          assert.equal(request.context, "outer-command", "post-direction command did not return to the outer read");
          liveStep = 6;
          key = roguelike ? "Q".charCodeAt(0) : 11;
        } else if (liveStep === 6) {
          assert.equal(request.context, "literal", "quit confirmation was command-mapped");
          assert.match(text, /Do you really want to quit\?/, "quit did not expose its literal confirmation");
          sawConfirmationPrompt = true;
          liveStep = 7;
          key = "n".charCodeAt(0);
        } else if (liveStep === 7) {
          assert.equal(request.context, "outer-command", "cancelled quit did not return to the outer read");
          liveStep = 8;
          key = "?".charCodeAt(0);
        } else if (liveStep === 8) {
          assert.equal(request.context, "literal", "help page was command-mapped");
          assert.match(text, /press any key to continue/i, "help page omitted its literal continuation prompt");
          sawHelpPrompt = true;
          liveStep = 9;
          key = 27;
        } else if (liveStep === 9) {
          assert.equal(request.context, "outer-command", "help page did not return to the outer read");
          liveStep = 10;
          key = (roguelike ? "3" : "#").charCodeAt(0);
        } else if (liveStep === 10 && roguelike) {
          assert.equal(request.context, "literal", "roguelike count continuation was command-mapped");
          awaitingRestPoll = true;
          liveStep = 13;
          key = ".".charCodeAt(0);
        } else if (liveStep === 10) {
          assert.equal(request.context, "literal", "original count digit was command-mapped");
          liveStep = 11;
          key = "3".charCodeAt(0);
        } else if (liveStep === 11) {
          assert.equal(request.context, "literal", "original count terminator was command-mapped");
          liveStep = 12;
          key = 32;
        } else if (liveStep === 12) {
          assert.equal(request.context, "literal", "original counted command was command-mapped");
          awaitingRestPoll = true;
          liveStep = 13;
          key = "5".charCodeAt(0);
        } else if (liveStep === 13) {
          assert.equal(request.context, "outer-command", "interrupted rest did not return to the outer read");
          assert.ok(sawRestInterrupt, "counted rest reached the outer read without its 10ms interrupt poll");
          activeDirection = chooseOpenDirection(frame, true);
          if (roguelike) {
            awaitingRunPoll = true;
            liveStep = 15;
            key = activeDirection.run.charCodeAt(0);
          } else {
            liveStep = 14;
            key = ".".charCodeAt(0);
          }
        } else if (liveStep === 14) {
          assert.equal(request.context, "literal", "original run direction was command-mapped");
          assert.match(text, /Which direction\?/, "original run omitted its literal direction prompt");
          awaitingRunPoll = true;
          liveStep = 15;
          key = activeDirection.original.charCodeAt(0);
        } else if (liveStep === 15) {
          assert.equal(request.context, "outer-command", "interrupted run did not return to the outer read");
          assert.ok(sawRunInterrupt, "run reached the outer read without its zero-delay interrupt poll");
          ending = true;
          liveStep = 16;
          key = roguelike ? "Q".charCodeAt(0) : 24;
        } else {
          assert.fail(`unexpected ${request.context} key request at live step ${liveStep}:\n${text
            .match(/.{1,80}/gs)?.filter((row) => row.trim()).join("\n")}`);
        }
        requests.at(-1).key = key;
        return { status: "key", key };
      }

      assert.equal(request.context, "poll", "nonblocking request was not marked as a poll");
      assert.ok(request.delayMicroseconds === 0 || request.delayMicroseconds === 10_000,
        `unexpected native poll delay ${request.delayMicroseconds}`);
      events.push(`poll-request:${request.delayMicroseconds}`);
      await new Promise((resolvePoll) => setTimeout(() => {
        events.push(`poll-task:${request.delayMicroseconds}`);
        resolvePoll();
      }, request.delayMicroseconds === 0 ? 0 : request.delayMicroseconds / 1000));
      pollRequests.push(request.delayMicroseconds);
      events.push(`poll-response:${request.delayMicroseconds}`);
      if (awaitingRestPoll && request.delayMicroseconds === 10_000) {
        awaitingRestPoll = false;
        sawRestInterrupt = true;
        return { status: "key", key: 0 };
      }
      if (awaitingRunPoll && request.delayMicroseconds === 0) {
        awaitingRunPoll = false;
        sawRunInterrupt = true;
        return { status: "key", key: 0 };
      }
      return { status: "none" };
    },
    beforeExit: async (status, outcome) => {
      beforeExitCalls += 1;
      assert.equal(status, 0, "normal Umoria exit did not preserve status 0");
      assert.equal(outcome, roguelike ? 2 : 1,
        roguelike
          ? "confirmed Q quit was not classified as a terminal outcome"
          : "Ctrl-X save-and-exit did not carry the exact source-classified (saved) reason");
      assert.equal(events.at(-1), "frame",
        "pre-exit hook ran before terminalRestore's final terminal flush");
      events.push("beforeExit");
      await Promise.resolve();
    },
  });

  const callerExitCode = process.exitCode;
  let timeoutId;
  const startResult = await Promise.race([
    Promise.resolve()
      .then(() => module.ccall(
        "moria_start", "number", ["number", "boolean"], [FIXED_SEED, roguelike], { async: true },
      ))
      .then(
        (value) => ({ kind: "resolved", value }),
        (error) => ({ kind: "rejected", error }),
      ),
    new Promise((resolveTimeout) => {
      timeoutId = setTimeout(() => resolveTimeout({ kind: "timeout" }), TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timeoutId);

  assert.notEqual(startResult.kind, "timeout",
    `fixed-seed native I/O run did not reach controlled exit within ${TIMEOUT_MS}ms`);
  if (beforeExitCalls === 0) {
    if (startResult.kind === "rejected") {
      throw startResult.error;
    }
    assert.fail(`moria_start returned without its controlled-exit marker: ${startResult.value}`);
  }
  // Emscripten 6 Asyncify handles libc's ExitStatus while rewinding and resolves
  // this ccall with undefined. A genuine native return remains numeric (including
  // zero), so the pre-exit marker and nonnumeric teardown stay distinguishable.
  assert.equal(startResult.kind, "resolved",
    `controlled native exit unexpectedly rejected: ${startResult.error?.stack ?? startResult.error}`);
  assert.equal(startResult.value, undefined,
    `moria_start produced a native return after its controlled-exit marker: ${startResult.value}`);
  process.exitCode = callerExitCode;

  assert.equal(beforeExitCalls, 1, "native exit wrapper did not call the pre-exit hook exactly once");
  assert.equal(events.at(-1), "beforeExit", "events occurred after the awaited pre-exit hook");
  assert.ok(sawDungeonFrame, "fixed-seed input never reached an outer dungeon command request");
  assert.ok(sawNamedCharacter, "fixed-seed creation never rendered the fallback character name X");
  assert.ok(sawMovement, "dynamic open-cell command did not move the player glyph");
  assert.ok(sawAlternateCtrl, "alternate Ctrl input did not traverse its literal suffix read");
  assert.ok(sawCtrlRRedraw, "Ctrl-R did not redraw and request another outer command key");
  assert.ok(sawDirectionPrompt, "direction prompt did not traverse its literal read");
  assert.ok(sawConfirmationPrompt, "confirmation prompt did not traverse its literal read");
  assert.ok(sawHelpPrompt, "help page did not traverse its literal continuation read");
  assert.ok(sawRestInterrupt, "counted rest was not interrupted through its 10ms poll");
  assert.ok(sawRunInterrupt, "run was not interrupted through its zero-delay poll");
  assert.equal(liveStep, 16, "native run exited before consuming the complete live input script");
  assert.equal(sawTomb, roguelike, "confirmed-quit tomb coverage did not match the selected key mode");
  assert.ok(sawScore, "normal exit did not expose the score screen");
  if (!roguelike) {
    assert.ok(module.FS.readdir("/moria-seed").includes("game.sav"),
      "Ctrl-X reached normal exit without creating game.sav");
    assert.ok(module.FS.stat("/moria-seed/game.sav").size > 0,
      "Ctrl-X created an empty game.sav");
  }
  assert.ok(requests.slice(0, creationKeys.length)
    .every((request) => request.blocking && request.context === "literal"),
    "character-creation reads were not literal input requests");
  const zeroPollRequest = events.indexOf("poll-request:0");
  const zeroPollTask = events.indexOf("poll-task:0", zeroPollRequest + 1);
  const zeroPollResponse = events.indexOf("poll-response:0", zeroPollTask + 1);
  const postPollFrame = events.indexOf("frame", zeroPollResponse + 1);
  assert.ok(zeroPollRequest >= 0 && zeroPollRequest < zeroPollTask &&
    zeroPollTask < zeroPollResponse && zeroPollResponse < postPollFrame,
  "zero-delay poll did not yield a Worker task before native execution resumed");
  assert.ok(pollRequests.includes(10_000),
    "counted rest never asked for the 10,000us poll delay");
}

await runNativeScenario(false);
await runNativeScenario(true);

const harnessSource = join(ROOT, "scripts/test/moria-native-io-harness.cpp");
assert.ok(existsSync(harnessSource),
  "missing native terminal harness for source-faithful ui_io_wasm.cpp behavior");
const harnessOut = mkdtempSync(join(tmpdir(), "vect-moria-native-io-"));
try {
  const upstreamObjects = readdirSync(join(ROOT, "build/moria/obj/upstream"))
    .filter((name) => name.endsWith(".o"))
    .sort()
    .map((name) => join(ROOT, "build/moria/obj/upstream", name));
  const harnessJs = join(harnessOut, "moria-native-harness.js");
  const harnessExports = [
    "_moria_start",
    "_moria_test_terminal",
    "_moria_test_messages",
    "_moria_test_partial_line",
    "_moria_test_paths",
    "_moria_test_bell",
    "_moria_test_poll",
    "_moria_test_io_state",
  ];
  const harnessBuild = spawnSync(join(ROOT, "external/emsdk/upstream/emscripten/em++"), [
    "-D__linux__", `-I${join(ROOT, "external/umoria/src")}`,
    "-std=c++14", "-O2", "-w", harnessSource,
    ...upstreamObjects,
    join(ROOT, "build/moria/obj/native/main-wasm.o"),
    join(ROOT, "build/moria/obj/native/semantic-wasm.o"),
    join(ROOT, "build/moria/obj/native/game-save-wasm.o"),
    join(ROOT, "build/moria/obj/native/checkpoint-wasm.o"),
    "--no-entry", "-s", "ENVIRONMENT=node", "-s", "EXPORT_ES6=1", "-s", "MODULARIZE=1",
    "-s", 'EXPORT_NAME="createMoriaNativeHarness"', "-s", "ASYNCIFY=1",
    "-Wl,--wrap=exit", "-s", `EXPORTED_FUNCTIONS=${JSON.stringify(harnessExports)}`,
    "-s", 'EXPORTED_RUNTIME_METHODS=["ccall","FS"]',
    "--preload-file", `${join(ROOT, "build/moria/seed")}@/moria-seed`,
    "-o", harnessJs,
  ], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(harnessBuild.status, 0,
    `native terminal harness failed to build:\n${harnessBuild.stdout}${harnessBuild.stderr}`);
  const createHarness = (await import(`${pathToFileURL(harnessJs).href}?harness=${Date.now()}`)).default;
  const harnessOptions = (extra = {}) => ({
    locateFile: (path) => join(harnessOut, path),
    ...extra,
  });

  const terminalFrames = [];
  const terminalHarness = await createHarness(harnessOptions({
    terminalFlush: (cells, y, x) => terminalFrames.push({ cells: Uint8Array.from(cells), y, x }),
  }));
  assert.equal(terminalHarness.ccall("moria_test_terminal", "number", [], []), 600,
    "terminal harness did not finish at clearToBottom row 6, column 0");
  assert.equal(terminalFrames.length, 5, "terminal harness emitted an unexpected number of phase frames");
  const row = (frame, y) => Buffer.from(frame.cells.subarray(y * COLS, (y + 1) * COLS));
  assert.equal(row(terminalFrames[1], 5).subarray(75).toString("latin1"), "ABCD ",
    "putString did not clip before the rightmost terminal cell");
  assert.equal(row(terminalFrames[2], 5).subarray(75).toString("latin1"), "AXY  ",
    "putStringClearToEOL did not wipe and rewrite the requested suffix");
  assert.deepEqual(terminalFrames[3], terminalFrames[2],
    "terminalRestoreScreen did not restore exact cells and cursor");
  assert.equal(row(terminalFrames[4], 5).subarray(75).toString("latin1"), "AXY  ",
    "clearToBottom modified a row above its boundary");
  for (let y = 6; y < ROWS; y += 1) {
    assert.ok(row(terminalFrames[4], y).every((byte) => byte === 0x20),
      `clearToBottom left a non-space byte on row ${y}`);
  }

  const messageFrames = [];
  const messageHarness = await createHarness(harnessOptions({
    terminalFlush: (cells) => messageFrames.push(Uint8Array.from(cells)),
    getKeyInput: async () => ({ status: "key", key: 32 }),
  }));
  assert.equal(await messageHarness.ccall("moria_test_messages", "number", [], [], { async: true }), 7,
    "message harness did not preserve combined and subsequent history entries");
  assert.ok(messageFrames.some((frame) => row({ cells: frame }, 0).toString("latin1").includes(" -more-")),
    "long message transition never exposed the source-faithful -more- gate");

  const partialKeys = ["A".charCodeAt(0), "B".charCodeAt(0), 27];
  const partialHarness = await createHarness(harnessOptions({
    getKeyInput: async () => ({ status: "key", key: partialKeys.shift() }),
  }));
  const partialResult = (await partialHarness.ccall(
    "moria_test_partial_line", "number", [], [], { async: true },
  )) >>> 0;
  assert.equal(partialResult, (("A".charCodeAt(0) << 8) |
    ("B".charCodeAt(0) << 16) | ("q".charCodeAt(0) << 24)) >>> 0,
  "aborted line edit did not preserve the exact partial-buffer bytes");

  const pathHarness = await createHarness(harnessOptions());
  assert.equal(pathHarness.ccall("moria_test_paths", "number", [], []), 63,
    "relative/tilde path expansion or file wrappers diverged from the native contract");
  assert.equal(Buffer.from(pathHarness.FS.readFile("/tmp/moria-relative.tmp")).toString(), "relative",
    "tfopen did not write through the relative path wrapper");
  assert.equal(Buffer.from(pathHarness.FS.readFile("/home/web_user/moria-tilde.tmp")).toString(), "tilde",
    "topen did not write through the tilde path wrapper");

  let bells = 0;
  const bellHarness = await createHarness(harnessOptions({ terminalBell: () => { bells += 1; } }));
  assert.equal(bellHarness.ccall("moria_test_bell", "number", [], []), 3,
    "optional bell did not return the source-faithful disabled/enabled results");
  assert.equal(bells, 1, "optional bell callback fired while disabled or failed to fire while enabled");

  const pollOrder = [];
  const pollReplies = [{ status: "none" }, { status: "key", key: 0 }];
  const pollHarness = await createHarness(harnessOptions({
    getKeyInput: async (request) => {
      assert.deepEqual(request, {
        blocking: false, context: "poll", roguelike: false, delayMicroseconds: 0,
      }, "direct poll harness received malformed metadata");
      pollOrder.push("request");
      await new Promise((resolveTask) => setTimeout(() => {
        pollOrder.push("task");
        resolveTask();
      }, 0));
      pollOrder.push("reply");
      return pollReplies.shift();
    },
  }));
  assert.equal(await pollHarness.ccall("moria_test_poll", "number", [], [], { async: true }), 3,
    "poll native result did not distinguish explicit no-key from key byte NUL");
  assert.deepEqual(pollOrder, ["request", "task", "reply", "request", "task", "reply"],
    "zero-delay native polls resumed without an intervening Worker task");
  assert.equal(pollHarness.ccall("moria_test_io_state", "number", [], []), 0,
    "no-key/NUL polls altered EOF or panic state");

  const verifyInputFailure = async (label, getKeyInput, expected) => {
    let beforeExitCalls = 0;
    const callerExitCode = process.exitCode;
    const options = harnessOptions({
      beforeExit: async () => { beforeExitCalls += 1; },
      ...(getKeyInput === undefined ? {} : { getKeyInput }),
    });
    const module = await createHarness(options);
    const result = await module.ccall(
      "moria_start", "number", ["number", "boolean"], [FIXED_SEED, false], { async: true },
    ).then(
      (value) => ({ kind: "resolved", value }),
      (error) => ({ kind: "rejected", error }),
    );
    process.exitCode = callerExitCode;
    assert.equal(result.kind, "rejected", `${label} input unexpectedly resolved: ${result.value}`);
    if (expected instanceof Error) {
      assert.equal(result.error, expected, `${label} input did not preserve the exact rejection object`);
    } else {
      assert.match(String(result.error?.message ?? result.error), expected,
        `${label} input rejection did not retain its validation reason`);
    }
    assert.equal(beforeExitCalls, 0, `${label} input failure entered the pre-exit hook`);
    assert.equal(module.moriaPreExit, undefined, `${label} input failure set the pre-exit marker`);
    assert.equal(module.ccall("moria_test_io_state", "number", [], []), 0,
      `${label} input failure altered EOF or panic state`);
    assert.ok(!module.FS.readdir("/moria-seed").includes("game.sav"),
      `${label} input failure created a panic save`);
  };
  const exactInputFailure = new Error("exact rejected input sentinel");
  await verifyInputFailure("rejected", async () => { throw exactInputFailure; }, exactInputFailure);
  await verifyInputFailure("missing", undefined, /requires a getKeyInput module option/);
  await verifyInputFailure("missing response", async () => undefined,
    /blocking getKeyInput must resolve/);
  await verifyInputFailure("no-key blocking response", async () => ({ status: "none" }),
    /blocking getKeyInput must resolve/);
  await verifyInputFailure("out-of-range response", async () => ({ status: "key", key: 256 }),
    /blocking getKeyInput must resolve/);

  const verifyPollFailure = async (label, getKeyInput, expected) => {
    let beforeExitCalls = 0;
    const callerExitCode = process.exitCode;
    const module = await createHarness(harnessOptions({
      getKeyInput,
      beforeExit: async () => { beforeExitCalls += 1; },
    }));
    const result = await module.ccall(
      "moria_test_poll", "number", [], [], { async: true },
    ).then(
      (value) => ({ kind: "resolved", value }),
      (error) => ({ kind: "rejected", error }),
    );
    process.exitCode = callerExitCode;
    assert.equal(result.kind, "rejected", `${label} poll unexpectedly resolved: ${result.value}`);
    if (expected instanceof Error) {
      assert.equal(result.error, expected, `${label} poll did not preserve the exact rejection object`);
    } else {
      assert.match(String(result.error?.message ?? result.error), expected,
        `${label} poll rejection did not retain its validation reason`);
    }
    assert.equal(beforeExitCalls, 0, `${label} poll failure entered the pre-exit hook`);
    assert.equal(module.moriaPreExit, undefined, `${label} poll failure set the pre-exit marker`);
    assert.equal(module.ccall("moria_test_io_state", "number", [], []), 0,
      `${label} poll failure altered EOF or panic state`);
    assert.ok(!module.FS.readdir("/moria-seed").includes("game.sav"),
      `${label} poll failure created a panic save`);
  };
  const exactPollFailure = new Error("exact rejected poll sentinel");
  await verifyPollFailure("rejected", async () => { throw exactPollFailure; }, exactPollFailure);
  await verifyPollFailure("missing response", async () => undefined,
    /poll getKeyInput must resolve to an explicit key or no-key result/);
  await verifyPollFailure("out-of-range response", async () => ({ status: "key", key: 256 }),
    /poll getKeyInput must resolve to an explicit key or no-key result/);

  let parkedRequestResolve;
  const parkedRequest = new Promise((resolveRequest) => { parkedRequestResolve = resolveRequest; });
  let parkedBeforeExit = 0;
  const parkedHarness = await createHarness(harnessOptions({
    getKeyInput: (request) => {
      parkedRequestResolve(request);
      return new Promise(() => {});
    },
    beforeExit: async () => { parkedBeforeExit += 1; },
  }));
  const parkedStart = parkedHarness.ccall(
    "moria_start", "number", ["number", "boolean"], [FIXED_SEED, false], { async: true },
  );
  let parkedSettled = false;
  void parkedStart.then(
    () => { parkedSettled = true; },
    () => { parkedSettled = true; },
  );
  assert.deepEqual(await parkedRequest, {
    blocking: true, context: "literal", roguelike: false, delayMicroseconds: 0,
  }, "live channel closure did not park at the blocking native read");
  await new Promise((resolveTask) => setTimeout(resolveTask, 0));
  assert.equal(parkedSettled, false, "live channel closure settled the blocking native read");
  assert.equal(parkedBeforeExit, 0, "live channel closure entered the pre-exit hook");
  assert.equal(parkedHarness.moriaPreExit, undefined, "live channel closure set the pre-exit marker");
  assert.equal(parkedHarness.ccall("moria_test_io_state", "number", [], []), 0,
    "live channel closure altered EOF or panic state");
  assert.ok(!parkedHarness.FS.readdir("/moria-seed").includes("game.sav"),
    "live channel closure created a panic save");
} finally {
  rmSync(harnessOut, { recursive: true, force: true });
}

console.log("OK(moria-native-io): both modes, terminal parity, explicit poll results, input failures, and controlled exit are live");

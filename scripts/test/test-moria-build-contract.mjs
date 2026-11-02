import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MORIA = `${ROOT}/external/umoria`;
const PIN = "3bf8abc4f76812810e59d738492c7b61fb8f1bb6";
const OFFICIAL_URL = "https://github.com/dungeons-of-moria/umoria";
const EMSDK_PIN = "224ec5f9f2f72f09f9ce0e26d66bae7dbd8b692f";
const EMSDK = `${ROOT}/external/emsdk`;
const STRICT = process.argv.includes("--require-build");

const run = (command, args, options = {}) => spawnSync(command, args, {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  ...options,
});
const checked = (command, args, options = {}) => {
  const result = run(command, args, options);
  assert.equal(result.status, 0,
    `${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result;
};
const git = (...args) => checked("git", args).stdout.trim();
const listFiles = (root) => {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path));
      else assert.fail(`staged runtime entry is not a regular file: ${path}`);
    }
  };
  visit(root);
  return files.sort();
};

const gitmodules = readFileSync(`${ROOT}/.gitmodules`, "utf8");
const submoduleEntry = [
  '[submodule "external/umoria"]',
  "\tpath = external/umoria",
  `\turl = ${OFFICIAL_URL}`,
];
const gitmoduleLines = gitmodules.split("\n");
const submoduleIndex = gitmoduleLines.indexOf(submoduleEntry[0]);
assert.notEqual(
  submoduleIndex,
  -1,
  `missing official external/umoria entry in .gitmodules (${OFFICIAL_URL})`,
);
assert.deepEqual(gitmoduleLines.slice(submoduleIndex, submoduleIndex + submoduleEntry.length), submoduleEntry,
  "external/umoria .gitmodules path or URL does not match the official source");

assert.equal(git("-C", MORIA, "rev-parse", "HEAD"), PIN, "external/umoria is not at the approved pin");
assert.equal(git("-C", MORIA, "status", "--short"), "", "external/umoria has local modifications");

const indexEntry = git("ls-files", "--stage", "--", "external/umoria");
const indexGitlink = indexEntry.match(/^160000 ([0-9a-f]{40}) 0\texternal\/umoria$/)?.[1];
assert.equal(indexGitlink, PIN, "the superproject index does not pin external/umoria at the approved commit");
const gitlinkIsStaged = git("diff", "--cached", "--name-only", "--", "external/umoria") !== "";
if (!gitlinkIsStaged) {
  assert.equal(git("rev-parse", "HEAD:external/umoria"), PIN,
    "the committed superproject gitlink does not pin external/umoria at the approved commit");
}

const licensePath = `${MORIA}/LICENSE`;
assert.ok(existsSync(licensePath), "external/umoria/LICENSE is missing");
const license = readFileSync(licensePath, "utf8");
assert.match(license, /GNU GENERAL PUBLIC LICENSE/,
  "external/umoria/LICENSE is not the upstream GNU GPL text");
assert.match(license, /Version 3, 29 June 2007/,
  "external/umoria/LICENSE is not the upstream GPL version 3 text");
const authors = readFileSync(`${MORIA}/AUTHORS`, "utf8");
assert.match(authors, /re-licensed under the GNU General Public License\s+version 3\.0-or-later/i,
  "external/umoria/AUTHORS does not carry the upstream GPL-3.0-or-later provenance");

const setupToolchain = readFileSync(`${ROOT}/scripts/build/setup-toolchain.sh`, "utf8");
const setupSubmodules = setupToolchain.split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith('git -C "$ROOT" submodule update --init '))
  .map((line) => line.match(/^git -C "\$ROOT" submodule update --init (\S+)$/)?.[1]);
assert.deepEqual(setupSubmodules, [
  "external/NetHack",
  "external/angband",
  "external/umoria",
], "setup-toolchain.sh does not initialize the exact supported engine submodule list");

console.log(`OK(source/license): Umoria is clean at ${PIN}, with the official gitlink and GPL-3.0-or-later provenance`);

const packageJson = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
assert.equal(packageJson.scripts["build:moria"], "scripts/build/build-moria-wasm.sh",
  "package.json build:moria does not invoke the guarded build");
assert.equal(packageJson.scripts["test:moria-boot"], "timeout 120 node scripts/test/test-moria-boot.mjs",
  "package.json test:moria-boot does not invoke Task 3's real smoke test");
assert.equal(packageJson.scripts["test:moria-play"], "timeout 120 node scripts/test/test-moria-play.mjs",
  "package.json test:moria-play does not invoke the bounded live-engine gate");
assert.equal(packageJson.scripts["test:moria-checkpoint-native"],
  "timeout 120 node scripts/test/test-moria-checkpoint-native.mjs",
  "package.json test:moria-checkpoint-native does not invoke the exact rollback harness");
assert.equal(packageJson.scripts["test:moria-map-contract"],
  "timeout 120 node scripts/test/test-moria-map-contract.mjs",
  "package.json test:moria-map-contract does not invoke the semantic gate");
assert.equal(packageJson.scripts["test:moria-persist"],
  "timeout 180 node scripts/test/test-moria-persistence.mjs",
  "package.json test:moria-persist does not invoke the real persistence gate");
assert.equal(packageJson.scripts["test:moria-save-restore"],
  "timeout 180 node scripts/test/test-moria-save-restore.mjs",
  "package.json test:moria-save-restore does not invoke the real restore gate");
assert.equal(packageJson.scripts["test:moria-tabs"],
  "timeout 180 node scripts/test/test-moria-tabs.mjs",
  "package.json test:moria-tabs does not invoke the real two-engine gate");
assert.equal(packageJson.scripts["test:moria-autosave"],
  "timeout 180 node scripts/test/test-moria-autosave.mjs",
  "package.json test:moria-autosave does not invoke the real turn-tail recovery gate");
assert.equal(packageJson.scripts["test:moria-overlay"],
  "timeout 240 node scripts/test/test-moria-overlay.mjs",
  "package.json test:moria-overlay does not invoke the real source-owned overlay gate");
assert.equal(packageJson.scripts["test:moria-build-contract"],
  "timeout 900 node scripts/test/test-moria-build-contract.mjs --require-build",
  "package.json test:moria-build-contract does not run this gate with the behavioral build checks");
assert.equal(packageJson.scripts["test:moria"],
  "npm run test:moria-boot && npm run test:moria-play && npm run test:moria-checkpoint-native && npm run test:moria-map-contract && npm run test:moria-persist && npm run test:moria-save-restore && npm run test:moria-tabs && npm run test:moria-autosave && npm run test:moria-overlay && npm run test:moria-build-contract",
  "package.json test:moria does not run every completed Moria engine gate");
assert.equal(packageJson.scripts.test,
  "npm run typecheck && npm run test:render && npm run test:nethack && npm run test:angband && npm run test:larn && npm run test:moria",
  "package.json test does not run typecheck, render, and every Module group in the required order");

if (!STRICT) {
  const buildScriptPath = `${ROOT}/scripts/build/build-moria-wasm.sh`;
  const buildState = existsSync(buildScriptPath)
    ? "run with --require-build for the behavioral build checks"
    : "scripts/build/build-moria-wasm.sh is not present";
  // Exit NON-ZERO. Everything below this line is the gate; without the flag
  // only the source pin and the npm scripts were checked, and a run that
  // reports success having skipped the contract is exactly the unrun-test-that-
  // reads-green shape this file exists to prevent.
  console.error(`INCOMPLETE: Umoria build contract — ${buildState}`);
  process.exit(1);
}

// A stub `make` has to leave a link output carrying the exported name the build
// script's own guard greps for (build-moria-wasm.sh: `_moria_describe`).
// Without it the build stops at that guard and never reaches the source and
// publication behaviour the stub fixtures below exist to prove — which is how
// those fixtures went vacuous when the Look HUD added the second export.
const STUB_EXPORTS = "_moria_start _moria_describe";
const stubArtifact = (label, extension) =>
  (extension === "js" ? `${label} js\n${STUB_EXPORTS}\n` : `${label} ${extension}\n`);

const buildScript = `${ROOT}/scripts/build/build-moria-wasm.sh`;
const makefile = `${ROOT}/scripts/build/moria-wasm.mk`;
const stageScript = `${ROOT}/scripts/build/stage-moria-seed.sh`;
const guardScript = `${ROOT}/scripts/build/guard-host-paths.sh`;
const mainNative = `${ROOT}/src/modules/moria/native/main-wasm.cpp`;
const uiNative = `${ROOT}/src/modules/moria/native/ui_io_wasm.cpp`;
const semanticNative = `${ROOT}/src/modules/moria/native/semantic-wasm.cpp`;
const semanticHeader = `${ROOT}/src/modules/moria/native/semantic-wasm.h`;
const checkpointNative = `${ROOT}/src/modules/moria/native/checkpoint-wasm.cpp`;
const checkpointHeader = `${ROOT}/src/modules/moria/native/checkpoint-wasm.h`;
const gameSaveNative = `${ROOT}/src/modules/moria/native/game-save-wasm.cpp`;
for (const path of [
  buildScript, makefile, stageScript, guardScript, mainNative, uiNative, semanticNative, semanticHeader,
  checkpointNative, checkpointHeader, gameSaveNative,
]) {
  assert.ok(existsSync(path), `missing Moria build input: ${relative(ROOT, path)}`);
}

const upstreamUiIo = readFileSync(`${MORIA}/src/ui_io.cpp`, "utf8");
const upstreamGameRun = readFileSync(`${MORIA}/src/game_run.cpp`, "utf8");
const upstreamGameDeath = readFileSync(`${MORIA}/src/game_death.cpp`, "utf8");
const upstreamGame = readFileSync(`${MORIA}/src/game.cpp`, "utf8");
const upstreamStore = readFileSync(`${MORIA}/src/store.cpp`, "utf8");
const upstreamCharacter = readFileSync(`${MORIA}/src/character.cpp`, "utf8");
const nativeMainText = readFileSync(mainNative, "utf8");
const nativeUiText = readFileSync(uiNative, "utf8");
const nativeSemanticText = readFileSync(semanticNative, "utf8");
// checkpoint-wasm.cpp itself is pinned as a compiled source (the
// expectedSources deepEqual below) but nothing asserts on its CONTENT, unlike
// its four siblings here. Reading it into a variable no assertion consults
// only made that look covered.
const nativeCheckpointHeaderText = readFileSync(checkpointHeader, "utf8");
const nativeGameSaveText = readFileSync(gameSaveNative, "utf8");
const makefileText = readFileSync(makefile, "utf8");
const uiDefinitions = [
  "terminalInitialize", "terminalRestore", "terminalSaveScreen", "terminalRestoreScreen",
  "terminalBellSound", "putQIO", "flushInputBuffer", "clearScreen", "clearToBottom",
  "moveCursor", "addChar", "putString", "putStringClearToEOL", "eraseLine",
  "panelMoveCursor", "panelPutTile", "messageLinePrintMessage", "messageLineClear",
  "printMessage", "printMessageNoCommandInterrupt", "getKeyInput", "getCommand",
  "getTileCharacter", "getMenuItemId", "getStringInput", "getInputConfirmation",
  "getInputConfirmationWithAbort", "waitForContinueKey", "checkForNonBlockingKeyPress",
  "getDefaultPlayerName", "tfopen", "topen", "tilde", "checkFilePermissions",
];
for (const name of uiDefinitions) {
  assert.match(upstreamUiIo, new RegExp(`\\b${name}\\s*\\([^;]*\\)\\s*\\{`),
    `pinned upstream ui_io.cpp no longer defines ${name}; re-audit the WASM boundary`);
  assert.match(nativeUiText, new RegExp(`\\b${name}\\s*\\([^;]*\\)\\s*\\{`),
    `project-owned ui_io_wasm.cpp does not define upstream I/O function ${name}`);
}
assert.match(nativeUiText,
  /^\/\/ Copyright \(c\) 1981-86 Robert A\. Koeneke\n\/\/ Copyright \(c\) 1987-94 James E\. Wilson\n\/\/\n\/\/ SPDX-License-Identifier: GPL-3\.0-or-later/m,
  "ui_io_wasm.cpp does not preserve the upstream copyright/SPDX header");
assert.match(nativeUiText, /constexpr int TERM_COLS = 80;/,
  "Moria native terminal width is not exactly 80 columns");
assert.match(nativeUiText, /constexpr int TERM_ROWS = 24;/,
  "Moria native terminal height is not exactly 24 rows");
assert.match(nativeUiText, /EM_ASYNC_JS\(int, wasm_wait_key,/,
  "blocking Moria key input is not an Asyncify import");
assert.match(nativeUiText, /EM_ASYNC_JS\(int, wasm_poll_key,/,
  "nonblocking Moria polling is not a distinct Asyncify import");
assert.match(nativeUiText, /vectMoriaGameRunKeyInput\s*\(/,
  "Moria native I/O does not own the game_run-only input wrapper");
assert.match(nativeUiText, /__wrap_exit\s*\(/,
  "Moria native boundary does not define the link-time exit wrapper");
assert.match(nativeUiText, /__real_exit\s*\(/,
  "Moria native exit wrapper does not delegate to the real libc exit");
assert.match(upstreamGameRun,
  /static void commandSaveAndExit\(\)[\s\S]*?character_died_from, "\(saved\)"[\s\S]*?if \(saveGame\(\)\)\s*\{\s*endGame\(\);/,
  "pinned explicit-save path no longer classifies (saved) before a successful save enters endGame");
assert.match(upstreamGameDeath,
  /void endGame\(\)[\s\S]*?recordNewHighScore\(\);[\s\S]*?exitProgram\(\);/,
  "pinned endGame no longer completes score handling before exitProgram");
assert.match(upstreamGame,
  /void exitProgram\(\)\s*\{\s*flushInputBuffer\(\);\s*terminalRestore\(\);\s*exit\(0\);/,
  "pinned exitProgram no longer flushes input and publishes the final terminal frame before exit");
assert.match(nativeUiText,
  /EM_ASYNC_JS\(int, wasm_before_exit, \(int status, int outcome\),/,
  "Moria pre-exit hook does not carry the source-classified lifecycle outcome");
assert.match(nativeUiText,
  /(?:std::)?strcmp\(game\.character_died_from, "\(saved\)"\)\s*==\s*0[\s\S]*?\? 1 : \(game\.character_generated && game\.character_is_dead \? 2 : 0\)[\s\S]*?wasm_before_exit\(status, outcome\)/,
  "Moria exit wrapper does not classify explicit save, terminal exit, and ordinary startup before the awaited hook");
assert.match(nativeUiText, /#include "semantic-wasm\.h"/,
  "Moria native terminal does not include the semantic seam declaration");
assert.match(nativeUiText,
  /void putQIO\(\)\s*\{[\s\S]*?wasm_terminal_flush\([^;]+;\s*moriaSemanticFlush\(\);/,
  "Moria terminal frames are not followed by the semantic flush seam");
assert.match(nativeUiText,
  /void terminalSaveScreen\(\)\s*\{[\s\S]*?moriaSemanticOverlayPush\(\);\s*\}/,
  "Moria full-screen terminal save does not push source-owned overlay state");
assert.match(nativeUiText,
  /void terminalRestoreScreen\(\)\s*\{[\s\S]*?moriaSemanticOverlayPop\(\);\s*\}/,
  "Moria full-screen terminal restore does not pop source-owned overlay state");
assert.match(nativeUiText,
  /bool checkForNonBlockingKeyPress\(int microseconds\)\s*\{\s*if \(moriaCheckpointActive\(\)\) return false;\s*moriaSemanticFlush\(\);[\s\S]*?wasm_poll_key\(/,
  "Moria run/rest polling does not suppress checkpoint polls then flush semantic state before yielding");
assert.match(nativeUiText,
  /void printMessage\(const char \*msg\)\s*\{[\s\S]*?moriaSemanticMessage\(msg\);/,
  "Moria source messages do not reach the semantic message seam");
assert.match(nativeSemanticText,
  /^\/\/ Copyright \(c\) 1981-86 Robert A\. Koeneke\n\/\/ Copyright \(c\) 1987-94 James E\. Wilson\n\/\/\n\/\/ SPDX-License-Identifier: GPL-3\.0-or-later/m,
  "semantic-wasm.cpp does not carry the upstream display-rule provenance");
assert.doesNotMatch(nativeUiText, /\bselect\s*\(/,
  "Moria WASM I/O still calls select() instead of the suspending poll import");
assert.match(nativeUiText, /const char \*default_name = "X";/,
  "Moria WASM default player name is not the source-faithful X fallback");
assert.match(nativeUiText, /return result\.key \+ 1;/,
  "Moria poll encoding does not keep NUL distinct from explicit no-key");
assert.match(nativeUiText,
  /void flushInputBuffer\(\)\s*\{\s*if \(eof_flag != 0 \|\| moriaCheckpointActive\(\)\)[\s\S]*?while \(checkForNonBlockingKeyPress\(0\)\)/,
  "flushInputBuffer does not preserve the EOF/checkpoint gates and drain through the yielding poll path");
assert.match(nativeUiText,
  /const bool outer_command = cursor_y != MSG_LINE;[\s\S]*?readBlockingKey\(outer_command\);[\s\S]*?if \(outer_command\) moriaCheckpointOuterCommandReturned\(\);/,
  "game_run wrapper does not mark only a returned direct outer command input");
assert.match(nativeUiText, /config::options::use_roguelike_keys \? 1 : 0/,
  "native input requests do not carry the live restored-save key mode");
assert.match(nativeUiText, /void requirePosition\(Coord_t coord\)[\s\S]*?std::abort\(\);/,
  "invalid terminal coordinates are not rejected before touching the 80x24 grid");
assert.doesNotMatch(nativeUiText, /\bclamp(?:Row|Column)\s*\(/,
  "invalid terminal coordinates still alias an edge cell through clamping");
assert.match(nativeUiText,
  /await Module\.beforeExit\(status, outcome\);\s*Module\.moriaPreExit = true;/,
  "native pre-exit marker is not set only after the Module hook resolves");
assert.match(nativeCheckpointHeaderText, /MORIA_CHECKPOINT_CANDIDATE\[\] = "recover\/\.pending\.sav"/,
  "native checkpoint candidate path is not the fixed private scratch path");
assert.match(nativeGameSaveText, /#include "\.\.\/\.\.\/\.\.\/\.\.\/external\/umoria\/src\/game_save\.cpp"/,
  "checkpoint adapter does not compile the exact pinned stock serializer in the same TU");
const upstreamExit = readFileSync(`${MORIA}/src/game.cpp`, "utf8").match(
  /void exitProgram\(\)\s*\{([\s\S]*?)\n\}/,
)?.[1];
assert.ok(upstreamExit, "could not find pinned upstream exitProgram ordering");
assert.match(upstreamExit, /flushInputBuffer\(\);\s*terminalRestore\(\);\s*exit\(0\);/,
  "pinned upstream exitProgram no longer drains input, restores the terminal, then exits");
assert.match(nativeMainText,
  /moria_start\s*\(\s*uint32_t\s+seed\s*,\s*bool\s+roguelike_keys\s*\)/,
  "moria_start is not the one parameterized seed/mode entry");
assert.match(nativeMainText, /startMoria\(seed, false, roguelike_keys\);/,
  "moria_start does not pass fixed start_new_game=false with its live seed/mode arguments");
assert.match(makefileText, /-Wl,--wrap=exit/,
  "Moria link flags do not wrap exit for controlled Worker teardown");

const gameRunWithoutComments = readFileSync(`${MORIA}/src/game_run.cpp`, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
const everyGameRunRead = gameRunWithoutComments.match(/\bgetKeyInput\s*\(/g) ?? [];
const directGameRunReads = gameRunWithoutComments
  .match(/\blast_input_command\s*=\s*getKeyInput\s*\(\s*\)\s*;/g) ?? [];
assert.equal(everyGameRunRead.length, 3,
  "pinned game_run.cpp no longer has exactly three getKeyInput occurrences of any shape");
assert.equal(directGameRunReads.length, 3,
  "pinned game_run.cpp no longer has exactly the audited two count reads and one outer command read");
const monsterUpdates = gameRunWithoutComments.match(/\bupdateMonsters\s*\(\s*(?:true|false)\s*\)/g) ?? [];
assert.equal(monsterUpdates.length, 11,
  "pinned game_run.cpp no longer has exactly the audited eleven monster-update seams");
assert.equal(monsterUpdates.filter((call) => call.includes("true")).length, 1,
  "pinned game_run.cpp no longer has one completed-turn attack=true checkpoint tail");
assert.equal(monsterUpdates.filter((call) => call.includes("false")).length, 10,
  "pinned game_run.cpp no longer has the ten incidental/initial attack=false update calls");
assert.equal((gameRunWithoutComments.match(/\bloadGame\s*\(\s*generate\s*\)/g) ?? []).length, 1,
  "pinned game_run.cpp no longer has one startup restore call");
assert.equal((gameRunWithoutComments.match(/\bchangeCharacterName\s*\(\s*\)/g) ?? []).length, 2,
  "pinned game_run.cpp no longer has the restored-character rename and manual character-screen calls");
const storeCommandReads = upstreamStore.match(/\bgetCommand\s*\(\s*""\s*,\s*command\s*\)/g) ?? [];
assert.equal(storeCommandReads.length, 1,
  "pinned store.cpp no longer has exactly one audited blocking store command read");
const storeExitDraws = upstreamStore.match(/\bdrawCavePanel\s*\(\s*\)/g) ?? [];
assert.equal(storeExitDraws.length, 1,
  "pinned store.cpp no longer has exactly one audited store-exit cave redraw");
assert.match(upstreamStore,
  /if \(store\.turns_left_before_closing >= dg\.game_turn\)\s*\{[\s\S]*?return;[\s\S]*?displayStore\([\s\S]*?getCommand\("", command\)[\s\S]*?drawCavePanel\(\);/,
  "pinned storeEnter no longer keeps locked exits before the command/draw lifetime seams");
const gameRunScoreScreens = upstreamGameRun.match(/\bshowScoresScreen\s*\(\s*\)/g) ?? [];
const gameDeathScoreScreens = upstreamGameDeath.match(/\bshowScoresScreen\s*\(\s*\)/g) ?? [];
assert.equal(gameRunScoreScreens.length, 1,
  "pinned game_run.cpp no longer has exactly one linked score-screen transition");
assert.equal(gameDeathScoreScreens.length, 1,
  "pinned game_death.cpp no longer has exactly one linked score-screen transition");
const gameRunHelpScreens = upstreamGameRun.match(/\bdisplayTextHelpFile\s*\(/g) ?? [];
const characterHelpScreens = upstreamCharacter.match(/\bdisplayTextHelpFile\s*\(/g) ?? [];
const gameRunDungeonMaps = upstreamGameRun.match(/\bdungeonDisplayMap\s*\(\s*\)/g) ?? [];
assert.equal(gameRunHelpScreens.length, 6,
  "pinned game_run.cpp no longer has exactly six linked help-file transitions");
assert.equal(characterHelpScreens.length, 3,
  "pinned character.cpp no longer has exactly three linked welcome/help transitions");
assert.equal(gameRunDungeonMaps.length, 1,
  "pinned game_run.cpp no longer has exactly one linked full-map transition");

const scratch = mkdtempSync(join(tmpdir(), "vect-moria-contract-"));
try {
  const unsafeCommandBin = join(scratch, "unsafe-stage-command-bin");
  mkdirSync(unsafeCommandBin);
  for (const command of ["cp", "mkdir", "mktemp", "mv", "rm"]) {
    const path = join(unsafeCommandBin, command);
    writeFileSync(path, `#!/usr/bin/env bash\necho 'unsafe staging reached ${command}' >&2\nexit 97\n`);
    chmodSync(path, 0o755);
  }
  const unsafeStageOptions = {
    cwd: scratch,
    env: { ...process.env, PATH: `${unsafeCommandBin}:${process.env.PATH}` },
  };
  for (const unsafe of ["relative-seed", "-dash-seed"]) {
    const target = join(scratch, unsafe);
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "must survive rejected staging\n");
    const result = run(stageScript, [MORIA, unsafe], unsafeStageOptions);
    assert.notEqual(result.status, 0, `seed stager accepted unsafe relative target ${unsafe}`);
    assert.match(`${result.stdout}${result.stderr}`, /destination must be an absolute path/,
      `seed stager rejected ${unsafe} only after reaching a mutating command`);
    assert.equal(readFileSync(join(target, "keep"), "utf8"), "must survive rejected staging\n",
      `seed stager modified rejected relative target ${unsafe}`);
  }

  const overlapSource = join(scratch, "overlap-source");
  mkdirSync(join(overlapSource, "data"), { recursive: true });
  for (const unsafe of ["/", overlapSource, `${overlapSource}/data`, dirname(overlapSource)]) {
    const result = run(stageScript, [overlapSource, unsafe], unsafeStageOptions);
    assert.notEqual(result.status, 0, `seed stager accepted destructive/overlapping target ${unsafe}`);
    assert.match(`${result.stdout}${result.stderr}`, /refusing unsafe destination|overlaps/,
      `seed stager rejected ${unsafe} only after reaching a mutating command`);
  }

  const overlapFixture = join(scratch, "overlap-fixture");
  const overlapFixtureScript = join(overlapFixture, "scripts/build/stage-moria-seed.sh");
  const overlapFixtureSeed = join(overlapFixture, "build/moria/seed");
  mkdirSync(dirname(overlapFixtureScript), { recursive: true });
  mkdirSync(join(overlapFixtureSeed, "data"), { recursive: true });
  copyFileSync(stageScript, overlapFixtureScript);
  for (const source of [overlapFixture, join(overlapFixtureSeed, "data")]) {
    const result = run(overlapFixtureScript, [source, overlapFixtureSeed], unsafeStageOptions);
    assert.notEqual(result.status, 0, `seed stager accepted overlapping source ${source}`);
    assert.match(`${result.stdout}${result.stderr}`, /overlaps/,
      `seed stager did not identify the source/destination overlap for ${source}`);
  }

  assert.equal(git("-C", EMSDK, "rev-parse", "HEAD"), EMSDK_PIN,
    "external/emsdk is not at the approved toolchain pin");
  const mismatch = join(scratch, "mismatched-source");
  mkdirSync(mismatch);
  checked("git", ["init", "-q"], { cwd: mismatch });
  checked("git", ["config", "user.name", "VectHack Contract"], { cwd: mismatch });
  checked("git", ["config", "user.email", "contract@example.invalid"], { cwd: mismatch });
  writeFileSync(join(mismatch, "README"), "deliberately not the pinned Umoria source\n");
  checked("git", ["add", "README"], { cwd: mismatch });
  checked("git", ["commit", "-q", "-m", "mismatch"], { cwd: mismatch });

  const mismatchResult = run(buildScript, ["--stage-only", "--source-dir", mismatch]);
  assert.notEqual(mismatchResult.status, 0,
    "build script accepted a deliberately mismatched source checkout");
  assert.match(`${mismatchResult.stdout}${mismatchResult.stderr}`, new RegExp(PIN),
    "pin rejection did not identify the exact supported Umoria commit");

  checked(buildScript, ["--stage-only"]);
  const seed = `${ROOT}/build/moria/seed`;
  const allowList = [
    "AUTHORS",
    "LICENSE",
    "data/death_royal.txt",
    "data/death_tomb.txt",
    "data/help.txt",
    "data/help_wizard.txt",
    "data/rl_help.txt",
    "data/rl_help_wizard.txt",
    "data/splash.txt",
    "data/versions.txt",
    "data/welcome.txt",
    "scores.dat",
  ].sort();
  assert.deepEqual(listFiles(seed), allowList,
    "staged Moria seed differs from the literal runtime allow-list");

  for (const path of allowList.filter((path) => !["data/splash.txt", "data/versions.txt"].includes(path))) {
    const upstream = path === "AUTHORS" || path === "LICENSE"
      ? `${MORIA}/${path}`
      : `${MORIA}/data/${basename(path)}`;
    assert.deepEqual(readFileSync(join(seed, path)), readFileSync(upstream),
      `staged ${path} differs from the pinned upstream file`);
  }

  const versionHeader = readFileSync(`${MORIA}/src/version.h`, "utf8");
  const part = (name) => versionHeader.match(new RegExp(`CURRENT_VERSION_${name} = ([0-9]+);`))?.[1];
  const version = `${part("MAJOR")}.${part("MINOR")}.${part("PATCH")}`;
  assert.doesNotMatch(version, /undefined/, "could not derive Umoria version from version.h");
  const changelog = readFileSync(`${MORIA}/CHANGELOG.md`, "utf8");
  const releaseDate = changelog.match(new RegExp(`^## ${version.replaceAll(".", "\\.")} \\(([0-9]{4}-[0-9]{2}-[0-9]{2})\\)$`, "m"))?.[1];
  assert.ok(releaseDate, `could not derive ${version}'s release date from CHANGELOG.md`);
  const generated = (name) => readFileSync(`${MORIA}/data/${name}.in`, "utf8")
    .replaceAll("${umoria_version}", version)
    .replaceAll("${current_date}", releaseDate);
  assert.equal(readFileSync(`${seed}/data/splash.txt`, "utf8"), generated("splash.txt"),
    "generated splash.txt does not match the pinned upstream template/version");
  assert.equal(readFileSync(`${seed}/data/versions.txt`, "utf8"), generated("versions.txt"),
    "generated versions.txt does not match the pinned upstream template/version/changelog date");

  const dryRun = checked("make", [
    "--no-print-directory",
    "-B",
    "-n",
    "-f", makefile,
    `VECT_ROOT=${ROOT}`,
    `MORIA_SOURCE=${MORIA}`,
    `${ROOT}/build/moria/moria.js`,
  ]).stdout;
  const commandLines = dryRun.replace(/\\\n\s*/g, " ").split("\n").filter(Boolean);
  const compileLines = commandLines.filter((line) => /(?:^|\s)-c(?:\s|$)/.test(line));
  const compiledSources = compileLines.map((line) => {
    const match = line.match(/(?:^|\s)-c\s+(\S+)/);
    assert.ok(match, `could not identify source in compile command: ${line}`);
    const output = line.match(/(?:^|\s)-o\s+(\S+)/)?.[1];
    assert.ok(output?.startsWith(`${ROOT}/build/moria/obj/`) && output.endsWith(".o"),
      `Moria object is not out-of-tree under build/moria/obj: ${line}`);
    assert.match(line, /(?:^|\s)-std=c\+\+14(?:\s|$)/,
      `Moria compile command is not C++14: ${line}`);
    return resolve(match[1]);
  }).sort();
  const expectedSources = readdirSync(`${MORIA}/src`)
    .filter((name) => name.endsWith(".cpp") && !["main.cpp", "ui_io.cpp", "game_save.cpp"].includes(name))
    .map((name) => `${MORIA}/src/${name}`)
    .concat([mainNative, uiNative, semanticNative, checkpointNative, gameSaveNative])
    .map((path) => resolve(path))
    .sort();
  assert.deepEqual(compiledSources, expectedSources,
    "actual make compilation commands do not contain exactly every approved upstream and project-owned source");
  assert.ok(!compiledSources.includes(`${MORIA}/src/main.cpp`), "upstream main.cpp is compiled");
  assert.ok(!compiledSources.includes(`${MORIA}/src/ui_io.cpp`), "upstream ui_io.cpp is compiled");
  assert.ok(!compiledSources.includes(`${MORIA}/src/game_save.cpp`),
    "upstream game_save.cpp is compiled separately from the same-TU adapter");
  const gameRunCompile = compileLines.filter((line) =>
    line.includes(`-c ${MORIA}/src/game_run.cpp`));
  assert.equal(gameRunCompile.length, 1, "game_run.cpp does not have exactly one compile command");
  assert.match(gameRunCompile[0], /(?:^|\s)-DgetKeyInput=vectMoriaGameRunKeyInput(?:\s|$)/,
    "game_run.cpp is not compiled through the command-context-only key rename seam");
  assert.match(gameRunCompile[0], /(?:^|\s)-DshowScoresScreen=vectMoriaShowScoresScreen(?:\s|$)/,
    "game_run.cpp is not compiled through the exact score-overlay seam");
  assert.match(gameRunCompile[0], /(?:^|\s)-DdisplayTextHelpFile=vectMoriaDisplayTextHelpFile(?:\s|$)/,
    "game_run.cpp is not compiled through the exact help-overlay seam");
  assert.match(gameRunCompile[0], /(?:^|\s)-DdungeonDisplayMap=vectMoriaDungeonDisplayMap(?:\s|$)/,
    "game_run.cpp is not compiled through the exact full-map overlay seam");
  assert.match(gameRunCompile[0], /(?:^|\s)-DupdateMonsters=vectMoriaGameRunUpdateMonsters(?:\s|$)/,
    "game_run.cpp is not compiled through the completed-turn checkpoint seam");
  assert.match(gameRunCompile[0], /(?:^|\s)-DloadGame=vectMoriaCheckpointLoadGame(?:\s|$)/,
    "game_run.cpp is not compiled through the checkpoint recovery loader seam");
  assert.match(gameRunCompile[0], /(?:^|\s)-DchangeCharacterName=vectMoriaCheckpointChangeCharacterName(?:\s|$)/,
    "game_run.cpp is not compiled through the checkpoint-only rename bypass seam");
  const storeCompile = compileLines.filter((line) => line.includes(`-c ${MORIA}/src/store.cpp`));
  assert.equal(storeCompile.length, 1, "store.cpp does not have exactly one compile command");
  assert.match(storeCompile[0], /(?:^|\s)-DgetCommand=vectMoriaStoreGetCommand(?:\s|$)/,
    "store.cpp is not compiled through the source-owned overlay command seam");
  assert.match(storeCompile[0], /(?:^|\s)-DdrawCavePanel=vectMoriaStoreDrawCavePanel(?:\s|$)/,
    "store.cpp is not compiled through the source-owned overlay exit seam");
  const gameDeathCompile = compileLines.filter((line) =>
    line.includes(`-c ${MORIA}/src/game_death.cpp`));
  assert.equal(gameDeathCompile.length, 1, "game_death.cpp does not have exactly one compile command");
  assert.match(gameDeathCompile[0], /(?:^|\s)-DshowScoresScreen=vectMoriaShowScoresScreen(?:\s|$)/,
    "game_death.cpp is not compiled through the exact score-overlay seam");
  const characterCompile = compileLines.filter((line) =>
    line.includes(`-c ${MORIA}/src/character.cpp`));
  assert.equal(characterCompile.length, 1, "character.cpp does not have exactly one compile command");
  assert.match(characterCompile[0], /(?:^|\s)-DdisplayTextHelpFile=vectMoriaDisplayTextHelpFile(?:\s|$)/,
    "character.cpp is not compiled through the exact help-overlay seam");
  for (const line of compileLines.filter((line) =>
    line !== gameRunCompile[0] && line !== storeCompile[0]
      && line !== gameDeathCompile[0] && line !== characterCompile[0])) {
    assert.doesNotMatch(line, /-DgetKeyInput=/,
      `getKeyInput rename leaked outside game_run.cpp: ${line}`);
    assert.doesNotMatch(line, /-DgetCommand=/,
      `getCommand rename leaked outside store.cpp: ${line}`);
    assert.doesNotMatch(line, /-DdrawCavePanel=/,
      `drawCavePanel rename leaked outside store.cpp: ${line}`);
    assert.doesNotMatch(line, /-DshowScoresScreen=/,
      `showScoresScreen rename leaked outside audited source files: ${line}`);
    assert.doesNotMatch(line, /-DdisplayTextHelpFile=/,
      `displayTextHelpFile rename leaked outside audited source files: ${line}`);
    assert.doesNotMatch(line, /-DdungeonDisplayMap=/,
      `dungeonDisplayMap rename leaked outside game_run.cpp: ${line}`);
    assert.doesNotMatch(line, /-DupdateMonsters=|-DloadGame=|-DchangeCharacterName=/,
      `checkpoint caller rename leaked outside game_run.cpp: ${line}`);
  }

  const linkLine = commandLines.find((line) => line.includes(" -o moria.js ") && !line.includes(" -c "));
  assert.ok(linkLine, "make dry-run did not produce the Moria link command");
  // Emscripten bakes the -o path into the glue as the .data package name, so
  // the link runs from build/moria with relative paths (vect-hack-uur5).
  assert.ok(linkLine.startsWith(`cd ${ROOT}/build/moria && `),
    `Moria link does not run from build/moria: ${linkLine}`);
  for (const line of compileLines) {
    assert.ok(line.includes(`-ffile-prefix-map=${ROOT}=.`),
      `Moria compile does not map the checkout out of __FILE__: ${line}`);
    assert.ok(line.includes(`-ffile-prefix-map=${MORIA}=external/umoria`),
      `Moria compile does not map the source directory out of __FILE__: ${line}`);
  }
  for (const expectedFlag of [
    "-s ENVIRONMENT=worker,node",
    "-s EXPORT_ES6=1",
    "-s MODULARIZE=1",
    "-s ASYNCIFY=1",
    "-s ASYNCIFY_ADVISE=1",
    "-s ALLOW_MEMORY_GROWTH=1",
    "-Wl,--wrap=exit",
    "-lidbfs.js",
    "--no-entry",
    "--preload-file seed@/moria-seed",
    "EXPORTED_FUNCTIONS=[\"_moria_start\",\"_moria_describe\"]",
    "EXPORTED_RUNTIME_METHODS=[\"FS\",\"ccall\",\"UTF8ToString\"]",
  ]) {
    assert.ok(linkLine.includes(expectedFlag), `Moria link command is missing ${expectedFlag}`);
  }

  const fixtureRoot = join(scratch, "fingerprint-fixture");
  mkdirSync(join(fixtureRoot, "scripts/build"), { recursive: true });
  mkdirSync(join(fixtureRoot, "src/modules/moria/native"), { recursive: true });
  mkdirSync(join(fixtureRoot, "external"), { recursive: true });
  copyFileSync(buildScript, join(fixtureRoot, "scripts/build/build-moria-wasm.sh"));
  copyFileSync(makefile, join(fixtureRoot, "scripts/build/moria-wasm.mk"));
  copyFileSync(stageScript, join(fixtureRoot, "scripts/build/stage-moria-seed.sh"));
  copyFileSync(guardScript, join(fixtureRoot, "scripts/build/guard-host-paths.sh"));
  copyFileSync(mainNative, join(fixtureRoot, "src/modules/moria/native/main-wasm.cpp"));
  copyFileSync(uiNative, join(fixtureRoot, "src/modules/moria/native/ui_io_wasm.cpp"));
  copyFileSync(semanticNative, join(fixtureRoot, "src/modules/moria/native/semantic-wasm.cpp"));
  copyFileSync(semanticHeader, join(fixtureRoot, "src/modules/moria/native/semantic-wasm.h"));
  copyFileSync(checkpointNative, join(fixtureRoot, "src/modules/moria/native/checkpoint-wasm.cpp"));
  copyFileSync(checkpointHeader, join(fixtureRoot, "src/modules/moria/native/checkpoint-wasm.h"));
  copyFileSync(gameSaveNative, join(fixtureRoot, "src/modules/moria/native/game-save-wasm.cpp"));
  symlinkSync(MORIA, join(fixtureRoot, "external/umoria"), "dir");
  const fixtureEmsdk = join(fixtureRoot, "external/emsdk");
  symlinkSync(EMSDK, fixtureEmsdk, "dir");
  const fixtureScript = join(fixtureRoot, "scripts/build/build-moria-wasm.sh");

  const fakeEmsdk = join(scratch, "mismatched-emsdk");
  mkdirSync(fakeEmsdk);
  checked("git", ["init", "-q"], { cwd: fakeEmsdk });
  checked("git", ["config", "user.name", "VectHack Contract"], { cwd: fakeEmsdk });
  checked("git", ["config", "user.email", "contract@example.invalid"], { cwd: fakeEmsdk });
  writeFileSync(join(fakeEmsdk, "README"), "deliberately not the pinned emsdk\n");
  checked("git", ["add", "README"], { cwd: fakeEmsdk });
  checked("git", ["commit", "-q", "-m", "mismatch"], { cwd: fakeEmsdk });
  rmSync(fixtureEmsdk);
  symlinkSync(fakeEmsdk, fixtureEmsdk, "dir");
  const mismatchedSdkResult = run(fixtureScript, ["--stage-only"], { cwd: fixtureRoot });
  assert.notEqual(mismatchedSdkResult.status, 0,
    "build script accepted a deliberately mismatched Emscripten SDK");
  assert.match(`${mismatchedSdkResult.stdout}${mismatchedSdkResult.stderr}`, new RegExp(EMSDK_PIN),
    "toolchain rejection did not identify the exact supported emsdk commit");
  rmSync(fixtureEmsdk);
  symlinkSync(EMSDK, fixtureEmsdk, "dir");

  checked(fixtureScript, ["--stage-only"], { cwd: fixtureRoot });
  const stale = join(fixtureRoot, "build/moria/obj/stale.o");
  mkdirSync(join(fixtureRoot, "build/moria/obj"), { recursive: true });
  writeFileSync(stale, "stale native object\n");
  appendFileSync(join(fixtureRoot, "src/modules/moria/native/ui_io_wasm.cpp"), "\n// fingerprint contract mutation\n");
  checked(fixtureScript, ["--stage-only"], { cwd: fixtureRoot });
  assert.ok(!existsSync(stale), "native-boundary change reused a stale Moria object");
  mkdirSync(join(fixtureRoot, "build/moria/obj"), { recursive: true });
  writeFileSync(stale, "stale flag object\n");
  const fixtureMakefile = join(fixtureRoot, "scripts/build/moria-wasm.mk");
  const changedFlags = readFileSync(fixtureMakefile, "utf8").replace("-O2", "-O1");
  assert.notEqual(changedFlags, readFileSync(fixtureMakefile, "utf8"), "fixture did not change a compiler flag");
  writeFileSync(fixtureMakefile, changedFlags);
  checked(fixtureScript, ["--stage-only"], { cwd: fixtureRoot });
  assert.ok(!existsSync(stale), "compiler-flag change reused a stale Moria object");

  const fixtureStageScript = join(fixtureRoot, "scripts/build/stage-moria-seed.sh");
  const seedBeforeGeneratorChange = allowList.map((path) =>
    readFileSync(join(fixtureRoot, "build/moria/seed", path)));
  mkdirSync(join(fixtureRoot, "build/moria/obj"), { recursive: true });
  writeFileSync(stale, "stale generator object\n");
  const staleArtifact = join(fixtureRoot, "build/moria/moria.data");
  writeFileSync(staleArtifact, "stale generator artifact\n");
  appendFileSync(fixtureStageScript, "\n# output-preserving generator mutation\n");
  checked(fixtureScript, ["--stage-only"], { cwd: fixtureRoot });
  assert.ok(!existsSync(stale), "seed-generator change reused a stale Moria object");
  assert.ok(!existsSync(staleArtifact), "seed-generator change reused a stale packaged artifact");
  allowList.forEach((path, index) => {
    assert.deepEqual(readFileSync(join(fixtureRoot, "build/moria/seed", path)),
      seedBeforeGeneratorChange[index], `generator-only fixture unexpectedly changed staged ${path}`);
  });

  // Change only the output of the unchanged generator by interposing its sed
  // tool in the fixture environment. This proves the staged-byte digest is an
  // independent invalidation cause, not an alias for a tracked input hash.
  const shimBin = join(scratch, "seed-byte-shim");
  mkdirSync(shimBin);
  const sedShim = join(shimBin, "sed");
  const realSed = checked("which", ["sed"]).stdout.trim();
  writeFileSync(sedShim, `#!/usr/bin/env bash
set -euo pipefail
"${realSed}" "$@"
for arg in "$@"; do
  case "$arg" in
    */data/splash.txt.in) printf 'seed-byte-environment-change\\n' ;;
  esac
done
`);
  chmodSync(sedShim, 0o755);
  const byteMutationOptions = {
    env: { ...process.env, PATH: `${shimBin}:${process.env.PATH}` },
  };
  const fixedBuildInputs = [
    fixtureScript,
    fixtureMakefile,
    fixtureStageScript,
    join(fixtureRoot, "src/modules/moria/native/main-wasm.cpp"),
    join(fixtureRoot, "src/modules/moria/native/ui_io_wasm.cpp"),
  ];
  const fixedBuildBytes = fixedBuildInputs.map((path) => readFileSync(path));
  mkdirSync(join(fixtureRoot, "build/moria/obj"), { recursive: true });
  writeFileSync(stale, "stale packaged seed object\n");
  writeFileSync(staleArtifact, "stale packaged seed artifact\n");
  checked(fixtureScript, ["--stage-only"], { cwd: fixtureRoot, ...byteMutationOptions });
  fixedBuildInputs.forEach((path, index) => {
    assert.deepEqual(readFileSync(path), fixedBuildBytes[index],
      `${relative(fixtureRoot, path)} changed during the seed-only invalidation fixture`);
  });
  assert.ok(!existsSync(stale), "staged seed byte change reused a stale Moria object");
  assert.ok(!existsSync(staleArtifact), "staged seed byte change reused a stale packaged artifact");
  assert.notDeepEqual(readFileSync(join(fixtureRoot, "build/moria/seed/data/splash.txt")),
    seedBeforeGeneratorChange[allowList.indexOf("data/splash.txt")],
    "seed-only invalidation fixture did not change staged bytes");

  // Mutation-check the regression itself: with only the seed digest disabled,
  // the exact same byte-only staging change must leave the stale outputs behind.
  const seedlessRoot = join(scratch, "seedless-fingerprint-fixture");
  mkdirSync(join(seedlessRoot, "scripts/build"), { recursive: true });
  mkdirSync(join(seedlessRoot, "src/modules/moria/native"), { recursive: true });
  mkdirSync(join(seedlessRoot, "external"), { recursive: true });
  const buildScriptText = readFileSync(buildScript, "utf8");
  const seedlessBuildScript = buildScriptText.replace(
    /# BEGIN seed-content-fingerprint[\s\S]*?# END seed-content-fingerprint/,
    '# BEGIN seed-content-fingerprint\nseed_sha="contract-disabled-seed-digest"\n# END seed-content-fingerprint',
  );
  assert.notEqual(seedlessBuildScript, buildScriptText,
    "could not disable only the seed digest for the invalidation mutation check");
  const seedlessScript = join(seedlessRoot, "scripts/build/build-moria-wasm.sh");
  copyFileSync(buildScript, seedlessScript);
  writeFileSync(seedlessScript, seedlessBuildScript);
  copyFileSync(makefile, join(seedlessRoot, "scripts/build/moria-wasm.mk"));
  copyFileSync(stageScript, join(seedlessRoot, "scripts/build/stage-moria-seed.sh"));
  copyFileSync(guardScript, join(seedlessRoot, "scripts/build/guard-host-paths.sh"));
  copyFileSync(mainNative, join(seedlessRoot, "src/modules/moria/native/main-wasm.cpp"));
  copyFileSync(uiNative, join(seedlessRoot, "src/modules/moria/native/ui_io_wasm.cpp"));
  copyFileSync(semanticNative, join(seedlessRoot, "src/modules/moria/native/semantic-wasm.cpp"));
  copyFileSync(semanticHeader, join(seedlessRoot, "src/modules/moria/native/semantic-wasm.h"));
  copyFileSync(checkpointNative, join(seedlessRoot, "src/modules/moria/native/checkpoint-wasm.cpp"));
  copyFileSync(checkpointHeader, join(seedlessRoot, "src/modules/moria/native/checkpoint-wasm.h"));
  copyFileSync(gameSaveNative, join(seedlessRoot, "src/modules/moria/native/game-save-wasm.cpp"));
  symlinkSync(MORIA, join(seedlessRoot, "external/umoria"), "dir");
  symlinkSync(EMSDK, join(seedlessRoot, "external/emsdk"), "dir");
  checked(seedlessScript, ["--stage-only"], { cwd: seedlessRoot });
  const seedlessStale = join(seedlessRoot, "build/moria/obj/stale.o");
  const seedlessArtifact = join(seedlessRoot, "build/moria/moria.data");
  mkdirSync(join(seedlessRoot, "build/moria/obj"), { recursive: true });
  writeFileSync(seedlessStale, "stale object hidden by disabled seed digest\n");
  writeFileSync(seedlessArtifact, "stale artifact hidden by disabled seed digest\n");
  checked(seedlessScript, ["--stage-only"], { cwd: seedlessRoot, ...byteMutationOptions });
  assert.ok(existsSync(seedlessStale) && existsSync(seedlessArtifact),
    "seed-only invalidation regression would still pass with the seed digest removed");

  const failedCanaryBin = join(scratch, "failed-canary-bin");
  mkdirSync(failedCanaryBin);
  const fakeMake = join(failedCanaryBin, "make");
  writeFileSync(fakeMake, `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${fixtureRoot}/build/moria"
printf 'js without diagnostics\\n' > "${fixtureRoot}/build/moria/moria.js"
printf 'wasm without diagnostics\\n' > "${fixtureRoot}/build/moria/moria.wasm"
printf 'data without diagnostics\\n' > "${fixtureRoot}/build/moria/moria.data"
printf 'link completed without Asyncify diagnostics\\n'
`);
  chmodSync(fakeMake, 0o755);
  const failedCanary = run(fixtureScript, [], {
    cwd: fixtureRoot,
    env: { ...process.env, PATH: `${failedCanaryBin}:${process.env.PATH}` },
  });
  assert.notEqual(failedCanary.status, 0, "build accepted a link without current Asyncify diagnostics");
  for (const extension of ["js", "wasm", "data"]) {
    assert.ok(!existsSync(join(fixtureRoot, `build/moria/moria.${extension}`)),
      `failed Asyncify canary left moria.${extension} reusable`);
  }
  assert.ok(!existsSync(join(fixtureRoot, "build/moria/.successful-build-sha")),
    "failed Asyncify canary published a successful full-build stamp");
  assert.ok(!existsSync(join(fixtureRoot, "build/moria/.artifact-sha256")),
    "failed Asyncify canary blessed its rejected artifacts in the hash manifest");

  const partialCanaryBin = join(scratch, "partial-canary-bin");
  mkdirSync(partialCanaryBin);
  writeFileSync(join(partialCanaryBin, "make"), `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${fixtureRoot}/build/moria"
for extension in js wasm data; do
  printf 'partial canary %s\\n' "$extension" > "${fixtureRoot}/build/moria/moria.$extension"
done
printf '%s\\n' '[asyncify] wasm_wait_key is an import that can change the state'
printf '%s\\n' '[asyncify] (anonymous namespace)::readBlockingKey(bool) can change the state due to wasm_wait_key'
`);
  chmodSync(join(partialCanaryBin, "make"), 0o755);
  const partialCanary = run(fixtureScript, [], {
    cwd: fixtureRoot,
    env: { ...process.env, PATH: `${partialCanaryBin}:${process.env.PATH}` },
  });
  assert.notEqual(partialCanary.status, 0,
    "build accepted fresh diagnostics that omit poll, flush, game-run wrapper, and pre-exit paths");
  for (const extension of ["js", "wasm", "data"]) {
    assert.ok(!existsSync(join(fixtureRoot, `build/moria/moria.${extension}`)),
      `partial Asyncify canary left moria.${extension} reusable`);
  }
  checked(fixtureScript, [], { cwd: fixtureRoot });
  assert.ok(existsSync(join(fixtureRoot, "build/moria/.successful-build-sha")),
    "normal retry after a failed Asyncify canary did not publish a success stamp");

  const cachedCanaryLog = join(fixtureRoot, "build/moria/asyncify.log");
  const completeCachedCanary = readFileSync(cachedCanaryLog, "utf8");
  writeFileSync(cachedCanaryLog, completeCachedCanary
    .split("\n")
    .filter((line) => !line.includes("flushInputBuffer() can change the state due to wasm_poll_key"))
    .join("\n"));
  const cachedCanaryBin = join(scratch, "cached-canary-bin");
  mkdirSync(cachedCanaryBin);
  writeFileSync(join(cachedCanaryBin, "make"), "#!/usr/bin/env bash\nset -euo pipefail\n");
  chmodSync(join(cachedCanaryBin, "make"), 0o755);
  const incompleteCachedCanary = run(fixtureScript, [], {
    cwd: fixtureRoot,
    env: { ...process.env, PATH: `${cachedCanaryBin}:${process.env.PATH}` },
  });
  assert.notEqual(incompleteCachedCanary.status, 0,
    "cached build accepted an Asyncify log missing the flush-to-poll canary");
  for (const extension of ["js", "wasm", "data"]) {
    assert.ok(!existsSync(join(fixtureRoot, `build/moria/moria.${extension}`)),
      `incomplete cached canary left moria.${extension} reusable`);
  }
  checked(fixtureScript, [], { cwd: fixtureRoot });

  const guardedSource = join(scratch, "publication-source");
  checked("git", ["clone", "-q", "--no-hardlinks", MORIA, guardedSource]);
  rmSync(join(fixtureRoot, "external/umoria"));
  symlinkSync(guardedSource, join(fixtureRoot, "external/umoria"), "dir");
  const fixturePublic = join(fixtureRoot, "public/modules/moria");
  mkdirSync(fixturePublic, { recursive: true });
  for (const extension of ["js", "wasm", "data"]) {
    writeFileSync(join(fixturePublic, `moria.${extension}`), `previous public ${extension}\n`);
  }
  const dirtyMakeBin = join(scratch, "dirty-source-make-bin");
  mkdirSync(dirtyMakeBin);
  writeFileSync(join(dirtyMakeBin, "make"), `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${fixtureRoot}/build/moria"
for extension in js wasm data; do
  printf 'candidate %s\\n' "$extension" > "${fixtureRoot}/build/moria/moria.$extension"
done
printf '%s\\n' '${STUB_EXPORTS}' >> "${fixtureRoot}/build/moria/moria.js"
printf '%s\\n' '[asyncify] wasm_wait_key is an import that can change the state'
printf '%s\\n' '[asyncify] (anonymous namespace)::readBlockingKey(bool) can change the state due to wasm_wait_key'
printf '%s\\n' '[asyncify] wasm_poll_key is an import that can change the state'
printf '%s\\n' '[asyncify] flushInputBuffer() can change the state due to wasm_poll_key'
printf '%s\\n' '[asyncify] vectMoriaGameRunKeyInput() can change the state due to (anonymous namespace)::readBlockingKey(bool)'
printf '%s\\n' '[asyncify] wasm_before_exit is an import that can change the state'
printf '%s\\n' '[asyncify] exitProgram() can change the state due to wasm_before_exit'
printf '%s\\n' '[asyncify] wasm_checkpoint_landed is an import that can change the state'
printf '%s\\n' '[asyncify] vectMoriaGameRunUpdateMonsters(bool) can change the state due to wasm_checkpoint_landed'
printf 'dirtied during link\\n' >> "${guardedSource}/CHANGELOG.md"
`);
  chmodSync(join(dirtyMakeBin, "make"), 0o755);
  const dirtyBuild = run(fixtureScript, [], {
    cwd: fixtureRoot,
    env: { ...process.env, PATH: `${dirtyMakeBin}:${process.env.PATH}` },
  });
  assert.notEqual(dirtyBuild.status, 0, "build accepted a source checkout dirtied during linking");
  for (const extension of ["js", "wasm", "data"]) {
    assert.equal(readFileSync(join(fixturePublic, `moria.${extension}`), "utf8"),
      `previous public ${extension}\n`, `source guard ran after publishing moria.${extension}`);
  }

  const atomicRoot = join(scratch, "atomic-publication-fixture");
  mkdirSync(join(atomicRoot, "scripts/build"), { recursive: true });
  mkdirSync(join(atomicRoot, "src/modules/moria/native"), { recursive: true });
  mkdirSync(join(atomicRoot, "external"), { recursive: true });
  copyFileSync(buildScript, join(atomicRoot, "scripts/build/build-moria-wasm.sh"));
  copyFileSync(makefile, join(atomicRoot, "scripts/build/moria-wasm.mk"));
  copyFileSync(stageScript, join(atomicRoot, "scripts/build/stage-moria-seed.sh"));
  copyFileSync(guardScript, join(atomicRoot, "scripts/build/guard-host-paths.sh"));
  copyFileSync(mainNative, join(atomicRoot, "src/modules/moria/native/main-wasm.cpp"));
  copyFileSync(uiNative, join(atomicRoot, "src/modules/moria/native/ui_io_wasm.cpp"));
  copyFileSync(semanticNative, join(atomicRoot, "src/modules/moria/native/semantic-wasm.cpp"));
  copyFileSync(semanticHeader, join(atomicRoot, "src/modules/moria/native/semantic-wasm.h"));
  copyFileSync(checkpointNative, join(atomicRoot, "src/modules/moria/native/checkpoint-wasm.cpp"));
  copyFileSync(checkpointHeader, join(atomicRoot, "src/modules/moria/native/checkpoint-wasm.h"));
  copyFileSync(gameSaveNative, join(atomicRoot, "src/modules/moria/native/game-save-wasm.cpp"));
  symlinkSync(MORIA, join(atomicRoot, "external/umoria"), "dir");
  symlinkSync(EMSDK, join(atomicRoot, "external/emsdk"), "dir");
  const atomicPublic = join(atomicRoot, "public/modules/moria");
  mkdirSync(atomicPublic, { recursive: true });
  for (const extension of ["js", "wasm", "data"]) {
    writeFileSync(join(atomicPublic, `moria.${extension}`), `atomic previous ${extension}\n`);
  }
  const atomicBin = join(scratch, "atomic-publication-bin");
  mkdirSync(atomicBin);
  writeFileSync(join(atomicBin, "make"), `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${atomicRoot}/build/moria"
for extension in js wasm data; do
  printf 'atomic candidate %s\\n' "$extension" > "${atomicRoot}/build/moria/moria.$extension"
done
printf '%s\\n' '${STUB_EXPORTS}' >> "${atomicRoot}/build/moria/moria.js"
printf '%s\\n' '[asyncify] wasm_wait_key is an import that can change the state'
printf '%s\\n' '[asyncify] (anonymous namespace)::readBlockingKey(bool) can change the state due to wasm_wait_key'
printf '%s\\n' '[asyncify] wasm_poll_key is an import that can change the state'
printf '%s\\n' '[asyncify] flushInputBuffer() can change the state due to wasm_poll_key'
printf '%s\\n' '[asyncify] vectMoriaGameRunKeyInput() can change the state due to (anonymous namespace)::readBlockingKey(bool)'
printf '%s\\n' '[asyncify] wasm_before_exit is an import that can change the state'
printf '%s\\n' '[asyncify] exitProgram() can change the state due to wasm_before_exit'
printf '%s\\n' '[asyncify] wasm_checkpoint_landed is an import that can change the state'
printf '%s\\n' '[asyncify] vectMoriaGameRunUpdateMonsters(bool) can change the state due to wasm_checkpoint_landed'
`);
  chmodSync(join(atomicBin, "make"), 0o755);
  const realCp = checked("which", ["cp"]).stdout.trim();
  writeFileSync(join(atomicBin, "cp"), `#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    */moria.js)
      destination="\${!#}"
      "${realCp}" -- "$arg" "$destination"
      exit 71
      ;;
  esac
done
exec "${realCp}" "$@"
`);
  chmodSync(join(atomicBin, "cp"), 0o755);
  const atomicBuild = run(join(atomicRoot, "scripts/build/build-moria-wasm.sh"), [], {
    cwd: atomicRoot,
    env: { ...process.env, PATH: `${atomicBin}:${process.env.PATH}` },
  });
  assert.notEqual(atomicBuild.status, 0, "build ignored a partial publication copy failure");
  for (const extension of ["js", "wasm", "data"]) {
    assert.equal(readFileSync(join(atomicPublic, `moria.${extension}`), "utf8"),
      `atomic previous ${extension}\n`, `partial publication replaced public moria.${extension}`);
  }
  assert.deepEqual(readdirSync(atomicPublic).filter((name) => name.startsWith(".moria.publish.")), [],
    "failed atomic publication left a temporary directory behind");
  assert.deepEqual(readdirSync(join(atomicRoot, "public/modules/moria-versions"))
    .filter((name) => name.startsWith(".moria.publish.")), [],
    "failed publication left a version candidate behind");

  rmSync(join(atomicBin, "cp"));
  const realMv = checked("which", ["mv"]).stdout.trim();
  writeFileSync(join(atomicBin, "mv"), `#!/usr/bin/env bash
set -euo pipefail
destination="\${!#}"
case "$destination" in
  "${dirname(atomicPublic)}"/.moria.previous.*)
    "${realMv}" "$@"
    exit 73
    ;;
esac
exec "${realMv}" "$@"
`);
  chmodSync(join(atomicBin, "mv"), 0o755);
  const failedAfterLegacyMove = run(join(atomicRoot, "scripts/build/build-moria-wasm.sh"), [], {
    cwd: atomicRoot,
    env: { ...process.env, PATH: `${atomicBin}:${process.env.PATH}` },
  });
  assert.notEqual(failedAfterLegacyMove.status, 0,
    "build ignored failure immediately after moving the legacy public directory");
  assert.ok(lstatSync(atomicPublic).isDirectory(),
    "EXIT cleanup did not restore the legacy public directory after the move failed");
  for (const extension of ["js", "wasm", "data"]) {
    assert.equal(readFileSync(join(atomicPublic, `moria.${extension}`), "utf8"),
      `atomic previous ${extension}\n`, `post-move failure lost prior public moria.${extension}`);
  }
  rmSync(join(atomicBin, "mv"));

  const mvCount = join(scratch, "publication-mv-count");
  writeFileSync(join(atomicBin, "mv"), `#!/usr/bin/env bash
set -euo pipefail
destination="\${!#}"
case "$destination" in
  "${atomicPublic}"|"${atomicPublic}"/moria.*|"${dirname(atomicPublic)}"/.moria.previous.*)
    count=0
    if [ -f "${mvCount}" ]; then count="$(cat "${mvCount}")"; fi
    count=$((count + 1))
    printf '%s' "$count" > "${mvCount}"
    if [ "$count" -eq 2 ]; then exit 72; fi
    ;;
esac
exec "${realMv}" "$@"
`);
  chmodSync(join(atomicBin, "mv"), 0o755);
  const interruptedCommit = run(join(atomicRoot, "scripts/build/build-moria-wasm.sh"), [], {
    cwd: atomicRoot,
    env: { ...process.env, PATH: `${atomicBin}:${process.env.PATH}` },
  });
  assert.notEqual(interruptedCommit.status, 0, "build ignored an interrupted publication commit");
  for (const extension of ["js", "wasm", "data"]) {
    assert.equal(readFileSync(join(atomicPublic, `moria.${extension}`), "utf8"),
      `atomic previous ${extension}\n`, `interrupted commit partially replaced public moria.${extension}`);
  }
  rmSync(join(atomicBin, "mv"));
  const atomicVersions = join(atomicRoot, "public/modules/moria-versions");
  const staleVersion = join(atomicVersions, `moria-${"b".repeat(64)}`);
  mkdirSync(staleVersion);
  for (const extension of ["js", "wasm", "data"]) {
    writeFileSync(join(staleVersion, `moria.${extension}`), `stale ${extension}\n`);
  }
  const unrelatedVersion = join(atomicVersions, "moria-not-a-version");
  mkdirSync(unrelatedVersion);
  writeFileSync(join(unrelatedVersion, "keep"), "unrelated version sibling\n");
  const unrelatedPublic = join(atomicRoot, "public/modules/keep-unrelated");
  writeFileSync(unrelatedPublic, "unrelated public sibling\n");
  checked(join(atomicRoot, "scripts/build/build-moria-wasm.sh"), [], {
    cwd: atomicRoot,
    env: { ...process.env, PATH: `${atomicBin}:${process.env.PATH}` },
  });
  assert.ok(lstatSync(atomicPublic).isSymbolicLink(),
    "normal retry did not migrate public/modules/moria to the atomic pointer");
  assert.equal(statSync(atomicPublic).mode & 0o777, 0o755,
    "resolved public Moria artifact directory is not explicitly traversable (0755)");
  const activeVersion = resolve(dirname(atomicPublic), readlinkSync(atomicPublic));
  assert.ok(existsSync(activeVersion), "active Moria version directory was pruned");
  assert.ok(!existsSync(staleVersion), "unreferenced validated Moria version directory was not pruned");
  assert.equal(readFileSync(join(unrelatedVersion, "keep"), "utf8"), "unrelated version sibling\n",
    "version pruning touched a non-version sibling");
  assert.equal(readFileSync(unrelatedPublic, "utf8"), "unrelated public sibling\n",
    "version pruning touched a path outside the version root");
  assert.deepEqual(readdirSync(dirname(atomicPublic)).filter((name) => name.startsWith(".moria.previous.")), [],
    "publication recovery left a physical-directory backup behind");
  for (const extension of ["js", "wasm", "data"]) {
    assert.equal(readFileSync(join(atomicPublic, `moria.${extension}`), "utf8"),
      stubArtifact("atomic candidate", extension),
      `normal retry did not publish complete moria.${extension}`);
  }

  const build = checked(buildScript, []);
  const buildOutput = `${build.stdout}${build.stderr}`;
  assert.match(buildOutput,
    /OK\(asyncify\): input, poll, checkpoint durability and pre-exit paths are instrumented/,
    "build did not enforce every Asyncify suspend-path canary");
  const buildLog = readFileSync(`${ROOT}/build/moria/build.log`, "utf8");
  const asyncifyLog = readFileSync(`${ROOT}/build/moria/asyncify.log`, "utf8");
  assert.match(asyncifyLog, /^\[asyncify\] wasm_wait_key is an import that can change the state$/m,
    "Emscripten diagnostics do not identify the module-supplied key import");
  assert.match(asyncifyLog,
    /^\[asyncify\] \(anonymous namespace\)::readBlockingKey\(bool\) can change the state due to wasm_wait_key$/m,
    "Emscripten diagnostics do not prove the blocking reader reaches the key import");
  assert.match(asyncifyLog,
    /^\[asyncify\] wasm_checkpoint_landed is an import that can change the state$/m,
    "Emscripten diagnostics do not identify the awaited checkpoint durability import");
  assert.match(asyncifyLog,
    /^\[asyncify\] vectMoriaGameRunUpdateMonsters\(bool\) can change the state due to wasm_checkpoint_landed$/m,
    "Emscripten diagnostics do not prove the completed-turn wrapper reaches checkpoint durability");

  for (const extension of ["wasm", "data"]) {
    rmSync(`${ROOT}/build/moria/moria.${extension}`);
    checked(buildScript, []);
    for (const sibling of ["js", "wasm", "data"]) {
      assert.ok(statSync(`${ROOT}/build/moria/moria.${sibling}`).size > 0,
        `one build did not restore the moria artifact set after deleting ${extension}`);
      assert.deepEqual(readFileSync(`${ROOT}/public/modules/moria/moria.${sibling}`),
        readFileSync(`${ROOT}/build/moria/moria.${sibling}`),
        `restored ${sibling} was not atomically published after deleting ${extension}`);
    }
  }

  const artifactManifest = `${ROOT}/build/moria/.artifact-sha256`;
  assert.ok(existsSync(artifactManifest),
    "successful Moria build did not persist a three-artifact hash manifest");
  const validManifest = readFileSync(artifactManifest);
  const successFingerprint = readFileSync(`${ROOT}/build/moria/.successful-build-sha`, "utf8");
  const validArtifacts = Object.fromEntries(["js", "wasm", "data"].map((extension) => [
    extension,
    readFileSync(`${ROOT}/build/moria/moria.${extension}`),
  ]));
  assert.deepEqual(validManifest.toString("utf8").trimEnd().split("\n"), [
    `fingerprint ${successFingerprint}`,
    ...["js", "wasm", "data"].map((extension) =>
      `${createHash("sha256").update(validArtifacts[extension]).digest("hex")}  moria.${extension}`),
  ], "artifact manifest does not bind the successful fingerprint to exact JS/WASM/data hashes");
  for (const corrupted of ["js", "wasm", "data"]) {
    writeFileSync(`${ROOT}/build/moria/moria.${corrupted}`,
      `nonempty stale Moria ${corrupted}\n`);
    checked(buildScript, []);
    assert.deepEqual(readFileSync(artifactManifest), validManifest,
      `one build did not restore the successful artifact hash manifest after corrupting ${corrupted}`);
    for (const sibling of ["js", "wasm", "data"]) {
      assert.deepEqual(readFileSync(`${ROOT}/build/moria/moria.${sibling}`), validArtifacts[sibling],
        `one build did not restore exact valid ${sibling} bytes after corrupting ${corrupted}`);
      assert.deepEqual(readFileSync(`${ROOT}/public/modules/moria/moria.${sibling}`), validArtifacts[sibling],
        `recovered ${sibling} was not atomically published after corrupting ${corrupted}`);
    }
  }
  const actualCompileSources = buildLog.split("\n")
    .filter((line) => line.startsWith("em++ ") && /(?:^|\s)-c(?:\s|$)/.test(line))
    .map((line) => resolve(line.match(/(?:^|\s)-c\s+(\S+)/)?.[1] ?? ""))
    .sort();
  assert.deepEqual(actualCompileSources, expectedSources,
    "the successful Emscripten build did not actually compile the exact approved source set");

  const objectRoot = `${ROOT}/build/moria/obj`;
  const oneObject = listFiles(objectRoot).find((path) => path.endsWith(".o"));
  assert.ok(oneObject, "Moria build produced no object for the partial-rebuild regression");
  rmSync(join(objectRoot, oneObject));
  checked(buildScript, []);
  checked(buildScript, []);
  const compileManifestAfterPartial = readFileSync(`${ROOT}/build/moria/build.log`, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("em++ ") && /(?:^|\s)-c(?:\s|$)/.test(line))
    .map((line) => resolve(line.match(/(?:^|\s)-c\s+(\S+)/)?.[1] ?? ""))
    .sort();
  assert.deepEqual(compileManifestAfterPartial, expectedSources,
    "one-object rebuild poisoned the canonical full-clean compile manifest");

  const publicRoot = `${ROOT}/public/modules/moria`;
  assert.ok(lstatSync(publicRoot).isSymbolicLink(),
    "public/modules/moria is not the atomic pointer to a complete artifact directory");
  assert.equal(statSync(publicRoot).mode & 0o777, 0o755,
    "resolved public Moria artifact directory is not explicitly traversable (0755)");
  for (const extension of ["js", "wasm", "data"]) {
    const artifact = `${ROOT}/public/modules/moria/moria.${extension}`;
    assert.ok(existsSync(artifact) && statSync(artifact).size > 0,
      `Moria artifact is missing or empty: ${relative(ROOT, artifact)}`);
    assert.ok(lstatSync(artifact).isFile(), `Moria artifact is not a regular file: ${artifact}`);
  }

  const smokeTimeoutMs = 15_000;
  const runBoundedNode = (args, timeout = smokeTimeoutMs) => run(process.execPath, args, {
    timeout,
    killSignal: "SIGKILL",
  });
  const childDiagnostics = (result) => [
    `status=${result.status}`,
    `signal=${result.signal}`,
    `error=${result.error?.stack ?? result.error ?? "none"}`,
    `stdout=${JSON.stringify(result.stdout)}`,
    `stderr=${JSON.stringify(result.stderr)}`,
  ].join("\n");

  // Mutation-proof the exact helper used below: a live event loop must be
  // killed by its configured timeout instead of leaving the contract hung.
  const timeoutProbe = runBoundedNode(["--eval", "setInterval(() => {}, 1000)"], 50);
  assert.equal(timeoutProbe.error?.code, "ETIMEDOUT",
    `bounded Node child did not enforce its timeout:\n${childDiagnostics(timeoutProbe)}`);

  const smoke = runBoundedNode(["scripts/test/test-moria-boot.mjs"]);
  assert.equal(smoke.error, undefined,
    `dedicated Moria smoke could not start or timed out:\n${childDiagnostics(smoke)}`);
  assert.equal(smoke.status, 0,
    `dedicated Moria smoke failed:\n${childDiagnostics(smoke)}`);
  assert.equal(smoke.stdout,
    "OK(moria-boot): canonical Umoria 5.7.15 splash reached exactly one blocking key request in an 80x24 frame\n",
    `dedicated Moria smoke did not report its exact first-key proof:\n${childDiagnostics(smoke)}`);
  assert.equal(smoke.stderr, "",
    `dedicated Moria smoke wrote stderr:\n${childDiagnostics(smoke)}`);
  process.stdout.write(smoke.stdout);

  const exitCodeProbe = runBoundedNode(["scripts/test/test-moria-boot-exit-code.mjs"]);
  assert.equal(exitCodeProbe.error, undefined,
    `Moria smoke exitCode proof could not start or timed out:\n${childDiagnostics(exitCodeProbe)}`);
  assert.equal(exitCodeProbe.status, 0,
    `Moria smoke exitCode proof failed:\n${childDiagnostics(exitCodeProbe)}`);
  assert.match(exitCodeProbe.stdout,
    /^OK\(moria-boot\):.*\nOK\(moria-boot-exit-code\): imported smoke preserved the caller's process\.exitCode\n$/,
    `Moria smoke exitCode proof did not report success:\n${childDiagnostics(exitCodeProbe)}`);
  assert.equal(exitCodeProbe.stderr, "",
    `Moria smoke exitCode proof wrote stderr:\n${childDiagnostics(exitCodeProbe)}`);

  const nativeIo = runBoundedNode(["scripts/test/test-moria-native-io.mjs"]);
  assert.equal(nativeIo.error, undefined,
    `Moria native I/O proof could not start or timed out:\n${childDiagnostics(nativeIo)}`);
  assert.equal(nativeIo.status, 0,
    `Moria native I/O proof failed:\n${childDiagnostics(nativeIo)}`);
  assert.equal(nativeIo.stdout,
    "OK(moria-native-io): both modes, terminal parity, explicit poll results, input failures, and controlled exit are live\n",
    `Moria native I/O proof did not report its exact live-engine result:\n${childDiagnostics(nativeIo)}`);
  assert.equal(nativeIo.stderr, "",
    `Moria native I/O proof wrote stderr:\n${childDiagnostics(nativeIo)}`);
  process.stdout.write(nativeIo.stdout);

  for (const diagnostic of [
    "[asyncify] wasm_poll_key is an import that can change the state",
    "[asyncify] wasm_before_exit is an import that can change the state",
    "[asyncify] flushInputBuffer() can change the state due to wasm_poll_key",
    "[asyncify] vectMoriaGameRunKeyInput() can change the state due to (anonymous namespace)::readBlockingKey(bool)",
  ]) {
    assert.ok(asyncifyLog.includes(diagnostic),
      `successful build lacks current Asyncify diagnostic: ${diagnostic}`);
  }

  const createMoriaModule = (await import(
    `${pathToFileURL(`${publicRoot}/moria.js`).href}?contract=${Date.now()}`
  )).default;
  const module = await createMoriaModule({
    locateFile: (path) => `${publicRoot}/${path}`,
  });
  const packagedFiles = [];
  const visitPackage = (directory, prefix = "") => {
    for (const entry of module.FS.readdir(directory).filter((name) => name !== "." && name !== "..")) {
      const path = `${directory}/${entry}`;
      const relativePath = prefix ? `${prefix}/${entry}` : entry;
      if (module.FS.isDir(module.FS.stat(path).mode)) visitPackage(path, relativePath);
      else packagedFiles.push(relativePath);
    }
  };
  visitPackage("/moria-seed");
  assert.deepEqual(packagedFiles.sort(), allowList,
    "packaged /moria-seed differs from the literal staged runtime allow-list");
  for (const path of allowList) {
    assert.deepEqual(Buffer.from(module.FS.readFile(`/moria-seed/${path}`)), readFileSync(`${seed}/${path}`),
      `packaged /moria-seed/${path} differs from the staged bytes`);
  }

  assert.equal(git("-C", MORIA, "rev-parse", "HEAD"), PIN, "Moria build changed the source HEAD");
  assert.equal(git("-C", MORIA, "status", "--short"), "", "Moria build modified the source checkout");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("OK(build): exact sources, seed files, flags, dedicated live key smoke, invalidation, and artifacts are behaviorally verified");

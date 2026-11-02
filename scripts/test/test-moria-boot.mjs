// Smoke test: boot the real Umoria 5.7.15 WASM module in Node, capture the
// canonical splash at the native core's first blocking input request, and
// terminate through an exact sentinel rejection. Full TTY play starts in the
// next epic stage; this gate deliberately sends no synthetic key or EOF.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const COLS = 80;
const ROWS = 24;
const FRAME_BYTES = COLS * ROWS;
const TIMEOUT_MS = 5_000;
const publicModuleUrl = new URL("../../public/modules/moria/", import.meta.url);
const CANONICAL_SPLASH = `
                    Robert A. Koeneke's classic roguelike

                            D U N G E O N S   O F

             ##     ##    #######    ########    ####      ###
             ###   ###   ##     ##   ##     ##    ##      ## ##
             #### ####   ##     ##   ##     ##    ##     ##   ##
             ## ### ##   ##     ##   ########     ##    ##     ##
             ##     ##   ##     ##   ##   ##      ##    #########
             ##     ##   ##     ##   ##    ##     ##    ##     ##
             ##     ##    #######    ##     ##   ####   ##     ##

                                Umoria 5.7.15


                Umoria is free software released under GPL-3.0
                    and comes with ABSOLUTELY NO WARRANTY

      For more information: https://github.com/dungeons-of-moria/umoria
`;

assert.equal(typeof globalThis.document, "undefined", "Moria smoke unexpectedly requires a DOM document");
assert.equal(typeof globalThis.window, "undefined", "Moria smoke unexpectedly requires a browser window");

for (const extension of ["js", "wasm", "data"]) {
  const artifactUrl = new URL(`moria.${extension}`, publicModuleUrl);
  assert.ok(existsSync(artifactUrl) && statSync(artifactUrl).isFile() && statSync(artifactUrl).size > 0,
    `public/modules/moria/moria.${extension} is missing or empty — run npm run build:moria`);
}

const createMoriaModule = (await import(
  `${new URL("moria.js", publicModuleUrl).href}?smoke=${Date.now()}`
)).default;
const terminalFrames = [];
const firstKeySentinel = new Error(`MORIA_BOOT_FIRST_KEY_SENTINEL_${randomUUID()}`);
let firstKeyFrame;
let keyRequests = 0;

const module = await createMoriaModule({
  // Both the preload package and the wasm binary must resolve from the fixed
  // public path, independent of npm's current working directory.
  locateFile: (path) => fileURLToPath(new URL(path, publicModuleUrl)),
  terminalFlush: (cells) => {
    const copy = Uint8Array.from(cells);
    assert.equal(copy.byteLength, FRAME_BYTES,
      "terminalFlush did not provide an exact 80x24 / 1,920-byte frame");
    terminalFrames.push(copy);
  },
  getKeyInput: async () => {
    keyRequests += 1;
    firstKeyFrame = terminalFrames.at(-1);
    throw firstKeySentinel;
  },
});

const splashText = Buffer.from(module.FS.readFile("/moria-seed/data/splash.txt")).toString("utf8");
assert.equal(splashText, CANONICAL_SPLASH,
  "packaged splash bytes are not the canonical Umoria 5.7.15 splash");
const splashRows = CANONICAL_SPLASH.slice(0, -1).split("\n");
assert.ok(splashRows.length <= ROWS, `canonical splash has ${splashRows.length} rows, exceeds ${ROWS}`);
const expectedFrame = Buffer.alloc(FRAME_BYTES, 0x20);
for (const [row, text] of splashRows.entries()) {
  const encoded = Buffer.from(text, "utf8");
  assert.ok(encoded.length <= COLS, `canonical splash row ${row} exceeds ${COLS} bytes`);
  encoded.copy(expectedFrame, row * COLS);
}
const firstKeyPrompt = Buffer.from("[ press any key to continue ]", "ascii");
firstKeyPrompt.copy(expectedFrame, 23 * COLS + 23);

const callerExitCode = process.exitCode;
let timeoutId;
const startResult = await Promise.race([
  Promise.resolve()
    .then(() => module.ccall("moria_start", "number", [], [], { async: true }))
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
  `moria_start did not reach its first blocking key request within ${TIMEOUT_MS}ms`);
assert.equal(startResult.kind, "rejected",
  `moria_start synthesized EOF or completed before its first key request: ${startResult.value}`);
assert.equal(startResult.error, firstKeySentinel,
  `moria_start did not preserve the exact input rejection: ${startResult.error?.stack ?? startResult.error}`);
// Emscripten's Node quit hook changes exitCode while routing a rewound throw
// into Asyncify's rejection. Restore the caller's value only after proving
// this is our exact sentinel; every other rejection remains a failure.
process.exitCode = callerExitCode;

assert.equal(keyRequests, 1, "moria_start did not make exactly one blocking Module.getKeyInput request");
assert.ok(firstKeyFrame, "moria_start requested input before flushing a terminal frame");
assert.deepEqual(Buffer.from(firstKeyFrame), expectedFrame,
  "the first-key 80x24 frame is not the exact canonical Umoria 5.7.15 splash");

console.log("OK(moria-boot): canonical Umoria 5.7.15 splash reached exactly one blocking key request in an 80x24 frame");

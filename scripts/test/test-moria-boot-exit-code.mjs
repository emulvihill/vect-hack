// Focused import contract: the smoke may temporarily receive Emscripten's
// sentinel exitCode, but it must return the caller's pre-existing value.
import assert from "node:assert/strict";

const CALLER_EXIT_CODE = 71;
process.exitCode = CALLER_EXIT_CODE;

await import(`./test-moria-boot.mjs?exit-code-contract=${Date.now()}`);

assert.equal(process.exitCode, CALLER_EXIT_CODE,
  "importing the Moria boot smoke clobbered the caller's process.exitCode");
process.exitCode = undefined;

console.log("OK(moria-boot-exit-code): imported smoke preserved the caller's process.exitCode");

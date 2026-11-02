// Stage 2's bounded real-engine play gate. Keep the canonical first-key boot
// smoke small; the native I/O harness owns the deeper terminal, command-mode,
// poll, and controlled-exit trace and is imported here rather than duplicated.
await import("./test-moria-native-io.mjs");

// The production Worker bridge is TypeScript and belongs to the browser
// bundle. Vitest loads that exact source, but its real-artifact case is opt-in
// so the unit-only test:render gate never depends on gitignored WASM outputs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitest = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));
const bridgeTest = fileURLToPath(new URL("moria-worker-bridge.test.ts", import.meta.url));
const result = spawnSync(process.execPath, [vitest, "run", bridgeTest], {
  cwd: fileURLToPath(new URL("../..", import.meta.url)),
  env: { ...process.env, MORIA_REAL_ARTIFACT: "1" },
  stdio: "inherit",
});
if (result.error) throw result.error;
assert.equal(result.signal, null, `Moria Worker bridge test ended by signal ${result.signal}`);
assert.equal(result.status, 0, `Moria Worker bridge test exited ${result.status}`);

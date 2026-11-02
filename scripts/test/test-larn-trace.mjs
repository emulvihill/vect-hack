// Behavioral equivalence: the bot's keystrokes over the frozen seed set must
// match scripts/test/fixtures/larn-action-traces.json exactly.
//
// Phase 1a promises to change no decisions. This is that promise, executable.
// If it fails after a refactor, the refactor changed behavior — fix the code,
// do not re-record the fixture. Re-record only for a deliberate, reviewed
// behavior change (run record-action-traces.mjs with no flag and say why in
// the commit message).
import { execFileSync } from "node:child_process";

try {
  execFileSync(process.execPath, ["scripts/dev/record-action-traces.mjs", "--check"], { stdio: "inherit" });
} catch {
  console.error("FAIL: the bot's action traces drifted from the committed fixture");
  process.exit(1);
}

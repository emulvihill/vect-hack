#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const out = mkdtempSync(join(tmpdir(), "vect-moria-checkpoint-"));
const harness = join(out, "moria-checkpoint-native-harness");

execFileSync("c++", [
  "-std=c++14", "-Wall", "-Wextra", "-Werror",
  "-ffunction-sections", "-fdata-sections", "-Wl,--gc-sections",
  "-DMORIA_CHECKPOINT_HOST_TEST",
  `-I${join(ROOT, "src/modules/moria/native")}`,
  `-I${join(ROOT, "external/umoria/src")}`,
  join(ROOT, "scripts/test/moria-checkpoint-native-harness.cpp"),
  join(ROOT, "src/modules/moria/native/checkpoint-wasm.cpp"),
  join(ROOT, "src/modules/moria/native/game-save-wasm.cpp"),
  join(ROOT, "external/umoria/src/rng.cpp"),
  "-o", harness,
], { cwd: ROOT, stdio: "inherit" });
execFileSync(harness, [], { cwd: ROOT, stdio: "inherit" });
console.log("OK(native): exact stock checkpoint success/failure rollback, callback suppression, marker timing, footer and RNG");

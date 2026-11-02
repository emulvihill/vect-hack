// scripts/build/guard-host-paths.sh is the only thing between a build-machine
// path and a published artifact (vect-hack-uur5), and every build script trusts
// its exit status. It must fail on a leak, on a resolved-symlink leak, and on
// anything it could not scan: a missing file or a directory reads as "no match"
// to a grep whose error is swallowed.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GUARD = new URL("../build/guard-host-paths.sh", import.meta.url).pathname;

let scratch: string;
let root: string;
let home: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "vect-guard-"));
  root = join(scratch, "checkout");
  home = join(scratch, "home");
  mkdirSync(root);
  mkdirSync(home);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function guard(dirs: string[], artifacts: string[]) {
  return spawnSync(GUARD, ["test", ...dirs, "--", ...artifacts], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

function artifact(name: string, contents: string): string {
  const path = join(scratch, name);
  writeFileSync(path, contents);
  return path;
}

describe("guard-host-paths.sh", () => {
  it("passes a clean artifact", () => {
    expect(guard([root], [artifact("clean.js", 'var PACKAGE_NAME="moria.data";')]).status).toBe(0);
  });

  it("refuses the checkout path, every source dir, and $HOME", () => {
    const source = join(scratch, "umoria");
    mkdirSync(source);
    expect(guard([root], [artifact("a.js", `"${root}/build/moria/moria.data"`)]).status).toBe(1);
    expect(guard([root, source], [artifact("b.wasm", `${source}/src/helpers.cpp`)]).status).toBe(1);
    expect(guard([root], [artifact("c.js", `${home}/elsewhere`)]).status).toBe(1);
  });

  it("refuses the resolved path of a symlinked checkout", () => {
    const link = join(scratch, "link");
    symlinkSync(root, link);
    expect(guard([link], [artifact("d.js", `${root}/build`)]).status).toBe(1);
  });

  it("does not match a sibling of $HOME", () => {
    expect(guard([root], [artifact("e.js", `${home}2/x`)]).status).toBe(0);
  });

  it("fails on a missing artifact or a directory instead of passing it", () => {
    const clean = artifact("clean.js", "clean");
    expect(guard([root], [clean, join(scratch, "missing.js")]).status).toBe(1);
    expect(guard([root], [clean, root]).status).toBe(1);
  });

  it("rejects a call that names no directory", () => {
    expect(guard([], [artifact("f.js", "clean")]).status).toBe(2);
  });
});

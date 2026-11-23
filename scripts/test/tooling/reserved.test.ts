// scripts/dev/reserved.mjs is what puts `npm test` and `npm run check:gates`
// under an account's reservation wrapper (vect-hack-v63n). Where a wrapper is
// configured it is required: a wrapper that fails is the run's failure, never a
// reason to run without it. Where none is, the command runs on this host.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RESERVED = new URL("../../dev/reserved.mjs", import.meta.url).pathname;
const NODE = process.execPath;
const NOTICE = "reserved: no reservation configured for test; running on this host";

let config: string;

beforeEach(() => { config = mkdtempSync(join(tmpdir(), "vect-reserved-")); });
afterEach(() => rmSync(config, { recursive: true, force: true }));

function writeConfig(text: string) {
  mkdirSync(join(config, "vect-hack"));
  writeFileSync(join(config, "vect-hack", "reserve.json"), text);
}

function reserved(name: string, command: string[]) {
  return spawnSync(NODE, [RESERVED, name, "--", ...command], {
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: config },
  });
}

/** A command that records how it was reached in `marker`, so a test can tell whether it ran. */
function runs(marker: string, code = 0) {
  return [NODE, "-e", `require("fs").writeFileSync(process.argv[1], process.env.VIA ?? "direct"); process.exit(${code})`, marker];
}

describe("reserved.mjs", () => {
  it("runs the configured prefix before the command and passes its exit code through", () => {
    writeConfig(JSON.stringify({ test: ["env", "VIA=prefix"] }));
    const marker = join(config, "ran");
    const r = reserved("test", runs(marker, 7));
    expect(r.status).toBe(7);
    expect(readFileSync(marker, "utf8")).toBe("prefix");
    expect(r.stderr).not.toContain("no reservation configured");
  });

  it("runs the command on this host, with the one notice, when there is no config file", () => {
    const marker = join(config, "ran");
    const r = reserved("test", runs(marker));
    expect(r.status).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("direct");
    expect(r.stderr.trim()).toBe(NOTICE);
  });

  it("runs the command on this host when the config has no entry for the name", () => {
    writeConfig(JSON.stringify({ gates: ["env", "VIA=prefix"] }));
    const marker = join(config, "ran");
    const r = reserved("test", runs(marker));
    expect(r.status).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("direct");
    expect(r.stderr.trim()).toBe(NOTICE);
  });

  // A broken config must not silently drop the reservation it was written for.
  it("refuses a config it cannot parse, or an entry that is not an argv, with exit 2", () => {
    const marker = join(config, "ran");
    writeConfig("{");
    expect(reserved("test", runs(marker)).status).toBe(2);
    writeFileSync(join(config, "vect-hack", "reserve.json"), JSON.stringify({ test: "nice -n 10" }));
    expect(reserved("test", runs(marker)).status).toBe(2);
    writeFileSync(join(config, "vect-hack", "reserve.json"), "[]");
    expect(reserved("test", runs(marker)).status).toBe(2);
    // A bad entry for another name is refused too, not left for that command to find.
    writeFileSync(join(config, "vect-hack", "reserve.json"),
      JSON.stringify({ test: ["env", "VIA=prefix"], gates: "nice -n 10" }));
    const other = reserved("test", runs(marker));
    expect(other.status).toBe(2);
    expect(other.stderr).toContain('"gates"');
    expect(existsSync(marker)).toBe(false);
  });

  // readFileSync through a dangling link is ENOENT, the same as no file at all.
  it("refuses a config that is a dangling symlink rather than running directly", () => {
    mkdirSync(join(config, "vect-hack"));
    symlinkSync(join(config, "gone.json"), join(config, "vect-hack", "reserve.json"));
    const marker = join(config, "ran");
    const r = reserved("test", runs(marker));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("dangling symlink");
    expect(existsSync(marker)).toBe(false);
  });

  // 69 is the queue being unreachable: the run fails closed, once.
  it("passes a failing prefix's code through without retrying it or running the command", () => {
    const count = join(config, "count");
    writeConfig(JSON.stringify({
      test: [NODE, "-e", `require("fs").appendFileSync(${JSON.stringify(count)}, "x"); process.exit(69)`],
    }));
    const marker = join(config, "ran");
    const r = reserved("test", runs(marker));
    expect(r.status).toBe(69);
    expect(readFileSync(count, "utf8")).toBe("x");
    expect(existsSync(marker)).toBe(false);
  });

  it("ends by the same signal as the command it ran", () => {
    const r = reserved("test", [NODE, "-e", "process.kill(process.pid, 'SIGTERM')"]);
    expect(r.signal).toBe("SIGTERM");
  });
});

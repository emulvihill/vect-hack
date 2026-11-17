// scripts/build/release-bundle.mjs makes the only copy of a release's compile
// units that outlives the host (vect-hack-z5ak). What must hold: the archive is
// one a stock tar(1) unpacks to the exact bytes, SHA256SUMS verifies them, the
// same input gives the same archive, an unbuilt engine fails the pack instead
// of shipping a short bundle, and an upload is refused for every way the bundle
// on disk can fail to be the build of the tag at HEAD. public/modules/ is
// gitignored, so the last of those rests on the record clean.sh leaves and on
// the order of `npm run build`; both are pinned here.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ENGINES } from "../../build/engine-artifacts.mjs";
import { LICENSE_FILES } from "../../build/stage-licenses.mjs";
import {
  bundleEntries, packRelease, remoteTagCommit, sha256sums, stampCleaned, tarGz, tarHeader,
  uploadRefusal,
} from "../../build/release-bundle.mjs";

const repo = join(import.meta.dirname, "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "vh-release-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A checkout-shaped directory: the license texts and fake engine outputs. */
function fakeRoot(name: string, skip?: string): string {
  const root = join(scratch, name);
  mkdirSync(root);
  for (const f of LICENSE_FILES) writeFileSync(join(root, f), readFileSync(join(repo, f)));
  for (const { game, files } of ENGINES) {
    mkdirSync(join(root, "public", "modules", game), { recursive: true });
    for (const f of files) {
      if (f === skip) continue;
      // 700 bytes: not a multiple of the 512-byte tar block, so padding is exercised
      writeFileSync(join(root, "public", "modules", game, f), Buffer.alloc(700, f));
    }
  }
  return root;
}

describe("release-bundle pack", () => {
  const root = fakeRoot("built");
  const out = join(scratch, "out");
  const meta = packRelease(root, out);

  it("writes a tarball stock tar unpacks, whose files SHA256SUMS verifies", () => {
    const unpacked = join(scratch, "unpacked");
    mkdirSync(unpacked);
    const tar = spawnSync("tar", ["-xzf", join(out, meta.tarball), "-C", unpacked], { encoding: "utf8" });
    expect(tar.stderr).toBe("");
    expect(tar.status).toBe(0);
    for (const line of readFileSync(join(out, "SHA256SUMS"), "utf8").trimEnd().split("\n")) {
      const [hash, name] = line.split("  ");
      expect(createHash("sha256").update(readFileSync(join(unpacked, name ?? ""))).digest("hex"), name).toBe(hash);
    }
    for (const { game, files } of ENGINES) {
      expect(readdirSync(join(unpacked, "modules", game)).sort()).toEqual([...files].sort());
      for (const f of files) {
        expect(readFileSync(join(unpacked, "modules", game, f)).equals(Buffer.alloc(700, f))).toBe(true);
      }
    }
    expect(readdirSync(join(unpacked, "licenses"))).toEqual(expect.arrayContaining([...LICENSE_FILES, "SOURCE.txt"]));
  });

  it("lists every file of every engine in SHA256SUMS", () => {
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8");
    for (const { game, files } of ENGINES) {
      for (const f of files) expect(sums).toMatch(new RegExp(`^[0-9a-f]{64}  modules/${game}/${f}$`, "m"));
    }
    expect(sums.trimEnd().split("\n")).toHaveLength(meta.files);
  });

  it("is deterministic and independent of entry order", () => {
    const entries = bundleEntries(root);
    const reversed = [...entries].reverse();
    expect(tarGz(reversed, 1700000000).equals(tarGz(entries, 1700000000))).toBe(true);
    expect(sha256sums(reversed)).toBe(sha256sums(entries));
    expect(tarGz(entries, 1700000001).equals(tarGz(entries, 1700000000))).toBe(false);
  });

  it("refuses to pack when an engine file is missing", () => {
    const short = fakeRoot("short", "moria.data");
    expect(() => packRelease(short, join(scratch, "short-out"))).toThrow(/engine not built: moria/);
  });

  it("refuses to pack an empty engine file", () => {
    const hollow = fakeRoot("hollow");
    writeFileSync(join(hollow, "public", "modules", "larn", "larn.wasm"), "");
    expect(() => packRelease(hollow, join(scratch, "hollow-out"))).toThrow(/empty engine file: modules\/larn\/larn\.wasm/);
  });

  it("refuses a path a ustar header cannot hold, and takes one that just fits", () => {
    expect(() => tarGz([{ name: "x".repeat(101), data: Buffer.alloc(1) }], 0)).toThrow(/over 100 bytes/);
    expect(tarHeader("x".repeat(100), 1, 0).subarray(0, 100).toString()).toBe("x".repeat(100));
  });

  // Stricter than any one reader: GNU tar forgives fields bsdtar may not.
  it("writes every ustar header field where the format puts it", () => {
    const h = tarHeader("modules/larn/larn.js", 700, 1700000000);
    const field = (at: number, len: number) => h.subarray(at, at + len).toString("latin1");
    expect(h).toHaveLength(512);
    expect(field(0, 21)).toBe("modules/larn/larn.js\0");
    expect(field(100, 8)).toBe("0000644\0");
    expect(field(108, 8)).toBe("0000000\0");
    expect(field(116, 8)).toBe("0000000\0");
    expect(field(124, 12)).toBe("00000001274\0");
    expect(field(136, 12)).toBe("14524770400\0");
    expect(field(156, 1)).toBe("0");
    expect(field(257, 8)).toBe("ustar\x0000");
    expect(field(148, 8)).toMatch(/^[0-7]{6}\0 $/);
    const blank = Buffer.from(h);
    blank.fill(" ", 148, 156);
    expect(parseInt(field(148, 6), 8)).toBe(blank.reduce((a, b) => a + b, 0));
  });
});

describe("release-bundle in a real checkout", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
  const root = fakeRoot("checkout");
  writeFileSync(join(root, ".gitignore"), "public/modules/\nbuild/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  git(root, "tag", "-a", "v1.2.3", "-m", "release");
  git(root, "tag", "v1.2.4-light");
  const head = git(root, "rev-parse", "HEAD");
  const out = join(root, "build", "release");

  it("records the clean, the commit and the tag version, and hashes both assets", () => {
    expect(stampCleaned(root)).toEqual({ commit: head, dirty: false });
    const meta = packRelease(root, out);
    expect(meta).toMatchObject({
      version: "1.2.3", commit: head, dirty: false, cleaned: { commit: head, dirty: false },
      tarball: "vect-hack-1.2.3-modules.tar.gz",
    });
    const hash = (name: string) => createHash("sha256").update(readFileSync(join(out, name))).digest("hex");
    expect(meta.sha256).toEqual({ tarball: hash(meta.tarball), sums: hash("SHA256SUMS") });
    expect(JSON.parse(readFileSync(join(out, "bundle.json"), "utf8"))).toEqual(meta);
  });

  it("records a dirty tree, at the clean and at the pack", () => {
    writeFileSync(join(root, "LICENSE"), "edited\n");
    expect(stampCleaned(root)).toEqual({ commit: head, dirty: true });
    expect(packRelease(root, out)).toMatchObject({ dirty: true, cleaned: { dirty: true } });
    git(root, "checkout", "--", "LICENSE");
  });

  it("records no clean when the engines were not built through one", () => {
    rmSync(join(root, "build"), { recursive: true, force: true });
    expect(packRelease(root, out).cleaned).toBeNull();
  });

  it("reads a remote's tag as its commit, annotated or lightweight, or null", () => {
    expect(remoteTagCommit(root, "v1.2.3", root)).toBe(head);
    expect(remoteTagCommit(root, "v1.2.4-light", root)).toBe(head);
    expect(remoteTagCommit(root, "v9.9.9", root)).toBeNull();
  });
});

describe("release-bundle wiring", () => {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> };

  it("packs last in npm run build, after a clean that precedes the engines", () => {
    const steps = (pkg.scripts.build ?? "").split(" && ");
    expect(steps.at(-1)).toBe("node scripts/build/release-bundle.mjs");
    expect(steps[0]).toBe("npm run clean");
    expect(steps[1]).toBe("npm run build:engines");
    expect(pkg.scripts.clean).toBe("scripts/build/clean.sh");
    expect(pkg.scripts["release:assets"]).toBe("node scripts/build/release-bundle.mjs --upload");
  });

  it("has clean.sh record the clean as its last command, after the deletions", () => {
    const lines = readFileSync(join(repo, "scripts/build/clean.sh"), "utf8").trimEnd().split("\n");
    expect(lines.at(-1)).toBe('node "$ROOT/scripts/build/release-bundle.mjs" --cleaned');
    expect(lines.findIndex((l) => l.startsWith("rm -rf --"))).toBeGreaterThan(-1);
  });
});

describe("release-bundle upload gate", () => {
  const meta = {
    version: "1.2.3", commit: "aaa", dirty: false, cleaned: { commit: "aaa", dirty: false },
    tarball: "t.tar.gz", files: 1, sha256: { tarball: "t1", sums: "s1" },
  };
  const now = {
    head: "aaa", tag: "v1.2.3", dirty: false, remoteTag: "aaa",
    onDisk: { tarball: "t1", sums: "s1" } as { tarball: string | null; sums: string | null },
    assets: [] as string[],
  };

  it("allows the clean build of the tag at HEAD", () => {
    expect(uploadRefusal(meta, now)).toBeNull();
  });

  it.each([
    ["HEAD has no v-tag", meta, { ...now, tag: null }, /not exactly a v-tag/],
    ["the tree is dirty now", meta, { ...now, dirty: true }, /working tree is dirty/],
    ["the bundle came from a dirty tree", { ...meta, dirty: true }, now, /built from a dirty tree/],
    ["the bundle came from another commit", { ...meta, commit: "bbb" }, now, /built from bbb/],
    ["the bundle carries another version", { ...meta, version: "1.2.2" }, now, /version 1\.2\.2/],
    ["origin has the tag elsewhere", meta, { ...now, remoteTag: "bbb" }, /origin has v1\.2\.3 at bbb/],
    ["origin has no such tag", meta, { ...now, remoteTag: null }, /origin has v1\.2\.3 at no commit/],
    ["no clean was recorded", { ...meta, cleaned: null }, now, /no clean recorded/],
    ["the clean saw a dirty tree", { ...meta, cleaned: { commit: "aaa", dirty: true } }, now, /engines were built from a dirty tree/],
    ["the clean was at another commit", { ...meta, cleaned: { commit: "bbb", dirty: false } }, now, /clean at bbb/],
    ["the tarball on disk changed", meta, { ...now, onDisk: { tarball: "t2", sums: "s1" } }, /not the ones the pack wrote/],
    ["SHA256SUMS on disk is missing", meta, { ...now, onDisk: { tarball: "t1", sums: null } }, /not the ones the pack wrote/],
    ["the release has the tarball", meta, { ...now, assets: ["t.tar.gz"] }, /already carries t\.tar\.gz/],
    ["the release has the sums", meta, { ...now, assets: ["SHA256SUMS"] }, /already carries SHA256SUMS/],
  ])("refuses when %s", (_why, m, n, expected) => {
    expect(uploadRefusal(m, n)).toMatch(expected);
  });
});

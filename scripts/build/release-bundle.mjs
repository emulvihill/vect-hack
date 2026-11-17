// Packs the engine build outputs into the two assets a GitHub release carries,
// and (--upload) attaches them to the release for the tag at HEAD.
//
//   build/release/vect-hack-<version>-modules.tar.gz
//   build/release/SHA256SUMS
//
// Why: public/modules/ is gitignored build output and CI builds no engine, so
// without these assets the bytes a release served exist nowhere but the host.
// The tag pins the sources; nobody has shown that two builds of one tag are
// byte-identical, so the tag alone does not pin the compile units.
//
// The tarball holds modules/<game>/<file> for every file in ENGINES and the
// licenses/ directory stage-licenses.mjs writes. The Emscripten .js is in it
// because it is a link output like the .wasm: it carries the byte offsets of
// every file inside the headerless .data and the minified import names of that
// one .wasm. licenses/ is in it because a release asset is a distributed copy
// of NGPL and GPL object code, which needs the texts and the source offer
// (SOURCE.txt names the commit) as much as dist/ does.
//
// SHA256SUMS is a separate asset in `sha256sum -c` format, one line per file
// in the tarball, so a served file can be checked without downloading it all.
//
// The archive is written here, not by tar(1): entries sorted, mtime the commit
// time, uid/gid 0, gzip with no timestamp. The same files at the same commit
// give the same tarball under the same Node build; the deflate stream belongs
// to the zlib Node was linked with, so another Node version may differ.
//
// What ties the bytes to a commit: public/modules/ is gitignored, so git cannot
// say what built it. clean.sh deletes it and then runs --cleaned here, which
// records HEAD and the tree's state in build/cleaned.json; whatever the pack
// finds in public/modules/ was therefore compiled after that point. The pack
// copies the record into bundle.json with the sha256 of both assets.
//
// --upload refuses unless HEAD is exactly a v-tag that origin has at the same
// commit, the tree is clean, the engines were built after a clean at HEAD of a
// clean tree, the two files on disk are the ones the pack wrote, and the
// release has neither asset yet. It never passes --clobber: a pinned asset is
// not replaced. An engine rebuilt by hand between the clean and the pack is
// the one case this cannot see (a per-engine input fingerprint would; clean.sh
// says why there is none).
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { ENGINES, missingEngines } from './engine-artifacts.mjs';
import { builtCommit, builtVersion, stageLicenses } from './stage-licenses.mjs';

const BLOCK = 512;

/** One ustar header block for a regular file. */
export function tarHeader(name, size, mtime) {
  if (Buffer.byteLength(name) > 100) throw new Error(`release-bundle: path over 100 bytes: ${name}`);
  const h = Buffer.alloc(BLOCK);
  const octal = (value, width, at) => h.write(value.toString(8).padStart(width - 1, '0') + '\0', at, 'ascii');
  h.write(name, 0, 'utf8');
  octal(0o644, 8, 100);
  octal(0, 8, 108); // uid
  octal(0, 8, 116); // gid
  octal(size, 12, 124);
  octal(mtime, 12, 136);
  h.write('        ', 148, 'ascii'); // checksum field counts as spaces while summing
  h.write('0', 156, 'ascii'); // regular file
  h.write('ustar\0' + '00', 257, 'ascii');
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

/** A gzipped ustar archive of `entries` ({ name, data }), sorted by name. */
export function tarGz(entries, mtime) {
  const blocks = [];
  for (const { name, data } of sorted(entries)) {
    blocks.push(tarHeader(name, data.length, mtime), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/** `sha256sum -c` lines for `entries`, sorted by name. */
export function sha256sums(entries) {
  return sorted(entries)
    .map(({ name, data }) => `${sha256(data)}  ${name}\n`)
    .join('');
}

function sorted(entries) {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Every file the bundle carries, read from `root`. Throws if an engine is not built. */
export function bundleEntries(root) {
  const missing = missingEngines(root);
  if (missing.length) {
    throw new Error(`release-bundle: engine not built: ${missing.join(', ')} (npm run build)`);
  }
  const entries = ENGINES.flatMap(({ game, files }) => files.map((f) => ({
    name: `modules/${game}/${f}`,
    data: readFileSync(join(root, 'public', 'modules', game, f)),
  })));
  const empty = entries.filter((e) => e.data.length === 0).map((e) => e.name);
  if (empty.length) throw new Error(`release-bundle: empty engine file: ${empty.join(', ')}`);
  const staged = mkdtempSync(join(tmpdir(), 'vh-release-licenses-'));
  try {
    stageLicenses(root, staged);
    for (const f of readdirSync(staged)) {
      entries.push({ name: `licenses/${f}`, data: readFileSync(join(staged, f)) });
    }
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  return entries;
}

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The checkout as git sees it now: HEAD and whether the tree is dirty. */
function treeState(root) {
  return { commit: git(root, 'rev-parse', 'HEAD'), dirty: git(root, 'status', '--porcelain') !== '' };
}

/** Record that every engine output was just deleted, and at which tree state.
 *  clean.sh calls this last. Outside a git checkout it records nothing. */
export function stampCleaned(root) {
  let state;
  try {
    state = treeState(root);
  } catch {
    return null;
  }
  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(join(root, 'build', 'cleaned.json'), JSON.stringify(state) + '\n');
  return state;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Write the tarball, SHA256SUMS and bundle.json for `root` into `out`. */
export function packRelease(root, out) {
  const entries = bundleEntries(root);
  const { commit, dirty } = builtCommit(root);
  const version = builtVersion(root);
  let mtime = 0;
  try {
    mtime = Number(git(root, 'log', '-1', '--format=%ct'));
  } catch {
    // not a git checkout: epoch 0 keeps the archive deterministic
  }
  const tarball = `vect-hack-${version}-modules.tar.gz`;
  const cleaned = readJson(join(root, 'build', 'cleaned.json'));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const archive = tarGz(entries, mtime);
  const sums = sha256sums(entries);
  writeFileSync(join(out, tarball), archive);
  writeFileSync(join(out, 'SHA256SUMS'), sums);
  const meta = {
    version, commit, dirty: dirty !== '', cleaned, tarball, files: entries.length,
    sha256: { tarball: sha256(archive), sums: sha256(sums) },
  };
  writeFileSync(join(out, 'bundle.json'), JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

/**
 * Why this bundle may not be attached to a release, or null when it may.
 * `meta` is bundle.json. `now` is the world as it stands: `head` commit, `tag`
 * the v-tag exactly at HEAD (null if none), `dirty` the tree's state,
 * `remoteTag` the commit origin has for that tag (null if it has none),
 * `onDisk` the sha256 of the two files (null for a missing one) and `assets`
 * the names the release already carries.
 */
export function uploadRefusal(meta, now) {
  if (!now.tag) return 'HEAD is not exactly a v-tag: check out the release tag and run npm run build';
  if (now.remoteTag !== now.head) {
    return `origin has ${now.tag} at ${now.remoteTag ?? 'no commit'}, HEAD is ${now.head}`;
  }
  if (now.dirty) return 'the working tree is dirty';
  if (meta.dirty) return 'the bundle was built from a dirty tree: npm run build';
  if (!meta.cleaned) return 'the engines were not built by npm run build (no clean recorded)';
  if (meta.cleaned.dirty) return 'the engines were built from a dirty tree: npm run build';
  if (meta.cleaned.commit !== now.head) {
    return `the engines were built after a clean at ${meta.cleaned.commit}, HEAD is ${now.head}: npm run build`;
  }
  if (meta.commit !== now.head) {
    return `the bundle was built from ${meta.commit}, HEAD is ${now.head}: npm run build`;
  }
  if (`v${meta.version}` !== now.tag) {
    return `the bundle is version ${meta.version}, the tag at HEAD is ${now.tag}: npm run build`;
  }
  if (now.onDisk.tarball !== meta.sha256?.tarball || now.onDisk.sums !== meta.sha256?.sums) {
    return 'the files in build/release/ are not the ones the pack wrote: npm run build';
  }
  const present = [meta.tarball, 'SHA256SUMS'].filter((name) => now.assets.includes(name));
  if (present.length) return `the release already carries ${present.join(' and ')}`;
  return null;
}

/** The commit `remote` has for `tag`: the peeled commit of an annotated tag,
 *  the ref itself for a lightweight one, null if the remote has no such tag. */
export function remoteTagCommit(root, tag, remote = 'origin') {
  const lines = git(root, 'ls-remote', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`)
    .split('\n').filter(Boolean).map((line) => line.split('\t'));
  const peeled = lines.find(([, ref]) => ref.endsWith('^{}'));
  return (peeled ?? lines[0])?.[0] ?? null;
}

function upload(root, out) {
  const meta = readJson(join(out, 'bundle.json'));
  if (!meta) throw new Error('release-bundle: no bundle in build/release/: npm run build');
  let tag = null;
  try {
    tag = git(root, 'describe', '--tags', '--exact-match', '--match', 'v[0-9]*');
  } catch {
    // no v-tag at HEAD
  }
  const hashOf = (name) => (existsSync(join(out, name)) ? sha256(readFileSync(join(out, name))) : null);
  const { commit: head, dirty } = treeState(root);
  const now = {
    head,
    tag,
    dirty,
    remoteTag: tag ? remoteTagCommit(root, tag) : null,
    onDisk: { tarball: hashOf(meta.tarball), sums: hashOf('SHA256SUMS') },
    // Asked before anything is sent: a half-attached pair cannot be retried.
    assets: tag
      ? JSON.parse(execFileSync('gh', ['release', 'view', tag, '--json', 'assets'],
        { cwd: root, encoding: 'utf8' })).assets.map((a) => a.name)
      : [],
  };
  const refusal = uploadRefusal(meta, now);
  if (refusal) throw new Error(`release-bundle: not uploading: ${refusal}`);
  execFileSync('gh', ['release', 'upload', tag, join(out, meta.tarball), join(out, 'SHA256SUMS')],
    { cwd: root, stdio: 'inherit' });
  console.log(`release-bundle: attached ${meta.tarball} and SHA256SUMS to ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const out = join(root, 'build', 'release');
  try {
    if (process.argv.includes('--cleaned')) {
      stampCleaned(root);
    } else if (process.argv.includes('--upload')) {
      upload(root, out);
    } else {
      const meta = packRelease(root, out);
      console.log(`release-bundle: ${meta.files} files -> build/release/${meta.tarball} + SHA256SUMS`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

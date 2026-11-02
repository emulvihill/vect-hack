// Copies license and notice texts into dist/licenses/ so a copied dist/ carries
// its own terms. Hosting the app is distribution, and NGPL ¶1, GPLv2 §1, GPLv3
// §4 and the BSD notice clauses all require the text to travel with the copy.
//
// Texts alone are not enough: object code also needs source-acquisition
// information (NGPL ¶3, GPLv2 §3, GPLv3 §6). A bare link to a moving `main`
// does not identify what was built, so SOURCE.txt records the exact commit.
//
// index.html is the page the game's Saves menu links to (vect-hack-a4c). It
// carries every text inline, escaped, in a <pre>: a visitor reads the terms
// in the browser whatever MIME type the host guesses for a `.md` file, and a
// host that only rewrites `/`-suffixed URLs still serves it, because the menu
// links the file by name.
//
// copyFileSync throws on a missing source, so a renamed or deleted license file
// fails the build rather than silently shipping less than it claims.
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LICENSE_FILES = [
  'LICENSING.md', 'LICENSE', 'LICENSE.NETHACK', 'LICENSE.GPL2',
  'LICENSE.GPL3', 'LICENSE.LARN', 'THIRD_PARTY_NOTICES.md', 'NOTICE',
];

export const SOURCE_URL = 'https://github.com/emulvihill/vect-hack';

/** Escape text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function builtCommit(root) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    const commit = git('rev-parse', 'HEAD');
    const dirty = git('status', '--porcelain') ? ' (built from a dirty tree)' : '';
    return { commit, dirty };
  } catch {
    // Not a git checkout (e.g. an unpacked source tarball). Leave UNKNOWN rather
    // than inventing a revision — a wrong commit is worse than an absent one.
    return { commit: 'UNKNOWN', dirty: '' };
  }
}

export function sourceText(commit, dirty) {
  return `VectHack — corresponding source
================================

This build was produced from commit:

  ${commit}${dirty}

Complete source, including every build script needed to reproduce these
artifacts, is the VectHack repository:

  ${SOURCE_URL}

To obtain the exact source for this build:

  git clone ${SOURCE_URL}
  cd vect-hack && git checkout ${commit}
  git submodule update --init --recursive

The engine cores are unmodified upstream sources tracked as submodules under
external/ (Larn is a vendored NetBSD snapshot). Lua 5.4.8 is not stored in the
repository: scripts/build/build-nethack-wasm.sh downloads it sha256-verified
from https://www.lua.org/ at build time. The Emscripten SDK is likewise
fetched by scripts/build/setup-toolchain.sh.

Per-component licensing is mapped in LICENSING.md in this directory. Note that
offering source by repository reference is the NGPL ¶3(b) archive-information
route, which that licence makes available for noncommercial distribution only;
commercial distribution requires accompanying the object code with source
under ¶3(a).
`;
}

/** The licenses page: SOURCE.txt first, then every text in LICENSE_FILES. */
export function indexHtml(texts) {
  const sections = texts.map(({ name, body }) =>
    `<h2 id="${escapeHtml(name)}"><a href="${escapeHtml(name)}">${escapeHtml(name)}</a></h2>\n` +
    `<pre>${escapeHtml(body)}</pre>`);
  const toc = texts.map(({ name }) =>
    `<li><a href="#${escapeHtml(name)}">${escapeHtml(name)}</a></li>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VectHack — licenses and source</title>
</head>
<body>
<h1>VectHack — licenses and source</h1>
<p>VectHack's own code is MIT. Each game engine keeps its own license;
LICENSING.md below is the map. The source for this build is at
<a href="${SOURCE_URL}">${SOURCE_URL}</a>, at the commit named in SOURCE.txt.</p>
<ul>
${toc.join('\n')}
</ul>
${sections.join('\n')}
</body>
</html>
`;
}

/** Stage every text, SOURCE.txt and index.html from `root` into `out`. */
export function stageLicenses(root, out) {
  mkdirSync(out, { recursive: true });
  for (const f of LICENSE_FILES) copyFileSync(join(root, f), join(out, f));
  const { commit, dirty } = builtCommit(root);
  const source = sourceText(commit, dirty);
  writeFileSync(join(out, 'SOURCE.txt'), source);
  const texts = [
    { name: 'SOURCE.txt', body: source },
    ...LICENSE_FILES.map((name) => ({ name, body: readFileSync(join(root, name), 'utf8') })),
  ];
  writeFileSync(join(out, 'index.html'), indexHtml(texts));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  stageLicenses(root, join(root, 'dist', 'licenses'));
  console.log(`stage-licenses: ${LICENSE_FILES.length} files + SOURCE.txt + index.html -> dist/licenses/`);
}

// Copies license and notice texts into dist/licenses/ so a copied dist/ carries
// its own terms. Hosting the app is distribution, and NGPL ¶1, GPLv2 §1, GPLv3
// §4 and the BSD notice clauses all require the text to travel with the copy.
//
// Texts alone are not enough: object code also needs source-acquisition
// information (NGPL ¶3, GPLv2 §3, GPLv3 §6). A bare link to a moving `main`
// does not identify what was built, so SOURCE.txt records the exact commit.
//
// Each game's Saves menu links its own page, <game>.html (vect-hack-a4c): VectHack's
// terms and that game's, never another game's. index.html, for a URL with no
// game, carries VectHack's alone. Every page carries its texts inline, escaped,
// in a <pre>: a visitor reads the terms
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

/** VectHack's own terms: the MIT host and the runtime every engine is
 *  compiled with. Every page carries these. */
export const VECTHACK_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];

/** Each game's own terms, keyed by its ?game id (src/backplane/volumes.ts).
 *  A game's page shows these and VECTHACK_FILES and nothing of another game:
 *  each game is licensed on its own, independent of VectHack's MIT license. */
export const MODULES = {
  nethack: { name: 'NetHack', license: 'the NetHack General Public License', files: ['LICENSE.NETHACK', 'NOTICE.NETHACK'] },
  angband: { name: 'Angband', license: 'GPL-2.0-only', files: ['LICENSE.GPL2', 'NOTICE.ANGBAND'] },
  moria: { name: 'Umoria', license: 'GPL-3.0-or-later', files: ['LICENSE.GPL3'] },
  larn: { name: 'Larn', license: "Noah Morgan's no-profit grant", files: ['LICENSE.LARN'] },
};

/** Every text, copied raw into dist/licenses/. One deploy serves all four
 *  games, so all of them ship whatever a single page shows. */
export const LICENSE_FILES = [
  'LICENSING.md', ...VECTHACK_FILES, ...Object.values(MODULES).flatMap((m) => m.files),
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

The engine cores are unmodified upstream sources under external/, tracked as
submodules or vendored snapshots. A library an engine's build script fetches
at build time, rather than storing in the repository, is named in that game's
notices; the Emscripten SDK is fetched by scripts/build/setup-toolchain.sh.

Per-component licensing is mapped in LICENSING.md in this directory. Each
game is covered by its own license, independent of VectHack's MIT license.
`;
}

/** One licenses page: the intro, then each text inline under its own heading. */
function page(title, intro, texts) {
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
<title>${escapeHtml(title)}</title>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${intro} The source for this build is at
<a href="${SOURCE_URL}">${SOURCE_URL}</a>, at the commit named in SOURCE.txt.</p>
<ul>
${toc.join('\n')}
</ul>
${sections.join('\n')}
</body>
</html>
`;
}

/** The page with no game: VectHack's own terms only. */
export function indexHtml(texts) {
  return page('VectHack — license and source',
    "VectHack's own code is MIT. Each game is covered by its own license, " +
    'independent of this one, shown on the licenses page linked from that game.',
    texts);
}

/** A game's page: VectHack's terms and that game's, nothing of another game. */
export function moduleHtml(module, texts) {
  return page(`VectHack and ${module.name} — licenses and source`,
    `VectHack's own code is MIT. ${escapeHtml(module.name)} is covered by its own ` +
    `license, ${escapeHtml(module.license)}, independent of VectHack's.`,
    texts);
}

/** Stage every text, SOURCE.txt, index.html and one <game>.html per entry in
 *  MODULES from `root` into `out`. */
export function stageLicenses(root, out) {
  mkdirSync(out, { recursive: true });
  for (const f of LICENSE_FILES) copyFileSync(join(root, f), join(out, f));
  const { commit, dirty } = builtCommit(root);
  const source = sourceText(commit, dirty);
  writeFileSync(join(out, 'SOURCE.txt'), source);
  const text = (name) => ({ name, body: readFileSync(join(root, name), 'utf8') });
  const vecthack = [{ name: 'SOURCE.txt', body: source }, ...VECTHACK_FILES.map(text)];
  writeFileSync(join(out, 'index.html'), indexHtml(vecthack));
  for (const [id, module] of Object.entries(MODULES)) {
    writeFileSync(join(out, `${id}.html`), moduleHtml(module, [...vecthack, ...module.files.map(text)]));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  stageLicenses(root, join(root, 'dist', 'licenses'));
  console.log(`stage-licenses: ${LICENSE_FILES.length} files + SOURCE.txt + index.html + ${Object.keys(MODULES).length} game pages -> dist/licenses/`);
}

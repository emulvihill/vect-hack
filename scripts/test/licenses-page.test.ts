// The license notices and source offer must be reachable from the game itself
// (vect-hack-a4c): every visitor downloads NGPL and GPL object code, and a
// player who lands on /play/?game=larn never sees the landing page's footer.
// Two halves, pinned together: the Saves panel links a relative licenses page
// for the booted game, and the build stages a page at exactly that path that
// carries VectHack's texts, that game's, no other game's, and the source offer.
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  LICENSE_FILES, MODULES, SOURCE_URL, VECTHACK_FILES, builtVersion, escapeHtml, stageLicenses,
  versionFromDescribe,
} from "../build/stage-licenses.mjs";
import { VOLUMES } from "../../src/backplane/volumes";
import { licensesHref } from "../../src/ui/licensesLink";

const root = join(import.meta.dirname, "..", "..");
const out = mkdtempSync(join(tmpdir(), "vh-licenses-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** The href of the licenses link inside #savepanel, or null. */
function panelLicenseHref(html: string): string | null {
  const panel = html.match(/<div id="savepanel"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  if (panel === undefined) return null;
  return panel.match(/<a id="licenseslink"[^>]*\shref="([^"]+)"/)?.[1] ?? null;
}

describe("the in-game licenses link", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const href = panelLicenseHref(html);

  it("sits in the Saves panel, which every Module shows", () => {
    expect(href).not.toBeNull();
  });

  it("is relative, so it resolves under the /play/ deploy base", () => {
    expect(href).not.toMatch(/^(\/|[a-z]+:)/i);
  });

  it("names the page the build stages, by file name", () => {
    stageLicenses(root, out);
    expect(href).toBe("licenses/index.html");
    expect(existsSync(join(out, "index.html"))).toBe(true);
  });
});

describe("the per-game link", () => {
  stageLicenses(root, out);

  it("has a staged page for every game the app boots, and no page for any other", () => {
    expect(Object.keys(MODULES).sort()).toEqual(Object.keys(VOLUMES).sort());
  });

  it("points each game at its own page, which the build stages", () => {
    for (const game of Object.keys(VOLUMES)) {
      expect(licensesHref(game)).toBe(`licenses/${game}.html`);
      expect(existsSync(join(out, `${game}.html`))).toBe(true);
    }
  });

  it("falls back to the VectHack-only page for no game or an unknown one", () => {
    expect(licensesHref(null)).toBe("licenses/index.html");
    expect(licensesHref("rogue")).toBe("licenses/index.html");
    expect(licensesHref("toString")).toBe("licenses/index.html");
  });
});

/** The texts a page inlines, by the heading each one is filed under. */
function inlined(page: string): string[] {
  return [...page.matchAll(/<h2 id="([^"]+)">/g)].map((m) => m[1]!);
}

describe("the staged licenses pages", () => {
  stageLicenses(root, out);
  const read = (name: string) => readFileSync(join(out, name), "utf8");

  it("copies every text and SOURCE.txt raw, because one deploy serves all four games", () => {
    for (const name of ["SOURCE.txt", ...LICENSE_FILES]) expect(existsSync(join(out, name))).toBe(true);
  });

  it("shows VectHack's terms alone on the page with no game, and says each game is licensed apart", () => {
    const page = read("index.html");
    expect(inlined(page)).toEqual(["SOURCE.txt", ...VECTHACK_FILES]);
    expect(page).toContain("Each game is covered by its own license, independent of this one");
  });

  it("shows each game VectHack's terms and its own, and nothing of another game", () => {
    for (const [id, module] of Object.entries(MODULES)) {
      const page = read(`${id}.html`);
      expect(inlined(page)).toEqual(["SOURCE.txt", ...VECTHACK_FILES, ...module.files]);
      expect(page).toContain(`${escapeHtml(module.name)} is covered by its own license`);
      for (const [other, o] of Object.entries(MODULES)) {
        if (other === id) continue;
        for (const f of o.files) expect(page).not.toContain(f);
        expect(page).not.toContain(o.name);
      }
    }
  });

  it("states the source offer with the repository, the version and the built commit on every page", () => {
    const version = builtVersion(root);
    expect(read("SOURCE.txt")).toMatch(new RegExp(`^VectHack ${version.replace(/\./g, "\\.")} — corresponding source\n`));
    for (const name of ["index.html", ...Object.keys(MODULES).map((id) => `${id}.html`)]) {
      const page = read(name);
      expect(page).toContain(SOURCE_URL);
      expect(page).toContain(`VectHack ${version} — corresponding source`);
      expect(page).toMatch(/This build was produced from commit:\s+(?:[0-9a-f]{40}|UNKNOWN)/);
    }
  });

  it("inlines each text verbatim, escaped, each linked to its file", () => {
    for (const [id, module] of Object.entries(MODULES)) {
      const page = read(`${id}.html`);
      for (const name of [...VECTHACK_FILES, ...module.files]) {
        const body = readFileSync(join(root, name), "utf8");
        expect(page).toContain(`<a href="${name}">${name}</a>`);
        expect(page).toContain(`<pre>${escapeHtml(body)}</pre>`);
      }
    }
    // The GPLv3 carries <https://www.gnu.org/licenses/>; raw, it is a tag.
    const moria = read("moria.html");
    expect(moria).not.toContain("<https://www.gnu.org");
    expect(moria).toContain("&lt;https://www.gnu.org");
  });
});

describe("the release tag is the version", () => {
  it("reads a tag's description, with or without commits past it", () => {
    expect(versionFromDescribe("v0.2.2\n")).toBe("0.2.2");
    expect(versionFromDescribe("v0.2.2-3-g248d26f")).toBe("0.2.2-3-g248d26f");
  });

  it("refuses what is not a v-tag description, so the stamp falls through", () => {
    // VERSION as committed: git archive expands it, a checkout never does.
    expect(versionFromDescribe("$Format:%(describe:tags=true,match=v[0-9]*)$")).toBeNull();
    expect(versionFromDescribe("")).toBeNull();
    expect(versionFromDescribe("release-7")).toBeNull();
    expect(versionFromDescribe(undefined)).toBeNull();
  });

  it("never stamps a build with package.json's version, which is not maintained", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.version).toBe("0.0.0");
    expect(builtVersion(root)).not.toBe("0.0.0");
  });
});

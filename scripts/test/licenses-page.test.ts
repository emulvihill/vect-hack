// The license notices and source offer must be reachable from the game itself
// (vect-hack-a4c): every visitor downloads NGPL and GPL object code, and a
// player who lands on /play/?game=larn never sees the landing page's footer.
// Two halves, pinned together: the Saves panel links a relative
// licenses/index.html, and the build stages a page at exactly that path that
// carries every text and the source offer.
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  LICENSE_FILES, SOURCE_URL, escapeHtml, stageLicenses,
} from "../build/stage-licenses.mjs";

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

describe("the staged licenses page", () => {
  stageLicenses(root, out);
  const page = readFileSync(join(out, "index.html"), "utf8");

  it("carries every license text and SOURCE.txt, each linked to its file", () => {
    for (const name of ["SOURCE.txt", ...LICENSE_FILES]) {
      expect(existsSync(join(out, name))).toBe(true);
      expect(page).toContain(`<a href="${name}">${name}</a>`);
    }
  });

  it("states the source offer with the repository and the built commit", () => {
    expect(page).toContain(SOURCE_URL);
    expect(page).toMatch(/This build was produced from commit:\s+(?:[0-9a-f]{40}|UNKNOWN)/);
  });

  it("inlines each text verbatim, escaped", () => {
    for (const name of LICENSE_FILES) {
      const body = readFileSync(join(root, name), "utf8");
      expect(page).toContain(`<pre>${escapeHtml(body)}</pre>`);
    }
    // The GPLv3 carries <https://www.gnu.org/licenses/>; raw, it is a tag.
    expect(page).not.toContain("<https://www.gnu.org");
    expect(page).toContain("&lt;https://www.gnu.org");
  });
});

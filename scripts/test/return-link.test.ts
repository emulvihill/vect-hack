// The Saves panel's quit row: a link back to the page named by ?return, shown
// only for a same-origin URL so the parameter is never an open redirect, and
// absent from index.html's first paint so a URL without it shows nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pointReturnLink, returnHref } from "../../src/ui/returnLink";

const HERE = "https://vecthack.example/play/?game=larn&return=%2F";
const at = (search: string) => returnHref(new URLSearchParams(search), HERE);

describe("returnHref", () => {
  it("resolves a root-relative path against the page", () => {
    expect(at("game=larn&return=/")).toBe("https://vecthack.example/");
  });

  it("keeps a same-origin absolute URL, query and hash included", () => {
    expect(at("return=" + encodeURIComponent("https://vecthack.example/games?x=1#top")))
      .toBe("https://vecthack.example/games?x=1#top");
  });

  it("names nothing without the parameter, or with an empty one", () => {
    expect(at("game=larn")).toBeNull();
    expect(at("return=")).toBeNull();
  });

  it("refuses another origin, including a protocol-relative one", () => {
    expect(at("return=" + encodeURIComponent("https://elsewhere.example/"))).toBeNull();
    expect(at("return=" + encodeURIComponent("//elsewhere.example/"))).toBeNull();
    expect(at("return=" + encodeURIComponent("http://vecthack.example/"))).toBeNull();
  });

  it("refuses script, blob and backslash-host URLs", () => {
    expect(at("return=" + encodeURIComponent("javascript:alert(1)"))).toBeNull();
    expect(at("return=" + encodeURIComponent("blob:https://vecthack.example/x"))).toBeNull();
    expect(at("return=" + encodeURIComponent("/\\elsewhere.example/"))).toBeNull();
  });

  it("refuses when the page's own URL will not parse", () => {
    expect(returnHref(new URLSearchParams("return=/"), "")).toBeNull();
  });
});

describe("pointReturnLink", () => {
  class Link { hidden = true; href = "#"; setAttribute(_: string, v: string) { this.href = v; } }
  const install = () => {
    const link = new Link();
    (globalThis as any).document = { getElementById: (id: string) => (id === "returnlink" ? link : null) };
    return link;
  };
  afterEach(() => { delete (globalThis as any).document; });

  it("points the row at ?return and shows it", () => {
    const link = install();
    pointReturnLink(new URLSearchParams("game=moria&return=/"), HERE);
    expect(link).toMatchObject({ hidden: false, href: "https://vecthack.example/" });
  });

  it("leaves the row hidden and untouched for a foreign URL", () => {
    const link = install();
    pointReturnLink(new URLSearchParams("return=https://elsewhere.example/"), HERE);
    expect(link).toMatchObject({ hidden: true, href: "#" });
  });
});

describe("the quit row in index.html", () => {
  const html = readFileSync(join(import.meta.dirname, "..", "..", "index.html"), "utf8");
  const panel = html.match(/<div id="savepanel"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";

  it("sits in the Saves panel, hidden until a launcher asks for it", () => {
    expect(panel).toMatch(/<a id="returnlink"[^>]*\shidden[\s>]/);
  });

  it("is really hidden: the panel's display rule would otherwise show it", () => {
    expect(html).toMatch(/#savepanel a\[hidden\]\s*\{\s*display:\s*none;/);
  });
});

// The Saves panel's way out of the game: a link back to whatever page launched
// it, named by that page in `?return=<url>`.
//
// The launcher says where home is, so this repo never learns about the site
// that hosts it: a URL without `?return` shows no row at all, which is every
// dev URL and every host that does not ask for one. Leaving is a plain
// navigation, the same as closing the tab — the character resumes from its
// last checkpoint (docs/SAVES.md), and nothing here saves first.
//
// Same-origin only. The site serves `/` and the game `/play/` from one origin,
// so that costs nothing, and it keeps the parameter from being an open
// redirect: `?return=https://elsewhere` and `?return=javascript:...` (whose
// origin is "null") both get no row.

/** The absolute URL `?return` names, or null when it is absent, malformed, or
 *  on another origin than `here`. */
export function returnHref(params: URLSearchParams, here: string): string | null {
  const raw = params.get("return");
  if (raw === null || raw === "") return null;
  let url: URL;
  let base: URL;
  try {
    base = new URL(here);
    url = new URL(raw, base);
  } catch {
    return null;
  }
  // http(s) only: a same-origin blob: URL shares the page's origin too.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin === base.origin ? url.href : null;
}

/** Point the Saves panel's quit row at `?return` and show it, or leave it
 *  hidden when there is nowhere to return to. */
export function pointReturnLink(params: URLSearchParams, here: string): void {
  const href = returnHref(params, here);
  if (href === null) return;
  const link = document.getElementById("returnlink");
  if (!link) return;
  link.setAttribute("href", href);
  link.hidden = false;
}

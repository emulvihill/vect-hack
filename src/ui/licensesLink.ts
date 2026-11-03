// Which licenses page the Saves panel links (vect-hack-a4c).
//
// Each game is licensed on its own, independent of VectHack's MIT license, so
// scripts/build/stage-licenses.mjs stages one page per game — VectHack's terms
// and that game's, nothing of another game's — plus index.html with VectHack's
// alone. The static href in index.html names that last page; a known ?game id
// swaps in its own. Relative, like the static href, so it resolves under any
// deploy base, and by file name, so a host that rewrites only `/`-suffixed
// URLs still serves it.

import { VOLUMES } from "../backplane/volumes";

/** The page for this ?game id, or the VectHack-only page for anything else. */
export function licensesHref(game: string | null): string {
  return game !== null && Object.hasOwn(VOLUMES, game) ? `licenses/${game}.html` : "licenses/index.html";
}

/** Point the Saves panel's licenses link at this game's page. */
export function pointLicensesLink(game: string | null): void {
  document.getElementById("licenseslink")?.setAttribute("href", licensesHref(game));
}

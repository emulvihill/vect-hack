// Skin registry and boot-time resolution. The active skin is fixed at module
// evaluation — before palette.ts derives its tables from it — so a skin change
// is a page reload, by design (see the spec's "no live switching").
//
// Colour rationale carried over from the code the values left (JSON can't
// hold comments):
//  - clr.BLACK #2c3c78 and clr.BLUE #3060ff are LIFTED: the raw token values
//    are too dark to read as themselves against a black void.
//  - ink.wall ["#1030ff", 2.2] is the old WALL_LIFT: #1030ff has almost no
//    luminance on black; walls need it brought up. Gains >1 are legal — the
//    additive renderer treats channel values above 1 as brightness.
//  - hudClr is deliberately NOT the 3D palette: tty defaults brightened for a
//    dark background; different medium, different table (old TextHud comment).
//  - ink.cursor #30ff50 is the one track colour nothing else uses, so the
//    pick reticle can never be mistaken for terrain, a pet or the hero.
// tokens/quadrascan.json is the base token file, kept under tokens/ so its
// basename does not collide with the default skin. It lived in
// src/render/ until vect-hack-t72k: tokens are skin data, and reading them from
// render while render reads src/skins/ was the tree's one import cycle.
import vendoredTokens from "./tokens/quadrascan.json";
import quadrascanJson from "./quadrascan.json";
import ghostJson from "./ghost.json";
import highContrastJson from "./high-contrast.json";
import {
  DEFAULT_SKIN, SKIN_STORAGE_KEY, deepMerge, resolveSkinName,
  type Skin, type SkinDelta, type Tokens,
} from "./types";

const base = quadrascanJson as unknown as Skin;

/** Every shipped skin, the default included, keyed by name. */
export const SKINS: Record<string, SkinDelta> = Object.fromEntries(
  [base as SkinDelta, ghostJson as SkinDelta, highContrastJson as unknown as SkinDelta]
    .map((s) => [s.name, s]),
);

export type ResolvedSkin = Skin & { tokens: Tokens };

/** A registry name -> full skin: delta over the default, tokens over vendored.
 *  Unknown names throw: resolveSkinName is the one place junk falls back. */
export function resolveSkin(name: string): ResolvedSkin {
  if (!Object.hasOwn(SKINS, name)) throw new Error(`Unknown skin "${name}"`);
  const delta = SKINS[name];
  const skin = name === DEFAULT_SKIN ? base : deepMerge(base, delta);
  return { ...skin, name, tokens: deepMerge(vendoredTokens as Tokens, skin.tokens) };
}

function resolveActive(): ResolvedSkin {
  const g = globalThis as {
    location?: Location; localStorage?: Storage;
    process?: { env?: Record<string, string | undefined> };
  };
  const search = g.location
    ? new URLSearchParams(g.location.search).get("skin")
    : g.process?.env?.VECT_SKIN ?? null;
  let stored: string | null = null;
  try { stored = g.localStorage?.getItem(SKIN_STORAGE_KEY) ?? null; } catch { /* private mode */ }
  const known = new Set(Object.keys(SKINS));
  const { name, persist } = resolveSkinName(known, search, stored);
  if (persist) { try { g.localStorage?.setItem(SKIN_STORAGE_KEY, name); } catch { /* ditto */ } }
  return resolveSkin(name);
}

const active = resolveActive();

/** The one skin this session runs. Everything colour-shaped derives from it. */
export function activeSkin(): ResolvedSkin {
  return active;
}

/** Push the skin's chrome onto :root. Called from main.ts before any view
 *  builds; index.html's stylesheet consumes only var(--vh-*), no literals. */
export function applySkinCss(root: HTMLElement = document.documentElement): void {
  root.style.setProperty("--vh-bg", active.background);
  for (const [prop, value] of Object.entries(active.css)) root.style.setProperty(prop, value);
}

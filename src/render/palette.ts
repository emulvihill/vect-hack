// Adapter from NetHack's CLR_* indices to the active skin (src/skins/), which
// is the single source of truth for every colour in the client. The vendored
// quadrascan.json token file underneath is the physics base; the skin overrides
// it and this module only maps onto the result.
import { Color } from "three/webgpu";
import { CLR, CLR_MAX } from "../backplane/colors";
import { activeSkin } from "../skins";
import type { ClrName, InkRole, InkSpec } from "../skins/types";

const skin = activeSkin();

/** Vector-CRT tokens with the active skin's overrides merged in. */
export const TOKENS = skin.tokens;

/** An ink spec -> Color; tuple gains scale past 1 for additive brightness. */
export function parseInk(spec: InkSpec): Color {
  return typeof spec === "string"
    ? new Color(spec)
    : new Color(spec[0]).multiplyScalar(spec[1]);
}

const CLR_COLORS: Color[] = [];
for (const [name, index] of Object.entries(CLR) as [ClrName, number][]) {
  CLR_COLORS[index] = parseInk(skin.clr[name]);
}
const FALLBACK = new Color(TOKENS.semantic.pointer);

/** CLR_* index -> vector-palette colour. Shared instances; do not mutate.
 *  External caller: src/ui/hud/Radar.ts (with TOKENS) tints the HUD by it. */
export function clr(index: number): Color {
  return (index >= 0 && index < CLR_MAX ? CLR_COLORS[index] : undefined) ?? FALLBACK;
}

/** Structural colours, keyed by role rather than by NetHack's colour index. */
export const INK = Object.fromEntries(
  Object.entries(skin.ink).map(([role, spec]) => [role, parseInk(spec as InkSpec)]),
) as Record<InkRole, Color>;

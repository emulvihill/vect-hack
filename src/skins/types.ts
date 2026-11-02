// Skin schema: the single source of truth for every colour and theme value in
// the client (docs/specs/2026-07-31-skins-opaque-walls-design.md).
// Skins are JSON: the default is complete, the others are deltas deep-merged
// over it. The vendored src/skins/tokens/quadrascan.json token file stays the
// physics/token base; a skin's `tokens` section overrides it.

/** A colour, or a colour with a brightness multiplier — additive rendering
 *  uses channel values above 1 as brightness, which plain hex can't express
 *  (the default skin's wall ink is #1030ff x2.2, the old WALL_LIFT). */
export type InkSpec = string | [hex: string, gain: number];

/** Structural colour roles, exactly the old palette.ts INK table. */
export const INK_ROLES = [
  "wall", "wallTop", "floor", "corridor", "door", "stairs", "hero", "heroRing",
  "pet", "water", "lava", "trap", "cursor",
] as const;
export type InkRole = (typeof INK_ROLES)[number];

/** Shape of the base token file (tokens/quadrascan.json). */
export interface Tokens {
  background: string;
  semantic: { primary: string; alert: string; accent: string; pointer: string; white: string };
  track_palette: string[];
  glow: {
    beam_layers: number; flare_budget: number; flare_spikes: number;
    flare_min_energy: number; persistence_half_life_s: number; energy_release_s: number;
  };
  arc: {
    seg_len_px: number; seg_var: number; base_amp_px: number; energy_amp_px: number;
    shift_period_s: number; trail_half_life_s: number; tint_chance: number; hue_spread_deg: number;
  };
}

/** CLR_* names (src/backplane/colors.ts owns the numbering; skins key by name). */
export type ClrName =
  | "BLACK" | "RED" | "GREEN" | "BROWN" | "BLUE" | "MAGENTA" | "CYAN" | "GRAY"
  | "NO_COLOR" | "ORANGE" | "BRIGHT_GREEN" | "YELLOW" | "BRIGHT_BLUE"
  | "BRIGHT_MAGENTA" | "BRIGHT_CYAN" | "WHITE";

export interface SkinTheme {
  /** Scene clear colour and the page background (--vh-bg). */
  background: string;
  /** CLR_* -> ink for the 3D view's clr(). */
  clr: Record<ClrName, InkSpec>;
  /** Structural roles for terrain and entities. */
  ink: Record<InkRole, InkSpec>;
  /** 0 = no fills (see-through), 1 = solid; between = ghost-pass translucency. */
  walls: { opacity: number };
  strokes: { terrainWidth: number; entityWidth: number };
  /** Partial override of TerrainBuilder's GAIN table. */
  gains: Partial<Record<
    "wallBase" | "floorInterior" | "floorBorder" | "doorSill" | "doorRail"
    | "openDoorJamb" | "water" | "lava" | "feature" | "trap", number>>;
  /** CLR_* -> CSS colour for the text chrome. Deliberately its own table:
   *  different medium, not the 3D palette. */
  hudClr: string[];
  radar: { backdrop: string };
  /** CSS custom properties applied to :root; index.html consumes them. */
  css: Record<string, string>;
  /** Overrides merged over the vendored quadrascan token file. */
  tokens?: DeepPartial<Tokens>;
}

export interface Skin extends SkinTheme { name: string; label: string }
export type SkinDelta = { name: string; label: string } & DeepPartial<SkinTheme>;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K]
    : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Objects merge key-by-key; arrays and scalars replace; base is not mutated. */
export function deepMerge<T>(base: T, delta: DeepPartial<T> | undefined): T {
  if (delta === undefined) return base;
  if (base === null || typeof base !== "object" || Array.isArray(base)) return delta as T;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(delta as object)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v as never);
  }
  return out as T;
}

export const SKIN_STORAGE_KEY = "vect-hack.skin";
export const DEFAULT_SKIN = "quadrascan";

/** URL param wins (and persists, if real); then the stored choice; then the
 *  default. Unknown names warn and fall through — junk is never persisted. */
export function resolveSkinName(
  known: ReadonlySet<string>, search: string | null, stored: string | null,
): { name: string; persist: boolean } {
  if (search) {
    if (known.has(search)) return { name: search, persist: true };
    console.warn(`Unknown skin "${search}"; falling back`);
  }
  if (stored && known.has(stored)) return { name: stored, persist: false };
  return { name: DEFAULT_SKIN, persist: false };
}

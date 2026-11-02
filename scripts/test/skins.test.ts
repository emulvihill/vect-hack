import { describe, expect, it } from "vitest";
import { deepMerge, resolveSkinName } from "../../src/skins/types";

describe("deepMerge", () => {
  it("merges nested sections, replaces scalars", () => {
    const base = { walls: { opacity: 1 }, strokes: { terrainWidth: 1.6, entityWidth: 2.2 } };
    const out = deepMerge(base, { walls: { opacity: 0.35 } });
    expect(out.walls.opacity).toBe(0.35);
    expect(out.strokes).toEqual(base.strokes);
    expect(base.walls.opacity).toBe(1); // base untouched
  });

  it("replaces arrays wholesale, never merges them", () => {
    const out = deepMerge({ hudClr: ["#111", "#222"] }, { hudClr: ["#aaa", "#bbb"] });
    expect(out.hudClr).toEqual(["#aaa", "#bbb"]);
  });

  it("takes delta keys the base lacks", () => {
    const out = deepMerge({ a: 1 } as { a: number; b?: { c: number } }, { b: { c: 2 } });
    expect(out.b).toEqual({ c: 2 });
  });

  it("returns base when delta is undefined", () => {
    const base = { a: 1 };
    expect(deepMerge(base, undefined)).toBe(base);
  });
});

describe("resolveSkinName", () => {
  const known = new Set(["quadrascan", "ghost"]);
  it("URL param wins and asks to persist", () => {
    expect(resolveSkinName(known, "ghost", "quadrascan"))
      .toEqual({ name: "ghost", persist: true });
  });
  it("falls back to the stored choice", () => {
    expect(resolveSkinName(known, null, "ghost")).toEqual({ name: "ghost", persist: false });
  });
  it("unknown URL name warns, falls to stored, never persists junk", () => {
    expect(resolveSkinName(known, "nope", "ghost")).toEqual({ name: "ghost", persist: false });
  });
  it("unknown everywhere lands on the default", () => {
    expect(resolveSkinName(known, "nope", "gone")).toEqual({ name: "quadrascan", persist: false });
  });
});

import { Color } from "three/webgpu";
import { SKINS, activeSkin, resolveSkin } from "../../src/skins";
import { INK_ROLES } from "../../src/skins/types";

const CLR_NAMES = [
  "BLACK", "RED", "GREEN", "BROWN", "BLUE", "MAGENTA", "CYAN", "GRAY",
  "NO_COLOR", "ORANGE", "BRIGHT_GREEN", "YELLOW", "BRIGHT_BLUE",
  "BRIGHT_MAGENTA", "BRIGHT_CYAN", "WHITE",
] as const;
const HEX = /^#[0-9a-f]{3,8}$/i;
const hexOf = (spec: unknown) => (typeof spec === "string" ? spec : (spec as [string])[0]);

describe("shipped skins", () => {
  for (const name of Object.keys(SKINS)) {
    it(`${name} resolves to a complete, parseable skin`, () => {
      const s = resolveSkin(name);
      for (const c of CLR_NAMES) expect(hexOf(s.clr[c]), `clr.${c}`).toMatch(HEX);
      for (const r of INK_ROLES) expect(hexOf(s.ink[r]), `ink.${r}`).toMatch(HEX);
      expect(s.hudClr).toHaveLength(16);
      for (const c of s.hudClr) expect(c).toMatch(HEX);
      expect(s.background).toMatch(HEX);
      expect(s.radar.backdrop).toMatch(HEX);
      expect(s.walls.opacity).toBeGreaterThanOrEqual(0);
      expect(s.walls.opacity).toBeLessThanOrEqual(1);
      expect(s.strokes.terrainWidth).toBeGreaterThan(0);
      expect(s.tokens.glow.beam_layers).toBeGreaterThanOrEqual(1);
      // three parses every ink without warning-level surprises
      for (const c of CLR_NAMES) new Color(hexOf(s.clr[c]));
    });
  }

  it("honours VECT_SKIN in node, defaulting to quadrascan", () => {
    // VECT_SKIN-aware so `VECT_SKIN=ghost npm run preview` (which shares the
    // vitest config) doesn't trip over a hard-coded expectation. Normalized
    // through the resolver so a misspelled VECT_SKIN surfaces its warning
    // rather than a confusing name mismatch here (node: no stored choice).
    const s = activeSkin();
    const { name } = resolveSkinName(
      new Set(Object.keys(SKINS)), process.env.VECT_SKIN ?? null, null);
    expect(s.name).toBe(name);
    expect(resolveSkin("quadrascan").walls.opacity).toBe(1);
  });

  it("rejects an unknown name instead of relabelling the default", () => {
    expect(() => resolveSkin("nope")).toThrow(/Unknown skin "nope"/);
  });
});

describe("skin intents", () => {
  it("ghost keeps the quadrascan look with translucent walls", () => {
    const s = resolveSkin("ghost");
    expect(s.walls.opacity).toBeCloseTo(0.8);
    expect(s.clr.RED).toEqual(resolveSkin("quadrascan").clr.RED); // delta touches walls only
  });
  it("high-contrast is opaque, thicker, and flattens the bloom", () => {
    const s = resolveSkin("high-contrast");
    expect(s.walls.opacity).toBe(1);
    expect(s.strokes.terrainWidth).toBeGreaterThan(2);
    expect(s.tokens.glow.beam_layers).toBeLessThan(3);
  });
});

import { INK, TOKENS, clr, parseInk } from "../../src/render/palette";
import { CLR } from "../../src/backplane/colors";

describe("palette derives from the active skin", () => {
  it("parseInk applies a tuple's gain above 1", () => {
    const c = parseInk(["#1030ff", 2.2]);
    expect(c.b).toBeCloseTo(2.2);              // unclamped: brightness, not hex
    expect(parseInk("#ff0000").r).toBe(1);
  });
  it("clr() and INK come from the skin file", () => {
    const s = activeSkin();
    expect(`#${clr(CLR.RED).getHexString()}`).toBe(s.clr.RED);
    expect(INK.wallTop.getHexString()).toBe((s.ink.wallTop as string).slice(1));
  });
  it("TOKENS is the vendored file with skin overrides merged", () => {
    expect(TOKENS.glow.beam_layers).toBe(activeSkin().tokens.glow.beam_layers);
  });
});

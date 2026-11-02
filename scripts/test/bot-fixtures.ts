// Shared fixtures for the bot test files. NOT a .test.ts file itself: vitest
// only collects *.test.ts, and importing a describe block from another test
// file re-executes it under the importing file's run (bot-model's suite was
// double-counted inside bot-policy.test.ts before this split).
import type { GlyphCell } from "../../src/modules/nethack/protocol";
import { BotModel } from "../../src/modules/nethack/bot/model";

// Minimal constants in the shape session.onReady delivers. GLYPH offsets are
// the ones the Classifier reads; values are small but ordered like the
// real export (cmap < zap < explode < warning < statue < unexplored).
export const CONSTANTS = {
  WIN_TYPE: { NHW_MESSAGE: 1, NHW_STATUS: 2, NHW_MAP: 3, NHW_MENU: 4, NHW_TEXT: 5 },
  GLYPH: {
    GLYPH_PET_OFF: 1000, GLYPH_INVIS_OFF: 2000, GLYPH_DETECT_OFF: 2100,
    GLYPH_BODY_OFF: 2200, GLYPH_RIDDEN_OFF: 2300, GLYPH_OBJ_OFF: 2400,
    GLYPH_CMAP_OFF: 3000, GLYPH_ZAP_OFF: 4000, GLYPH_EXPLODE_OFF: 4100,
    GLYPH_WARNING_OFF: 4200, GLYPH_STATUE_OFF: 4300, GLYPH_UNEXPLORED_OFF: 4400,
  },
  STATUS_FIELD: { BL_HP: 18, BL_HPMAX: 19, BL_HUNGER: 17 },
} as Record<string, Record<string, number | string>>;

export function cell(ch: string, opts: Partial<GlyphCell> = {}): GlyphCell {
  // glyph 3000 = first cmap glyph -> a terrain Category under CONSTANTS.
  return { glyph: 3000, ch, color: 7, glyphflags: 0, ...opts };
}

export function ready(): BotModel {
  const m = new BotModel();
  m.onReady(CONSTANTS);
  // Windows as the engine creates them: reply carries the view's id.
  m.observe({ name: "create_nhwindow", wintype: 1 }, 10); // message
  m.observe({ name: "create_nhwindow", wintype: 3 }, 30); // map
  m.observe({ name: "create_nhwindow", wintype: 4 }, 40); // menu
  return m;
}

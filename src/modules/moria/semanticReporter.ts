import {
  GRID,
  GRID_STRIDE,
  MORIA_MAX_COLS,
  MORIA_MAX_ROWS,
  OVERLAY,
  STATE,
  STATE_STRIDE,
} from "./mapRecords";
import type { MoriaSemanticEvent, MoriaSemanticState } from "./semanticProtocol";

export type { MoriaSemanticEvent, MoriaSemanticState } from "./semanticProtocol";

export type MoriaSemanticPost = (
  event: MoriaSemanticEvent,
  transfer?: Transferable[],
) => void;

export interface MoriaSemanticReporter {
  semanticMap(words: Int32Array, reset: boolean): void;
  semanticState(words: Int32Array, playerName: string): void;
  semanticMessage(message: string): void;
}

interface ActiveDimensions { width: number; height: number }

/**
 * Copies Emscripten heap views into Worker-owned values and validates the
 * packed public contract before anything can cross to the main thread.
 * Native emits state before map on each flush, so active dimensions are
 * already available when a full or diff batch arrives.
 */
export function createMoriaSemanticReporter(post: MoriaSemanticPost): MoriaSemanticReporter {
  let active: ActiveDimensions | null = null;

  return {
    semanticMap(words, reset) {
      // Copy first and synchronously: the caller may reuse or grow WASM memory
      // as soon as this callback returns.
      const records = new Int32Array(words);
      validateMap(records, reset, active);
      post(
        { name: "map", records, reset },
        [records.buffer as ArrayBuffer],
      );
    },

    semanticState(words, playerName) {
      const copy = new Int32Array(words);
      const state = decodeState(copy, String(playerName));
      active = state.width === 0 ? null : { width: state.width, height: state.height };
      post({ name: "state", state });
    },

    semanticMessage(message) {
      post({ name: "message", text: String(message) });
    },
  };
}

function validateMap(
  records: Int32Array,
  reset: boolean,
  active: ActiveDimensions | null,
): void {
  if (active === null) throw new Error("Moria map batch arrived before structured state");
  if (records.length === 0) throw new Error("empty Moria map batch");
  if (records.length % GRID_STRIDE !== 0) {
    throw new Error("Moria map batch must contain whole packed records");
  }

  const count = records.length / GRID_STRIDE;
  const activeCells = active.width * active.height;
  if (count > activeCells) throw new Error("Moria map batch exceeds active Moria grid");

  const seen = new Set<number>();
  for (let offset = 0; offset < records.length; offset += GRID_STRIDE) {
    const x = records[offset + GRID.X]!;
    const y = records[offset + GRID.Y]!;
    if (x < 0 || x >= active.width || y < 0 || y >= active.height) {
      throw new Error(`Moria map coordinate (${x},${y}) is outside active Moria bounds`);
    }
    const key = y * active.width + x;
    if (seen.has(key)) throw new Error(`Moria map batch has duplicate coordinate (${x},${y})`);
    seen.add(key);
  }

  if (reset && count !== activeCells) {
    throw new Error("Moria reset batch must contain the complete active grid");
  }
}

function decodeState(words: Int32Array, playerName: string): MoriaSemanticState {
  if (words.length !== STATE_STRIDE) {
    throw new Error(`Moria semantic state must contain exactly 25 words, got ${words.length}`);
  }

  const width = words[STATE.WIDTH]!;
  const height = words[STATE.HEIGHT]!;
  const zeroDimensions = width === 0 && height === 0;
  if (!zeroDimensions && (
    width <= 0 || width > MORIA_MAX_COLS || height <= 0 || height > MORIA_MAX_ROWS
  )) {
    throw new Error(`invalid Moria semantic dimensions ${width}x${height}`);
  }
  if ((width === 0) !== (height === 0)) {
    throw new Error(`invalid Moria semantic dimensions ${width}x${height}`);
  }

  const panel = {
    top: words[STATE.PANEL_TOP]!,
    bottom: words[STATE.PANEL_BOTTOM]!,
    left: words[STATE.PANEL_LEFT]!,
    right: words[STATE.PANEL_RIGHT]!,
  };
  const heroX = words[STATE.HERO_X]!;
  const heroY = words[STATE.HERO_Y]!;
  let hero: { x: number; y: number } | null = null;
  if (zeroDimensions) {
    if (panel.top !== 0 || panel.bottom !== 0 || panel.left !== 0 || panel.right !== 0
      || heroX !== -1 || heroY !== -1) {
      throw new Error("zero-dimension Moria state must not name a panel or hero");
    }
  } else {
    if (panel.top < 0 || panel.top > panel.bottom || panel.bottom >= height
      || panel.left < 0 || panel.left > panel.right || panel.right >= width) {
      throw new Error("Moria semantic panel is outside active dimensions");
    }
    const absentHero = heroX === -1 && heroY === -1;
    if (!absentHero) {
      if (heroX < 0 || heroX >= width || heroY < 0 || heroY >= height) {
        throw new Error("Moria semantic hero is outside active dimensions");
      }
      hero = { x: heroX, y: heroY };
    }
  }

  const flagOffsets = [
    STATE.BLIND,
    STATE.HALLUCINATING,
    STATE.CONFUSED,
    STATE.AFRAID,
    STATE.POISONED,
    STATE.RESTING,
  ];
  for (const offset of flagOffsets) {
    if (words[offset] !== 0 && words[offset] !== 1) {
      throw new Error(`Moria semantic boolean flag ${offset} is not 0 or 1`);
    }
  }
  const overlay = words[STATE.OVERLAY]!;
  if (overlay < OVERLAY.NONE || overlay > OVERLAY.CHARACTER) {
    throw new Error(`invalid Moria semantic overlay ${overlay}`);
  }

  return {
    width,
    height,
    panel,
    hero,
    depth: words[STATE.DEPTH]!,
    turn: words[STATE.TURN]!,
    playerName,
    playerLevel: words[STATE.PLAYER_LEVEL]!,
    experience: words[STATE.EXPERIENCE]!,
    gold: words[STATE.GOLD]!,
    hp: words[STATE.HP]!,
    maxHp: words[STATE.MAX_HP]!,
    mana: words[STATE.MANA]!,
    maxMana: words[STATE.MAX_MANA]!,
    ac: words[STATE.AC]!,
    blind: words[STATE.BLIND] !== 0,
    hallucinating: words[STATE.HALLUCINATING] !== 0,
    confused: words[STATE.CONFUSED] !== 0,
    afraid: words[STATE.AFRAID] !== 0,
    poisoned: words[STATE.POISONED] !== 0,
    resting: words[STATE.RESTING] !== 0,
    overlay,
  };
}

/** Browser-facing state decoded from the sanitized native semantic ABI. */
export interface MoriaSemanticState {
  width: number;
  height: number;
  panel: { top: number; bottom: number; left: number; right: number };
  hero: { x: number; y: number } | null;
  depth: number;
  turn: number;
  playerName: string;
  playerLevel: number;
  experience: number;
  gold: number;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  ac: number;
  blind: boolean;
  hallucinating: boolean;
  confused: boolean;
  afraid: boolean;
  poisoned: boolean;
  resting: boolean;
  overlay: number;
}

/** Semantic callbacks remain separate from the canonical terminal protocol.
 * The composition root unions these events only at the Worker boundary. */
export type MoriaSemanticEvent =
  | { name: "map"; records: Int32Array; reset: boolean }
  | { name: "state"; state: MoriaSemanticState }
  | { name: "message"; text: string };

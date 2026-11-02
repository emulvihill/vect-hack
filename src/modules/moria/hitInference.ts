// Umoria's source message tap reports exact player/monster combat text but no
// victim coordinate. Infer only from fresh command-level direction evidence;
// a missed pulse is safer than a guessed one.
import { STEP_OF } from "../../ui/gaze";
import type { MoriaKeyMode } from "./protocol";

export interface MoriaDir { dx: number; dy: number }
export interface MoriaPoint { x: number; y: number }

/** Both tables index STEP_OF: N, NE, E, SE, S, SW, W, NW. The vector view
 * sends from the same strings, so a reordering cannot desynchronise the key it
 * emits from the direction hit inference credits it with. */
export const ORIGINAL_DIRECTIONS = "89632147";
export const ROGUELIKE_DIRECTIONS = "kulnjbhy";

/** Decode only bytes that are movement commands in the named source mode.
 * Uppercase roguelike bytes are run commands in the same direction. */
export function moriaKeyDir(key: number, mode: MoriaKeyMode): MoriaDir | null {
  const raw = String.fromCharCode(key);
  const directions = mode === "original" ? ORIGINAL_DIRECTIONS : ROGUELIKE_DIRECTIONS;
  const normalized = mode === "roguelike" ? raw.toLowerCase() : raw;
  const index = directions.indexOf(normalized);
  if (index < 0) return null;
  const [dx, dy] = STEP_OF[index]!;
  return { dx, dy };
}

// player.cpp playerAttackMonster()/player_bash.cpp produce only these exact
// period-terminated forms. Trap/projectile text uses different punctuation or
// subjects and therefore cannot claim the adjacent cell.
const PLAYER_MELEE = /^You hit (?:it|the .+)\.$/;

// monster.cpp monsterPrintAttackDescription(), limited to descriptions that
// actually attack the player. Requiring source-owned "It "/"The <name> "
// prefixes excludes arrows, darts, scenery, and similarly worded notices.
const MONSTER_MELEE = /^(?:It|The .+) (?:hits|bites|claws|stings|touches|gazes at|breathes on|spits on|crawls on|crushes|tramples|drools on) you\.$/;

export function inferMoriaHit(
  text: string,
  hero: MoriaPoint | null,
  lastDir: MoriaDir | null,
): MoriaPoint | null {
  if (hero === null) return null;
  if (MONSTER_MELEE.test(text) || text === "You've been slimed!") {
    return { x: hero.x, y: hero.y };
  }
  if (lastDir !== null && PLAYER_MELEE.test(text)) {
    return { x: hero.x + lastDir.dx, y: hero.y + lastDir.dy };
  }
  return null;
}

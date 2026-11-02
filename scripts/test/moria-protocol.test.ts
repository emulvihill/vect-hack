import { describe, expect, it } from "vitest";
import {
  KC_ESCAPE,
  MORIA_FRAME_BYTES,
  MORIA_COLS,
  MORIA_ROWS,
  type MoriaEvent,
  type MoriaMainToWorker,
  type MoriaWorkerToMain,
} from "../../src/modules/moria/protocol";

describe("Moria protocol constants", () => {
  it("pins the byte terminal and cancel key", () => {
    expect({ cols: MORIA_COLS, rows: MORIA_ROWS, bytes: MORIA_FRAME_BYTES, escape: KC_ESCAPE })
      .toEqual({ cols: 80, rows: 24, bytes: 1920, escape: 27 });
  });
});

/**
 * The rest of the protocol is pinned at COMPILE time, deliberately not by a
 * vitest assertion. tsc is the only gate that can fail here: each literal
 * below must still satisfy its union member, and EVENT_KINDS must name every
 * MoriaEvent — a name added to the union is a missing key, a name removed is
 * an excess one, which is how "unions sanitized semantic events with the
 * canonical terminal events" is actually enforced.
 *
 * vect-hack-8r0: these were two it()s whose expects compared object literals
 * against those same literals — `expect(message).toEqual({ type: "event", ev:
 * { name: "state", state } })` with `state` the same object reference on both
 * sides. No production change could ever fail them.
 */
const WORKER_MESSAGES: MoriaWorkerToMain[] = [
  // ready carries nothing but its own name now: the storage state it used to
  // carry existed for a message-strip line the banner replaced (vect-hack-dem).
  { type: "ready" },
  { type: "quit", saved: true, persistent: true, reason: null },
  {
    type: "saveBlob", id: 9, ok: true,
    bytes: new Uint8Array([1, 2, 3]), filename: "moria.vhsave",
  },
  {
    type: "event",
    ev: {
      name: "state",
      state: {
        width: 80, height: 24,
        panel: { top: 1, bottom: 22, left: 0, right: 79 },
        hero: { x: 7, y: 9 }, depth: 1, turn: 2, playerName: "Moria",
        playerLevel: 1, experience: 0, gold: 0, hp: 10, maxHp: 10,
        mana: 0, maxMana: 0, ac: 2, blind: false, hallucinating: false,
        confused: false, afraid: false, poisoned: false, resting: false,
        overlay: 0,
      },
    },
  },
];

const MAIN_MESSAGES: MoriaMainToWorker[] = [{ type: "exportSave", id: 9 }];

const EVENT_KINDS: Record<MoriaEvent["name"], "terminal" | "semantic"> = {
  frame: "terminal", bell: "terminal",
  map: "semantic", state: "semantic", message: "semantic",
};

void WORKER_MESSAGES;
void MAIN_MESSAGES;
void EVENT_KINDS;

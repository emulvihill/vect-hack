// One valid Moria checkpoint and every way to break it, shared by the recovery,
// import and persistence tests. A checkpoint is a stock save followed by the
// fixed payload and the trailer (src/modules/moria/recovery.ts); runtime
// recovery and portable import both judge it with validateMoriaCheckpoint, so
// one defect list serves both.
import {
  MORIA_CHECKPOINT_PAYLOAD_BYTES,
  MORIA_CHECKPOINT_PAYLOAD_MAX_BYTES,
  MORIA_CHECKPOINT_SOURCE_SHA,
  MORIA_CHECKPOINT_TRAILER_BYTES,
  MORIA_CHECKPOINT_TRAILER_MAGIC,
  fnv1a32Hex,
} from "../../../src/modules/moria/recovery";

export const STORES_AT = 317;

/** A stock game.sav: a supported version triplet, then the body. */
export function validGame(): Uint8Array {
  const out = new Uint8Array(32);
  out.set([5, 7, 15, 42]);
  return out;
}

/** A payload the validator accepts: zero but for the fields it constrains.
 *  `marker` lands in the unvalidated last-command byte, to tell generations
 *  apart. */
export function validPayload(marker = 0): Uint8Array {
  const payload = new Uint8Array(MORIA_CHECKPOINT_PAYLOAD_BYTES);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 1, true); // live RNG seed
  payload[4] = marker; // last command
  view.setInt32(22, 21, true); // bottom = top + screen height - 1
  view.setInt32(30, 65, true); // right = left + screen width - 1
  view.setInt32(34, -13, true); // col_prt = left - 13
  view.setInt32(38, -1, true); // row_prt = top - 1
  view.setInt16(63, 2, true); // next free monster id
  return payload;
}

/** A checkpoint around `payload`; a number is the marker of a valid one. */
export function checkpoint(payload: Uint8Array | number = validPayload()): Uint8Array {
  const body = typeof payload === "number" ? validPayload(payload) : payload;
  const stock = validGame();
  const footer = new Uint8Array(MORIA_CHECKPOINT_TRAILER_BYTES);
  footer.set(new TextEncoder().encode(MORIA_CHECKPOINT_TRAILER_MAGIC));
  const view = new DataView(footer.buffer);
  view.setUint32(8, 1, true);
  footer.set(Buffer.from(MORIA_CHECKPOINT_SOURCE_SHA, "hex"), 12);
  view.setUint32(32, body.byteLength, true);
  view.setUint32(36, Number.parseInt(fnv1a32Hex(body), 16), true);
  const out = new Uint8Array(stock.byteLength + body.byteLength + footer.byteLength);
  out.set(stock); out.set(body, stock.byteLength); out.set(footer, stock.byteLength + body.byteLength);
  return out;
}

/** The commit record that publishes checkpoint-<generation>.sav. */
export function commitJson(generation: number, bytes: Uint8Array, ancestor: string | null = null): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schema: 1, generation, file: `checkpoint-${generation}.sav`,
    size: bytes.byteLength, checksum: fnv1a32Hex(bytes), ancestor,
  }));
}

/** A terminal tombstone at `generation`. */
export function terminalJson(generation: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ schema: 1, generation, terminal: true }));
}

function withTrailer(edit: (trailer: DataView, bytes: Uint8Array, at: number) => void): Uint8Array {
  const bytes = checkpoint(), at = bytes.byteLength - MORIA_CHECKPOINT_TRAILER_BYTES;
  edit(new DataView(bytes.buffer, at), bytes, at);
  return bytes;
}

function withPayload(edit: (payload: Uint8Array, view: DataView) => void): Uint8Array {
  const payload = validPayload();
  edit(payload, new DataView(payload.buffer));
  return checkpoint(payload);
}

/** Each a checkpoint that differs from a valid one by exactly one defect. */
export const CHECKPOINT_DEFECTS: ReadonlyArray<readonly [string, () => Uint8Array]> = [
  ["a wrong trailer magic", () => withTrailer((_, bytes, at) => { bytes[at] = bytes[at]! ^ 0x20; })],
  ["a wrong trailer schema", () => withTrailer((trailer) => trailer.setUint32(8, 2, true))],
  ["a wrong source pin", () => withTrailer((_, bytes, at) => { bytes[at + 12] = bytes[at + 12]! ^ 0x80; })],
  ["a zero payload length", () => withTrailer((trailer) => trailer.setUint32(32, 0, true))],
  ["a wrong payload checksum", () => withTrailer((_, bytes) => { bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff; })],
  ["an oversized payload", () => checkpoint(new Uint8Array(MORIA_CHECKPOINT_PAYLOAD_MAX_BYTES + 1))],
  ["a short payload", () => checkpoint(new Uint8Array([4, 5, 6]))],
  ["an invalid Boolean", () => withPayload((payload) => { payload[payload.length - 1] = 2; })],
  ["an out-of-range store owner", () => withPayload((payload) => { payload[STORES_AT + 6] = 18; })],
  ["an out-of-range store item count", () => withPayload((payload) => { payload[STORES_AT + 7] = 25; })],
  ["an incoherent panel relation", () => withPayload((_, view) => view.setInt32(38, 99, true))],
  ["a non-source panel maximum", () => withPayload((_, view) => view.setInt16(42, 2, true))],
  ["an out-of-range store item id", () => withPayload((payload, view) => {
    payload[STORES_AT + 7] = 1; view.setUint16(STORES_AT + 16, 420, true);
  })],
  ["an out-of-range store special name", () => withPayload((payload) => {
    payload[STORES_AT + 7] = 1; payload[STORES_AT + 18] = 56;
  })],
  ["an unterminated store inscription", () => withPayload((payload) => {
    payload[STORES_AT + 7] = 1; payload.fill(1, STORES_AT + 19, STORES_AT + 32);
  })],
];

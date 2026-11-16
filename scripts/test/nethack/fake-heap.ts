// Wasm linear memory, little-endian, with a bump allocator: the slice of the
// emscripten runtime wasmAbi.ts and the NetHack worker call. Shared by the
// NetHack ABI tests (wasm-abi, nethack-describe-abi, nethack-worker). NOT a
// .test.ts file itself, so vitest does not collect it.
//
// `dirty` fills every allocation with that byte, the way real malloc hands
// back whatever was there: on zero-filled memory every "this byte is zeroed"
// assertion is true whether or not production writes it.

export interface FakeHeapOptions {
  bytes?: number;
  /** First address handed out: keeps NULL (0) distinct from a real pointer. */
  base?: number;
  dirty?: number;
}

export class FakeHeap {
  readonly view: DataView;
  readonly freed: number[] = [];
  private top: number;
  private readonly dirty: number | undefined;

  constructor({ bytes = 1 << 16, base = 16, dirty }: FakeHeapOptions = {}) {
    this.view = new DataView(new ArrayBuffer(bytes));
    this.top = base;
    this.dirty = dirty;
  }

  _malloc = (n: number): number => {
    const p = this.top;
    this.top += (n + 7) & ~7;
    if (this.dirty !== undefined) for (let i = p; i < p + n; i++) this.view.setUint8(i, this.dirty);
    return p;
  };

  _free = (p: number): void => void this.freed.push(p);

  getValue = (p: number, t: string): number => {
    if (t === "i8") return this.view.getInt8(p);
    if (t === "i16") return this.view.getInt16(p, true);
    if (t === "i32" || t === "*") return this.view.getInt32(p, true); // both 32-bit on wasm32
    throw new Error(`unexpected type ${t}`);
  };

  setValue = (p: number, v: number, t: string): void => {
    if (t === "i8") this.view.setInt8(p, v);
    else if (t === "i16") this.view.setInt16(p, v, true);
    else if (t === "i32" || t === "*") this.view.setInt32(p, v, true);
    else throw new Error(`unexpected type ${t}`);
  };

  UTF8ToString = (p: number): string => {
    if (!p) return "";
    let end = p;
    while (this.view.getUint8(end) !== 0) end++;
    return new TextDecoder().decode(new Uint8Array(this.view.buffer, p, end - p));
  };

  stringToUTF8 = (s: string, p: number, max: number): void => {
    const bytes = new TextEncoder().encode(s).slice(0, max - 1);
    bytes.forEach((b, i) => this.view.setUint8(p + i, b));
    this.view.setUint8(p + bytes.length, 0);
  };

  /** A NUL-terminated copy of `s` on the heap. */
  str(s: string): number {
    const bytes = new TextEncoder().encode(s);
    const p = this._malloc(bytes.length + 1);
    this.stringToUTF8(s, p, bytes.length + 1);
    return p;
  }
}

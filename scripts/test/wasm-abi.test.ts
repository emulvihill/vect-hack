// writeMenuPicks's byte layout must match include/wintype.h's `struct mi`
// (anything item; long count; unsigned itemflags) as emscripten actually
// lays it out on wasm32: `anything` is 8 bytes (it has int64/uint64
// members), not 4, so the struct is 16 bytes with count at offset 8 and
// itemflags at offset 12 — a shorter stride under-allocates and misaligns
// every entry from the second pick on, which crashed the tab on any
// multi-item PICK_ANY confirm (pickup/drop menus).
import { describe, expect, it } from "vitest";
import { writeMenuPicks } from "../../src/modules/nethack/wasmAbi";

/**
 * A bump-allocated byte buffer standing in for wasm linear memory. `_malloc`
 * hands back DIRTY memory (0xAA per byte, the way real malloc hands back
 * whatever was there): a zero-filled ArrayBuffer would make every "this byte
 * is zeroed" assertion below true whether or not production writes it.
 */
const DIRTY = 0xaa;
/** 0xAAAAAAAA read back as a little-endian i32 — what an unwritten word says. */
const DIRTY_I32 = -1431655766;

function fakeModule(bytes = 256) {
  const mem = new DataView(new ArrayBuffer(bytes));
  let next = 0;
  return {
    _malloc: (n: number) => {
      const p = next; next += n;
      for (let i = p; i < next; i++) mem.setUint8(i, DIRTY);
      return p;
    },
    setValue: (ptr: number, value: number, type: string) => {
      if (type !== "i32") throw new Error(`unexpected type ${type}`);
      mem.setInt32(ptr, value, true);
    },
    getValue: (ptr: number, type: string) => {
      if (type !== "i32") throw new Error(`unexpected type ${type}`);
      return mem.getInt32(ptr, true);
    },
    UTF8ToString: () => "",
  };
}

describe("writeMenuPicks", () => {
  it("lays out each entry at the real 16-byte struct-mi stride", () => {
    const mod = fakeModule();
    // Distinct non-zero itemflags: a pick whose flags are 0 cannot tell the
    // offset-12 write from no write at all against dirty memory.
    const arr = writeMenuPicks(mod, [
      { identifier: 11, count: -1, itemflags: 5 },
      { identifier: 22, count: 3, itemflags: 2 },
    ]);
    // item (8, only the low 4 bytes carry our int), count (4) at offset 8,
    // itemflags (4) at offset 12 — entry 1 starts 16 bytes after entry 0.
    expect(mod.getValue(arr + 0, "i32")).toBe(11);
    expect(mod.getValue(arr + 4, "i32")).toBe(0); // high half of the union, zeroed
    expect(mod.getValue(arr + 8, "i32")).toBe(-1);
    expect(mod.getValue(arr + 12, "i32")).toBe(5);
    expect(mod.getValue(arr + 16, "i32")).toBe(22);
    expect(mod.getValue(arr + 20, "i32")).toBe(0);
    expect(mod.getValue(arr + 24, "i32")).toBe(3);
    expect(mod.getValue(arr + 28, "i32")).toBe(2);
  });

  it("hands back dirty memory, so an unwritten word is not silently zero", () => {
    // The guard on the guard: if _malloc ever went back to zero-filled, the
    // "high half of the union, zeroed" assertion above would pass with the
    // production zeroing deleted, which is the defect this fixture repairs.
    const mod = fakeModule();
    const p = mod._malloc(8);
    expect(mod.getValue(p, "i32")).toBe(DIRTY_I32);
    expect(mod.getValue(p + 4, "i32")).toBe(DIRTY_I32);
  });
});

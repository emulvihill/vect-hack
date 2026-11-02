// The do_screen_description marshalling, pinned against a fake module: the
// coord NetHack takes by value is a 4-byte struct of two int16 (include/
// global.h's coordxy, include/coord.h), which clang's wasm32 ABI passes as a
// pointer to a temp — so we allocate one and pass its address. Getting that
// wrong reads garbage coordinates and describes the wrong square, silently.
import { describe, expect, it } from "vitest";
import { describeScreenCell } from "../../src/modules/nethack/wasmAbi";

/** A heap with just enough Emscripten surface for the marshalling. */
function fakeModule(answer: { found: number; firstmatch: string | null }) {
  const heap = new DataView(new ArrayBuffer(4096));
  let next = 16;
  const freed: number[] = [];
  const calls: { cc: number; looked: number; sym: number; supplement: number }[] = [];
  const mod = {
    calls, freed,
    coordAt(ptr: number) { return { x: heap.getInt16(ptr, true), y: heap.getInt16(ptr + 2, true) }; },
    getValue(ptr: number, type: string) {
      return type === "i16" ? heap.getInt16(ptr, true) : heap.getInt32(ptr, true);
    },
    setValue(ptr: number, value: number, type: string) {
      if (type === "i16") heap.setInt16(ptr, value, true);
      else if (type === "i8") heap.setInt8(ptr, value);
      else heap.setInt32(ptr, value, true);
    },
    UTF8ToString(ptr: number) {
      if (!ptr) return "";
      const out: number[] = [];
      for (let p = ptr; heap.getUint8(p); p++) out.push(heap.getUint8(p));
      return String.fromCharCode(...out);
    },
    _malloc(bytes: number) { const p = next; next += bytes + 8; return p; },
    _free(ptr: number) { freed.push(ptr); },
    _do_screen_description(cc: number, looked: number, sym: number, out: number,
                           fm: number, supplement: number) {
      calls.push({ cc, looked, sym, supplement });
      heap.setInt32(out, 0, true);
      if (answer.firstmatch === null) { heap.setInt32(fm, 0, true); return answer.found; }
      const at = next; next += answer.firstmatch.length + 1;
      for (let i = 0; i < answer.firstmatch.length; i++)
        heap.setUint8(at + i, answer.firstmatch.charCodeAt(i));
      heap.setUint8(at + answer.firstmatch.length, 0);
      heap.setInt32(fm, at, true);
      return answer.found;
    },
  };
  return mod;
}

describe("describeScreenCell", () => {
  it("hands NetHack the cell as two int16 and returns firstmatch", () => {
    const mod = fakeModule({ found: 1, firstmatch: "dwarven valkyrie called player" });
    expect(describeScreenCell(mod, 42, 9)).toBe("dwarven valkyrie called player");
    expect(mod.coordAt(mod.calls[0]!.cc)).toEqual({ x: 42, y: 9 });
    // looked = TRUE is what makes it read the map glyph rather than a symbol;
    // for_supplement stays NULL because v1 shows no monster supplement.
    expect(mod.calls[0]).toMatchObject({ looked: 1, sym: 0, supplement: 0 });
  });

  it("frees every buffer it allocated", () => {
    const mod = fakeModule({ found: 1, firstmatch: "wall" });
    describeScreenCell(mod, 1, 1);
    expect(mod.freed).toHaveLength(3);
  });

  it("answers null when NetHack found nothing", () => {
    const mod = fakeModule({ found: 0, firstmatch: null });
    expect(describeScreenCell(mod, 1, 1)).toBeNull();
  });

  it("answers null when NetHack left firstmatch unset", () => {
    const mod = fakeModule({ found: 1, firstmatch: null });
    expect(describeScreenCell(mod, 1, 1)).toBeNull();
  });
});

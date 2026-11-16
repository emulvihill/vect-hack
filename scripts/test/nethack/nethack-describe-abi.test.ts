// The do_screen_description marshalling, pinned against a fake module: the
// coord NetHack takes by value is a 4-byte struct of two int16 (include/
// global.h's coordxy, include/coord.h), which clang's wasm32 ABI passes as a
// pointer to a temp — so we allocate one and pass its address. Getting that
// wrong reads garbage coordinates and describes the wrong square, silently.
import { describe, expect, it } from "vitest";
import { describeScreenCell } from "../../../src/modules/nethack/wasmAbi";
import { FakeHeap } from "./fake-heap";

/** A heap whose do_screen_description() answers `answer`. */
function fakeModule(answer: { found: number; firstmatch: string | null }) {
  const heap = new FakeHeap({ bytes: 4096 });
  const calls: { cc: number; looked: number; sym: number; supplement: number }[] = [];
  return Object.assign(heap, {
    calls,
    coordAt(ptr: number) { return { x: heap.view.getInt16(ptr, true), y: heap.view.getInt16(ptr + 2, true) }; },
    _do_screen_description(cc: number, looked: number, sym: number, out: number,
                           fm: number, supplement: number) {
      calls.push({ cc, looked, sym, supplement });
      heap.setValue(out, 0, "i32");
      heap.setValue(fm, answer.firstmatch === null ? 0 : heap.str(answer.firstmatch), "*");
      return answer.found;
    },
  });
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

  // isok() (src/cmd.c) is x in 1..COLNO-1, y in 0..ROWNO-1, COLNO 80 and
  // ROWNO 21 (include/global.h). do_screen_description() never checks it, and
  // lookat() indexes levl[x][y] with whatever it is given. Column 0 is inside
  // the arrays but is not a map column. A fractional or huge value would be
  // truncated to int16 by setValue and describe a cell the pointer is not on.
  it.each([
    ["column 0", 0, 5],
    ["past the right edge", 80, 5],
    ["negative x", -1, 5],
    ["negative y", 10, -1],
    ["past the bottom edge", 10, 21],
    ["fractional x", 1.5, 5],
    ["fractional y", 10, 0.5],
    ["NaN x", NaN, 5],
    ["NaN y", 10, NaN],
    ["infinite x", Infinity, 5],
    ["x that wraps to 1 as an int16", 65537, 5],
  ])("never asks NetHack about %s", (_name, x, y) => {
    const mod = fakeModule({ found: 1, firstmatch: "wall" });
    expect(describeScreenCell(mod, x, y)).toBeNull();
    expect(mod.calls).toHaveLength(0);
  });

  it.each([
    [1, 0],
    [79, 20],
  ])("still asks NetHack about the edge cell %i,%i", (x, y) => {
    const mod = fakeModule({ found: 1, firstmatch: "wall" });
    expect(describeScreenCell(mod, x, y)).toBe("wall");
    expect(mod.coordAt(mod.calls[0]!.cc)).toEqual({ x, y });
  });
});

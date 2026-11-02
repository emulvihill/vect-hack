// Guards the save-file rebuild in src/modules/nethack/recoverSave.ts.
//
// Two jobs. First, the framing constants that port hardcodes are re-derived
// here from the NetHack headers themselves, so a submodule bump that moves a
// struct fails a fast test instead of silently producing a save the engine
// rejects at restore. Second, the assembly order is checked against a
// synthetic level set, which is the part util/recover.c specifies and no
// header can.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PL_NSIZ_PLUS, SAVESIZE, VERSION_INFO_BYTES, buildSaveFile,
} from "../../src/modules/nethack/recoverSave";

const NH = new URL("../../external/NetHack/", import.meta.url);
const header = (p: string) => readFileSync(new URL(p, NH), "utf8");

/** `#define NAME value`, with the value read as an integer. */
function defined(src: string, name: string): number {
  const m = new RegExp(`^#define\\s+${name}\\s+(\\d+)`, "m").exec(src);
  if (!m) throw new Error(`no numeric #define ${name}`);
  return Number(m[1]);
}

describe("NetHack layout the rebuild depends on", () => {
  const global_h = header("include/global.h");
  const fnamesiz_h = header("include/fnamesiz.h");

  it("still sizes the player name as PL_NSIZ_PLUS = PL_NSIZ + 4 * (1 + 3) + 1", () => {
    const plNsiz = defined(global_h, "PL_NSIZ");
    expect(global_h).toContain("#define PL_NSIZ_PLUS (PL_NSIZ + 4 * (1 + 3) + 1)");
    expect(plNsiz + 4 * (1 + 3) + 1).toBe(PL_NSIZ_PLUS);
  });

  it("still sizes the save-name field as SAVESIZE", () => {
    // SAVESIZE = PL_NSIZ + sizeof(SAVEX) + sizeof(SAVE_EXTENSION) + INDSIZE,
    // and sizeof of a string literal counts its NUL.
    expect(fnamesiz_h).toContain(
      "#define SAVESIZE (PL_NSIZ + sizeof(SAVEX) + sizeof(SAVE_EXTENSION) + INDSIZE)");
    const literal = (name: string) => {
      const m = new RegExp(`^#define\\s+${name}\\s+"([^"]*)"`, "m").exec(fnamesiz_h);
      if (!m) throw new Error(`no string #define ${name}`);
      return m[1]!.length + 1;
    };
    // The unix branch: SAVEX "save/99999.e", SAVE_EXTENSION "", INDEXT ".xxxxxx".
    expect(defined(global_h, "PL_NSIZ") + literal("SAVEX") + 1 + literal("INDEXT"))
      .toBe(SAVESIZE);
  });

  it("still defines version_info as three unsigned longs", () => {
    const m = /struct version_info \{([^}]*)\}/.exec(global_h);
    expect(m).not.toBeNull();
    const fields = [...m![1]!.matchAll(/unsigned long\s+\w+;/g)];
    expect(fields).toHaveLength(3);
    expect(fields.length * 4).toBe(VERSION_INFO_BYTES); // wasm32
  });
});

/** A level.0 whose framing header matches what savestateinlock() writes. */
function level0({ savelev = 1, savename = "save/0player", state = "STATE" } = {}): Uint8Array {
  const csc = Uint8Array.from([8, 16, 24]);
  const name = new TextEncoder().encode("player");
  const bytes: number[] = [];
  const int32 = (v: number) => bytes.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255);

  int32(4242);          // hpid, ignored by the rebuild
  int32(savelev);
  const nameField = new Uint8Array(SAVESIZE);
  nameField.set(new TextEncoder().encode(savename));
  bytes.push(...nameField);
  bytes.push(117);              // indicator ('u')
  bytes.push(csc.length);
  bytes.push(...csc);
  bytes.push(...new Uint8Array(VERSION_INFO_BYTES).fill(7));
  int32(name.length);
  bytes.push(...name);
  bytes.push(...new TextEncoder().encode(state));
  return Uint8Array.from(bytes);
}

const ascii = (s: string) => new TextEncoder().encode(s);

describe("buildSaveFile", () => {
  it("assembles header, hero level, game state, then the other levels", () => {
    const { path, bytes, savelev } = buildSaveFile(new Map([
      [0, level0({ savelev: 2, state: "STATE" })],
      [1, ascii("LEVEL-ONE")],
      [2, ascii("HERO-LEVEL")],
      [5, ascii("LEVEL-FIVE")],
    ]));

    expect(path).toBe("save/0player");
    expect(savelev).toBe(2);

    // indicator, cscsize, cscbuf, version_info, name size, name
    const headerLen = 1 + 1 + 3 + VERSION_INFO_BYTES + 4 + "player".length;
    const text = new TextDecoder().decode(bytes.subarray(headerLen));
    // The whole header, byte for byte. Checking only bytes[0] and [1] and then
    // skipping to headerLen left the interior — the cscbuf copied out of
    // level.0, the version_info bytes and the name — free to be zeroed or
    // transposed as long as the length came out right (vect-hack-8r0), and
    // util/recover.c's contract is that those bytes are COPIED: a save whose
    // version_info is wrong is one the engine rejects at restore.
    expect([...bytes.subarray(0, headerLen)]).toEqual([
      117,                                          // indicator ('u')
      3,                                            // cscsize
      8, 16, 24,                                    // cscbuf, out of level.0
      ...new Array(VERSION_INFO_BYTES).fill(7),     // version_info, out of level.0
      6, 0, 0, 0,                                   // name length, little-endian
      ...[..."player"].map((c) => c.charCodeAt(0)),
    ]);
    // The hero's level comes before the state that trails level.0's header,
    // and the remaining levels follow in ledger order behind their number.
    expect(text).toBe(`HERO-LEVEL STATE \x01LEVEL-ONE \x05LEVEL-FIVE`
      .replaceAll(" ", ""));
  });

  it("refuses a set missing the level the hero is on", () => {
    expect(() => buildSaveFile(new Map([[0, level0({ savelev: 3 })]])))
      .toThrow(/no level 3/);
  });

  it("refuses a set with no level.0", () => {
    expect(() => buildSaveFile(new Map([[1, ascii("x")]]))).toThrow(/no level\.0/);
  });

  it("rejects a header whose save name is not a plausible path", () => {
    expect(() => buildSaveFile(new Map([
      [0, level0({ savename: "../../etc/passwd" })], [1, ascii("x")],
    ]))).toThrow(/implausible save name/);
  });

  it("rejects a truncated level.0 rather than building a partial save", () => {
    const short = level0().subarray(0, 20);
    expect(() => buildSaveFile(new Map([[0, short]]))).toThrow(/short of its|ends inside/);
  });
});

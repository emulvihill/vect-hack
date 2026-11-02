// Wasm ABI knowledge that src/modules/nethack/worker.ts and the node test drivers under
// scripts/test/ both need to decode or encode — shared so it lives in exactly
// one place. See worker.ts's decodeGlyph for the glyph_info layout, which only
// the worker touches and so stays there.
//
// ".ts" import extension: scripts/test/*.mjs load this file straight from
// source, and node's ESM resolver does not guess one (same as persist.ts).
import type { ExtCmd } from "./protocol.ts";

/** The slice of the emscripten module the decoders below need. */
export interface AbiModule {
  getValue: (ptr: number, type: string) => number;
  setValue: (ptr: number, value: number, type: string) => void;
  UTF8ToString: (ptr: number) => string;
  _malloc: (bytes: number) => number;
}

/* ext_func_tab layout on wasm32 (include/func_tab.h):
   0 key u8 | 4 ef_txt char* | 8 ef_desc char* | 12 ef_funct ptr |
   16 flags u32 | 20 f_text char* — stride 24, list ends at ef_txt == NULL */
export function decodeExtCmds(mod: AbiModule): ExtCmd[] {
  const base = (globalThis as Record<string, any>).nethackGlobal?.pointers?.extcmdlist as number | undefined;
  const cmds: ExtCmd[] = [];
  if (!base) return cmds;
  for (let p = base; ; p += 24) {
    const txt = mod.getValue(p + 4, "*");
    if (!txt) break;
    cmds.push({ name: mod.UTF8ToString(txt), desc: mod.UTF8ToString(mod.getValue(p + 8, "*")) });
  }
  return cmds;
}

/** One entry of the menu_item array shim_select_menu hands back to the engine. */
export interface MenuPick {
  identifier: number;
  count: number;
  itemflags: number;
}

/**
 * malloc a menu_item array (include/wintype.h's `struct mi`: an `anything`
 * union `item`, then `long count`, then `unsigned itemflags`) and write
 * `picks` into it. Returns the array pointer; the caller still owns writing
 * that pointer into the out-param.
 *
 * `anything` is 8 bytes wasm32-side, not 4: it has a_int64/a_uint64 members,
 * so its own size and 8-byte alignment carry into the struct — count sits at
 * offset 8, itemflags at offset 12, and the struct's stride is 16, not the
 * 12 an int-sized union would give. A shorter stride here under-allocates
 * and misaligns every entry from the second one on, which the engine then
 * reads out of bounds — in practice a wasm trap that crashes the tab on any
 * multi-item PICK_ANY pick (vect-hack pickup/drop menu hang report).
 */
export function writeMenuPicks(mod: AbiModule, picks: MenuPick[]): number {
  const STRIDE = 16;
  const arr = mod._malloc(picks.length * STRIDE);
  picks.forEach((p, i) => {
    const base = arr + i * STRIDE;
    // item is a union; only its low 4 bytes carry our int identifier, but
    // it's 8 bytes wide, so the high half must be zeroed rather than left
    // as malloc garbage.
    mod.setValue(base, p.identifier, "i32");
    mod.setValue(base + 4, 0, "i32");
    mod.setValue(base + 8, p.count, "i32");
    mod.setValue(base + 12, p.itemflags, "i32");
  });
  return arr;
}

/** The extra module surface describeScreenCell needs, on top of AbiModule. */
export interface DescribeAbiModule extends AbiModule {
  _free: (ptr: number) => void;
  /** do_screen_description(coord cc, boolean looked, int sym, char *out_str,
   *  const char **firstmatch, struct permonst **for_supplement) — src/pager.c.
   *  Added to the artifact's export list by scripts/build/build-nethack-wasm.sh. */
  _do_screen_description: (cc: number, looked: number, sym: number, out: number,
                           firstmatch: number, forSupplement: number) => number;
}

/** BUFSZ is 256 in NetHack; out_str is written but not shown in v1. */
const DESCRIBE_BUFSZ = 256;

/**
 * The engine's own name for the glyph at a map cell — the phrase autodescribe
 * itself shows ("dwarven valkyrie called player", "wall", "unexplored area").
 *
 * No windowport call on the normal path: the curs(), flush_screen() and
 * pline() live in its caller auto_describe(). That is what makes it callable
 * from a worker message handler while the engine sits Asyncify-suspended at
 * an input request (spec 2026-08-18, spike-verified). One defensive branch
 * escapes that — look_at_monster() can reach impossible(), which prints — so
 * the worker makes the call under the checkpointer's non-unwinding bridge
 * swap; see describeCell() in worker.ts.
 *
 * Nor is it free of engine state. The didlook: tail (pager.c:1590) calls
 * lookat(), which through object_from_map() may mksobj() a temporary object
 * for a remembered glyph that is no longer really there; mksobj() reaches
 * next_ident(), which is `svc.context.ident += rnd(2)` — the *game* RNG and
 * saved state (mkobj.c:521) — and lookat() sets t->tseen on a trap it names.
 * That cost is accepted, not worked around: NetHack's own autodescribe cursor
 * (auto_describe(), getpos.c:640) calls this same function once per cell it
 * is walked across, which is the rate a hover asks at. See the amended
 * read-only bullet in docs/specs/2026-08-18-look-hud-design.md.
 *
 * `coord` is two coordxy — int16_t (include/global.h) — so 4 bytes; clang's
 * wasm32 ABI passes that by-value struct as a pointer to a temp, which is why
 * this allocates one rather than passing two numbers. firstmatch is the
 * concise phrase; out_str is the long form, with a \G mixed-glyph escape and
 * the class phrase, and is deliberately not read here.
 */
export function describeScreenCell(
  mod: DescribeAbiModule, x: number, y: number,
): string | null {
  const cc = mod._malloc(4);
  const out = mod._malloc(DESCRIBE_BUFSZ);
  const firstmatch = mod._malloc(4);
  try {
    mod.setValue(cc, x, "i16");
    mod.setValue(cc + 2, y, "i16");
    mod.setValue(out, 0, "i8");
    mod.setValue(firstmatch, 0, "*");
    const found = mod._do_screen_description(cc, 1, 0, out, firstmatch, 0);
    if (!found) return null;
    const ptr = mod.getValue(firstmatch, "*");
    return ptr ? mod.UTF8ToString(ptr) || null : null;
  } finally {
    mod._free(cc);
    mod._free(out);
    mod._free(firstmatch);
  }
}

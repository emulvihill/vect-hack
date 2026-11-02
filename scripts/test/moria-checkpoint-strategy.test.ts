import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

describe("Moria checkpoint strategy", () => {
  it("uses the one inaccessible stock writer through one same-TU adapter", () => {
    const upstream = read("external/umoria/src/game_save.cpp");
    const adapter = read("src/modules/moria/native/game-save-wasm.cpp");
    const makefile = read("scripts/build/moria-wasm.mk");

    expect(upstream.match(/static bool saveChar\(/g)).toHaveLength(2);
    expect(adapter).toContain('#include "../../../../external/umoria/src/game_save.cpp"');
    expect(adapter.match(/saveChar\(/g)).toHaveLength(1);
    expect(makefile).toMatch(/filter-out[\s\S]*game_save\.cpp/);
    expect(makefile.match(/game-save-wasm\.cpp/g)).toHaveLength(1);
  });

  it("snapshots typed state and forbids a raw linear-memory rewind", () => {
    const checkpoint = read("src/modules/moria/native/checkpoint-wasm.cpp");
    for (const type of ["Game_t", "Player_t", "Dungeon_t", "Monster_t", "Store_t", "Recall_t"]) {
      expect(checkpoint).toContain(type);
    }
    for (const named of [
      "objects_identified", "messages", "next_free_monster_id",
      "monster_multiply_total", "message_ready_to_print", "screen_has_changed",
      "moriaTerminalCheckpointCapture", "moriaTerminalCheckpointRestore",
    ]) expect(checkpoint).toContain(named);
    expect(checkpoint).not.toMatch(/HEAPU8|emscripten_get_heap|memcpy\s*\([^,]*0\s*,/);
    expect(checkpoint).toMatch(/std::unique_ptr<LiveSnapshot>/);
    expect(checkpoint).not.toMatch(/LiveSnapshot\s+(?:snapshot|after)\s*\{/);
  });

  it("pins a tail-only cadence callback and post-restore durability yield", () => {
    const checkpoint = read("src/modules/moria/native/checkpoint-wasm.cpp");
    const ui = read("src/modules/moria/native/ui_io_wasm.cpp");
    const makefile = read("scripts/build/moria-wasm.mk");

    expect(ui).toMatch(/moriaCheckpointOuterCommandReturned\(\)/);
    expect(checkpoint).toMatch(/vectMoriaGameRunUpdateMonsters\(bool attack\)/);
    expect(checkpoint).toMatch(/updateMonsters\(attack\);/);
    expect(checkpoint.match(/const bool due = wasm_checkpoint_command\(\)/g)).toHaveLength(1);
    expect(checkpoint).toMatch(/moriaCheckpointRestore[\s\S]*wasm_checkpoint_landed\(\)/);
    expect(makefile).toContain("-DupdateMonsters=vectMoriaGameRunUpdateMonsters");
  });

  it("suppresses every checkpoint-only input and presentation callback", () => {
    const ui = read("src/modules/moria/native/ui_io_wasm.cpp");
    const semantic = read("src/modules/moria/native/semantic-wasm.cpp");
    expect(ui).toMatch(/void putQIO\(\)\s*\{[\s\S]*?if \(moriaCheckpointActive\(\)\) return;[\s\S]*?wasm_terminal_flush/);
    expect(ui).toMatch(/ssize_t terminalBellSound\(\)\s*\{[\s\S]*?if \(moriaCheckpointActive\(\)\) return 0;[\s\S]*?wasm_terminal_bell/);
    expect(ui).toMatch(/void flushInputBuffer\(\)\s*\{\s*if \(eof_flag != 0 \|\| moriaCheckpointActive\(\)\)/);
    expect(ui).toMatch(/bool checkForNonBlockingKeyPress\(int microseconds\)\s*\{\s*if \(moriaCheckpointActive\(\)\) return false;[\s\S]*?wasm_poll_key/);
    expect(semantic).toMatch(/void moriaSemanticFlush\(\)\s*\{\s*if \(checkpoint_active\) return;/);
    expect(semantic).toMatch(/void moriaSemanticMessage\(const char \*message\)\s*\{\s*if \(checkpoint_active\) return;/);
    expect(semantic).toMatch(/void moriaSemanticOverlayPush[\s\S]*?if \(checkpoint_active\) return;/);
    expect(semantic).toMatch(/void moriaSemanticOverlayPop[\s\S]*?if \(checkpoint_active\) return;/);
  });
});

// ?borg=<ms>: pacing for the built-in borg, by the engine's own knob.
//
// borg_think_dungeon() pauses once per borg move — "add a short pause to slow
// the borg down for viewing" (external/angband/src/borg/borg-think-dungeon.c:1237)
// — for borg_cfg[BORG_DELAY_FACTOR]² ms, read from user/borg.txt at activation
// (borg-init.c:81). That file lives in our persisted volume, so the delay is
// set by patching the line there before the borg starts, and it must be
// patched on EVERY ?borg run: a value written once would otherwise persist,
// and a later plain ?borg would inherit it instead of running unthrottled.
//
// The factor is the square root of the asked-for ms (the engine squares it),
// so the pace lands on the nearest perfect square: ?borg=250 runs at 256ms.

export const BORG_CONFIG_PATH = "/lib/user/borg.txt";

/** The Emscripten FS calls the patch needs, named structurally as usual. */
export interface BorgConfigFS {
  analyzePath(path: string): { exists: boolean };
  readFile(path: string, opts: { encoding: "utf8" }): string;
  writeFile(path: string, data: string): void;
}

export function borgDelayFactor(ms: number): number {
  return Math.round(Math.sqrt(Math.max(0, ms)));
}

/** The pause before each key the borg feeds a menu (inventory, store):
 *  the same pace a dungeon move actually runs at (factor², not the
 *  asked-for ms). borg.txt has no such knob — the borg never pauses
 *  in a menu — so main-wasm.c applies it itself, in front of inkey_hack. */
export function borgMenuDelayMs(ms: number): number {
  return borgDelayFactor(ms) ** 2;
}

/** borg.txt with its borg_delay_factor line set to `ms`'s factor — replaced
 *  wherever it already is (the parser takes leading spaces and any case,
 *  borg-init.c's borg_proc_setting), appended when the file never had one.
 *  Everything else in the file is the player's and stays untouched. */
export function withBorgDelay(text: string, ms: number): string {
  const line = `borg_delay_factor = ${borgDelayFactor(ms)}`;
  const existing = /^[ \t]*borg_delay_factor\b.*$/gim;
  if (existing.test(text)) return text.replace(existing, line);
  return `${text.length && !text.endsWith("\n") ? `${text}\n` : text}${line}\n`;
}

export function applyBorgDelay(fs: BorgConfigFS, ms: number): void {
  const current = fs.analyzePath(BORG_CONFIG_PATH).exists
    ? fs.readFile(BORG_CONFIG_PATH, { encoding: "utf8" })
    : "";
  fs.writeFile(BORG_CONFIG_PATH, withBorgDelay(current, ms));
}

// Layer 1 persistence (vect-hack-be3.5): loads a stored override, validates
// it, and merges it over DEFAULT_BINDINGS at startup — no editor UI (declined
// 2026-07-29). The override is produced by hand (devtools) or by a later
// bead; this module is the loading, validation, merging and persistence, full
// stop. Layer 2 (moveKeys.ts's resolve/resolveTarget) never enters into it:
// only which chord means which Action is user data, not what an Action does.
import { shadowsCommand } from "./keys";
import { CAMERA_ACTIONS, DEFAULT_BINDINGS, type Action } from "./moveKeys";

/** localStorage key for the override blob. View config, not game state —
 *  saves and scores go through persist.ts's per-tab IDBFS volume, this is a
 *  plain synchronous read/write beside it. Shared across every tab at this
 *  origin like any other localStorage key; test:nethack-tabs's isolation is about
 *  the worker/IDBFS mount, not this, so sharing it is fine as-is. */
const STORAGE_KEY = "vect-hack/keybindings";

/** Only the camera-relative actions: resolve() answers nothing else for a
 *  key, so a chord bound to a pointer action (attack, open, ...) would load
 *  cleanly and then silently do nothing — worse than a refusal, since the
 *  console report below is the only surface a bad entry ever shows on. */
const BINDABLE: ReadonlySet<string> = new Set(CAMERA_ACTIONS);

export interface OverrideIssue { chord: string; reason: string }

export interface ParsedOverride {
  bindings: Record<string, Action>;
  issues: OverrideIssue[];
}

/**
 * Validate a raw override (parsed JSON, or a hand-built object headed for
 * saveOverride) entry by entry. Three ways an entry is refused rather than
 * loaded: an action name outside the key-bindable set (CAMERA_ACTIONS, not a
 * copy that could drift from it), a pointer-only action no key press could
 * ever resolve, or a chord that shadows a bare NetHack command letter
 * (keys.ts's shadowsCommand). Everything else about a valid entry —
 * its chord string — is trusted verbatim, since chord() is the only thing
 * that ever produces or looks one up.
 */
export function parseOverride(raw: unknown): ParsedOverride {
  const bindings: Record<string, Action> = {};
  const issues: OverrideIssue[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push({ chord: "*", reason: "override is not a chord-to-action object" });
    return { bindings, issues };
  }
  for (const [chordStr, action] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof action !== "string" || !BINDABLE.has(action)) {
      issues.push({ chord: chordStr, reason: `not a key-bindable action: ${JSON.stringify(action)}` });
      continue;
    }
    if (shadowsCommand(chordStr)) {
      issues.push({ chord: chordStr, reason: "would shadow a NetHack command letter" });
      continue;
    }
    bindings[chordStr] = action as Action;
  }
  return { bindings, issues };
}

/**
 * Layer 1's merge: a validated override entry wins over the default at the
 * same chord, every other default passes through untouched, and the result
 * is the same flat Record<string, Action> shape as DEFAULT_BINDINGS either
 * way — the lookup downstream (VectorView's `bindings[chord(e)]`) can't tell
 * an override entry from a default one, by construction.
 */
export function mergeBindings(override: Record<string, Action>): Record<string, Action> {
  return { ...DEFAULT_BINDINGS, ...override };
}

/** Reads and validates the stored override, without merging it. Missing or
 *  corrupt storage reads back as no override at all, not a crash. */
export function loadOverride(): ParsedOverride {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return { bindings: {}, issues: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { bindings: {}, issues: [
      { chord: "*", reason: `stored override is not valid JSON: ${(e as Error).message}` },
    ] };
  }
  return parseOverride(parsed);
}

/**
 * Startup entry point: the merged table VectorView looks chords up in. Any
 * refused entry is reported to the console rather than silently dropped —
 * there is no editor UI to show it in (declined 2026-07-29), so the console
 * is the only place a bad override could ever be noticed.
 */
export function loadBindings(): Record<string, Action> {
  const { bindings, issues } = loadOverride();
  for (const issue of issues)
    console.warn(`[vect-hack] keybinding override for ${issue.chord} refused: ${issue.reason}`);
  return mergeBindings(bindings);
}

/**
 * Validates and persists an override so it survives a reload. Refused
 * entries are dropped rather than stored and handed back as issues for the
 * caller to report — there is no editor UI yet to show them in, but a test,
 * or a later bead, can.
 */
export function saveOverride(override: unknown): OverrideIssue[] {
  const { bindings, issues } = parseOverride(override);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  return issues;
}

/** Clears the stored override, restoring DEFAULT_BINDINGS on the next load. */
export function clearOverride(): void {
  localStorage.removeItem(STORAGE_KEY);
}

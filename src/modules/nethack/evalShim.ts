// NetHack's get_nhuuid() (sys/libnh/libnhmain.c:818) reaches JS through
// emscripten_run_script_int/_string, which the emscripten glue implements as
// `eval(UTF8ToString(ptr))`. The site serves `script-src 'self'
// 'wasm-unsafe-eval'` with no 'unsafe-eval', so that eval throws EvalError
// inside a wasm import, Asyncify swallows the throw, and the engine suspends
// forever — character creation finishes and the game then hangs at newgame
// with no output and no console error (found on the live vecthack.com deploy).
//
// Both scripts are compile-time string constants, so answer them natively and
// refuse anything else loudly: a future upstream eval must fail a test, not
// hang the tab. Widening the CSP instead would trade two constant strings for
// an 'unsafe-eval' hole across the whole site (docs/DECISIONS.md, vect-hack-efb).
//
// Split out of worker.ts so it is unit-testable without a worker or a wasm
// module (same reason as engineBoot.ts and wasmAbi.ts).

/** Every script the engine is known to eval, keyed by its exact source text. */
export const EVAL_TABLE: Record<string, () => unknown> = {
  "typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'":
    () => typeof crypto !== "undefined" && typeof crypto.randomUUID === "function",
  "crypto.randomUUID()": () => crypto.randomUUID(),
};

/** Answer a known script, or throw naming the one that was not expected. */
export function runKnownScript(script: string): unknown {
  // Own keys only: EVAL_TABLE["constructor"] is Object, inherited.
  const known = Object.hasOwn(EVAL_TABLE, script) ? EVAL_TABLE[script] : undefined;
  if (!known) throw new Error(`[vect-hack] blocked eval of unexpected script: ${script.slice(0, 100)}`);
  return known();
}

/**
 * Replace the global `eval` with the table above. Call before the emscripten
 * glue is imported: the glue's `eval` is a free identifier, so it resolves
 * through the scope chain to whatever `globalThis.eval` holds at call time.
 */
export function installEvalShim(): void {
  (globalThis as { eval: unknown }).eval = runKnownScript;
}

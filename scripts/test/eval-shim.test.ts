// The table's keys are the exact script text NetHack's get_nhuuid() hands to
// emscripten_run_script_int/_string (sys/libnh/libnhmain.c:818-822) — the C
// literal is split across two lines, and its concatenation is what arrives at
// eval(). A key that drifts from that text falls through to the throw below,
// which is the point: under the site CSP the alternative is an engine that
// suspends at newgame and never says why.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVAL_TABLE, installEvalShim, runKnownScript } from "../../src/modules/nethack/evalShim";

const DETECT = "typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** get_nhuuid()'s two call sites, re-read from the vendored NetHack source:
 *  the argument of each emscripten_run_script_* call, with C's adjacent-string
 *  concatenation performed. A test-local copy catches EVAL_TABLE drifting from
 *  the test, but not both of them drifting from the engine at a submodule bump
 *  — and the failure that would cause is an engine suspended at newgame with
 *  nothing said (vect-hack-8r0; the recover-save.test.ts pattern). */
function nethackScripts(): string[] {
  const src = readFileSync(
    new URL("../../external/NetHack/sys/libnh/libnhmain.c", import.meta.url), "utf8");
  const calls = [...src.matchAll(
    /emscripten_run_script_(?:int|string)\(\s*((?:"(?:[^"\\]|\\.)*"\s*)+)\)/g)];
  if (calls.length === 0) throw new Error("no emscripten_run_script_* call found");
  return calls.map(([, literal]) =>
    [...literal!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([, chunk]) => chunk).join(""));
}

describe("runKnownScript", () => {
  it("knows every script the vendored engine actually evaluates", () => {
    const scripts = nethackScripts();
    // Non-vacuous first: an empty or mangled parse would make the loop pass.
    expect(scripts).toContain(DETECT);
    expect(scripts).toContain("crypto.randomUUID()");
    for (const script of scripts) expect(EVAL_TABLE[script]).toBeTypeOf("function");
  });

  it("answers the crypto feature check the way a real eval would", () => {
    expect(EVAL_TABLE[DETECT]).toBeTypeOf("function");
    expect(runKnownScript(DETECT)).toBe(true);
    expect(Number(runKnownScript(DETECT))).toBe(1); // the glue does `|0` on it
  });

  it("answers crypto.randomUUID() with a fresh uuid string", () => {
    const uuid = runKnownScript("crypto.randomUUID()");
    expect(uuid).toBeTypeOf("string");
    expect(uuid).toMatch(UUID_RE);
    expect(uuid).not.toBe(runKnownScript("crypto.randomUUID()"));
  });

  it("throws on a script it does not know, naming it", () => {
    expect(() => runKnownScript("Module.doSomething()")).toThrow(/unexpected script: Module\.doSomething\(\)/);
  });

  it("throws on a name the table only inherits", () => {
    for (const script of ["constructor", "toString", "valueOf", "__proto__"])
      expect(() => runKnownScript(script)).toThrow(/unexpected script/);
  });

  it("throws rather than returning undefined on a near-miss key", () => {
    // Whitespace the C concatenation does not produce: a silent undefined here
    // would be the Asyncify hang all over again.
    expect(() => runKnownScript(DETECT.replace(" && ", "  && "))).toThrow();
  });
});

describe("installEvalShim", () => {
  it("routes the global eval through the table", () => {
    const original = globalThis.eval;
    try {
      installEvalShim();
      expect(globalThis.eval("crypto.randomUUID()")).toMatch(UUID_RE);
      expect(() => globalThis.eval("1 + 1")).toThrow(/blocked eval/);
    } finally {
      globalThis.eval = original;
    }
  });
});

// The control gate's own rule, tested where the gate itself cannot be: it
// needs a GPU and a dev server, so `npm test` never runs it and a race inside
// it is only ever found by running it twenty times (vect-hack-hfa).
//
// Two halves. `nethackArmed` is the readiness predicate, extracted the way
// moria-gate-utils.mjs extracted Moria's key accounting. The second half reads
// the gate script itself, because the acceptance criterion is a property of
// the text: no fixed sleep may stand in for a readiness wait anywhere in the
// NetHack arm. A predicate that is correct and never awaited would pass the
// first half and fail the gate exactly as before.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nethackArmed } from "../dev/fp-gate-utils.mjs";

const READY = { parked: true, queued: 0, pendingInput: "none", hero: { x: 4, y: 5 } };

describe("the NetHack arm's readiness predicate", () => {
  it("is armed only when the engine is parked on an idle command read", () => {
    expect(nethackArmed(READY)).toBe(true);
  });

  it("refuses while the engine is still resolving the last turn", () => {
    // The bead's red: the boot settle returned with the engine still talking,
    // so the mode message was overwritten and the first arrow was spent on
    // whatever came up rather than on turning.
    expect(nethackArmed({ ...READY, parked: false })).toBe(false);
  });

  it("refuses when the engine is waiting for an answer, not a command", () => {
    // A yn_function is a wait too, and TextHud does not consult `remap` there:
    // an arrow at "Really quit?" is a plain 'h'. Waiting for "parked" alone
    // would call that state ready.
    for (const pending of ["yesno", "menu", "line", "direction"]) {
      expect(nethackArmed({ ...READY, pendingInput: pending })).toBe(false);
    }
  });

  it("refuses when a key is buffered ahead of the read", () => {
    expect(nethackArmed({ ...READY, queued: 1 })).toBe(false);
  });

  it("only demands a hero when the caller asks for one", () => {
    expect(nethackArmed({ ...READY, hero: null })).toBe(true);
    expect(nethackArmed({ ...READY, hero: null }, true)).toBe(false);
  });

  it("refuses a view that answered nothing at all", () => {
    // Every field is undefined before __nhView exists, or if `hud` is ever
    // renamed out from under the gate's dev-only reach into it.
    expect(nethackArmed({})).toBe(false);
  });
});

describe("the NetHack arm of the control gate", () => {
  const source = readFileSync(new URL("../dev/fp-controls-check.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function nethackSection(");
  // The function body alone, to its closing brace in column 1 — not everything
  // up to angbandSection, which would sweep in the Angband helpers that sit
  // between them and whose polls legitimately sleep between asks.
  const end = source.indexOf("\n}\n", start);
  // Read once, loudly: a slice of nothing satisfies "no fixed sleep here" for
  // the wrong reason, which is the assertion that cannot fail this repo keeps
  // finding (AGENTS.md, vect-hack-azf).
  const arm = () => {
    if (start < 0 || end <= start) throw new Error("no nethackSection body to read");
    return source.slice(start, end);
  };

  it("has a NetHack section to read", () => {
    expect(arm().length).toBeGreaterThan(1000);
  });

  it("waits for a readiness condition and never for a fixed interval", () => {
    expect(arm()).toMatch(/nethackReady\(/);
    // The acceptance criterion, in the file: a sleep here is a guess at how
    // long the engine still has left to talk, and it was wrong about one run
    // in eight. Every other arm polls; this one now does too.
    expect(arm()).not.toMatch(/waitForTimeout/);
  });
});

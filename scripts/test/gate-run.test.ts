import { describe, expect, it } from "vitest";
import {
  GATES, appendProblem, buildSummary, notifiableFailures, parseGateArgs, pruneList,
  renderNodeProblem, splitGates, stampVerified, summaryLines, verdictOf,
} from "../dev/gate-run-utils.mjs";

type Gate = { name: string; npm: string; report: string | null; standalone: boolean };

describe("gate-run argument parsing", () => {
  it("runs every gate by default", () => {
    expect(parseGateArgs([]).gates.map((g: { name: string }) => g.name))
      .toEqual(["payload", "browser", "controls", "touch", "borg"]);
  });

  it("runs an --only subset in gate order, not command-line order", () => {
    expect(parseGateArgs(["--only", "borg,browser"]).gates.map((g: { name: string }) => g.name))
      .toEqual(["browser", "borg"]);
    expect(parseGateArgs(["--only", "touch"]).gates.map((g: { name: string }) => g.name))
      .toEqual(["touch"]);
    expect(parseGateArgs(["--only", "touch,browser"]).gates.map((g: { name: string }) => g.name))
      .toEqual(["browser", "touch"]);
  });

  // The two halves of vect-hack-qv1's acceptance, read off the parser rather
  // than off the runner: `--only payload` must be runnable on a machine that
  // can drive nothing else, and `--only browser` must not drag a 40s build in
  // behind it.
  it("selects payload alone, and never selects it for another gate's --only", () => {
    expect(parseGateArgs(["--only", "payload"]).gates.map((g: { name: string }) => g.name))
      .toEqual(["payload"]);
    expect(parseGateArgs(["--only", "browser"]).gates.map((g: { name: string }) => g.name))
      .toEqual(["browser"]);
  });

  // A misspelled gate that quietly ran the other two would be exactly the
  // silent under-run this runner exists to stop.
  it("refuses an unknown gate rather than running the rest", () => {
    expect(() => parseGateArgs(["--only", "brwoser"])).toThrow(/unknown gate: brwoser/);
    expect(() => parseGateArgs(["--only", ""])).toThrow(/named no gate/);
    expect(() => parseGateArgs(["--onlyy", "borg"])).toThrow(/usage:/);
  });

  // Refused here, not 25 minutes later: the line --stamp writes claims every
  // gate, so a partial run may never write it.
  it("refuses --stamp on a partial run, up front", () => {
    expect(() => parseGateArgs(["--stamp", "--only", "browser"], {}))
      .toThrow(/--stamp refuses a partial run/);
    expect(parseGateArgs(["--stamp"], {}).stamp).toBe(true);
    expect(parseGateArgs([], {}).stamp).toBe(false);
  });

  // The stamp claims THIS checkout was verified, and the summary beside it
  // records this checkout's sha — but with NH_URL set the gates drove a server
  // whose code this process never saw.
  it("refuses --stamp against a foreign server", () => {
    expect(() => parseGateArgs(["--stamp"], { NH_URL: "http://elsewhere:5199/" }))
      .toThrow(/--stamp refuses a run against NH_URL \(http:\/\/elsewhere:5199\/\)/);
    // ... and only for --stamp: a plain run against NH_URL is fine.
    expect(parseGateArgs([], { NH_URL: "http://elsewhere:5199/" }).gates).toHaveLength(GATES.length);
  });
});

describe("the freshness stamp", () => {
  const all = GATES as Gate[];
  const doc = [
    "## 1. The browser gates",
    "",
    "Last verified green: **2026-08-26**, ten arms — `check:payload` four Modules,",
    "`check:browser` on WebGPU and WebGL at 60fps plus the WebGL-fallback and no-GPU",
    "arms (`vect-hack-4d0`), `check:controls` 85 checks, `check:touch` 32 checks, and",
    "`check:angband-borg` 130s of play.",
    "",
  ].join("\n");

  it("rewrites the date and nothing else", () => {
    const out = stampVerified(doc, "2026-09-01", all);
    expect(out).toContain("Last verified green: **2026-09-01**, ten arms — `check:payload`");
    expect(out).toContain("arms (`vect-hack-4d0`), `check:controls` 85 checks");
    expect(stampVerified(out, "2026-09-01", all)).toBe(out);
  });

  // The classic failure of a pattern rewriter is matching nothing and
  // reporting success, which would leave the stamp "working" forever over a
  // file that had moved on.
  it("throws when the line it expects is gone", () => {
    expect(() => stampVerified("## 1. The browser gates\n\nnothing to stamp here\n", "2026-09-01", all))
      .toThrow(/no "Last verified green/);
    expect(() => stampVerified(doc, "last Tuesday", all)).toThrow(/must be YYYY-MM-DD/);
    expect(() => stampVerified(doc.replace("**2026-08-26**", "**2026-8-26**"), "2026-09-01", all))
      .toThrow(/no "Last verified green/);
  });

  // vect-hack-r1s, and the bug it was filed on: on 2026-08-26 the sentence
  // named three gates while the run drove four, and the stamp re-dated it
  // anyway. The refusal has to NAME the gate, or it just moves the puzzle.
  it("refuses when the sentence does not mention a gate the run drove", () => {
    const withoutTouch = doc.replace("`check:touch` 32 checks, and", "and");
    expect(() => stampVerified(withoutTouch, "2026-09-01", all))
      .toThrow(/does not mention.*check:touch/);
    expect(() => stampVerified(withoutTouch, "2026-09-01", all)).toThrow(/touch/);
    // The real 2026-08-26 shape: every GPU gate named, payload missing.
    const withoutPayload = doc.replace("`check:payload` four Modules,", "");
    expect(() => stampVerified(withoutPayload, "2026-09-01", all))
      .toThrow(/does not mention.*check:payload/);
  });

  // Only the gates this run actually drove. --stamp refuses a partial run up
  // front, so nothing reaches here with a short list today; the rule is still
  // "what ran must be named", not "every gate that exists".
  it("asks only about the gates it was given", () => {
    const withoutPayload = doc.replace("`check:payload` four Modules,", "");
    const gpuOnly = all.filter((g) => g.name !== "payload");
    expect(stampVerified(withoutPayload, "2026-09-01", gpuOnly))
      .toContain("Last verified green: **2026-09-01**");
  });

  // The sentence is the paragraph the line starts, and it ends at the blank
  // line. A gate named further down the file — in the command block, say, where
  // every gate name appears — is not a claim about the verified run.
  it("reads only the paragraph the line starts, not the rest of the file", () => {
    const elsewhere = doc.replace("`check:touch` 32 checks, and", "and")
      + "\nSee also `npm run check:touch`, the phone gate.\n";
    expect(() => stampVerified(elsewhere, "2026-09-01", all))
      .toThrow(/does not mention.*check:touch/);
  });

  // What this check CANNOT do, pinned so the next reader does not assume it
  // can: the counts are prose, and a stale one leaves every gate mentioned.
  // Only option B in vect-hack-r1s closes that, and B was not worth its price.
  it("does not notice a stale count", () => {
    expect(stampVerified(doc.replace("85 checks", "1 check"), "2026-09-01", all))
      .toContain("`check:controls` 1 check");
  });
});

describe("the run summary", () => {
  const green = [
    { name: "browser", ok: true, exitCode: 0, durationMs: 90000 },
    { name: "controls", ok: true, exitCode: 0, durationMs: 65000 },
  ];
  const base = {
    startedAt: "2026-08-26T03:30:00.000Z", endedAt: "2026-08-26T03:55:00.000Z",
    durationMs: 1500000, host: "devbox", gitSha: "deadbee", gitDirty: false,
    url: "http://localhost:5199/", server: { mode: "started", note: "" }, borgGateMs: 600000,
  };

  it("is green only when every gate that ran passed", () => {
    expect(verdictOf(green)).toBe("green");
    expect(verdictOf([...green, { name: "borg", ok: false, exitCode: 1, durationMs: 10 }])).toBe("red");
    expect(verdictOf([])).toBe("red");
  });

  // A run can now be both: payload drives on a machine whose GPU the other
  // gates never reach. A gate that RAN and failed is a fact about the code and
  // outranks "could not run", which is a fact about the machine — otherwise a
  // logged-out nightly would file a real payload regression under "told you
  // nothing" and exit 3.
  it("lets a real failure outrank could-not-run, and not the other way round", () => {
    const payloadRed = [{ name: "payload", ok: false, exitCode: 1, durationMs: 40000 }];
    const payloadGreen = [{ name: "payload", ok: true, exitCode: 0, durationMs: 40000 }];
    expect(verdictOf(payloadRed, "no render node")).toBe("red");
    expect(verdictOf(payloadGreen, "no render node")).toBe("could-not-run");
    expect(verdictOf([], "no render node")).toBe("could-not-run");
    expect(verdictOf(payloadGreen)).toBe("green");
  });

  // The third verdict is the point of the whole exercise: a reader has to be
  // able to tell a failure from a run that never reached a GPU.
  it("records could-not-run as its own verdict, outranking an empty gate list", () => {
    const s = buildSummary({ ...base, results: [], cannotRun: "no render node" });
    expect(s.verdict).toBe("could-not-run");
    expect(s.cannotRun).toBe("no render node");
    expect(s.gates).toEqual([]);
  });

  // The artifact must not contradict the exit code: a payload failure beside a
  // GPU the run never reached is a red run whose reason is also recorded.
  it("records a failed gate as red even when the rest could not run", () => {
    const s = buildSummary({
      ...base, cannotRun: "no render node",
      results: [{ name: "payload", ok: false, exitCode: 1, durationMs: 40000 }],
    });
    expect(s.verdict).toBe("red");
    expect(s.cannotRun).toBe("no render node");
    expect(s.gates[0]).toMatchObject({ name: "payload", ok: false });
  });

  // A harness failure is recorded beside the verdict and never instead of it:
  // the gates ran, and what they found still stands.
  it("carries a harness problem without touching the verdict", () => {
    const s = buildSummary({ ...base, results: green, harnessProblem: "the stamp failed: ENOSPC" });
    expect(s.verdict).toBe("green");
    expect(s.harnessProblem).toBe("the stamp failed: ENOSPC");
    expect(buildSummary({ ...base, results: green }).harnessProblem).toBeNull();
  });

  it("names each gate's log beside its exit code", () => {
    const s = buildSummary({ ...base, results: green });
    expect(s.verdict).toBe("green");
    expect(s.cannotRun).toBeNull();
    expect(s.gates[0]).toMatchObject({ name: "browser", ok: true, exitCode: 0, log: "browser.log" });
    expect(summaryLines(green)[0]).toMatch(/PASS {2}browser {4}1m30s {2}exit 0/);
  });
});

describe("artifact pruning", () => {
  // The names are timestamps, so lexical order is chronological — that is the
  // only reason this can work off a bare directory listing.
  const runs = ["20260824T033000Z", "20260826T033000Z", "20260825T033000Z"];

  it("deletes the oldest beyond the keep count", () => {
    expect(pruneList(runs, 2)).toEqual(["20260824T033000Z"]);
    expect(pruneList(runs, 20)).toEqual([]);
    expect(pruneList(runs, 0)).toEqual(["20260824T033000Z", "20260825T033000Z", "20260826T033000Z"]);
  });
});

describe("the render-node check", () => {
  const all = ["by-path", "card1", "renderD128"];

  it("passes when a render node is usable", () => {
    expect(renderNodeProblem(all, (n: string) => n === "renderD128")).toBeNull();
  });

  // This is the logged-out case: the node is still there, the seat ACL that
  // let this user open it is not.
  it("names the logged-out case when the node exists but cannot be opened", () => {
    expect(renderNodeProblem(all, () => false)).toMatch(/logind grants that access to the seat's active session/);
  });

  it("names the no-GPU case when there is no render node at all", () => {
    expect(renderNodeProblem(["by-path", "card1"], () => true)).toMatch(/no GPU for the gates to use/);
  });
});

describe("the gate table", () => {
  // The runner copies these three out of .preview/, which the next run
  // overwrites; a rename there must fail here rather than silently stop
  // keeping the report.
  it("names the JSON reports the gates write for themselves", () => {
    expect(GATES.map((g: { report: string | null }) => g.report))
      .toEqual([".preview/payload.json", ".preview/browser-check.json", null, null,
        ".preview/angband-borg-gate.json"]);
  });

  // The gate list is what `check:gates` and the nightly timer both drive, so a
  // gate that exists as an npm script and not here is a gate nobody runs —
  // which is the whole of vect-hack-hnw, and then of vect-hack-qv1. touch and
  // payload are named explicitly because each spent time being exactly that.
  it("drives every gate, touch and payload included", () => {
    expect(GATES.map((g: { name: string }) => g.name))
      .toEqual(["payload", "browser", "controls", "touch", "borg"]);
    expect(GATES.find((g: { name: string }) => g.name === "touch"))
      .toMatchObject({ script: "touch-check.mjs", npm: "check:touch" });
    expect(GATES.find((g: { name: string }) => g.name === "payload"))
      .toMatchObject({ script: "payload-check.mjs", npm: "check:payload" });
  });

  // The one property that makes payload a different animal: it builds and
  // serves its own page, so it needs neither the runner's dev server nor a
  // render node. Everything else does, and mislabelling one would either run a
  // GPU gate with no server (a red run for the wrong reason) or make payload
  // wait on a preflight it does not need (vect-hack-qv1's whole point).
  it("marks payload standalone and every GPU gate hosted", () => {
    const { standalone, hosted } = splitGates(GATES);
    expect(standalone.map((g: Gate) => g.name)).toEqual(["payload"]);
    expect(hosted.map((g: Gate) => g.name)).toEqual(["browser", "controls", "touch", "borg"]);
  });

  // payload is first for a reason, not by alphabet: it is the only gate that
  // can run before the preflight has decided whether the rest can, so a
  // logged-out machine still gets one real answer instead of exit 3 for
  // everything.
  it("puts the standalone gate ahead of the preflight, and borg last", () => {
    const order = (GATES as Gate[]).map((g) => g.name);
    expect(order[0]).toBe("payload");
    expect(order[order.length - 1]).toBe("borg");
  });

  it("splits a subset, and copes with a subset that is all of one kind", () => {
    expect(splitGates(GATES.filter((g: Gate) => g.name === "payload")).hosted).toEqual([]);
    expect(splitGates(GATES.filter((g: Gate) => g.name === "browser")).standalone).toEqual([]);
  });
});

describe("which failures reach a desktop notification", () => {
  const gate = (name: string, ok: boolean) => ({ name, ok, exitCode: ok ? 0 : 1, durationMs: 1000 });
  const names = (rs: { name: string }[]) => rs.map((r) => r.name);

  // The carve-out list itself, read off the real gate table rather than a
  // hand-written one. Every gate fails; only browser and controls may be named.
  //
  // What THIS test catches is a name ADDED to NOTIFYING_GATES: adding "borg" or
  // "touch" to that set reddens it, which is how it was checked. It does NOT
  // catch a NEW gate nobody decided about — notifiableFailures filters to the
  // set, so an undecided name is simply absent and this stays green. Checked
  // that way round too: an extra gate in GATES left this test passing, and
  // payload's arrival in vect-hack-qv1 confirmed it a second time.
  //
  // What forces that decision is "drives every gate" above, with the two
  // neighbours that also pin the name list. A new gate reddens the suite
  // there, and whoever fixes those tests has to come here and say which side of
  // the line the gate is on.
  it("is exactly browser and controls, however many gates there are", () => {
    const allRed = GATES.map((g: { name: string }) => gate(g.name, false));
    expect(names(notifiableFailures(allRed))).toEqual(["browser", "controls"]);
  });

  // A ten-minute unattended play session whose outcome is partly luck does not
  // get to wake anyone up. It still fails the run — that is the exit code's job,
  // not the notification's.
  it("never notifies for the borg gate alone", () => {
    expect(notifiableFailures([gate("browser", true), gate("controls", true), gate("borg", false)]))
      .toEqual([]);
  });

  // And touch is out for its own reason: it is deterministic, which normally
  // argues FOR notifying, but it watches a spike behind `?touch` with
  // vect-hack-21k and vect-hack-lxd still open against it. A gate on churning
  // code goes red for expected reasons, and that is what teaches an eye to
  // dismiss the notification that matters.
  it("never notifies for the touch gate alone", () => {
    expect(notifiableFailures([gate("browser", true), gate("controls", true), gate("touch", false)]))
      .toEqual([]);
    expect(notifiableFailures([gate("touch", false), gate("borg", false)])).toEqual([]);
  });

  // And payload is out for a third reason (vect-hack-qv1): it is deterministic
  // AND it watches settled code, so neither of the reasons above applies. It is
  // excluded on CONSEQUENCE — a chunk leak makes the download bigger, and
  // nobody is unable to play. The channel carries "the desktop client broke",
  // and a delivery regression is read in the summary the morning after.
  it("never notifies for the payload gate alone", () => {
    expect(notifiableFailures([gate("browser", true), gate("controls", true), gate("payload", false)]))
      .toEqual([]);
    expect(notifiableFailures([gate("payload", false), gate("touch", false), gate("borg", false)]))
      .toEqual([]);
  });

  it("notifies for browser or controls", () => {
    expect(names(notifiableFailures([gate("browser", false), gate("controls", true), gate("touch", true), gate("borg", true)])))
      .toEqual(["browser"]);
    expect(names(notifiableFailures([gate("browser", true), gate("controls", false), gate("touch", true), gate("borg", true)])))
      .toEqual(["controls"]);
  });

  // The one that is easy to get wrong: payload, touch and borg must not be
  // named just because something else already earned the notification. The body
  // the runner sends is summaryLines() over exactly these rows, so it is
  // checked here too.
  it("does not mention the log-only gates when they fail alongside one that does notify", () => {
    const all = notifiableFailures([
      gate("payload", false), gate("browser", true), gate("controls", false),
      gate("touch", false), gate("borg", false),
    ]);
    expect(names(all)).toEqual(["controls"]);
    const body = summaryLines(all).join("\n");
    expect(body).not.toContain("borg");
    expect(body).not.toContain("touch");
    expect(body).not.toContain("payload");
  });

  it("notifies nobody on a green run", () => {
    expect(notifiableFailures(GATES.map((g: Gate) => gate(g.name, true)))).toEqual([]);
  });
});

describe("a run that hits more than one harness problem", () => {
  const STAMP = 'the stamp failed: no "Last verified green" line to stamp';
  const PRUNE = "old runs could not be pruned under ~/.local/state/vect-hack/gates: EACCES";

  it("keeps both, in the order they happened", () => {
    let p: string | null = null;
    p = appendProblem(p, STAMP);
    p = appendProblem(p, PRUNE);
    expect(p).toBe(`${STAMP}; ${PRUNE}`);
  });

  it("starts from nothing without a stray separator", () => {
    expect(appendProblem(null, STAMP)).toBe(STAMP);
    expect(appendProblem("", STAMP)).toBe(STAMP);
  });

  // The one that matters: --stamp threw, then the prune failed. The prune used
  // never to write this slot at all, so overwriting it lost the stamp failure
  // to the console — and the console is not a channel for an unwatched run.
  it("carries both into summary.json, and neither touches the verdict", () => {
    const gates = [{ name: "browser", ok: true, exitCode: 0, durationMs: 1000 }];
    let p: string | null = null;
    p = appendProblem(p, STAMP);
    p = appendProblem(p, PRUNE);
    const s = buildSummary({
      startedAt: "2026-08-26T03:30:00.000Z", endedAt: "2026-08-26T03:31:00.000Z",
      durationMs: 60000, host: "devbox", gitSha: "deadbee", gitDirty: false,
      url: "http://localhost:5199/", server: { mode: "started", note: "" },
      borgGateMs: 600000, results: gates, harnessProblem: p,
    });
    expect(s.harnessProblem).toContain("the stamp failed");
    expect(s.harnessProblem).toContain("could not be pruned");
    expect(s.verdict).toBe("green");
  });
});

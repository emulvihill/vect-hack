// Re-ask a committed set of reflection transcripts under the CURRENT prompt,
// and report what changed about the kinds the model chooses.
//
// The reflect prompt is code, and a change to it is a behaviour change with no
// test that can see it: a unit test can pin the words, only a model can say
// whether the words route a lesson to the kind that acts on it. This is how
// that gets measured. Each transcript already holds the request it sent and the
// deltas that came back, so the old side of the comparison costs nothing and
// only the new side needs the model.
//
// It answers one question and not the other: whether a lesson lands on a kind
// the ladder reads. Whether acting on it is good play is the held-out A/B's
// question (scripts/dev/kb-ab-report.mjs) and nothing here bears on it.
//
// Written for vect-hack-b5f.6; see docs/reports/
// 2026-08-21-larn-note-routing.md for the run it was written to produce.
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runGrounds } from "../../src/bot/digest.ts";
import { applyDeltas, parseDeltaDocument } from "../../src/bot/factDelta.ts";
import { buildReflectPrompt } from "../../src/bot/reflect.ts";

const USAGE = `usage: reflect-prompt-probe.mjs --transcripts <dir> --out <file.jsonl>
       [--only <file with one run id per line>] [--url http://127.0.0.1:8090/v1]
       [--model qwen38-q5]

Appends one JSON line per run and skips ids already in --out, so a killed pass
resumes by being run again.`;

const { values: opts } = parseArgs({
  options: {
    transcripts: { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
    url: { type: "string", default: "http://127.0.0.1:8090/v1" },
    model: { type: "string", default: "qwen38-q5" },
  },
});
const die = (msg) => { console.error(msg); process.exit(2); };
if (!opts.transcripts || !opts.out) die(USAGE);

/** Larn's four downward exits, which its native tap all reports as
 *  TERRAIN_STAIRS (src/modules/larn/native/main-wasm.c:457-461).
 *
 *  This exists for one transitional reason and should be deleted with it: the
 *  Phase-1b transcripts were written before DescentTaken carried `category`,
 *  and their trajectories were never committed, so the category cannot be
 *  replayed and has to be reconstructed. A transcript written after b5f.6
 *  carries its own and never reaches this table. Anything not named here
 *  reconstructs to "", which grounds nothing — a guess would be worse than a
 *  missing subject. */
const RECONSTRUCT = { "%": "stairs", "^": "stairs", E: "stairs", V: "stairs", " ": "floor", ".": "floor" };

function post(url, body) {
  const target = new URL(`${url}/chat/completions`);
  return new Promise((resolve, reject) => {
    // No clock on it, and a fresh socket per call, for the reasons
    // scripts/dev/bot-reflect.mjs spells out: a local 27B answers one of these
    // in minutes, and llama-server hangs up between them.
    const req = httpRequest({
      hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`,
      method: "POST", headers: { "content-type": "application/json" }, agent: false,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.setTimeout(0);
    req.write(body);
    req.end();
  });
}

/** The digest, run id and event count a transcript's own request carries. */
function readTranscript(path) {
  const rec = JSON.parse(readFileSync(path, "utf8"));
  const user = rec.request.user;
  const digest = JSON.parse(user.slice(user.indexOf("{"), user.indexOf("\n\nRun block:")));
  return {
    digest,
    id: /trajectory: (\S+)/.exec(user)[1],
    events: Number(/events: (\d+)/.exec(user)[1]),
    before: rec.parse.deltas.map((d) => ({ op: d.op, claim: d.claim })),
  };
}

const only = opts.only
  ? new Set(readFileSync(opts.only, "utf8").trim().split("\n").map((s) => s.trim()).filter(Boolean))
  : null;
const done = new Set();
if (existsSync(opts.out)) {
  for (const line of readFileSync(opts.out, "utf8").trim().split("\n")) {
    if (line) done.add(JSON.parse(line).id);
  }
}

for (const name of readdirSync(opts.transcripts).filter((f) => f.endsWith(".json")).sort()) {
  const { digest, id, events, before } = readTranscript(join(opts.transcripts, name));
  if (done.has(id) || (only !== null && !only.has(id))) continue;

  digest.descents = digest.descents.map((d) => ({
    ...d,
    category: d.category
      ?? digest.finalTerrain.find((t) => t.ch === d.ch)?.category
      ?? RECONSTRUCT[d.ch] ?? "",
  }));
  if (digest.killer === undefined) digest.killer = null;

  const req = buildReflectPrompt(digest, [], id, events);
  const raw = await post(opts.url, JSON.stringify({
    model: opts.model, temperature: 0, seed: 7,
    messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
  }));
  let reply;
  try { reply = JSON.parse(raw).choices[0].message.content; } catch { reply = ""; }
  const parse = parseDeltaDocument(reply);
  const grounds = runGrounds(digest);
  // Through the real applier: what matters is the facts a batch would end up
  // with, not the deltas a model happened to type. A claim the gate rejects
  // changed nothing however well it was worded.
  const applied = applyDeltas([], parse.deltas, {
    engine: "larn", now: "1970-01-01T00:00:00Z",
    evidenceExists: (e) => e.trajectory === id && e.from >= 0 && e.from < e.to && e.to <= events,
    grounds,
  });

  const row = {
    id,
    exits: digest.descents.map((d) => `${d.category}:${d.ch}`),
    grounds,
    before,
    after: parse.deltas.map((d) => ({ op: d.op, claim: d.claim })),
    parseError: parse.error,
    facts: applied.facts.map((f) => f.id),
    rejected: applied.rejections.map((r) => r.reason),
  };
  appendFileSync(opts.out, JSON.stringify(row) + "\n");
  console.log(`${id}  before ${before.map((d) => d.claim.kind).join(",") || "-"}`
    + `  after ${row.after.map((d) => d.claim.kind).join(",") || "-"}`
    + `  facts ${row.facts.join(",") || "-"}`);
}
console.log("done");

// Reading one run's trajectory back, for the node hosts that need the whole
// event list at once (`buildLarnDigest` takes an array).
//
// **Never `gunzipSync(gz).toString("utf8")`.** A capped Larn run is 24000
// commands, and its trajectory decompresses to well past node's 512 MB string
// ceiling — the 2026-08-21 r3 training batch has one at 565 MB, 127945 lines —
// so that idiom throws ERR_STRING_TOO_LONG on exactly the longest games, after
// the caller has already spent hours on the shorter ones. Streaming a line at
// a time has no such ceiling; the parsed array of that run costs about 2 GB of
// heap, which is the real limit and is one a fold can avoid entirely.
//
// A consumer that only needs a running total should fold as the lines stream
// instead of collecting them — `scripts/dev/larn-engagement-report.mjs` does,
// and stays flat in memory.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

/** Every event of `path` (a `trajectory.jsonl.gz`), parsed, in file order. */
export async function readTrajectoryLines(path) {
  const lines = [];
  const rl = createInterface({
    input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity,
  });
  for await (const raw of rl) {
    if (raw) lines.push(JSON.parse(raw));
  }
  return lines;
}

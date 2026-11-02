// What every game's gym child shares (the child contract; see bot-gym.mjs):
// argument parsing, a synchronous line writer for the trajectory, and the
// summary.json writer. Synchronous on purpose — an engine's exit() path can
// end the process right after its quit callback, so nothing may be pending.
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";

/** --out <dir> --id <id> [--max-commands N] [--seed N] [--kb DIR|none];
 *  exits 2 on misuse. `kbDir` is null for "none" — the untaught seed bot,
 *  which is what a run gets unless the arm was named. */
export function childArgs(usage) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      id: { type: "string" },
      "max-commands": { type: "string", default: "3000" },
      seed: { type: "string", default: "0" },
      kb: { type: "string", default: "none" },
    },
  });
  if (!values.out || !values.id) {
    console.error(`usage: ${usage} --out <dir> --id <id> [--max-commands N] [--seed N] [--kb DIR|none]`);
    process.exit(2);
  }
  return {
    outDir: values.out, id: values.id,
    maxCommands: Number(values["max-commands"]),
    seed: Number(values.seed),
    kbDir: values.kb === "none" ? null : values.kb,
  };
}

/** Line writer over an fd with a 64 KB buffer flushed synchronously. */
export function openRunWriter(outDir) {
  mkdirSync(outDir, { recursive: true });
  const fd = openSync(`${outDir}/trajectory.jsonl`, "w");
  let buf = "";
  const flush = () => { if (buf) { writeSync(fd, buf); buf = ""; } };
  return {
    line(l) { buf += l + "\n"; if (buf.length >= 65536) flush(); },
    summary(obj) { writeFileSync(`${outDir}/summary.json`, JSON.stringify(obj, null, 2)); },
    close() { flush(); closeSync(fd); },
  };
}

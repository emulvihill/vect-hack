// A Module's engine tests as vitest tests: one test per `test:<game>-<name>`
// script in package.json, run in package.json order through `npm run`.
// package.json stays the one list of engine tests and of their time limits;
// each script carries its own `timeout N`, which kills a hung driver before
// vitest's own limit (N plus a grace period) fires.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const GRACE_SECONDS = 30;
const TAIL_LINES = 80;

export interface EngineScript {
  name: string;
  seconds: number;
}

export function engineScripts(game: string, scripts: Record<string, string>): EngineScript[] {
  const prefix = `test:${game}-`;
  return Object.entries(scripts)
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, command]) => {
      const limit = /^timeout (\d+) /.exec(command);
      if (!limit) throw new Error(`${name} has no \`timeout N\` prefix: "${command}"`);
      return { name, seconds: Number(limit[1]) };
    });
}

function run(script: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "--silent", script], { cwd: ROOT });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => chunks.push(b));
    child.stderr.on("data", (b: Buffer) => chunks.push(b));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output: Buffer.concat(chunks).toString("utf8") }));
  });
}

export function engineTests(game: string): void {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const scripts = engineScripts(game, pkg.scripts);
  if (scripts.length === 0) throw new Error(`package.json has no test:${game}-* scripts`);
  for (const { name, seconds } of scripts) {
    it(name, async () => {
      const { code, output } = await run(name);
      const tail = output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
      expect(code, `${name} exited ${code}; last ${TAIL_LINES} lines:\n${tail}`).toBe(0);
    }, (seconds + GRACE_SECONDS) * 1000);
  }
}

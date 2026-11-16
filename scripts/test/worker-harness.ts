// What the worker-entry tests share (nethack-worker, angband-worker,
// larn-worker, moria-worker-start): a stand-in for the emscripten artifact,
// the worker globals a worker script reads at import, and the two async
// helpers they all lean on. NOT a .test.ts file itself, so vitest does not
// collect it.
//
// A worker resolves its core through import.meta.env.BASE_URL, so the
// stand-in is a temp directory holding modules/<game>/<game>.js, one line that
// hands the emscripten options object to a global the test installs and then
// plays the runtime from.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, vi } from "vitest";

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((y, n) => { resolve = y; reject = n; });
  return { promise, resolve, reject };
}

/** One macrotask: every microtask queued before it has run. */
export const turn = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Write modules/<game>/<game>.js under a temp directory for the file's tests,
 * calling `globalThis[global](opts)`, and undo every stubbed global and env
 * after each test. Call at module level; `dir()` is the BASE_URL to point at.
 */
export function standInCore(game: string, global: string): { dir: () => string } {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), `vh-${game}-core-`));
    mkdirSync(join(dir, "modules", game), { recursive: true });
    writeFileSync(join(dir, "modules", game, `${game}.js`),
      `export default (opts) => globalThis.${global}(opts);\n`);
    return () => rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  return { dir: () => dir };
}

export type Posted<M> = { m: M; transfer: Transferable[] };

/**
 * Stub the globals a worker script reads at import — postMessage, self,
 * onmessage — and point BASE_URL at `baseDir`. Every post lands in `posted`
 * (with its transfer list) and in `messages`; every self listener in
 * `listeners`.
 */
export function stubWorkerScope<M>(baseDir: string) {
  const posted: Posted<M>[] = [];
  const messages: M[] = [];
  const listeners = new Map<string, (e: unknown) => void>();
  vi.stubGlobal("postMessage", (m: M, transfer: Transferable[]) => {
    posted.push({ m, transfer });
    messages.push(m);
  });
  vi.stubGlobal("self", {
    addEventListener: (t: string, fn: (e: unknown) => void) => void listeners.set(t, fn),
    location: { origin: "file://" },
  });
  vi.stubGlobal("onmessage", null);
  vi.stubEnv("BASE_URL", baseDir + "/");
  return { posted, messages, listeners };
}

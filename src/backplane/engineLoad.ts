// Loading a Module's engine artifact: the emscripten glue each worker imports
// from public/modules/<game>/ at boot (vect-hack-o3rc).
//
// An import that fails — the file is missing (the dev server 404s a missing
// /modules/ file) or the network dropped it — is not a death on the way in.
// The engine never ran and never read the volume, so the reset advice a boot
// fatal gets would send the player to delete a save that is fine. It travels
// as its own lifecycle message, naming the URL, and EngineSession words it.
//
// Every worker's boot failure goes through bootFailure() below, so the
// distinction is made once, here, rather than in four catch blocks.

/** The engine artifact at `url` could not be imported. The URL and not the
 *  exception: the worker built the URL itself, and it is the one thing the
 *  player (or whoever serves the page) can act on. */
export type EngineLoadFailed = { type: "engineLoadFailed"; url: string };

/** What a worker's import of its engine throws when the import failed. */
export class EngineLoadError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`could not load the engine from ${url}`);
    this.name = "EngineLoadError";
    this.url = url;
  }
}

/** Import the engine artifact at `url`. The browser's own reason goes to the
 *  console, never into a player-facing sentence; what is thrown carries only
 *  the URL. */
export async function importEngine<T>(url: string): Promise<T> {
  try {
    return (await import(/* @vite-ignore */ url)) as T;
  } catch (err) {
    console.warn(`[engine] import of ${url} failed:`, err);
    throw new EngineLoadError(url);
  }
}

/** The lifecycle message for a worker whose boot threw: engineLoadFailed for
 *  an engine that never arrived, an ordinary fatal for everything else. */
export function bootFailure(err: unknown): EngineLoadFailed | { type: "fatal"; message: string } {
  return err instanceof EngineLoadError
    ? { type: "engineLoadFailed", url: err.url }
    : { type: "fatal", message: String(err) };
}

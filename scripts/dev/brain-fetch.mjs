// The transport the reflect host talks to a local model over: one POST with no
// clock on it, and a bounded retry around the socket.
//
// **No clock.** Node's global fetch is undici, whose headers timeout is 300 s
// and cannot be raised without a dispatcher undici is not a dependency here to
// supply. A local 27B answers one reflection in roughly 90 s at the median and
// now and then takes longer than five minutes, so that ceiling ends a batch
// partway through for a reason that has nothing to do with reflection — as it
// did at run 45 of the first 1b training batch. The model is on the loopback
// and a batch is watched while it runs, so a genuine hang is visible without a
// timer inventing one.
//
// **Retry, and only around the socket.** A reflect pass is a five-hour job made
// of hundreds of independent calls, so any single dropped connection must not
// be able to end it (vect-hack-b5f.13, which lost 66 finished reflections to
// one eviction at run 67 of 200). untimedFetch rejects on a transport failure
// and resolves on everything the server actually answered, so wrapping it is
// what scopes the retry: a 4xx or a 5xx comes back as a value and stays the
// Brain's to reject. Retrying a request the server answered would turn a real
// refusal into four of them.
//
// Two socket failures are known here and they are different faults. The first
// is a keep-alive socket the server had already hung up on, which arrives as
// ECONNRESET before the request reaches the model at all — `agent: false`, a
// fresh socket per call, is the fix for that one. The second is llama-swap
// evicting the model mid-generation, which drops a connection that was being
// served; nothing can prevent it, and re-asking is the whole remedy, because
// the next request loads the model back.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Waits between attempts, and so also the attempt budget: four retries, a
 *  little over 50 s of patience in total. Long enough for llama-swap to load a
 *  27B back into VRAM, short enough that a server which is genuinely down
 *  fails the batch while someone is still watching it. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

/** One POST, no timeout, a fresh socket. Rejects only when the connection
 *  failed; any HTTP status the server sent resolves. */
export function untimedFetch(url, init) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = transport({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(0);
    if (init?.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** `fetchFn` with `delays.length` retries on a transport failure, waiting
 *  `delays[n]` before attempt n+1. The last error is rethrown once the budget
 *  is spent, so a server that is really gone still ends the pass. */
export function retryingFetch({
  fetchFn = untimedFetch,
  delays = RETRY_DELAYS_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.error,
} = {}) {
  return async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchFn(url, init);
      } catch (err) {
        if (attempt >= delays.length) throw err;
        const wait = delays[attempt];
        log(`brain transport error (${err?.code ?? err?.message ?? err}); retrying in ${wait / 1000}s — attempt ${attempt + 1} of ${delays.length}`);
        await sleep(wait);
      }
    }
  };
}

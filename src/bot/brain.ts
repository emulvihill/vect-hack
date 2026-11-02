// The Brain: one interface — a prompt in, a raw delta document out — and the
// two adapters that can live here (spec: 2026-08-19-bot-phase1b-larn-reflect-
// design.md, "The Brain"). The cloud adapter is a third, and it is in
// scripts/dev/brain-claude.mjs rather than beside these two, because of the
// filesystem rule below: it spawns the `claude -p` CLI, and the browser bot
// has neither a shell nor a temp directory to give it.
//
// Reflection sits off the measured path entirely: the evaluation arms read a
// static KB and call no model, so a weak provider costs time, never a result.
// What matters here instead is that a call is recordable, and that what it
// records is honest — hence `reflect` returning the model id that actually
// served the request rather than the one asked for. The caller writes prompt,
// model and raw reply beside the run; without that transcript the KB is an
// artifact nobody can rebuild or review, and the transcript is also what makes
// a killed pass resumable.
//
// Reproducibility is a property of that transcript, not of the sampler.
// `localBrain` pins what an OpenAI-compatible server offers — temperature 0
// and a fixed seed — and that is worth having, but it is belt and braces: the
// Claude adapter has no such control to set, and the loop is no less
// repeatable for it.
//
// `replayBrain` is what `npm test` uses: recorded replies keyed by run id, so
// the whole loop is exercised with no GPU and no network. It takes an object
// rather than a directory on purpose — see the filesystem rule below.
//
// NO FILESYSTEM ACCESS and no node imports: the browser bot shares this
// directory, so the caller reads the recordings and hands them in, and the
// HTTP adapter uses `fetch`, which node >= 18 and the browser both have.
//
// ".ts" import extension rule applies to this directory (see trajectory.ts).

export interface BrainRequest {
  system: string;
  user: string;
}

export interface Brain {
  /** `key` identifies the run being reflected on: it is what the replay
   *  adapter serves from, so a recording can never be served for the wrong
   *  run just because the calls happened in a different order. */
  reflect(key: string, req: BrainRequest): Promise<{ raw: string; model: string }>;
}

interface ChatCompletion {
  model?: unknown;
  choices?: { message?: { content?: unknown } }[];
}

export function localBrain(opts: { url: string; model: string; fetchFn?: typeof fetch }): Brain {
  const call = opts.fetchFn ?? fetch;
  const endpoint = `${opts.url}/chat/completions`;
  return {
    async reflect(_key, req) {
      const res = await call(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          temperature: 0,
          seed: 7,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`brain: ${endpoint} responded ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as ChatCompletion;
      const raw = body.choices?.[0]?.message?.content;
      if (typeof raw !== "string") {
        throw new Error(`brain: ${endpoint} returned no message content`);
      }
      // The served id, not the requested one: an alias that resolved to
      // something else has to be visible in the transcript.
      return { raw, model: typeof body.model === "string" ? body.model : opts.model };
    },
  };
}

export function replayBrain(responses: Record<string, string>): Brain {
  return {
    async reflect(key) {
      const raw = responses[key];
      // A missing recording is a broken fixture, not an empty reflection:
      // returning "[]" here would quietly turn it into a run that learned
      // nothing, which is exactly the failure a fixture test cannot see.
      if (raw === undefined) throw new Error(`replay: no recorded response for ${key}`);
      return { raw, model: "replay" };
    },
  };
}

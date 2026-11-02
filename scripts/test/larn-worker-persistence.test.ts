import { describe, expect, it, vi } from "vitest";
import type { PersistHandle } from "../../src/backplane/persistFs";
import { LarnPersistenceLifecycle } from "../../src/modules/larn/persistenceLifecycle";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

function handle(flush: () => Promise<void>) {
  return {
    ready: Promise.resolve(true), persistent: true, reason: null,
    flush: vi.fn(flush), release: vi.fn(), exportSave: vi.fn(),
  } as unknown as PersistHandle;
}

describe("Larn worker persistence lifecycle", () => {
  it("does not report quit until the landed save and final volume flush finish", async () => {
    const landed = deferred();
    const final = deferred();
    const persist = handle(vi.fn()
      .mockImplementationOnce(() => landed.promise)
      .mockImplementationOnce(() => final.promise));
    const lifecycle = new LarnPersistenceLifecycle(() => persist);

    lifecycle.saveLanded();
    const quit = lifecycle.quit(1);
    let settled = false;
    void quit.then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(persist.flush).toHaveBeenCalledTimes(1);
    landed.resolve();
    await turn();
    expect(settled).toBe(false);
    expect(persist.flush).toHaveBeenCalledTimes(2);
    final.resolve();

    await expect(quit).resolves.toEqual({
      type: "quit", saved: true, persistent: true, reason: null,
    });
  });

  it("never promises a saved quit when the landed flush fails", async () => {
    const persist = handle(vi.fn()
      .mockRejectedValueOnce(new Error("IDBFS failed"))
      .mockResolvedValueOnce(undefined));
    const lifecycle = new LarnPersistenceLifecycle(() => persist);

    lifecycle.saveLanded();

    await expect(lifecycle.quit(1)).resolves.toMatchObject({ saved: false });
  });

  it("waits for a background checkpoint and a final flush before releasing the lock", async () => {
    const checkpoint = deferred();
    const final = deferred();
    const persist = handle(vi.fn()
      .mockImplementationOnce(() => checkpoint.promise)
      .mockImplementationOnce(() => final.promise));
    const lifecycle = new LarnPersistenceLifecycle(() => persist);

    lifecycle.saveLanded();
    const released = lifecycle.release();
    await Promise.resolve();
    expect(persist.release).not.toHaveBeenCalled();

    checkpoint.resolve();
    await turn();
    expect(persist.flush).toHaveBeenCalledTimes(2);
    expect(persist.release).not.toHaveBeenCalled();

    final.resolve();
    await released;
    expect(persist.release).toHaveBeenCalledOnce();
  });

  it("still releases the lock when the final flush reports failure", async () => {
    const persist = handle(() => Promise.reject(new Error("IDBFS failed")));
    const lifecycle = new LarnPersistenceLifecycle(() => persist);

    await expect(lifecycle.release()).resolves.toBeUndefined();
    expect(persist.release).toHaveBeenCalledOnce();
  });

  it("closes input before release can yield to a late key and late save", async () => {
    const final = deferred();
    const persist = handle(() => final.promise);
    const lifecycle = new LarnPersistenceLifecycle(() => persist);
    let keyDelivered = false;

    const released = lifecycle.release();
    const accepted = lifecycle.deliverKey(() => {
      keyDelivered = true;
      // Model the resumed engine reaching a native save before its next key.
      lifecycle.saveLanded();
    });

    expect(accepted).toBe(false);
    expect(keyDelivered).toBe(false);
    await turn();
    expect(persist.flush).toHaveBeenCalledOnce();
    final.resolve();
    await released;
    expect(persist.release).toHaveBeenCalledOnce();
  });
});

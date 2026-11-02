import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestPersistentStorage,
  type StorageManagerLike,
} from "../../src/backplane/persistentStorage";

/** Every path reports its answer to the console and nothing else — the
 *  player-facing storage UI was cut from vect-hack-9tv — so each case silences
 *  the reporting channel it expects to use. */
const quiet = () => ({
  info: vi.spyOn(console, "info").mockImplementation(() => {}),
  warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
});

afterEach(() => vi.restoreAllMocks());

describe("requestPersistentStorage", () => {
  it("asks once when the origin is not yet persisted and reports the grant", async () => {
    const { info, warn } = quiet();
    const storage: StorageManagerLike = {
      persisted: vi.fn(async () => false),
      persist: vi.fn(async () => true),
    };

    await expect(requestPersistentStorage(storage)).resolves.toBe(true);
    expect(storage.persist).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]![0]).toContain("storage is persistent");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not ask an already-persisted origin again", async () => {
    quiet();
    const storage: StorageManagerLike = {
      persisted: vi.fn(async () => true),
      persist: vi.fn(async () => true),
    };

    await expect(requestPersistentStorage(storage)).resolves.toBe(true);
    // Idempotence is the whole point of the persisted() check: on Firefox a
    // second ask would be a second prompt for a grant already held.
    expect(storage.persist).not.toHaveBeenCalled();
  });

  it("reports a denied request without failing", async () => {
    const { warn } = quiet();

    await expect(requestPersistentStorage({
      persisted: async () => false,
      persist: async () => false,
    })).resolves.toBe(false);
    expect(warn.mock.calls[0]![0]).toContain("declined");
  });

  it("swallows a rejecting request", async () => {
    const { warn } = quiet();

    await expect(requestPersistentStorage({
      persisted: async () => false,
      persist: () => Promise.reject(new Error("SecurityError")),
    })).resolves.toBe(false);
    expect(warn.mock.calls[0]![1]).toEqual(new Error("SecurityError"));
  });

  it("reports a browser with no storage manager at all", async () => {
    const { warn } = quiet();

    // Older Safari, and any insecure context: navigator.storage is absent, so
    // there is nothing to call and boot must carry on regardless.
    await expect(requestPersistentStorage(null)).resolves.toBe(false);
    expect(warn.mock.calls[0]![0]).toContain("no storage manager");
  });

  it("finds no storage manager on a bare globalThis by default", async () => {
    quiet();
    expect((globalThis as { navigator?: { storage?: unknown } }).navigator?.storage)
      .toBeUndefined();

    await expect(requestPersistentStorage()).resolves.toBe(false);
  });
});

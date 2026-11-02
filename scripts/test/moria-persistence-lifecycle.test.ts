import { describe, expect, it, vi } from "vitest";
import {
  MoriaPersistenceLifecycle,
  type MoriaQuitState,
} from "../../src/modules/moria/persistenceLifecycle";
import type { MoriaCheckpoint } from "../../src/modules/moria/checkpoint";
import type { SessionOnlyReason } from "../../src/backplane/persistFs";
import type { MoriaPersistHandle } from "../../src/modules/moria/persist";

function handle(options: {
  persistent?: boolean;
  reason?: SessionOnlyReason | null;
  flush?: () => Promise<void>;
  recoveryPath?: string;
} = {}) {
  let released = false;
  const persist: MoriaPersistHandle = {
    ready: Promise.resolve(options.persistent ?? true),
    get persistent() { return released ? false : (options.persistent ?? true); },
    get reason() {
      return released
        ? { code: "another-tab" as const, detail: "released" }
        : (options.reason ?? null);
    },
    flush: vi.fn(options.flush ?? (() => Promise.resolve())),
    get checkpointRecoveryPath() { return options.recoveryPath ?? "/vect-moria/recover/checkpoint-1.sav"; },
    publishCheckpoint: vi.fn(),
    clearRecovery: vi.fn(),
    recordTerminal: vi.fn(),
    exportSave: () => { throw new Error("unused"); },
    release: vi.fn(() => { released = true; }),
  };
  return persist;
}

const saved: MoriaQuitState = { saved: true, persistent: true, reason: null };

function checkpoint(): MoriaCheckpoint {
  return { command: vi.fn(), due: vi.fn(() => true), landed: vi.fn() };
}

describe("Moria persistence lifecycle", () => {
  it("reports saved only after an explicit native save and owner flush", async () => {
    let finish!: () => void;
    const persist = handle({ flush: () => new Promise<void>((resolve) => { finish = resolve; }) });
    const lifecycle = new MoriaPersistenceLifecycle(() => persist);

    const result = lifecycle.beforeExit(1);
    expect(lifecycle.closing).toBe(true);
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await expect(result).resolves.toEqual(saved);
  });

  it("flushes ordinary death/quit score writes without calling the run saved", async () => {
    const persist = handle();
    const lifecycle = new MoriaPersistenceLifecycle(() => persist);
    await expect(lifecycle.beforeExit(2)).resolves.toEqual({
      saved: false, persistent: true, reason: null,
    });
    expect(persist.flush).toHaveBeenCalledOnce();
    expect(persist.recordTerminal).toHaveBeenCalledOnce();
  });

  it("never reports a session-only native save as durable", async () => {
    const persist = handle({
      persistent: false,
      reason: { code: "another-tab", detail: "another tab is playing" },
    });
    const lifecycle = new MoriaPersistenceLifecycle(() => persist);
    // The quit message carries the developer detail, never the code: it is a
    // diagnostic field, and the player-facing half of the session-only state
    // is the Backplane's own banner message (vect-hack-dem).
    await expect(lifecycle.beforeExit(1)).resolves.toEqual({
      saved: false, persistent: false, reason: "another tab is playing",
    });
  });

  it("turns strict flush failure into a truthful resolved quit", async () => {
    const persist = handle({ flush: () => Promise.reject(new Error("IDB transaction failed")) });
    const lifecycle = new MoriaPersistenceLifecycle(() => persist);
    await expect(lifecycle.beforeExit(1)).resolves.toEqual({
      saved: false,
      persistent: true,
      reason: "could not persist the Moria volume: Error: IDB transaction failed",
    });
  });

  it("shares exactly one flush across duplicate exit and concurrent release", async () => {
    let finish!: () => void;
    const persist = handle({ flush: () => new Promise<void>((resolve) => { finish = resolve; }) });
    const lifecycle = new MoriaPersistenceLifecycle(() => persist);

    const first = lifecycle.beforeExit(1);
    const duplicate = lifecycle.beforeExit(1);
    const release = lifecycle.release();
    await Promise.resolve();
    expect(persist.flush).toHaveBeenCalledOnce();
    expect(persist.release).not.toHaveBeenCalled();
    finish();

    await expect(first).resolves.toEqual(saved);
    await expect(duplicate).resolves.toEqual(saved);
    await release;
    expect(persist.release).toHaveBeenCalledOnce();
  });

  it("closes synchronously and still releases the lock after a release-only flush failure", async () => {
    const persist = handle({ flush: () => Promise.reject(new Error("sync failed")) });
    const lifecycle = new MoriaPersistenceLifecycle(() => persist);
    const release = lifecycle.release();
    expect(lifecycle.closing).toBe(true);
    await expect(release).resolves.toBeUndefined();
    expect(persist.release).toHaveBeenCalledOnce();
  });

  it("rejects late key delivery after either finalization path starts", async () => {
    const persist = handle();
    const lifecycle = new MoriaPersistenceLifecycle(() => persist);
    const deliver = vi.fn();
    expect(lifecycle.deliverKey(deliver)).toBe(true);
    void lifecycle.beforeExit(0);
    expect(lifecycle.deliverKey(deliver)).toBe(false);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("advances cadence exactly once only for the live writer and exposes validated recovery", () => {
    const persist = handle({ recoveryPath: "/vect-moria/recover/checkpoint-8.sav" });
    const cadence = checkpoint();
    const lifecycle = new MoriaPersistenceLifecycle(() => persist, cadence);
    expect(lifecycle.checkpointCommand()).toBe(true);
    expect(cadence.command).toHaveBeenCalledOnce();
    expect(cadence.due).toHaveBeenCalledOnce();
    expect(lifecycle.checkpointRecoveryPath()).toBe("/vect-moria/recover/checkpoint-8.sav");

    const loser = handle({ persistent: false });
    const loserCadence = checkpoint();
    const sessionOnly = new MoriaPersistenceLifecycle(() => loser, loserCadence);
    expect(sessionOnly.checkpointCommand()).toBe(false);
    expect(sessionOnly.checkpointRecoveryPath()).toBe("");
    expect(loserCadence.command).not.toHaveBeenCalled();
  });

  it("publishes synchronously, lands cadence only after a successful strict flush", async () => {
    let finish!: () => void;
    const persist = handle({ flush: () => new Promise<void>((resolve) => { finish = resolve; }) });
    const cadence = checkpoint();
    const lifecycle = new MoriaPersistenceLifecycle(() => persist, cadence);
    const landed = lifecycle.checkpointLanded();
    expect(persist.publishCheckpoint).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(persist.flush).toHaveBeenCalledOnce();
    expect(cadence.landed).not.toHaveBeenCalled();
    finish();
    await expect(landed).resolves.toBe(true);
    expect(cadence.landed).toHaveBeenCalledOnce();

    const failedPersist = handle({ flush: () => Promise.reject(new Error("no IDB")) });
    const failedCadence = checkpoint();
    const failed = new MoriaPersistenceLifecycle(() => failedPersist, failedCadence);
    await expect(failed.checkpointLanded()).resolves.toBe(false);
    expect(failedCadence.landed).not.toHaveBeenCalled();
  });

  it("serializes an in-flight checkpoint before explicit-save cleanup and final flush", async () => {
    const order: string[] = [];
    let finishCheckpoint!: () => void;
    let calls = 0;
    const persist = handle({ flush: () => {
      calls += 1;
      order.push(`flush-${calls}`);
      return calls === 1
        ? new Promise<void>((resolve) => { finishCheckpoint = resolve; })
        : Promise.resolve();
    } });
    vi.mocked(persist.publishCheckpoint).mockImplementation(() => order.push("publish"));
    vi.mocked(persist.clearRecovery).mockImplementation(() => order.push("clear"));
    const lifecycle = new MoriaPersistenceLifecycle(() => persist, checkpoint());
    const landed = lifecycle.checkpointLanded();
    const quit = lifecycle.beforeExit(1);
    await Promise.resolve();
    expect(order).toEqual(["publish", "flush-1"]);
    finishCheckpoint();
    await expect(landed).resolves.toBe(true);
    await expect(quit).resolves.toEqual(saved);
    expect(order).toEqual(["publish", "flush-1", "clear", "flush-2"]);
  });

  it("parks release behind an in-flight landing and forbids publication after handoff", async () => {
    let finishCheckpoint!: () => void;
    let flushes = 0;
    const persist = handle({ flush: () => {
      flushes += 1;
      return flushes === 1
        ? new Promise<void>((resolve) => { finishCheckpoint = resolve; })
        : Promise.resolve();
    } });
    const cadence = checkpoint();
    const lifecycle = new MoriaPersistenceLifecycle(() => persist, cadence);

    const landed = lifecycle.checkpointLanded();
    await Promise.resolve();
    expect(persist.publishCheckpoint).toHaveBeenCalledOnce();
    expect(persist.flush).toHaveBeenCalledOnce();

    const release = lifecycle.release();
    expect(lifecycle.closing).toBe(true);
    expect(persist.release).not.toHaveBeenCalled();
    expect(persist.publishCheckpoint).toHaveBeenCalledOnce();

    finishCheckpoint();
    await expect(landed).resolves.toBe(true);
    await release;
    expect(persist.flush).toHaveBeenCalledTimes(2);
    expect(persist.release).toHaveBeenCalledOnce();

    expect(lifecycle.checkpointCommand()).toBe(false);
    await expect(lifecycle.checkpointLanded()).resolves.toBe(false);
    expect(persist.publishCheckpoint).toHaveBeenCalledOnce();
  });
});

import {
  MORIA_FRAME_BYTES,
  type MoriaInputContext,
  type MoriaInputResult,
  type MoriaMainToWorker,
  type MoriaWorkerToMain,
} from "./protocol";
import type { MoriaExitOutcome } from "./persistenceLifecycle";

export interface MoriaNativeKeyRequest {
  blocking: boolean;
  context: MoriaInputContext;
  roguelike: boolean;
  delayMicroseconds: number;
}

export type MoriaWorkerPost = (
  message: MoriaWorkerToMain,
  transfer?: Transferable[],
) => void;

export interface MoriaWorkerBridgeOptions {
  delay?: (milliseconds: number) => Promise<void>;
  release?: () => void | Promise<void>;
  beforeExit?: (status: number, outcome: MoriaExitOutcome) => void | Promise<void>;
}

interface PendingInput {
  id: number;
  promise: Promise<MoriaInputResult>;
  resolve: (result: MoriaInputResult) => void;
  reject: (error: unknown) => void;
}

const timerTask = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const parkedInput = (): Promise<never> => new Promise(() => {});

/**
 * Owns the JS half of Moria's native callbacks. The core has one Asyncify
 * suspension point at a time, so keeping exactly one resolver makes a reply
 * incapable of answering a later request by accident.
 */
export class MoriaWorkerBridge {
  private nextId = 1;
  private pending: PendingInput | null = null;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly releaseHook: () => void | Promise<void>;
  private readonly beforeExitHook: (
    status: number,
    outcome: MoriaExitOutcome,
  ) => void | Promise<void>;
  private releasePromise: Promise<void> | null = null;
  closing = false;

  constructor(
    private readonly post: MoriaWorkerPost,
    options: MoriaWorkerBridgeOptions = {},
  ) {
    this.delay = options.delay ?? timerTask;
    this.releaseHook = options.release ?? (() => {});
    this.beforeExitHook = options.beforeExit ?? (() => {});
  }

  terminalFlush = (cells: Uint8Array, y: number, x: number): void => {
    if (cells.byteLength !== MORIA_FRAME_BYTES) {
      throw new Error(
        `Moria terminal flush must contain exactly 1,920 bytes, got ${cells.byteLength}`,
      );
    }
    const copy = Uint8Array.from(cells);
    this.post(
      { type: "event", ev: { name: "frame", cells: copy, x, y } },
      [copy.buffer],
    );
  };

  terminalBell = (): void => {
    this.post({ type: "event", ev: { name: "bell" } });
  };

  getKeyInput = (request: MoriaNativeKeyRequest): Promise<MoriaInputResult> => {
    if (this.closing) return parkedInput();
    if (this.pending !== null) {
      return Promise.reject(new Error(
        `Moria input request ${this.pending.id} is already outstanding`,
      ));
    }

    let resolve!: (result: MoriaInputResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<MoriaInputResult>((resolveInput, rejectInput) => {
      resolve = resolveInput;
      reject = rejectInput;
    });
    const pending: PendingInput = { id: this.nextId++, promise, resolve, reject };
    this.pending = pending;

    return this.postInputAfterDelay(pending, request);
  };

  beforeExit = async (status: number, outcome: MoriaExitOutcome): Promise<void> => {
    await this.beforeExitHook(status, outcome);
  };

  handleMessage(message: MoriaMainToWorker): boolean | Promise<void> {
    if (message.type === "release") return this.release();
    if (message.type !== "key") return false;
    if (this.closing || this.pending === null || message.id !== this.pending.id) {
      return false;
    }
    const pending = this.pending;
    this.pending = null;
    pending.resolve(message.result);
    return true;
  }

  private async postInputAfterDelay(
    pending: PendingInput,
    request: MoriaNativeKeyRequest,
  ): Promise<MoriaInputResult> {
    try {
      if (!request.blocking) {
        await this.delay(request.delayMicroseconds / 1_000);
      }
      if (this.closing) return pending.promise;
      this.post({
        type: "getKey",
        id: pending.id,
        wait: request.blocking,
        context: request.context,
        mode: request.roguelike ? "roguelike" : "original",
        delayMicroseconds: request.delayMicroseconds,
      });
    } catch (error) {
      // Release deliberately strands the native read until the Worker is
      // terminated. A timer that loses that race must not turn closure into
      // an input exception (or, worse, an EOF-shaped engine transition).
      if (this.closing) return pending.promise;
      if (this.pending === pending) this.pending = null;
      pending.reject(error);
    }
    return pending.promise;
  }

  private release(): Promise<void> {
    this.closing = true;
    if (this.releasePromise === null) {
      this.releasePromise = (async () => {
        await this.releaseHook();
        this.post({ type: "released" });
      })();
    }
    return this.releasePromise;
  }
}

// Getting a packed save from the worker that owns the volume to the main
// thread that can hand it to the player.
//
// The volume is mounted in the *engine worker's* Emscripten FS — the main
// thread has no path to it — so an export is a round trip, and the bytes come
// back transferred rather than copied. Nothing here is game-specific: every
// Module includes these two messages in its protocol union, EngineSession
// routes the reply, and every worker answers through the one helper below —
// which is the whole reason it lives in the Backplane.

/** A worker that never answers must not leave a spinning UI. Generous: packing
 *  is synchronous, but it queues behind whatever the engine is doing. */
const EXPORT_TIMEOUT_MS = 15_000;

export interface ExportedSave {
  bytes: Uint8Array;
  filename: string;
}

export type SaveExportRequest = { type: "exportSave"; id: number };

export type SaveExportReply =
  | { type: "saveBlob"; id: number; ok: true; bytes: Uint8Array; filename: string }
  | { type: "saveBlob"; id: number; ok: false; message: string };

/**
 * Main-thread half: one table of in-flight exports, settled by the worker's
 * replies. Ids are per-table, so no two Modules ever collide.
 */
export class SaveExports {
  private nextId = 1;
  private pending = new Map<number, {
    resolve(save: ExportedSave): void;
    reject(err: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  request(send: (msg: SaveExportRequest) => void): Promise<ExportedSave> {
    const id = this.nextId++;
    return new Promise<ExportedSave>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(id, "the engine did not answer the export in time"),
        EXPORT_TIMEOUT_MS,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        send({ type: "exportSave", id });
      } catch (err) {
        // A dead worker throws here rather than staying silent; settle now.
        this.fail(id, `the export could not be sent: ${String(err)}`);
      }
    });
  }

  /** Settle from a worker reply. An id we do not know is one we already timed
   *  out or failed — dropping it is right, and it must not throw. */
  settle(msg: SaveExportReply): void {
    const waiter = this.take(msg.id);
    if (!waiter) return;
    if (msg.ok) waiter.resolve({ bytes: msg.bytes, filename: msg.filename });
    else waiter.reject(new Error(msg.message));
  }

  private fail(id: number, message: string): void {
    this.take(id)?.reject(new Error(message));
  }

  private take(id: number) {
    const waiter = this.pending.get(id);
    if (!waiter) return undefined;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    return waiter;
  }
}

/**
 * Worker half: answer one export request from the volume handle. Failures
 * become a reply rather than an exception, because the caller is a message
 * handler — throwing there loses the request and leaves the main thread
 * waiting out the timeout for a failure that is already known. That includes
 * a handle that does not exist yet: an F3 during engine boot.
 *
 * Synchronous by design, and safe to be: it runs while the engine is parked
 * on its suspend point, so the volume is not being written and no suspend
 * point of its own is needed. The reply's bytes are transferred, not copied.
 */
export function answerExportRequest(
  id: number,
  persist: { exportSave(now: Date): ExportedSave } | undefined,
  post: (msg: SaveExportReply, transfer: Transferable[]) => void,
): void {
  try {
    if (!persist) throw new Error("storage is still starting up");
    const save = persist.exportSave(new Date());
    post(
      { type: "saveBlob", id, ok: true, bytes: save.bytes, filename: save.filename },
      [save.bytes.buffer as ArrayBuffer],
    );
  } catch (err) {
    post(
      { type: "saveBlob", id, ok: false, message: err instanceof Error ? err.message : String(err) },
      [],
    );
  }
}

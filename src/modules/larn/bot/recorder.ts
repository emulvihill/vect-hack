// A LarnHandler decorator that writes every event the engine showed and
// every key the wrapped handler answered to a TrajectoryLog. Wrap the
// LarnBotPlayer, not the view: the bot answers keys itself, so a recorder
// inside it would miss them. An event is recorded before it is forwarded, so
// the one that made the bot throw is still in the trajectory; a key is
// recorded after, because its reply is what there is to record.
//
// ".ts" import extensions: the headless gym loads this straight from source.
import type { LarnEvent, LarnKey } from "../protocol.ts";
import type { LarnHandler } from "../session.ts";
import { TrajectoryLog } from "../../../bot/trajectory.ts";

export class LarnRecorder implements LarnHandler {
  readonly log: TrajectoryLog;
  private inner: LarnHandler;

  constructor(inner: LarnHandler, sink: (line: string) => void) {
    this.inner = inner;
    this.log = new TrajectoryLog(sink);
  }

  onReady(): void { this.inner.onReady?.(); }
  onNotice(text: string): void { this.inner.onNotice(text); }

  handle(ev: LarnEvent): void {
    this.log.record(ev.name, ev, null);
    this.inner.handle(ev);
  }

  async nextKey(wait: boolean, cmd: boolean): Promise<LarnKey | null> {
    const key = await this.inner.nextKey(wait, cmd);
    this.log.record("getKey", { wait, cmd }, key);
    return key;
  }
}

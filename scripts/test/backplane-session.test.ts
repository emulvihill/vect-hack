// EngineSession: the shared worker-session mechanism, tested over a fake
// worker and a toy message vocabulary. The two intended behavioral deltas of
// the Backplane extraction live here and ONLY here (backplane design):
//   vect-hack-1g5 — an engine fatal becomes an on-screen notice.
//   vect-hack-c1w — a throwing dispatch posts the delegate's cancel-shaped
//                   fallback instead of stranding the Asyncify-suspended
//                   engine, and the player is told.
// The Module delegates' fallback tables get their own cases appended here
// as each Module conforms (NetHack in the wave-1 session task, Angband in
// wave 2) — and, where a delegate can be reached without spawning a real
// Worker, its own behavior too: the mechanism is only half the contract.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineSession, onSessionOnly, type LifecycleToMain, type SessionDelegate,
} from "../../src/backplane/session";
import { VOLUMES } from "../../src/backplane/volumes";
import {
  fallbackValue, makeDelegate as makeNetHackDelegate, type ShimReply,
} from "../../src/modules/nethack/session";
import type { ShimEvent } from "../../src/modules/nethack/protocol";
import {
  AngbandSession, angbandFallback, makeDelegate as makeAngbandDelegate,
} from "../../src/modules/angband/session";
import {
  KC_ESCAPE,
  type AngbandEvent, type AngbandMainToWorker, type AngbandWorkerToMain,
} from "../../src/modules/angband/protocol";

type ToyIn =
  | { type: "ping"; id: number }
  | { type: "boom"; id: number }
  | { type: "hush" }            // dispatched, but owes no reply
  | LifecycleToMain;
type ToyOut = { type: "pong"; id: number };

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { this.terminated = true; }
  emit(data: ToyIn) { this.onmessage?.({ data }); }
}

// Node has no ErrorEvent constructor; the browser's is an Event carrying
// message/filename/lineno, which is all EngineSession reads.
const errorEvent = (message: string, filename = "", lineno = 0) =>
  Object.assign(new Event("error"), { message, filename, lineno }) as unknown as ErrorEvent;

function harness(opts: { noticeThrows?: boolean } = {}) {
  const worker = new FakeWorker();
  const notices: string[] = [];
  // Every message the session handed the delegate. The routing tests below
  // need this rather than `worker.posted`: the toy delegate answers an
  // unknown type with null, so a Backplane reply that leaked through to
  // dispatch() would post nothing either and an empty `posted` would prove
  // nothing (vect-hack-azf).
  const dispatched: ToyIn[] = [];
  const delegate: SessionDelegate<ToyIn, ToyOut> = {
    onNotice: (text) => {
      // The real onNotice reaches DOM mutation via TextHud.message.
      if (opts.noticeThrows) throw new Error("notice renderer exploded");
      notices.push(text);
    },
    fatalNotice: (message) => `engine died: ${message}`,
    dispatch: async (msg) => {
      dispatched.push(msg);
      if (msg.type === "ping") return { type: "pong", id: msg.id };
      if (msg.type === "boom") throw new Error("view exploded");
      return null;
    },
    fallback: (msg) => ("id" in msg ? { type: "pong", id: -msg.id } : null),
  };
  const session = new EngineSession<ToyIn, ToyOut>(worker as unknown as Worker, delegate);
  return { worker, notices, dispatched, session };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** What a death on the way in adds to the Module's own wording
 *  (vect-hack-60i). Written once here so the death-routing tests stay about
 *  routing, and pinned as a rule of its own below. */
const BOOT_ADVICE = " If it dies again on the way in, the stored save may be the cause:"
  + " the Saves button can delete it.";

describe("EngineSession", () => {
  // The session-only listener is page-wide, because a page has one banner and
  // one engine. Put it back to a no-op after every case so one test's listener
  // cannot outlive it.
  afterEach(() => onSessionOnly(() => {}));

  it("routes notice to the delegate", async () => {
    const { worker, notices } = harness();
    worker.emit({ type: "notice", text: "saving is off" });
    await flush();
    expect(notices).toEqual(["saving is off"]);
  });

  // vect-hack-dem. The delegate is the message strip, and the strip is where
  // this warning used to scroll away behind the engine's own opening messages,
  // so `sessionOnly` deliberately goes somewhere else: a page-wide listener
  // main.ts registers, which draws a banner and marks the Saves button.
  it("routes sessionOnly to the page listener and never to the delegate", async () => {
    const codes: string[] = [];
    onSessionOnly((code) => codes.push(code));
    const { worker, notices, dispatched } = harness();

    worker.emit({ type: "sessionOnly", code: "another-tab" });
    await flush();

    expect(codes).toEqual(["another-tab"]);
    // Not `worker.posted`: the toy delegate answers an unknown type with null,
    // so a leak to dispatch() would post nothing either (vect-hack-azf).
    expect(dispatched).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("keeps the engine when the session-only banner throws", async () => {
    onSessionOnly(() => { throw new Error("banner renderer exploded"); });
    const { worker, dispatched } = harness();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    worker.emit({ type: "sessionOnly", code: "setup-failed" });
    worker.emit({ type: "ping", id: 1 });
    await flush();

    // The throw cost the banner and nothing else: the next message is still
    // dispatched and still answered.
    expect(dispatched).toEqual([{ type: "ping", id: 1 }]);
    expect(worker.posted).toEqual([{ type: "pong", id: 1 }]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("routes fatal through fatalNotice to onNotice (vect-hack-1g5)", async () => {
    const { worker, notices } = harness();
    worker.emit({ type: "fatal", message: "wasm trap" });
    await flush();
    // Every death below is a death on the way in — nothing has reached the
    // delegate yet — so each one also carries the reset advice
    // (vect-hack-60i), pinned on its own further down.
    expect(notices).toEqual([`engine died: wasm trap${BOOT_ADVICE}`]);
  });

  // vect-hack-4p9: a worker can die before its own error listener posts a
  // fatal (a script that never loaded, an OOM kill), and a value that fails
  // to deserialize never arrives as a message at all. Both were console-only.
  it("notices a worker error, naming where it happened (vect-hack-4p9)", () => {
    const { worker, notices } = harness();
    worker.onerror?.(errorEvent("RangeError: out of memory", "http://x/worker.js", 12));
    expect(notices).toEqual([`engine died: RangeError: out of memory (http://x/worker.js:12)${BOOT_ADVICE}`]);
  });

  it("says the worker never started when the error carries no message", () => {
    // A script that fails to fetch fires an ErrorEvent with nothing in it;
    // wording it as an engine diagnostic would be inventing one.
    const { worker, notices } = harness();
    worker.onerror?.(errorEvent(""));
    expect(notices).toEqual([`engine died: the engine worker failed to start${BOOT_ADVICE}`]);
  });

  it("notices a messageerror as the deserialization failure it is (vect-hack-4p9)", () => {
    // A messageerror carries no message: the value could not be read, so
    // there is nothing to quote. Fatal all the same — the class's invariant
    // is one reply-owing message in flight, and its id was inside the value
    // nobody could read, so the suspended engine can never be answered.
    const { worker, notices } = harness();
    worker.onmessageerror?.(new MessageEvent("messageerror"));
    expect(notices).toEqual(
      [`engine died: a message from the engine could not be deserialized${BOOT_ADVICE}`]);
  });

  it("tells the player about one death once, error then posted fatal", async () => {
    const { worker, notices } = harness();
    worker.onerror?.(errorEvent("boom", "w.js", 1));
    worker.emit({ type: "fatal", message: "worker error: boom" }); // the worker's own listener
    await flush();
    expect(notices).toEqual([`engine died: boom (w.js:1)${BOOT_ADVICE}`]);
  });

  it("tells the player about one death once, posted fatal then error", async () => {
    const { worker, notices } = harness();
    worker.emit({ type: "fatal", message: "wasm trap" });
    await flush();
    worker.onerror?.(errorEvent("boom", "w.js", 1));
    worker.onmessageerror?.(new MessageEvent("messageerror"));
    expect(notices).toEqual([`engine died: wasm trap${BOOT_ADVICE}`]);
  });

  // vect-hack-60i. A save file's bytes reach the engine's own C save code, and
  // a volume that fatals on the way in leaves a page with nothing to offer:
  // the parked import is already cleared and the character it replaced is
  // already gone. The reset row is reachable the whole time; what was missing
  // was any reason to look at it.
  it("points a death on the way in at the reset, once (vect-hack-60i)", async () => {
    const { worker, notices } = harness();
    worker.emit({ type: "fatal", message: "wasm trap in restore" });
    await flush();

    expect(notices).toEqual([`engine died: wasm trap in restore${BOOT_ADVICE}`]);
    // The Module's own wording still leads: the first move is a reload, and
    // most deaths are not the volume's fault.
    expect(notices[0]).toMatch(/^engine died: wasm trap in restore/);
  });

  it("says nothing about the save when the engine had started", async () => {
    // A death mid-game is a bug in a running game. Pointing that player at the
    // button that deletes their character would be advice that costs them one.
    const { worker, notices } = harness();
    worker.emit({ type: "ping", id: 1 });
    await flush();
    worker.emit({ type: "fatal", message: "wasm trap" });
    await flush();

    expect(notices).toEqual(["engine died: wasm trap"]);
  });

  it("counts the engine as started by its own message, not by a lifecycle one", async () => {
    // notice, sessionOnly, saveBlob and describeReply are all Backplane
    // traffic: a mount posting "saving is off" says nothing about whether the
    // engine ever ran, and a death after one is still a death on the way in.
    const { worker, notices } = harness();
    worker.emit({ type: "notice", text: "saving is off" });
    worker.emit({ type: "sessionOnly", code: "another-tab" });
    await flush();
    worker.emit({ type: "fatal", message: "wasm trap" });
    await flush();

    expect(notices).toEqual(["saving is off", `engine died: wasm trap${BOOT_ADVICE}`]);
  });

  it("a worker error posts nothing and leaves the worker alone", () => {
    // The posted fatal does not terminate either: the delegates' wording asks
    // for a reload, and a worker still flushing its volume gets to finish.
    const { worker } = harness();
    worker.onerror?.(errorEvent("boom", "w.js", 1));
    expect(worker.posted).toEqual([]);
    expect(worker.terminated).toBe(false);
  });

  it("posts the delegate's dispatch reply back to the worker", async () => {
    const { worker } = harness();
    worker.emit({ type: "ping", id: 3 });
    await flush();
    expect(worker.posted).toEqual([{ type: "pong", id: 3 }]);
  });

  it("a fatal posts nothing", async () => {
    const { worker } = harness();
    worker.emit({ type: "fatal", message: "x" }); // lifecycle: dispatch never runs
    await flush();
    expect(worker.posted).toEqual([]);
  });

  it("a null dispatch result posts nothing", async () => {
    const { worker } = harness();
    worker.emit({ type: "hush" }); // dispatched, resolves null: no reply owed
    await flush();
    expect(worker.posted).toEqual([]);
  });

  it("a throwing dispatch posts the fallback reply and notices (vect-hack-c1w)", async () => {
    const { worker, notices } = harness();
    worker.emit({ type: "boom", id: 9 });
    await flush();
    expect(worker.posted).toEqual([{ type: "pong", id: -9 }]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/view exploded/);
  });

  it("still posts the fallback when onNotice also throws (vect-hack-c1w)", async () => {
    const { worker, notices } = harness({ noticeThrows: true });
    worker.emit({ type: "boom", id: 9 });
    await flush();
    // The reply is the guarantee; the notice is best-effort. A broken notice
    // renderer costs the notice, never the unwedging of the engine.
    expect(worker.posted).toEqual([{ type: "pong", id: -9 }]);
    expect(notices).toEqual([]);
  });

  it("terminate() terminates the worker", () => {
    const { worker, session } = harness();
    session.terminate();
    expect(worker.terminated).toBe(true);
  });

  // The export round trip is Backplane traffic like notice/fatal: EngineSession
  // owns the request table and routes saveBlob itself, so every Module's
  // session gets exportSave() without carrying any of the wiring.
  it("owns the save-export round trip end to end", async () => {
    const { worker, session } = harness();
    const wait = session.exportSave();
    const request = worker.posted.at(-1) as { type: string; id: number };
    expect(request.type).toBe("exportSave");

    const save = { bytes: new Uint8Array([1]), filename: "a.vhsave" };
    worker.emit({ type: "saveBlob", id: request.id, ok: true, ...save } as unknown as ToyIn);
    await expect(wait).resolves.toEqual(save);
  });

  it("routes a saveBlob reply before the delegate ever sees it", async () => {
    const { worker, dispatched } = harness();
    // Unsolicited: no request pending, so it must be dropped, not dispatched —
    // the toy delegate would return null but a real one would hit its switch.
    worker.emit({ type: "saveBlob", id: 99, ok: false, message: "x" } as unknown as ToyIn);
    await flush();
    expect(dispatched).toEqual([]);
    expect(worker.posted).toEqual([]);
  });

  // A hover, not the save export, but the same Backplane traffic: EngineSession
  // owns the request table and routes describeReply itself, so every Module's
  // session gets describe() without carrying any of the wiring.
  it("owns the describe round trip end to end", async () => {
    const { worker, session } = harness();
    const wait = session.describe(7, 8);
    const request = worker.posted.at(-1) as { type: string; id: number; x: number; y: number };
    expect(request).toMatchObject({ type: "describe", x: 7, y: 8 });

    worker.emit({ type: "describeReply", id: request.id, text: "jackal" } as unknown as ToyIn);
    await expect(wait).resolves.toBe("jackal");
  });

  it("routes a describeReply reply before the delegate ever sees it", async () => {
    const { worker, dispatched } = harness();
    // Unsolicited: no request pending, so it must be dropped, not dispatched —
    // the toy delegate would return null but a real one would hit its switch.
    worker.emit({ type: "describeReply", id: 99, text: "x" } as unknown as ToyIn);
    await flush();
    expect(dispatched).toEqual([]);
    expect(worker.posted).toEqual([]);
  });
});

describe("volume registry", () => {
  it("gives every Module a distinct mountpoint and lock (IDBFS keys its DB by mountpoint)", () => {
    const vols = Object.values(VOLUMES);
    expect(new Set(vols.map((v) => v.mountpoint)).size).toBe(vols.length);
    expect(new Set(vols.map((v) => v.lock)).size).toBe(vols.length);
  });

  it("names the renamed NetHack volume with no legacy compat", () => {
    expect(VOLUMES.nethack).toMatchObject({
      id: "nethack", mountpoint: "/vect-nethack", lock: "vect-nethack/persist",
    });
    expect(VOLUMES.angband).toMatchObject({
      id: "angband", mountpoint: "/vect-angband", lock: "vect-angband/persist",
    });
  });

  it("declares where every Module keeps a character (vect-hack-70x)", () => {
    // A volume with no character paths would export an empty blob as happily
    // as the build this replaced, so the declaration is the guard.
    for (const [key, volume] of Object.entries(VOLUMES)) {
      expect(volume.characterPaths.length, key).toBeGreaterThan(0);
      for (const path of volume.characterPaths) {
        expect(path, key).not.toMatch(/^\/|\.\.|\/$/);
      }
    }
  });

  it("carries an id matching its registry key (it names exported saves)", () => {
    for (const [key, volume] of Object.entries(VOLUMES)) expect(volume.id).toBe(key);
  });
});

describe("NetHack fallback table (cancel-shaped, per the backplane design)", () => {
  it("ESC for the key waits", () => {
    expect(fallbackValue({ name: "nhgetch" })).toBe(27);
    expect(fallbackValue({ name: "nh_poskey" })).toBe(27);
  });
  it("the default for yn_function", () => {
    expect(fallbackValue({ name: "yn_function", query: "Really quit?", choices: "yn", def: 110 })).toBe(110);
  });
  it("null (= cancel) for getlin and select_menu", () => {
    expect(fallbackValue({ name: "getlin", query: "Name?" })).toBeNull();
    expect(fallbackValue({ name: "select_menu", win: 3, how: 1 })).toBeNull();
  });
  it("null reply for display events", () => {
    expect(fallbackValue({ name: "curs", win: 1, x: 0, y: 0 })).toBeNull();
    expect(fallbackValue({ name: "delay_output" })).toBeNull();
  });
  // The three events whose reply the view supplies into a scalar C return
  // slot: setPointerValue() (external/NetHack/sys/libnh/libnhmain.c:895)
  // throws a TypeError on null there, which would fatal the engine rather
  // than cancel — the opposite of what the c1w fallback is for.
  it("a number, never null, for the scalar-slot events", () => {
    expect(fallbackValue({ name: "get_ext_cmd", commands: [] })).toBe(-1);
    expect(fallbackValue({ name: "message_menu", how: 0, text: "f - a wafer" })).toBe(27);
    expect(fallbackValue({ name: "create_nhwindow", wintype: 1 })).toBe(0);
  });

  // Every shim call owes a reply — src/modules/nethack/worker.ts routes all
  // of them through ask(), and the engine stays Asyncify-suspended until one
  // arrives.
  // So the table has no holes by construction: this Record must name every
  // ShimEvent, and a new windowport event breaks the typecheck until its
  // cancel shape is decided here.
  const EXPECTED: Record<ShimEvent["name"], number | null> = {
    nhgetch: 27, nh_poskey: 27, yn_function: 110,
    get_ext_cmd: -1, message_menu: 27, create_nhwindow: 0,
    init_nhwindows: null, askname: null,
    exit_nhwindows: null, clear_nhwindow: null,
    display_nhwindow: null, destroy_nhwindow: null, curs: null, putstr: null,
    start_menu: null, add_menu: null, end_menu: null, select_menu: null,
    print_glyph: null, raw_print: null, getlin: null,
    getmsghistory: null, putmsghistory: null,
    status_init: null, status_enablefield: null, status_update: null,
    cliparound: null, delay_output: null, nhbell: null, other: null,
  };
  it("answers every ShimEvent in the union", () => {
    for (const [name, want] of Object.entries(EXPECTED))
      expect(fallbackValue({ name, def: 110 } as unknown as ShimEvent), name).toBe(want);
  });
});

// The delegate the NetHack Module hands EngineSession: the fallback *table*
// above is only the value it answers with, and the wrapper around it — the
// reply message the worker routes by id — is the delegate's own. Reached
// through makeDelegate() because NetHackSession's constructor spawns a real
// Worker, which node has no business doing here.
describe("NetHack delegate", () => {
  // No default for `reply`: harness(undefined) is the bare-`return;` case
  // below, and a default would quietly answer it with something else.
  const harness = (reply: ShimReply | Promise<ShimReply>) => {
    const notices: string[] = [];
    const events: ShimEvent[] = [];
    let ready: Record<string, Record<string, number | string>> | null = null;
    const delegate = makeNetHackDelegate({
      onReady: (constants) => { ready = constants; },
      onNotice: (text) => notices.push(text),
      handle: (ev) => { events.push(ev); return reply; },
    });
    return { notices, events, delegate, constants: () => ready };
  };

  it("hands the engine's constants to the view on ready, and owes nothing back", async () => {
    const h = harness(null);
    const constants = { GLYPH: { GLYPH_PET_OFF: 100 } };
    expect(await h.delegate.dispatch({ type: "ready", constants })).toBeNull();
    expect(h.constants()).toBe(constants);
  });

  it("words an engine death around the engine's own diagnostic", () => {
    // Promises the autosave, unlike Angband's wording: this Module mounts a
    // storage volume, so a reload has a checkpoint to offer.
    expect(harness(null).delegate.fatalNotice("wasm trap"))
      .toBe("The NetHack engine died — wasm trap. Reload the page; your last autosave will be offered.");
  });

  it("forwards a lifecycle notice to the view", () => {
    const h = harness(null);
    h.delegate.onNotice("saving is off");
    expect(h.notices).toEqual(["saving is off"]);
  });

  // Both members are optional on NethackHandler (the bot and the debug
  // view supply neither), so the delegate must tolerate their absence.
  it("tolerates a view that implements neither optional member", async () => {
    const delegate = makeNetHackDelegate({ handle: () => null });
    expect(await delegate.dispatch({ type: "ready", constants: {} })).toBeNull();
    expect(() => delegate.onNotice("saving is off")).not.toThrow();
  });

  it("wraps the view's answer in a reply message, awaiting a view that answers late", async () => {
    expect(await harness(121).delegate.dispatch({ type: "call", id: 5, ev: { name: "nhgetch" } }))
      .toEqual({ type: "reply", id: 5, value: 121 });
    // getlin and the menus resolve a promise; an unawaited one would post the
    // promise object itself as the engine's answer.
    expect(await harness(Promise.resolve("Elbereth")).delegate
      .dispatch({ type: "call", id: 6, ev: { name: "getlin", query: "What do you engrave?" } }))
      .toEqual({ type: "reply", id: 6, value: "Elbereth" });
  });

  // Many TextHud.handle cases answer a display event with a bare `return;`.
  // The reply is still owed, and undefined is not a value the reply can
  // carry, so the delegate coerces it to the protocol's null.
  it("coerces a view's bare `return;` to null", async () => {
    const h = harness(undefined);
    expect(await h.delegate.dispatch({ type: "call", id: 7, ev: { name: "curs", win: 1, x: 0, y: 0 } }))
      .toEqual({ type: "reply", id: 7, value: null });
    expect(h.events).toEqual([{ name: "curs", win: 1, x: 0, y: 0 }]);
  });

  it("wraps the fallback value in the same reply message, and answers nothing else", () => {
    const { delegate } = harness(null);
    // Only the value is cancel-shaped: a null *message* here would leave the
    // worker's ask() resolver parked and the engine suspended on it.
    expect(delegate.fallback({ type: "call", id: 8, ev: { name: "nhgetch" } }))
      .toEqual({ type: "reply", id: 8, value: fallbackValue({ name: "nhgetch" }) });
    expect(delegate.fallback({ type: "ready", constants: {} })).toBeNull();
  });
});

describe("Angband fallback table (cancel-shaped, per the backplane design)", () => {
  it("ESC for a stranded blocking key wait", () => {
    expect(angbandFallback({ type: "getKey", id: 7, wait: true, cmd: true }))
      .toEqual({ type: "key", id: 7, code: KC_ESCAPE, mods: 0 });
  });

  // wait=false is not a prompt to cancel, it is a poll: TERM_XTRA_FLUSH
  // drains the queue by calling wasm_handle_event(0) until it answers "no
  // key" (src/modules/angband/native/main-wasm.c:104). ESC there would be a phantom
  // Escape pressed into the drain — and the drain would loop again.
  it("no key, never ESC, for a stranded non-blocking poll", () => {
    expect(angbandFallback({ type: "getKey", id: 8, wait: false, cmd: false }))
      .toEqual({ type: "key", id: 8, code: 0, mods: 0 });
  });

  it("null reply for a display event", () => {
    expect(angbandFallback({ type: "event", ev: { name: "clear" } })).toBeNull();
  });

  // getKey is the protocol's one reply-owing message — the worker parks a
  // resolver for it (src/modules/angband/worker.ts's pending map) and the engine
  // stays Asyncify-suspended until a reply arrives, so its fallback is a
  // message and never null. Everything else is one-way. This Record must
  // name every AngbandWorkerToMain type, so a new message breaks the
  // typecheck until its cancel shape is decided here.
  const EXPECTED: Record<AngbandWorkerToMain["type"], AngbandMainToWorker | null> = {
    getKey: { type: "key", id: 7, code: KC_ESCAPE, mods: 0 }, // wait=true; the poll is above
    ready: null, event: null, quit: null, released: null,
    // A save export owes the worker nothing: the worker has already finished
    // with it, and the main thread's own timeout settles a lost reply.
    saveBlob: null,
    // Same reasoning as saveBlob: a describe reply is one-way, and a hover
    // superseded or timed out settles itself (src/backplane/describe.ts).
    describeReply: null,
    // Lifecycle: EngineSession routes these itself, so dispatch — and hence
    // the fallback — never sees them.
    notice: null, fatal: null, sessionOnly: null,
  };
  it("answers every message in the union", () => {
    for (const [type, want] of Object.entries(EXPECTED))
      expect(angbandFallback({ type, id: 7, wait: true, cmd: true } as unknown as AngbandWorkerToMain), type)
        .toEqual(want);
  });
});

// The delegate the Angband Module hands EngineSession: its behavior is the
// Module's half of the contract, and the mechanism above is the other half.
// Reached through makeDelegate() because AngbandSession's constructor spawns a
// real Worker, which node has no business doing here.
describe("Angband delegate", () => {
  const harness = () => {
    const notices: string[] = [];
    const events: AngbandEvent[] = [];
    const delegate = makeAngbandDelegate({
      onNotice: (text) => notices.push(text),
      handle: (ev) => events.push(ev),
      nextKey: () => ({ code: 0x6a, mods: 0 }),
    });
    return { notices, events, delegate };
  };

  it("tells the player a persistent normal exit saved the game", async () => {
    const { notices, delegate } = harness();
    expect(await delegate.dispatch({
      type: "quit", saved: true, persistent: true, reason: null,
    })).toBeNull();
    expect(notices).toEqual(["Angband exited — your game is saved. Reload to continue."]);
  });

  it("does not promise a save after a session-only normal exit", async () => {
    const { notices, delegate } = harness();
    expect(await delegate.dispatch({
      type: "quit", saved: false, persistent: false, reason: "another tab is already playing",
    })).toBeNull();
    expect(notices).toEqual(["Angband exited — reload to restart."]);
  });

  it("does not promise a save when no checkpoint reached the volume", async () => {
    const { notices, delegate } = harness();
    expect(await delegate.dispatch({
      type: "quit", saved: false, persistent: true, reason: null,
    })).toBeNull();
    expect(notices).toEqual(["Angband exited — reload to restart."]);
  });

  it("says nothing in the message strip about session-only storage", async () => {
    const calls: string[] = [];
    const delegate = makeAngbandDelegate({
      onNotice: (text) => calls.push(text), handle: () => {}, nextKey: () => null,
      onReady: () => calls.push("ready"),
    });
    expect(await delegate.dispatch({ type: "ready" })).toBeNull();
    // Only "ready". The storage warning used to be a strip line here carrying
    // the developer sentence — "Saving is off — IndexedDB is unavailable:
    // TypeError: ..." — which scrolled away behind the engine's own opening
    // messages and put exception text on screen. It is the Backplane's
    // `sessionOnly` banner now (vect-hack-dem).
    expect(calls).toEqual(["ready"]);
  });

  it("words an engine death around the engine's own diagnostic", () => {
    // No checkpoint promise yet, unlike NetHack's wording: clean saves are
    // durable now, but Task 8 owns safe mid-game checkpoints.
    const { delegate } = harness();
    expect(delegate.fatalNotice("Cannot create '/lib/save'"))
      .toBe("The Angband engine died — Cannot create '/lib/save'. Reload the page to restart.");
  });

  it("forwards a lifecycle notice to the view", () => {
    const { notices, delegate } = harness();
    delegate.onNotice("saving is off");
    expect(notices).toEqual(["saving is off"]);
  });

  it("answers the key wait with the view's key", async () => {
    const calls: Array<[boolean, boolean]> = [];
    const delegate = makeAngbandDelegate({
      onNotice: () => {}, handle: () => {},
      nextKey: (wait, cmd) => { calls.push([wait, cmd]); return { code: 0x6a, mods: 0 }; },
    });
    expect(await delegate.dispatch({ type: "getKey", id: 4, wait: true, cmd: true }))
      .toEqual({ type: "key", id: 4, code: 0x6a, mods: 0 });
    expect(await delegate.dispatch({ type: "getKey", id: 5, wait: false, cmd: false }))
      .toEqual({ type: "key", id: 5, code: 0x6a, mods: 0 });
    expect(calls).toEqual([[true, true], [false, false]]);
  });

  it("answers a keyless view with code 0 — the reply is still owed", async () => {
    const delegate = makeAngbandDelegate({
      onNotice: () => {}, handle: () => {}, nextKey: () => null,
    });
    expect(await delegate.dispatch({ type: "getKey", id: 5, wait: false, cmd: false }))
      .toEqual({ type: "key", id: 5, code: 0, mods: 0 });
  });

  it("hands display events to the view and posts nothing back", async () => {
    const { events, delegate } = harness();
    expect(await delegate.dispatch({ type: "event", ev: { name: "clear" } })).toBeNull();
    expect(events).toEqual([{ name: "clear" }]);
  });

  it("wires the fallback table it was written for", () => {
    expect(harness().delegate.fallback).toBe(angbandFallback);
  });
});

describe("AngbandSession storage lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks the worker to release its storage handle before terminating it", () => {
    const workers: FakeWorker[] = [];
    vi.stubGlobal("Worker", class extends FakeWorker {
      constructor() { super(); workers.push(this); }
    });
    const session = new AngbandSession({
      onNotice: () => {}, handle: () => {}, nextKey: () => null,
    });

    session.terminate();

    expect(workers[0]?.posted).toEqual([{ type: "release" }]);
    expect(workers[0]?.terminated).toBe(false);
    workers[0]?.onmessage?.({ data: { type: "released" } });
    expect(workers[0]?.terminated).toBe(true);
  });
});

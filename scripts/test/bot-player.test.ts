import { describe, expect, it } from "vitest";
import { BotPlayer } from "../../src/modules/nethack/bot/BotPlayer";
import type { ShimEvent } from "../../src/modules/nethack/protocol";
import type { ShimReply, NethackHandler } from "../../src/modules/nethack/session";
import { CONSTANTS } from "./bot-fixtures";

/** Recording stub view: returns canned replies, never blocks. */
function stubView() {
  const seen: ShimEvent[] = [];
  let nextWin = 1;
  const view: NethackHandler = {
    handle(ev: ShimEvent): ShimReply {
      seen.push(ev);
      if (ev.name === "create_nhwindow") return nextWin++;
      return null;
    },
  };
  return { view, seen };
}

async function boot() {
  const { view, seen } = stubView();
  const bot = new BotPlayer(view, 0); // no pacing in tests
  bot.onReady?.(CONSTANTS);
  const msgWin = await bot.handle({ name: "create_nhwindow", wintype: 1 });
  const mapWin = await bot.handle({ name: "create_nhwindow", wintype: 3 });
  const menuWin = await bot.handle({ name: "create_nhwindow", wintype: 4 });
  return { bot, view, seen, msgWin: msgWin as number, mapWin: mapWin as number, menuWin: menuWin as number };
}

describe("BotPlayer routing", () => {
  it("forwards display events and returns the view's reply", async () => {
    const { seen, mapWin } = await boot();
    expect(seen.filter((e) => e.name === "create_nhwindow").length).toBe(3);
    expect(mapWin).toBe(2); // the stub's second id, passed through
  });

  it("answers input events itself without forwarding them", async () => {
    const { bot, seen } = await boot();
    expect(await bot.handle({ name: "askname" })).toBe("Bot");
    expect(await bot.handle({ name: "getlin", query: "What do you call it?" })).toBe(null);
    expect(await bot.handle({ name: "yn_function", query: "Are you sure you want to pray?", choices: "yn", def: 110 })).toBe(121);
    expect(await bot.handle({ name: "message_menu", how: 1, text: "pick something" })).toBe(0);
    const names = seen.map((e) => e.name);
    for (const n of ["askname", "getlin", "yn_function", "message_menu"]) expect(names).not.toContain(n);
  });

  it("answers movement keys from the brain once the map has a hero", async () => {
    const { bot, mapWin } = await boot();
    const floor = { glyph: 3000, ch: ".", color: 7, glyphflags: 0 };
    await bot.handle({ name: "print_glyph", win: mapWin, x: 5, y: 5, cell: floor, bg: null });
    await bot.handle({ name: "print_glyph", win: mapWin, x: 6, y: 5, cell: floor, bg: null });
    await bot.handle({ name: "print_glyph", win: mapWin, x: 5, y: 5, cell: { ...floor, glyph: 1, ch: "@", glyphflags: 0x1 }, bg: null });
    const key = await bot.handle({ name: "nh_poskey" });
    expect(typeof key).toBe("number");
    expect(key).toBeGreaterThan(0);
  });

  it("buffers menus: build-up not forwarded, select answered from the buffer", async () => {
    const { bot, seen, menuWin } = await boot();
    const before = seen.length;
    await bot.handle({ name: "start_menu", win: menuWin, mbehavior: 0 });
    await bot.handle({ name: "add_menu", win: menuWin, item: { identifier: 103, accelerator: "c", groupAccel: "", attr: 0, color: 0, text: "Valkyrie", itemflags: 0, glyph: null } });
    await bot.handle({ name: "end_menu", win: menuWin, prompt: "Pick a role or profession" });
    expect(seen.length).toBe(before); // nothing forwarded
    const reply = await bot.handle({ name: "select_menu", win: menuWin, how: 1 });
    expect(reply).toEqual({ picks: [{ identifier: 103, count: -1, itemflags: 0 }] });
    expect(seen.length).toBe(before);
  });

  it("replays a buffered menu to the view for display-only windows", async () => {
    const { bot, seen, menuWin } = await boot();
    await bot.handle({ name: "start_menu", win: menuWin, mbehavior: 0 });
    await bot.handle({ name: "end_menu", win: menuWin, prompt: "" });
    await bot.handle({ name: "display_nhwindow", win: menuWin, blocking: true });
    const names = seen.map((e) => e.name);
    expect(names).toContain("start_menu");
    expect(names).toContain("end_menu");
    const disp = seen.find((e) => e.name === "display_nhwindow") as { blocking: boolean };
    expect(disp.blocking).toBe(false); // never let the view block on a key
  });

  it("de-blocks blocking displays of ordinary windows too", async () => {
    const { bot, seen } = await boot();
    const textWin = await bot.handle({ name: "create_nhwindow", wintype: 5 });
    await bot.handle({ name: "display_nhwindow", win: textWin as number, blocking: true });
    const disp = seen.filter((e) => e.name === "display_nhwindow").pop() as { blocking: boolean };
    expect(disp.blocking).toBe(false);
  });

  it("drains the queued script's direction key through a yn_function prompt", async () => {
    const { bot, mapWin } = await boot();
    const floor = { glyph: 3000, ch: ".", color: 7, glyphflags: 0 };
    const door = { glyph: 3000, ch: "+", color: 7, glyphflags: 0 };
    // Hero at (5,5), a closed door at (6,5) bordering unexplored space beyond
    // it (7,5 is never painted) -> the door is the frontier: the brain
    // queues an open script ['o', dir].
    await bot.handle({ name: "print_glyph", win: mapWin, x: 5, y: 5, cell: { ...floor, glyph: 1, ch: "@", glyphflags: 0x1 }, bg: null });
    await bot.handle({ name: "print_glyph", win: mapWin, x: 6, y: 5, cell: door, bg: null });

    const openKey = await bot.handle({ name: "nh_poskey" });
    expect(openKey).toBe("o".charCodeAt(0));

    const dirReply = await bot.handle({
      name: "yn_function", query: "In what direction?", choices: "hykulnjb><", def: 27,
    });
    expect(typeof dirReply).toBe("number");
    expect("hjklyubn").toContain(String.fromCharCode(dirReply as number));

    // The queue is drained: the next key comes from a fresh decision, not a
    // replayed leftover direction key.
    const nextKey = await bot.handle({ name: "nh_poskey" });
    expect(nextKey).toBe("o".charCodeAt(0));
  });

  it("routes the queued extended command to get_ext_cmd", async () => {
    const { bot, mapWin, msgWin } = await boot();
    // Hero at 1 HP of 20 -> brain prays: '#', then get_ext_cmd picks "pray".
    const floor = { glyph: 3000, ch: ".", color: 7, glyphflags: 0 };
    await bot.handle({ name: "print_glyph", win: mapWin, x: 5, y: 5, cell: { ...floor, glyph: 1, ch: "@", glyphflags: 0x1 }, bg: null });
    await bot.handle({ name: "status_update", fldidx: 18, text: "1", condbits: 0, chg: 0, percent: 0, color: 0 });
    await bot.handle({ name: "status_update", fldidx: 19, text: "20", condbits: 0, chg: 0, percent: 0, color: 0 });
    const hash = await bot.handle({ name: "nh_poskey" });
    expect(hash).toBe("#".charCodeAt(0));
    const idx = await bot.handle({ name: "get_ext_cmd", commands: [{ name: "chat", desc: "" }, { name: "pray", desc: "" }] });
    expect(idx).toBe(1);
    void msgWin;
  });
});

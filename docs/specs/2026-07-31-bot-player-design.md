# Bot player — a self-playing WindowPortHandler decorator

Date: 2026-07-31. Bead: `vect-hack-m6c`.

## Why

Two uses, one mechanism:

- **Automated playtesting.** Every fix in DECISIONS.md from 2026-07-27 came out
  of one manual tutorial run. A bot that plays unattended multiplies that
  coverage for free.
- **Attract mode.** A self-playing game in the 3D view is the arcade demo
  screen this renderer was born for.

Existing bots (TAEB/Perl, BotHack/Clojure, autoascend/Python+NLE) are all
wrong-language and wrong-interface — they scrape a tty or drive NLE's gym API,
and wrapping any of them means a second runtime and a fake terminal. Our
`ShimEvent` stream is already structured windowport data, a cleaner substrate
than anything those bots parse. So: our own bot, small, algorithmic. No LLM.

## Shape

`BotPlayer` implements `WindowPortHandler` and **decorates** the real view:

```ts
// main.ts — the only wiring in the codebase
const handler = flags.has("bot") ? new BotPlayer(view) : view;
new NetHackSession(handler);
```

Every event is observed by the bot's own world model, then:

- **Display events** are forwarded to the wrapped view unchanged — the 3D
  scene (or DebugView) renders the bot's game exactly as it renders a human's.
- **Input events** — `nhgetch`, `nh_poskey`, `yn_function`, `getlin`,
  `get_ext_cmd`, `select_menu`, `message_menu`, `askname` — are answered by
  the bot and **never forwarded**: the view's handlers for these block on the
  keyboard queue and would hang.
- **`display_nhwindow` with `blocking: true`** also waits for a keypress in
  the view. The bot forwards it as `{...ev, blocking: false}` — content still
  renders, nothing stalls — and replies itself.

Nothing outside `main.ts` knows the bot exists; the bot imports only
`protocol.ts` types and the `WindowPortHandler`/`ShimReply` types from
`session.ts`. It never touches the render layer, `TextHud`, or `__nhView`.

### Menu windows

NetHack menus are `start_menu … add_menu … end_menu`, then *either*
`select_menu` (interactive) or `display_nhwindow` (display-only). Forwarding
the build-up events but answering `select_menu` ourselves would leave the HUD
holding a menu it never shows. So the bot **buffers** the event group per
window and forwards nothing at build time:

- `select_menu` arrives → the bot answers picks from its buffer; the view
  never sees the menu. (Attract mode stays visually calm — no inventory
  flicker.)
- `display_nhwindow` arrives for a buffered menu window → the buffered events
  are replayed to the view followed by a non-blocking display, so
  informational screens still render.
- `destroy_nhwindow` clears the buffer and is forwarded.

## Files

```
src/bot/BotPlayer.ts   — the decorator: event routing, pacing, answer loop
src/bot/model.ts       — BotModel: grid, hero, status, messages, menus
src/bot/policy.ts      — decideAction(model): pure priority policy + BFS
src/bot/prompts.ts     — rule tables for yn/getlin/menu answers
```

All pure TypeScript, no DOM, no three.js — unit-testable in node.

## BotModel

Built solely from observed events:

- **Grid**: 80×21 of `{ch, color, glyphflags}` from `print_glyph`; hero
  position from the `MG.HERO` glyphflag (constants from `onReady`). A
  parallel `explored` bitmask remembers everywhere a glyph has ever landed.
- **Status**: HP/HPmax/hunger from `status_update` (field indices from
  `status_enablefield`).
- **Messages**: last N `putstr` lines to the message window (window role
  learned from `create_nhwindow` wintype). Used for stuck detection ("You
  can't move", "This door is locked", "It's a wall").
- **Menus**: the per-window buffers above.
- **Counters**: actions since last prayer, actions on the current level,
  recent positions (loop detection).

## Policy — solid survivor

`decideAction(model)` returns keystrokes. Priorities, first match wins:

1. **Emergency** — HP below ~1/7 max, or hunger Weak/Fainting with no food:
   pray (`#pray`, confirm), at most once per ~900 actions.
2. **Eat** — hunger Hungry and inventory has food: `e`, pick a food item from
   the "eat what?" prompt/menu.
3. **Fight** — hostile monster adjacent (letter glyph, not `MG.PET`): move
   into it. Ignore floating eyes (`e`, blue) — attack nothing that punishes
   melee in the basic table.
4. **Loot** — standing on an item glyph: `,`, take all.
5. **Explore** — BFS over walkable cells (`.` `#` `<` `>` `'` open doors,
   items, corridors; never water/lava `}`, known traps `^`) to the nearest
   frontier: a walkable cell adjacent to unexplored dark. Closed door `+` on
   the path: open (`o` + direction); "locked" message: kick (Ctrl-D +
   direction) until it gives.
6. **Descend** — no frontier left: BFS to known `>`, then `>`.
7. **Search** — no frontier, no known downstairs: `s` at dead-end walls,
   rotating spots, 10× each.
8. **Anti-stuck** — same position + same intent too many times in a row:
   fall through to the next priority; as last resort a random legal step.

**Character creation**: `askname` → "Bot". Creation menus answered from
`prompts.ts` by prompt text: role menu → the Valkyrie row, then human, female,
lawful (match by row text, fall back to first selectable row); confirmation
`yn` → `y`; tutorial offer → `n`.

**Prompt tables** (`prompts.ts`): `yn_function` answers by regex on the query —
explicit rules for the cases the policy drives (pray confirmations, "Really
attack your pet?" → `n`, "eat it?" off the floor → `n` — floor food is how
bots die), otherwise **the engine's default** (`def`), which NetHack chose to
be safe. `getlin` → escape (empty) unless a rule matches. `get_ext_cmd` →
index looked up by name (`pray`), else -1. Unmatched menus → cancel (empty
picks).

**Death**: end-of-game prompts take defaults; on `exit_nhwindows` the bot
logs the death summary to the console and stops. No auto-restart in v1.

## Pacing

Attract mode must be watchable: the bot waits ~150 ms before answering any
input event (`?bot`), `?bot=fast` drops the delay to 0 for playtest grinding.
The delay lives in `BotPlayer`, not the policy.

## Testing

- `bot-model.test.ts` — grid/hero/status/messages built from synthetic event
  sequences; explored mask; menu buffering (select answered, display-only
  replayed).
- `bot-policy.test.ts` — priority order on hand-built models: emergency
  beats eat beats fight; BFS routes around walls and refuses water; frontier
  targeting; descend when explored; anti-stuck fallthrough.
- `bot-prompts.test.ts` — creation menu picks Valkyrie from a real captured
  menu fixture; yn table (unmatched → def); ext-cmd lookup.
- Integration: manual `?bot` run in the browser is the acceptance test —
  boots to a character, explores the first level, descends at least once.
  (A headless node harness driving the real engine is a natural follow-up,
  approach C in the brainstorm — out of scope for v1.)

## Out of scope

- LLM consultation, node/CI harness, auto-restart after death.
- Item strategy (identification, wearing/wielding upgrades beyond start kit),
  Elbereth, altars, Sokoban rules, shops (beyond "don't steal": the yn
  defaults handle payment prompts).
- In-page start/stop UI — the URL flag is the only switch.
- First-person camera awareness: the bot plays the engine, not the camera;
  F2 remains view chrome.

## Risks

- **Message-text matching** (locked doors, hunger states) is brittle in
  principle; acceptable for the same reason as the stand-on menu spec — the
  NetHack revision is pinned and options are default. Tests double as
  tripwires.
- **Swallowed menus** mean a watcher never sees the bot's inventory choices;
  accepted for visual calm. If it ever confuses debugging, `?trace` already
  logs every event.
- **The bot answering during engine-driven redraws**: replies are strictly
  request/reply over the existing seam, so ordering is inherited from the
  bridge — no new race surface.

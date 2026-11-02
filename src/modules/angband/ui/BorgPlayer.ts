// ?borg: a self-playing decorator around the real Angband view, the crash
// gate for the 3D renderer (vect-hack-3vk.4). NetHack's BotPlayer is the
// precedent, but the work here is far smaller: Angband ships its own borg, so
// this only has to birth a character and hand control over. Every event and
// notice passes straight through to the wrapped view, which therefore renders
// exactly as it would in a human game.
//
// Activation is Ctrl-Z, y, z — `^Z` is bound to do_cmd_try_borg
// (external/angband/src/ui-game.c:227), which first asks get_check("Are you
// sure you want to use the borg commands? ") (cmd-misc.c:126), and the borg's
// own get_com("Borg command (? for help): ") takes 'z' for "activate borg"
// (borg/borg-commands.c:102).
//
// Once the borg is running it feeds the engine through its own inkey_hack, so
// nextKey is called only for prompts the borg does not answer itself.
import { AngbandGrid } from "../grid.ts";
import type { AngbandHandler } from "../session.ts";
import type { AngbandEvent, AngbandKey } from "../protocol.ts";

const KC_ENTER = 0x9c; // external/angband/src/ui-event.h:171
const CTRL_Z = 0x1a;

export class BorgPlayer implements AngbandHandler {
  /** A private mirror of the tty text, so the decorator can read prompts
   * without reaching into the wrapped view's own screen state. */
  private readonly screen = new AngbandGrid();
  /** ^Z has been sent; the confirmation and command prompts are still to
   * come. Separate from `activated` so a declined confirmation does not
   * retry forever. */
  private tried = false;
  private activated = false;
  private postmortem = false;
  // Not a parameter property: node's type stripping runs these tests straight
  // from source, and `constructor(private view)` is not erasable syntax.
  private readonly view: AngbandHandler;

  constructor(view: AngbandHandler) { this.view = view; }

  onReady() { this.view.onReady?.(); }
  onNotice(text: string) { this.view.onNotice(text); }

  /** Forwarded like onReady/onNotice: a decorator that swallows teardown
   *  leaves the wrapped view's listeners installed (vect-hack-a8r). */
  dispose(): void { this.view.dispose?.(); }

  handle(ev: AngbandEvent) {
    switch (ev.name) {
      case "text": this.screen.text(ev.x, ev.y, ev.rgb, ev.text); break;
      case "wipe": this.screen.wipe(ev.x, ev.y, ev.n); break;
      case "curs": this.screen.curs(ev.x, ev.y); break;
      case "clear": this.screen.clear(); break;
    }
    this.view.handle(ev);
  }

  nextKey(wait: boolean, cmd: boolean): ReturnType<AngbandHandler["nextKey"]> {
    // A poll is a drain, not a prompt: TERM_XTRA_FLUSH loops until it gets
    // "no key" (native/main-wasm.c), so answering one with a keystroke feeds
    // the engine a phantom press and never terminates the drain.
    if (!wait) return null;

    const text = this.screen.toText();

    // Enter selects Information in ui-death.c's menu, then returns to the
    // tombstone forever. Hand this menu and its inspection screens to the
    // player; latch it because those screens replace the menu's tty text.
    if (text.includes("Information") && text.includes("Examine items")
      && text.includes("New Game") && text.includes("Quit")) this.postmortem = true;
    if (this.postmortem) return this.view.nextKey(wait, cmd);

    // Activation is prompt-driven rather than a queued ^Z,y,z burst.
    // do_cmd_try_borg msg()s two warnings and signals EVENT_MESSAGE_FLUSH
    // *before* it asks get_check (cmd-misc.c:120-126), so a blind burst feeds
    // its `y` and `z` to those -more- prompts and the borg never starts.
    if (!this.activated) {
      if (text.includes("use the borg commands?")) return key("y");
      if (text.includes("Borg command")) {
        this.activated = true;
        return key("z"); // "activate borg" (borg/borg-commands.c:102)
      }
      // The first command-level wait is the first moment a character exists,
      // which is the earliest point ^Z can mean anything.
      if (cmd && !this.tried) {
        this.tried = true;
        return { code: CTRL_Z, mods: 0 };
      }
    }
    // Birth: '@' takes the quick-start path — random role, race and class —
    // rather than walking the menus. The borg plays whatever it is given, and
    // a character it did not choose is a better crash test than one it did.
    if (text.includes("select your character traits") || text.includes("Human"))
      return key("@");
    // Everything else before play (the news splash, name and history
    // prompts) wants Enter; so does a -more- the borg left standing.
    return { code: KC_ENTER, mods: 0 };
  }
}

const key = (ch: string): AngbandKey => ({ code: ch.codePointAt(0)!, mods: 0 });

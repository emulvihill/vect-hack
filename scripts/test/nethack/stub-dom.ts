// The DOM stand-in the NetHack view tests share: enough of an element for
// TextHud, DebugView, VectorView and TouchControls, and a `document` that
// routes listeners by event type. NOT a .test.ts file itself, so vitest does
// not collect it.
//
// Where the DOM has a rule the views lean on, the stub keeps it rather than a
// convenience: assigning textContent replaces every child (a blanked #prompt
// must lose its yn chips, or a "clears the chips" test passes against a bug),
// remove() detaches from the parent (clear_nhwindow removes a transient line
// that way), contains() means "is or holds", and a document listener added
// during a dispatch waits for the next event, with `once` honoured.
//
// Install it before importing a view: TextHud looks its elements up while it
// constructs.
//
//   const dom = installStubDocument();
//   const { TextHud } = await import("../../../src/modules/nethack/ui/TextHud");
//   beforeEach(() => dom.reset());

export type Listener = (e: never) => void;

export class StubEl {
  id = "";
  type = "";
  title = "";
  tabIndex = 0;
  className = "";
  value = "";
  innerHTML = "";
  hidden = true;
  scrollTop = 0;
  scrollHeight = 0;
  /** How often blur(), focus() and remove() were called. */
  blurred = 0;
  focused = 0;
  removed = 0;
  onkeydown: ((e: { key: string; stopPropagation(): void }) => void) | null = null;
  parentElement: StubEl | null = null;
  children: StubEl[] = [];
  classes = new Set<string>();
  listeners = new Map<string, Set<Listener>>();
  #text = "";

  get textContent() { return this.#text; }
  set textContent(v: string) {
    this.#text = v;
    this.innerHTML = v;
    for (const c of this.children) c.parentElement = null;
    this.children = [];
  }
  get childElementCount() { return this.children.length; }
  get firstChild(): StubEl | null { return this.children[0] ?? null; }
  get classList() {
    const s = this.classes;
    return {
      add: (c: string) => void s.add(c),
      remove: (c: string) => void s.delete(c),
      toggle: (c: string, on: boolean) => void (on ? s.add(c) : s.delete(c)),
      contains: (c: string) => s.has(c),
    };
  }
  appendChild(c: StubEl) {
    c.#detach();
    c.parentElement = this;
    this.children.push(c);
    return c;
  }
  append(...cs: StubEl[]) { for (const c of cs) this.appendChild(c); }
  remove() {
    this.removed++;
    this.#detach();
  }
  #detach() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
  blur() { this.blurred++; }
  focus() { this.focused++; }
  contains(n: unknown): boolean { return n === this || this.children.some((c) => c.contains(n)); }
  querySelector() { return null; }
  addEventListener(t: string, fn: Listener) {
    const set = this.listeners.get(t) ?? new Set<Listener>();
    this.listeners.set(t, set).get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Listener) { this.listeners.get(t)?.delete(fn); }
  emit(t: string, e: unknown = {}) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn(e as never); }
}

export interface KeyMods { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; shiftKey?: boolean }

export interface StubDom {
  /** Every element looked up or stood up by id. */
  readonly els: Map<string, StubEl>;
  /** The element with this id, made on first use. */
  el(id: string): StubEl;
  readonly body: StubEl;
  /** A keydown through every document keydown listener. */
  press(key: string, mods?: KeyMods): { defaultPrevented: boolean };
  /** Any other event through the document's listeners for its type. */
  dispatch(type: string, event?: object): void;
  /** Forget every element and document listener: one test's view, not the last's. */
  reset(): void;
}

type Entry = { fn: Listener; once: boolean };

/**
 * Install a stub `document` on globalThis.
 *
 * `lookup: "null"` makes getElementById answer null for an id nothing stood up
 * — for views that build their own elements and must be seen doing it. The
 * default stands one up on first lookup, as the page's markup would have.
 */
export function installStubDocument(opts: { lookup?: "create" | "null" } = {}): StubDom {
  const els = new Map<string, StubEl>();
  const listeners = new Map<string, Entry[]>();
  const el = (id: string) => els.get(id) ?? els.set(id, new StubEl()).get(id)!;
  const body = new StubEl();

  const dispatch = (type: string, event: object = {}) => {
    const list = listeners.get(type) ?? [];
    listeners.set(type, list.filter((l) => !l.once));
    for (const l of list) l.fn(event as never);
  };

  (globalThis as Record<string, unknown>).document = {
    body,
    getElementById: (id: string) => (opts.lookup === "null" ? els.get(id) ?? null : el(id)),
    createElement: () => new StubEl(),
    addEventListener: (t: string, fn: Listener, options?: boolean | { once?: boolean }) => {
      const list = listeners.get(t) ?? listeners.set(t, []).get(t)!;
      list.push({ fn, once: typeof options === "object" && !!options.once });
    },
    removeEventListener: (t: string, fn: Listener) => {
      const list = listeners.get(t);
      if (list) listeners.set(t, list.filter((l) => l.fn !== fn));
    },
  } as unknown as Document;

  return {
    els, el, body, dispatch,
    press(key, mods = {}) {
      const event = {
        key, ...mods, defaultPrevented: false,
        preventDefault() { event.defaultPrevented = true; },
      };
      dispatch("keydown", event);
      return event;
    },
    reset() {
      els.clear();
      listeners.clear();
    },
  };
}

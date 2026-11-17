// #messages keeps the newest line in view, but only for a reader already at
// the bottom: one scrolled up into history stays where they are. The unit
// suite runs in node with no layout engine, so the log is a fake whose
// scrollHeight grows by one line per child.
import { expect, it } from "vitest";
import { MAX_MESSAGES, appendMessage, keepNewestInView } from "../../../src/ui/hud/messageLog";

const LINE = 17.5;

function fakeLog(lines: number, visibleLines = 4) {
  const children: { remove(): void; textContent: string }[] = [];
  const log = {
    scrollTop: 0,
    clientHeight: visibleLines * LINE,
    get scrollHeight() { return Math.max(children.length * LINE, this.clientHeight); },
    get childElementCount() { return children.length; },
    get firstChild() { return children[0] ?? null; },
    appendChild(child: { textContent: string }) {
      const entry = { ...child, remove: () => children.splice(children.indexOf(entry), 1) };
      children.push(entry);
      return child;
    },
    children,
  };
  for (let i = 0; i < lines; i++) log.appendChild({ textContent: `old ${i}` });
  return log;
}

(globalThis as { document?: unknown }).document = {
  createElement: () => ({ textContent: "" }),
};

it("follows the newest line when the log was at the bottom", () => {
  const log = fakeLog(10);
  log.scrollTop = log.scrollHeight - log.clientHeight;
  appendMessage(log as unknown as HTMLElement, "new");
  expect(log.scrollTop).toBe(log.scrollHeight);
});

it("follows within the sub-pixel slack a browser leaves at the bottom", () => {
  const log = fakeLog(10);
  log.scrollTop = log.scrollHeight - log.clientHeight - 0.5;
  appendMessage(log as unknown as HTMLElement, "new");
  expect(log.scrollTop).toBe(log.scrollHeight);
});

it("leaves a reader who scrolled up into history where they are", () => {
  const log = fakeLog(10);
  log.scrollTop = LINE * 2;
  appendMessage(log as unknown as HTMLElement, "new");
  expect(log.scrollTop).toBe(LINE * 2);
});

it("follows from the first line, before the log can scroll at all", () => {
  const log = fakeLog(0);
  for (let i = 0; i < 8; i++) appendMessage(log as unknown as HTMLElement, `line ${i}`);
  expect(log.scrollTop).toBe(8 * LINE);
});

it("keeps at most MAX_MESSAGES lines, dropping the oldest", () => {
  const log = fakeLog(MAX_MESSAGES);
  appendMessage(log as unknown as HTMLElement, "newest");
  expect(log.childElementCount).toBe(MAX_MESSAGES);
  expect(log.children[0]!.textContent).toBe("old 1");
  expect(log.children.at(-1)!.textContent).toBe("newest");
});

it("an in-place rewrite of the last line also follows", () => {
  const log = fakeLog(10);
  log.scrollTop = log.scrollHeight - log.clientHeight;
  keepNewestInView(log as unknown as HTMLElement, () => log.appendChild({ textContent: "wrapped" }));
  expect(log.scrollTop).toBe(log.scrollHeight);
});

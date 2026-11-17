// index.html's #messages: the one message log every Module writes into.
//
// The newest line has to stay in view, or a message arrives below the fold and
// the player never sees it. But a player who scrolled up to reread history
// is reading, so a new line only pulls the log down when it was already at the
// bottom. "At the bottom" allows a few pixels of slack: browsers round
// scrollTop to device pixels, so a log scrolled fully down can still be a
// fraction short of scrollHeight.

const BOTTOM_SLACK_PX = 4;

/** The cap on lines kept in #messages; older lines are dropped from the top. */
export const MAX_MESSAGES = 200;

/** Runs `change` on the log, then scrolls it to the newest line if it was
 *  scrolled to the bottom before the change. */
export function keepNewestInView(log: HTMLElement, change: () => void): void {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight <= BOTTOM_SLACK_PX;
  change();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

/** Appends one line of `text` to `log`, trims it to MAX_MESSAGES and keeps
 *  the newest line in view. Returns the new line's element. */
export function appendMessage(log: HTMLElement, text: string): HTMLDivElement {
  const line = document.createElement("div");
  line.textContent = text;
  keepNewestInView(log, () => {
    log.appendChild(line);
    while (log.childElementCount > MAX_MESSAGES) log.firstChild!.remove();
  });
  return line;
}

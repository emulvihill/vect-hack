/**
 * Return exactly the newly consumed key records once all are present.
 * Surplus input is a gate failure, never something to slice away: an extra
 * command can be blocked in-game and leave no visible movement evidence.
 */
export function exactNewKeys(keys, before, expected) {
  const consumed = keys.length - before;
  if (consumed < expected) return null;
  if (consumed > expected) {
    throw new Error(`Moria consumed ${consumed} keys, expected exactly ${expected}`);
  }
  return keys.slice(before);
}

/** Keep the transcript on the latest turn unless the user scrolled away. */

export function pinnedToLatest(el: { scrollHeight: number; scrollTop: number; clientHeight: number }, slack: number): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/**
 * Layout growth (images, earlier turns) must not unpin. Only a user scroll
 * away from the bottom does. Reaching the bottom always pins again.
 */
export function followLatestTurn(input: {
  following: boolean;
  atBottom: boolean;
  userInitiated: boolean;
}): boolean {
  if (input.atBottom) return true;
  if (input.userInitiated) return false;
  return input.following;
}

export function pinToLatest(el: { scrollHeight: number; scrollTop: number }): void {
  el.scrollTop = el.scrollHeight;
}

export function pinnedToTop(el: { scrollTop: number }, slack: number): boolean {
  return el.scrollTop <= slack;
}

/** Reach the top of a long chat (not a short thread that is both top and bottom). */
export function shouldLoadEarlierTurns(input: {
  hasEarlier: boolean;
  loading: boolean;
  atTop: boolean;
  atBottom: boolean;
}): boolean {
  return input.hasEarlier && !input.loading && input.atTop && !input.atBottom;
}

/** Keep the same turns in view when earlier history is prepended. */
export function keepScrollThroughPrepend(
  el: { scrollTop: number; scrollHeight: number },
  previousHeight: number,
): void {
  if (previousHeight <= 0) return;
  const grown = el.scrollHeight - previousHeight;
  if (grown > 0) el.scrollTop += grown;
}

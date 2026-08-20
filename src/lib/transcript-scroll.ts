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

export function countTurnsAboveViewport(
  turns: Array<{ bottom: number }>,
  viewportTop: number,
): number {
  let count = 0;
  for (const turn of turns) {
    if (turn.bottom < viewportTop) count += 1;
    else break;
  }
  return count;
}

/**
 * Page in the next older window when fewer than `lookahead` loaded turns
 * remain above the fold. Stay put at the latest turn (atBottom).
 */
export function shouldLoadEarlierWindow(input: {
  hasEarlier: boolean;
  loading: boolean;
  atBottom: boolean;
  turnsAboveViewport: number;
  lookahead: number;
}): boolean {
  if (!input.hasEarlier || input.loading || input.atBottom) return false;
  return input.turnsAboveViewport < input.lookahead;
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

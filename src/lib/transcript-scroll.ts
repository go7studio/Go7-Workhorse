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

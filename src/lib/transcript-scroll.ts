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

export type FrameClock = {
  frame: (run: () => void) => number;
  cancelFrame: (handle: number) => void;
};

/**
 * One pin per frame, however many tokens land in it. `pinToLatest` reads
 * `scrollHeight` and writes `scrollTop`, which forces layout, so calling it
 * once per streamed token is a forced layout per token. Requests inside the
 * same frame collapse into the one that is already scheduled.
 */
export function createPinScheduler(
  pin: () => void,
  clock: FrameClock,
): { request: () => void; stop: () => void } {
  let handle = 0;
  let waiting = false;
  return {
    request() {
      if (waiting) return;
      waiting = true;
      handle = clock.frame(() => {
        waiting = false;
        handle = 0;
        pin();
      });
    },
    stop() {
      if (waiting) clock.cancelFrame(handle);
      waiting = false;
      handle = 0;
    },
  };
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
  scrollTop?: number;
  leadPx?: number;
}): boolean {
  if (!input.hasEarlier || input.loading || input.atBottom) return false;
  if (input.scrollTop != null && input.leadPx != null && input.scrollTop <= input.leadPx) return true;
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

export type ScrollAnchor = { id: string; top: number };

/** The first painted turn that intersects or sits below the viewport top. */
export function captureScrollAnchor(
  turns: Array<{ id: string; top: number; bottom: number }>,
  viewportTop: number,
): ScrollAnchor | null {
  if (turns.length === 0) return null;
  for (const turn of turns) {
    if (turn.bottom > viewportTop) return { id: turn.id, top: turn.top };
  }
  const last = turns[turns.length - 1];
  return { id: last.id, top: last.top };
}

/**
 * Put the anchored turn back at the same screen Y after older turns (or
 * late markdown/images) change height above it. Returns false when there
 * is no matching turn so a height-delta fallback can run.
 */
export function keepViewportOnAnchor(
  el: { scrollTop: number },
  turns: Array<{ id: string; top: number }>,
  anchor: ScrollAnchor | null,
): boolean {
  if (!anchor) return false;
  const current = turns.find((turn) => turn.id === anchor.id);
  if (!current) return false;
  const delta = current.top - anchor.top;
  if (delta !== 0) el.scrollTop += delta;
  return true;
}

/**
 * The turn the user is looking at, plus how far its top sits from the
 * scroller's scrollTop. Re-applying that shift puts the same pixels back
 * on screen after older history or late images change height.
 */
export type ViewportLock = { id: string; shift: number };

export function captureViewportLock(
  scrollTop: number,
  turns: Array<{ id: string; offsetTop: number; height: number }>,
): ViewportLock | null {
  if (turns.length === 0) return null;
  let chosen = turns[0];
  for (const turn of turns) {
    if (turn.offsetTop + turn.height > scrollTop) {
      chosen = turn;
      break;
    }
    chosen = turn;
  }
  return { id: chosen.id, shift: chosen.offsetTop - scrollTop };
}

export function restoreViewportLock(
  el: { scrollTop: number },
  turn: { offsetTop: number } | undefined,
  lock: ViewportLock | null,
): boolean {
  if (!lock || !turn) return false;
  el.scrollTop = turn.offsetTop - lock.shift;
  return true;
}

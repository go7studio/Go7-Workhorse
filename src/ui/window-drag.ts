import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Move the frameless window from a header drag.
 * -webkit-app-region does not receive the pointer on the word or the feed age
 * when a no-drag ancestor is in the way, and on this desk the caption overlay
 * only drags the top title bar. These events move the window that sent them.
 */
function point(event: ReactPointerEvent): { screenX: number; screenY: number } {
  return { screenX: event.screenX, screenY: event.screenY };
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, a, input, textarea, select"));
}

export function windowDragProps() {
  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0 || isControl(event.target)) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      window.workhorse?.beginWindowDrag?.(point(event));
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      window.workhorse?.moveWindowDrag?.(point(event));
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      window.workhorse?.endWindowDrag?.();
    },
    onPointerCancel() {
      window.workhorse?.endWindowDrag?.();
    },
  };
}

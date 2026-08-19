export type MediaPaintItem = { allow: () => void };

export type MediaPaintQueue = {
  pending: MediaPaintItem[];
  frame: number | null;
};

export function createMediaPaintQueue(): MediaPaintQueue {
  return { pending: [], frame: null };
}

export function pumpMediaPaint(
  queue: MediaPaintQueue,
  schedule: (fn: () => void) => number,
  cancel: (id: number) => void,
): void {
  if (queue.frame != null) return;
  queue.frame = schedule(() => {
    queue.frame = null;
    const next = queue.pending.shift();
    if (next) next.allow();
    if (queue.pending.length > 0) pumpMediaPaint(queue, schedule, cancel);
  });
}

export function enqueueMediaPaint(
  queue: MediaPaintQueue,
  allow: () => void,
  schedule: (fn: () => void) => number,
  cancel: (id: number) => void,
): () => void {
  const item: MediaPaintItem = { allow };
  queue.pending.push(item);
  pumpMediaPaint(queue, schedule, cancel);
  return () => {
    const index = queue.pending.indexOf(item);
    if (index >= 0) queue.pending.splice(index, 1);
  };
}

export function resetMediaPaint(queue: MediaPaintQueue, cancel: (id: number) => void): void {
  queue.pending = [];
  if (queue.frame != null) cancel(queue.frame);
  queue.frame = null;
}

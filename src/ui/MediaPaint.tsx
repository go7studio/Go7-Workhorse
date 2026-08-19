import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createMediaPaintQueue, enqueueMediaPaint, resetMediaPaint } from "../lib/media-paint";

type MediaPaintApi = {
  enqueue: (allow: () => void) => () => void;
};

const MediaPaintContext = createContext<MediaPaintApi | null>(null);

export function MediaPaintProvider({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  const queue = useRef(createMediaPaintQueue());
  const generation = useRef(0);
  const enqueue = useCallback((allow: () => void) => {
    const mine = generation.current;
    return enqueueMediaPaint(
      queue.current,
      () => {
        if (generation.current === mine) allow();
      },
      (fn) => requestAnimationFrame(fn),
      (id) => cancelAnimationFrame(id),
    );
  }, []);
  useEffect(() => {
    generation.current += 1;
    resetMediaPaint(queue.current, (id) => cancelAnimationFrame(id));
  }, [resetKey]);
  return <MediaPaintContext.Provider value={{ enqueue }}>{children}</MediaPaintContext.Provider>;
}

export function useMediaPaintReady(): boolean {
  const api = useContext(MediaPaintContext);
  const [ready, setReady] = useState(!api);
  useEffect(() => {
    if (!api || ready) return;
    return api.enqueue(() => setReady(true));
  }, [api, ready]);
  return ready;
}

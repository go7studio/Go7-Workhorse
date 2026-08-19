import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from "react";
import type { Store } from "./store";

export const StoreContext = createContext<Store | null>(null);

export type StoreRuntime = {
  getSnapshot: () => Store;
  subscribe: (listener: () => void) => () => void;
};

export const StoreRuntimeContext = createContext<StoreRuntime | null>(null);

export function useStore(): Store {
  const value = useContext(StoreContext);
  if (!value) throw new Error("useStore must be used inside StoreProvider");
  return value;
}

/**
 * Subscribe to one desk slice instead of waking for every streamed token.
 * The selected value is held when `isEqual` says its visible inputs did not
 * change, so unrelated chats never repaint this surface.
 */
export function useStoreSelector<T>(
  selector: (store: Store) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const runtime = useContext(StoreRuntimeContext);
  if (!runtime) throw new Error("useStoreSelector must be used inside StoreProvider");
  const cache = useRef<{ store: Store; value: T } | null>(null);
  const read = useCallback(() => {
    const store = runtime.getSnapshot();
    const current = cache.current;
    if (current?.store === store) return current.value;
    const next = selector(store);
    if (current && isEqual(current.value, next)) {
      cache.current = { store, value: current.value };
      return current.value;
    }
    cache.current = { store, value: next };
    return next;
  }, [runtime, selector, isEqual]);
  return useSyncExternalStore(runtime.subscribe, read, read);
}

/** Read the newest desk snapshot for demand-driven work such as search. */
export function useStoreReader(): () => Store {
  const runtime = useContext(StoreRuntimeContext);
  if (!runtime) throw new Error("useStoreReader must be used inside StoreProvider");
  return runtime.getSnapshot;
}

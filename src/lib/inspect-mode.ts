import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function inspectIsOpen(): boolean {
  return open;
}

export function setInspectOpen(next: boolean) {
  open = next;
  if (!next && typeof window !== "undefined" && window.location.hash === "#inspect") {
    const nextUrl = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, "", nextUrl);
  }
  emit();
}

export function useInspectOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    inspectIsOpen,
    inspectIsOpen,
  );
}

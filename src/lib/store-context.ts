import { createContext, useContext } from "react";
import type { Store } from "./store";

export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const value = useContext(StoreContext);
  if (!value) throw new Error("useStore must be used inside StoreProvider");
  return value;
}

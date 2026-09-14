import type { Panel } from "./types";

/**
 * The panel a launch comes back to.
 *
 * Settings survives a quit; Add Bot does not, and neither does the legacy
 * "usage" panel, which becomes Settings on the Usage section instead. One
 * home, because two readers need the same answer: the loader, which restores
 * it, and the persist guard, which asks whether a change to it is worth
 * writing the desk for.
 */
export function restoredPanel(value: unknown): Panel {
  return value === "usage" || value === "settings" ? "settings" : null;
}

import type { LlmLink, ProviderId } from "./types";
import { vendorEnabled } from "./settings";

const VENDOR_NAMES: Record<Exclude<ProviderId, "custom">, string> = { grok: "Grok", codex: "Codex", claude: "Claude", cursor: "Cursor" };

/** The short word under a vendor's name on its Settings card. */
export function llmCardHint(id: Exclude<ProviderId, "custom">, link: LlmLink): string {
  if (!vendorEnabled(link)) return "Disabled";
  // Keep the desk token problem visible even when Claude can use a CLI login.
  if (link.authProblem && (id === "claude" || link.needsAuth)) return "Sign in again";
  // Installed but signed out is a different problem from missing, and the
  // only one the person can fix from here.
  if (link.needsAuth && !link.connected) return "Needs auth";
  if (link.available === false) return "Not found";
  if (id === "grok" || id === "codex" || id === "claude" || id === "cursor") return "Local login";
  return "Marked";
}

/** The one line under the card that says what to do next. */
export function llmDetailCopy(id: Exclude<ProviderId, "custom">, link: LlmLink): string {
  if (link.connected && link.enabled === false) {
    return "Disabled for new chats.";
  }
  // A vendor that is signed in and cannot start reads as ready everywhere else
  // on this row. The reason is one line the detector already wrote, so the meta
  // line says that instead of promising a launch that will throw.
  // No usable login outranks a missing binary: it is the one thing the person
  // fixes from this card, and the vendor's own reason says why.
  if (link.authProblem && (id === "claude" || link.needsAuth)) {
    return `${VENDOR_NAMES[id]} refused the desk's login: ${link.authProblem}. ${id === "claude" ? "Log in with Claude mints a new one." : "Sign in again, then Recheck."}`;
  }
  if (link.needsAuth) {
    if (id === "claude") return "Not signed in. Log in with Claude mints a token for this desk.";
    if (id === "cursor") return "Sign in to Cursor Agent, then Recheck.";
    return "Not signed in. Sign in, then Recheck.";
  }
  if (link.launchable === false && link.launchBlocker) return `${link.launchBlocker}. Install it, then Recheck.`;
  const found = link.available ?? link.connected;
  if (id === "grok") {
    return found ? "Local Grok ready." : "Grok not found.";
  }
  if (id === "codex") {
    return found
      ? "Local Codex ready."
      : "Codex not found.";
  }
  if (id === "claude") {
    return found
      ? "Local Claude ready."
      : "Claude not found.";
  }
  if (id === "cursor") {
    return found || link.connected ? "Local Cursor Agent ready." : "Cursor ACP binary or login not found.";
  }
  return found ? "Marked for a future adapter" : "Not connected";
}

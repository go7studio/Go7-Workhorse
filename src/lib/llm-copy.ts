import type { LlmLink, ProviderId } from "./types";
import { vendorEnabled } from "./settings";

/** The short word under a vendor's name on its Settings card. */
export function llmCardHint(id: Exclude<ProviderId, "custom">, link: LlmLink): string {
  if (!vendorEnabled(link)) return "Disabled";
  // The vendor refused the login the desk holds. That is the one state where
  // the person must act here, so it outranks the artifact that still exists.
  if (link.needsAuth && link.authProblem) return "Sign in again";
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
    if (link.needsAuth && link.authProblem) return `Claude refused the desk's login: ${link.authProblem}. Log in with Claude mints a new one.`;
    return found
      ? "Local Claude ready."
      : "Claude not found.";
  }
  if (id === "cursor") {
    if (link.needsAuth && !link.connected) return "Sign in to Cursor Agent, then Recheck.";
    return found || link.connected ? "Local Cursor Agent ready." : "Cursor ACP binary or login not found.";
  }
  return found ? "Marked for a future adapter" : "Not connected";
}

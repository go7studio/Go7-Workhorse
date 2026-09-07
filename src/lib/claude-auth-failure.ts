/**
 * Whether an error from a Claude call is the vendor refusing the login, and
 * the one line worth showing for it. Narrow on purpose: a rate limit, a full
 * context or a dropped pipe is a chat problem, and must not send the person
 * to sign in again.
 */
const REFUSALS = [/failed to authenticate/i, /oauth session expired/i, /not logged in/i, /invalid (?:api key|token)/i, /authentication_error/i, /unauthori[sz]ed/i];

export function claudeAuthFailure(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message || !REFUSALS.some((shape) => shape.test(message))) return null;
  const reason = (message.match(/failed to authenticate:\s*(.+)$/is)?.[1] ?? message)
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^(?:Error:\s*)+/i, "")
    .replace(/^Internal error:\s*/i, "")
    .trim()
    .split(/\r?\n/, 1)[0]
    .slice(0, 160);
  return reason || "The login was refused";
}

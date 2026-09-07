/**
 * Workhorse's own Claude token, read straight from the desk's encrypted vault.
 *
 * It used to be copied onto the desk's `process.env` so the Claude child would
 * inherit it. `process.env` is shared by every vendor child, so a Codex, Cursor
 * or Grok chat could print the user's Claude login, and so could every MCP
 * server and shell those agents started. The token now reaches the Claude
 * launch spec's own env and nothing else.
 *
 * Main owns the vault, and these readers live in modules that must stay
 * testable without Electron, so main registers the reader once at startup.
 * Until it does — and in every test — there is no stored token.
 */
let readStoredToken: () => string | null = () => null;

export function setStoredClaudeTokenReader(reader: () => string | null): void {
  readStoredToken = reader;
}

/** The vault token, or null. Never throws: a locked vault is simply no login. */
export function storedClaudeToken(): string | null {
  try {
    const token = readStoredToken()?.trim();
    return token ? token : null;
  } catch {
    return null;
  }
}

import { createHash } from "node:crypto";

type Refusal = { fingerprint: string; reason: string; at: string };
let rejected: Refusal | null = null;
let store: { read: () => string | null; write: (text: string | null) => void } | null = null;

/**
 * A token names itself here by a hash, never by its value. The refusal has to
 * outlive the process — a desk that has just started would otherwise show a
 * dead login as On until something failed — and a file holding the credential
 * would be a second place to leak it.
 */
export function claudeTokenFingerprint(token: string | null): string {
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "none";
}

/**
 * Where the refusal is kept between runs. Main wires this to a file under
 * userData; tests wire it to memory, and an unwired desk simply forgets, which
 * is what the desk did before.
 */
export function setClaudeRefusalStore(io: { read: () => string | null; write: (text: string | null) => void } | null): void {
  store = io;
  rejected = null;
  let raw: string | null = null;
  try {
    raw = io?.read() ?? null;
  } catch {
    // A note the desk cannot read is a desk that forgets, not a desk that
    // fails to start.
    return;
  }
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Partial<Refusal>;
    if (typeof parsed.fingerprint === "string" && typeof parsed.reason === "string" && parsed.reason.trim()) {
      rejected = { fingerprint: parsed.fingerprint, reason: parsed.reason, at: typeof parsed.at === "string" ? parsed.at : "" };
    }
  } catch {
    /* a torn file is no refusal */
  }
}

function keep(): void {
  try {
    store?.write(rejected ? JSON.stringify(rejected) : null);
  } catch {
    /* a desk that cannot write still knows within this run */
  }
}

/**
 * Claude refused the desk's login. Remembered against the token that was
 * refused, so minting a new one clears it on its own, and written down, so a
 * restart does not turn a dead login back into a green card.
 */
export function markClaudeTokenRejected(reason: string, current: string | null = storedClaudeToken()): void {
  const text = reason.trim();
  rejected = text ? { fingerprint: claudeTokenFingerprint(current), reason: text, at: new Date().toISOString() } : null;
  keep();
}

/** Why the current login cannot be used, or null once a different token is stored. */
export function claudeTokenProblem(current: string | null = storedClaudeToken()): string | null {
  return rejected && rejected.fingerprint === claudeTokenFingerprint(current) ? rejected.reason : null;
}

/**
 * The login just worked. A refusal is a claim about a token, and this is the
 * same claim answered the other way, so it goes: otherwise one blip — a proxy,
 * a clock, an incident at the vendor — would leave a good login reading Sign
 * in again for good, since nothing else clears it.
 */
export function clearClaudeTokenRejection(current: string | null = storedClaudeToken()): void {
  if (!rejected || rejected.fingerprint !== claudeTokenFingerprint(current)) return;
  rejected = null;
  keep();
}

export function resetClaudeTokenRejection(): void {
  rejected = null;
  keep();
}

/**
 * Recheck's word. A refusal remembered with no desk token of its own is the
 * CLI login's, and the person may have signed that in again; one keyed to a
 * desk token stays until a different token is stored.
 */
export function forgetClaudeRefusalWithoutToken(): void {
  if (rejected && rejected.fingerprint === claudeTokenFingerprint(null)) {
    rejected = null;
    keep();
  }
}

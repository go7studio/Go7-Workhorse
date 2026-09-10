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

type Refusal = { fingerprint: string; reason: string; at: string; source: "usage" | "launch" };
const rejected = new Map<string, Refusal>();
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
  rejected.clear();
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
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed?.refusals) ? parsed.refusals : [parsed];
    for (const row of rows) {
      if (typeof row?.fingerprint !== "string" || typeof row.reason !== "string" || !row.reason.trim()) continue;
      // Older meters wrote no source. Migrate only their known refusal copy.
      const usage = row.source === "usage" || (!row.source && /usage token|refused the desk's login \((?:401|403)\)/i.test(row.reason));
      rejected.set(row.fingerprint, {
        fingerprint: row.fingerprint, reason: row.reason,
        at: typeof row.at === "string" ? row.at : "",
        source: usage ? "usage" : "launch",
      });
    }
  } catch {
    /* a torn file is no refusal */
  }
}

function keep(): void {
  try {
    store?.write(rejected.size ? JSON.stringify({ refusals: [...rejected.values()] }) : null);
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
  markClaudeCredentialRejected(reason, claudeTokenFingerprint(current));
}

/** The launch carries this identity, never a credential value, to its handler. */
export function markClaudeCredentialRejected(reason: string, fingerprint: string): void {
  const text = reason.trim();
  if (text) rejected.set(fingerprint, { fingerprint, reason: text, at: new Date().toISOString(), source: "launch" });
  else rejected.delete(fingerprint);
  keep();
}

export function claudeCredentialProblem(fingerprint: string): string | null {
  const refusal = rejected.get(fingerprint);
  return refusal?.source === "launch" ? refusal.reason : null;
}

/** Why this login cannot be used. Other credentials retain their own records. */
export function claudeTokenProblem(current: string | null = storedClaudeToken()): string | null {
  return claudeCredentialProblem(claudeTokenFingerprint(current));
}

/** A refused meter is suspect, but it is not evidence that inference fails. */
export function markClaudeMeterTokenSuspect(reason: string, current: string | null): void {
  if (claudeTokenProblem(current)) return;
  const fingerprint = claudeTokenFingerprint(current);
  rejected.set(fingerprint, { fingerprint, reason, at: new Date().toISOString(), source: "usage" });
  keep();
}

export function claudeMeterTokenProblem(current: string | null): string | null {
  const refusal = rejected.get(claudeTokenFingerprint(current));
  return refusal?.source === "usage" ? refusal.reason : null;
}

/**
 * The login just worked. A refusal is a claim about a token, and this is the
 * same claim answered the other way, so it goes: otherwise one blip — a proxy,
 * a clock, an incident at the vendor — would leave a good login reading Sign
 * in again for good, since nothing else clears it.
 */
export function clearClaudeTokenRejection(current: string | null = storedClaudeToken()): void {
  clearClaudeCredentialRejection(claudeTokenFingerprint(current));
}

export function clearClaudeCredentialRejection(fingerprint: string): void {
  if (rejected.delete(fingerprint)) keep();
}

export function resetClaudeTokenRejection(): void {
  rejected.clear();
  keep();
}

/** Recheck retries the CLI store without forgiving a refused desk token. */
export function forgetClaudeRefusalWithoutToken(): void {
  clearClaudeCredentialRejection(claudeTokenFingerprint(null));
}

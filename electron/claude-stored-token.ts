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

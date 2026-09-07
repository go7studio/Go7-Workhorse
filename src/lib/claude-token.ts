/**
 * The shape of a Claude token. Shared, because two paths produce one: the
 * sign-in the desk runs itself, and a token the person mints in their own
 * terminal and pastes in.
 */
export const CLAUDE_OAUTH_TOKEN_PATTERN = /\bsk-ant-[A-Za-z0-9_-]{20,}\b/;

/** The command a person runs in their own terminal to mint one. */
export const CLAUDE_SETUP_TOKEN_COMMAND = "claude setup-token";

export function looksLikeClaudeToken(value: string | null | undefined): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /\s/.test(text)) return false;
  return CLAUDE_OAUTH_TOKEN_PATTERN.test(text);
}

/** What went wrong, in the words the card shows. Null when the token is usable. */
export function claudeTokenComplaint(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "Paste the token the command printed.";
  if (looksLikeClaudeToken(text)) return null;
  if (/\s/.test(text)) return "That looks like more than the token. Paste only the sk-ant-… line.";
  return "A Claude token starts with sk-ant- and is longer than that.";
}

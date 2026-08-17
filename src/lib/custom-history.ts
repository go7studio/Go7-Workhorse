import type { ChatMessage } from "./types";

/**
 * What a custom HTTP bot is told about the conversation so far.
 *
 * ACP vendors keep their own session and reload it by id, so Grok, Claude,
 * Codex and Cursor remember without help. A custom bot has no session: every
 * request carries the whole conversation or none of it, and Workhorse sent
 * `history: []` — so a custom bot answered every message as if it were the
 * first. Kimi and MiniMax were not forgetful; they were never told.
 *
 * Only plain text is replayed, never tool calls. Both dialects require an
 * assistant `tool_use` to be answered by a matching `tool_result` in the very
 * next message, and the desk stores tool activity as its own system messages
 * without the pairing — so a faithful replay is not reconstructible, while an
 * unfaithful one is a 400. Text-only is always valid in both.
 */
export type CustomHistoryMessage = { role: "user" | "assistant"; text: string };

/** Roughly 4 characters a token; a generous slice that still leaves room to answer. */
export const CUSTOM_HISTORY_MAX_CHARS = 60_000;

/**
 * Desk-authored lines that were never the model speaking. Replaying them
 * teaches a bot that it says "Stopped." when it has nothing to add.
 */
function isDeskNotice(text: string): boolean {
  const line = text.trim();
  return (
    line === "Stopped." ||
    /finished without a visible reply\.$/.test(line) ||
    /^Preview only\./.test(line) ||
    /^(Grok|Claude|Codex|Cursor|Custom) agent failed:/.test(line)
  );
}

export function customChatHistory(
  messages: ChatMessage[],
  options?: { maxChars?: number },
): CustomHistoryMessage[] {
  const maxChars = options?.maxChars ?? CUSTOM_HISTORY_MAX_CHARS;

  // Only what was actually said. Tool, thought, compact, peer and subagent
  // messages are the desk's own record of the turn, not the conversation.
  const spoken: CustomHistoryMessage[] = [];
  for (const message of messages) {
    if (message.kind) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = (message.text ?? "").trim();
    if (!text) continue;
    if (message.role === "assistant" && isDeskNotice(text)) continue;
    spoken.push({ role: message.role, text });
  }

  // A trailing user turn with no answer is the turn being sent right now — it
  // arrives as the prompt itself, so replaying it would ask the same thing
  // twice. Dropping it is right whether or not the caller has appended it yet.
  while (spoken.length > 0 && spoken[spoken.length - 1]!.role === "user") spoken.pop();

  // Keep the most recent conversation that fits, oldest dropped first.
  let total = 0;
  const kept: CustomHistoryMessage[] = [];
  for (let index = spoken.length - 1; index >= 0; index -= 1) {
    const message = spoken[index]!;
    total += message.text.length;
    if (total > maxChars && kept.length > 0) break;
    kept.unshift(message);
  }

  // Anthropic requires the first message to be from the user, so a trim that
  // lands on an assistant reply would be rejected outright.
  while (kept.length > 0 && kept[0]!.role === "assistant") kept.shift();
  return kept;
}

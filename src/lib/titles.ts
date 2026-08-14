import type { Session } from "./types";

const DEFAULT_TITLES = new Set(["new chat", "untitled", "untitled chat"]);

export function isDefaultTitle(title: string | undefined): boolean {
  return !title || DEFAULT_TITLES.has(title.trim().toLowerCase());
}

export function cleanTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "").trim();
}

/** First six words of the player's prompt; "..." if it ran longer. */
export function titleFromPrompt(text: string): string {
  const words = text.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (words.length === 0) return "New chat";
  if (words.length <= 6) return words.join(" ");
  return `${words.slice(0, 6).join(" ")}...`;
}

export function looksLikePromptSlice(title: string, prompt: string): boolean {
  const next = titleFromPrompt(prompt);
  const fold = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  return fold(title) === fold(next) || fold(title) === fold(next.replace(/\.\.\.$/, ""));
}

export function applyAutoTitle(current: string, next: string | undefined, locked?: boolean): string | undefined {
  if (locked) return undefined;
  const cleaned = next?.trim() ?? "";
  if (!cleaned || cleaned === current) return undefined;
  return cleaned;
}

export function autoTitleForSend(
  session: Pick<Session, "title" | "titleLocked" | "messages">,
  prompt: string,
): string | undefined {
  if (session.titleLocked) return undefined;
  const first = session.messages.find((message) => message.role === "user")?.text;
  if (first && !isDefaultTitle(session.title) && !looksLikePromptSlice(session.title, first)) return undefined;
  return applyAutoTitle(session.title, titleFromPrompt(prompt || "Image"), session.titleLocked);
}

export function suggestedTitleForSession(session: Pick<Session, "title" | "titleLocked" | "messages">): string | undefined {
  if (session.titleLocked) return undefined;
  const first = session.messages.find((message) => message.role === "user")?.text;
  if (!first) return undefined;
  return applyAutoTitle(session.title, titleFromPrompt(first), false);
}

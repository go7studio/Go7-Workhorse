import type { Session } from "./types";

const DEFAULT_TITLES = new Set(["new chat", "untitled", "untitled chat"]);
/** Cursor ACP session/new often names every chat this. Not a generated title. */
const GENERIC_VENDOR_TITLES = new Set(["cursor agent guide", "cursor agent", "agent guide", "cursor"]);
const TITLE_MAX_CHARS = 48;
const TITLE_MAX_WORDS = 8;
const PING_TITLE = "Availability check";

const TASK_HINT =
  /\b(fix|implement|build|refactor|debug|write|code|login|error|file|project|function|component|bug|game|access|redirect|settings|webhook|sidebar|title)\b/;

export function foldedTitle(title: string | undefined): string {
  return (title ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function isGenericVendorTitle(title: string | undefined): boolean {
  return GENERIC_VENDOR_TITLES.has(foldedTitle(title));
}

export function isDefaultTitle(title: string | undefined): boolean {
  const folded = foldedTitle(title);
  return !folded || DEFAULT_TITLES.has(folded) || GENERIC_VENDOR_TITLES.has(folded);
}

export function cleanTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "").trim();
}

function fold(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Raw first-six-words slice. Kept so hydrate can still recognize old sidebar titles. */
export function titleFromPrompt(text: string): string {
  const words = text.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (words.length === 0) return "New chat";
  if (words.length <= 6) return words.join(" ");
  return `${words.slice(0, 6).join(" ")}...`;
}

export function looksLikePromptSlice(title: string, prompt: string): boolean {
  const next = titleFromPrompt(prompt);
  return fold(title) === fold(next) || fold(title) === fold(next.replace(/\.\.\.$/, ""));
}

export function looksLikeIntentTitle(title: string, prompt: string): boolean {
  return fold(title) === fold(titleFromIntent(prompt));
}

export function looksLikePing(text: string): boolean {
  const folded = fold(text.replace(/[^\p{L}\p{N}\s?']/gu, " "));
  if (!folded || folded.length > 160) return false;
  if (TASK_HINT.test(folded)) return false;
  return (
    /^(hi|hey|hello|yo|sup|howdy|test|testing|ping|pong)(\b|$)/.test(folded) ||
    /\b(are you there|you there|can you hear me|anyone there|still there)\b/.test(folded)
  );
}

function hostFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    const bits = [host];
    for (const value of parsed.searchParams.values()) {
      if (value.trim()) bits.push(decodeURIComponent(value).replace(/[+_]/g, " "));
    }
    const hash = decodeURIComponent(parsed.hash.replace(/^#/, ""));
    const query = hash.match(/(?:^|[?&])q=([^&]+)/i)?.[1];
    if (query) bits.push(query.replace(/[+_]/g, " "));
    else if (hash && !hash.includes("=")) bits.push(hash);
    return bits.join(" ").replace(/\s+/g, " ").trim() || url;
  } catch {
    return url;
  }
}

function replaceUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s]+/gi, hostFromUrl);
}

function stripFiller(text: string): string {
  let next = text.replace(/\s+/g, " ").trim();
  let previous = "";
  while (next && next !== previous) {
    previous = next;
    next = next
      .replace(/^(please\s+)+/i, "")
      .replace(/^(hi|hey|hello|yo|sup|howdy)[,!.\s]+/i, "")
      .replace(/^(can|could|would|will)\s+you\s+(please\s+)?/i, "")
      .replace(/^(i\s+)?(just\s+)?(want|need|like)\s+(you\s+to\s+)?/i, "")
      .replace(/^help\s+me\s+(to\s+)?/i, "")
      .replace(/^(what|how|why|when|where|who)\s+(do|can|are|is|does|did|would|should|could)\s+(you\s+)?/i, "")
      .replace(/^do\s+you\s+/i, "")
      .replace(/(\s+(please|thanks|thank you|extra|for me|lol|tho|though|ok|okay))+$/i, "")
      .trim();
  }
  return next.replace(/[?!.,;:]+$/g, "").trim();
}

function dropLeadingArticle(text: string): string {
  const match = text.match(
    /^(fix|make|create|add|update|check|debug|implement|write|build|refactor|test)\s+(a|an|the)\s+(.+)$/i,
  );
  if (!match) return text;
  const rest = match[3].split(/\s+/).filter(Boolean);
  return rest.length >= 3 ? `${match[1]} ${match[3]}` : text;
}

function polishTitle(text: string): string {
  const words = cleanTitle(text)
    .replace(/[`*_#]/g, "")
    .replace(/[.?!]+$/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, TITLE_MAX_WORDS);
  let next = words.join(" ");
  if (next.length > TITLE_MAX_CHARS) {
    const clipped: string[] = [];
    for (const word of words) {
      const joined = clipped.length ? `${clipped.join(" ")} ${word}` : word;
      if (joined.length > TITLE_MAX_CHARS) break;
      clipped.push(word);
    }
    next = clipped.join(" ");
  }
  if (!next) return "New chat";
  return next.charAt(0).toUpperCase() + next.slice(1);
}

/**
 * Deterministic sidebar title from the first prompt. Same prompt → same title.
 * Strips greetings, pings, and filler, then keeps the remaining task words.
 * Never calls a model.
 */
export function titleFromIntent(text: string): string {
  const cleaned = cleanTitle(text);
  if (!cleaned) return "New chat";
  if (looksLikePing(cleaned)) return PING_TITLE;
  const reduced = dropLeadingArticle(stripFiller(replaceUrls(cleaned)));
  if (reduced) return polishTitle(reduced);
  const slice = cleaned.split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
  return slice ? polishTitle(slice) : "New chat";
}

export function firstUserText(session: Pick<Session, "messages">): string {
  return session.messages.find((message) => message.role === "user" && !message.kind)?.text ?? "";
}

/**
 * Hydrate / first-send placeholders that may still be replaced: defaults, the old
 * six-word slice, or the local intent title. Manual locks never upgrade.
 */
export function titleNeedsUpgrade(session: Pick<Session, "title" | "titleLocked" | "messages">): boolean {
  if (session.titleLocked) return false;
  if (isDefaultTitle(session.title)) return true;
  const first = firstUserText(session);
  if (!first) return false;
  return looksLikePromptSlice(session.title, first) || looksLikeIntentTitle(session.title, first);
}

/** A vendor may name an initial placeholder once; later metadata cannot retitle a live task. */
export function titleAcceptsVendor(session: Pick<Session, "title" | "titleLocked" | "messages">): boolean {
  return titleNeedsUpgrade(session);
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
  if (session.titleLocked || !isDefaultTitle(session.title)) return undefined;
  return applyAutoTitle(session.title, titleFromIntent(prompt || "Image"), session.titleLocked);
}

export function suggestedTitleForSession(session: Pick<Session, "title" | "titleLocked" | "messages">): string | undefined {
  if (!titleNeedsUpgrade(session)) return undefined;
  const first = firstUserText(session);
  if (!first) return undefined;
  return applyAutoTitle(session.title, titleFromIntent(first), false);
}

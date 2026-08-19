import { APP_VERSION } from "./app-info";

/** Truthful Workhorse client. Never impersonate Claude Code, Cursor, or another tool. */
export function workhorseUserAgent(): string {
  return `Go7-Workhorse/${APP_VERSION}`;
}

/** Documented Gemini partner id: company-product/version, `-oai` on the OpenAI-compat path. */
export function geminiApiClient(): string {
  return `go7-workhorse-oai/${APP_VERSION}`;
}

function hostnameOf(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return "";
  try {
    return new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isKimiCodeUrl(baseUrl: string): boolean {
  return /(^|\.)kimi\.com$/i.test(hostnameOf(baseUrl));
}

export function isGeminiApiUrl(baseUrl: string): boolean {
  return /(^|\.)generativelanguage\.googleapis\.com$/i.test(hostnameOf(baseUrl));
}

export function customHttpIdentityHeaders(baseUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": workhorseUserAgent(),
  };
  if (isGeminiApiUrl(baseUrl)) headers["x-goog-api-client"] = geminiApiClient();
  return headers;
}

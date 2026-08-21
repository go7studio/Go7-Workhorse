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

const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i;

/** Grok Bot's custom HTTP preset lives on loopback. Other local shims use the same door. */
export function isGrokBotUrl(baseUrl: string): boolean {
  return LOOPBACK.test(hostnameOf(baseUrl));
}

/** Connection refused on the Grok Bot shim. Do not guess another host. */
export function grokBotShimDownMessage(baseUrl: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (!isGrokBotUrl(baseUrl)) return raw;
  if (!/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|network/i.test(raw)) return raw;
  return "Grok Bot shim is down. Do not guess another host.";
}

export function customHttpIdentityHeaders(baseUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": workhorseUserAgent(),
  };
  if (isGeminiApiUrl(baseUrl)) headers["x-goog-api-client"] = geminiApiClient();
  return headers;
}

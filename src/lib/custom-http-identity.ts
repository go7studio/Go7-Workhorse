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

/** The Grok Bot Custom HTTP preset. Other loopback hosts (Ollama, the desk bridge) are not this door. */
export const GROK_BOT_SHIM_PORT = "8787";

export function isGrokBotUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    if (!LOOPBACK.test(url.hostname.toLowerCase())) return false;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return port === GROK_BOT_SHIM_PORT;
  } catch {
    return false;
  }
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

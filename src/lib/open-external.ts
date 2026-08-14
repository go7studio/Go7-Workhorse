/** Only http(s) leaves the desk. javascript:, file:, and relative paths stay closed. */
export function safeExternalUrl(href: string): string | null {
  const value = href.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    return null;
  }
  return null;
}

import { isHollowHref } from "./markdown";

const MEDIA_SCHEME = "workhorse-media://local/?p=";

export type MediaDisplayContext = {
  cwd?: string;
  vendorSessionId?: string;
};

export function isPassThroughImageHref(href: string): boolean {
  return /^(data:|https?:)/i.test(String(href ?? "").trim());
}

export function pathToMediaUrl(filePath: string, context: MediaDisplayContext = {}): string {
  const params = new URLSearchParams();
  params.set("p", filePath);
  const cwd = context.cwd?.trim();
  const sid = context.vendorSessionId?.trim();
  if (cwd) params.set("cwd", cwd);
  if (sid) params.set("sid", sid);
  return `workhorse-media://local/?${params.toString()}`;
}

export function mediaUrlToPath(url: string): string | null {
  const raw = String(url ?? "").trim();
  if (!/^workhorse-media:/i.test(raw)) return null;
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
  const encoded = new URLSearchParams(query).get("p");
  if (encoded == null || !encoded.trim()) return null;
  return encoded;
}

export function mediaUrlContext(url: string): MediaDisplayContext {
  const raw = String(url ?? "").trim();
  if (!/^workhorse-media:/i.test(raw)) return {};
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
  const params = new URLSearchParams(query);
  const cwd = params.get("cwd")?.trim() || undefined;
  const vendorSessionId = params.get("sid")?.trim() || undefined;
  return { ...(cwd ? { cwd } : {}), ...(vendorSessionId ? { vendorSessionId } : {}) };
}

function fileHrefToPath(href: string): string {
  let file = href;
  if (/^file:/i.test(file)) {
    file = file.replace(/^file:\/\//i, "");
    try {
      file = decodeURIComponent(file);
    } catch {
      // keep stripped form
    }
    // file:///C:/... → /C:/... ; Windows drive letters must keep the colon.
    if (file.startsWith("/") && /^[A-Za-z]:/.test(file.slice(1))) file = file.slice(1);
  }
  return file;
}

export function mdImageInitialSrc(href: string, context: MediaDisplayContext = {}): string {
  const raw = String(href ?? "").trim();
  if (!raw || isHollowHref(raw)) return "";
  if (isPassThroughImageHref(raw)) return raw;
  if (/^(blob:|workhorse-media:)/i.test(raw)) return raw;
  const file = fileHrefToPath(raw);
  if (!file.trim()) return "";
  return pathToMediaUrl(file, context);
}

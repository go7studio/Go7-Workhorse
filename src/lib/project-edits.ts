import { pathFromToolText, splitToolLine } from "./grok-events";
import type { ProviderId, Session } from "./types";

export type ProjectEdit = {
  path: string;
  name: string;
  folder: string;
  edits: number;
  at: number;
  provider: ProviderId;
};

const WRITE_TITLE =
  /^(write|edit|strreplace|str_replace|search_replace|search-replace|apply_patch|apply-patch|applypatch|create|save|update_file|update-file|replace|patch|insert)$/i;

const WRITE_HINT =
  /\b(write|writing|wrote|edit|editing|edited|strreplace|str_replace|search_replace|apply_patch|applypatch|apply(?:ing|ed)?\s*patch|update(?:d|s|_file)?|updating|replace|patch(?:ed|ing)?|insert|save)\b/i;

const READ_HINT = /^(read|reading|list|grep|glob|find|ls|cat|view|stat)\b/i;

export function isWriteToolTitle(title: string): boolean {
  const text = title.trim();
  if (!text) return false;
  const key = text.toLowerCase().replace(/[\s-]+/g, "_");
  if (READ_HINT.test(text) || READ_HINT.test(key)) return false;
  const head = key.split(/[\s_./\\]/)[0] ?? "";
  return WRITE_TITLE.test(head) || WRITE_HINT.test(text) || WRITE_HINT.test(key);
}

export function looksLikePath(value: string): boolean {
  const text = value.trim();
  if (!text || text.includes("\n")) return false;
  if (/^[A-Za-z]:[\\/]/.test(text)) return true;
  if (text.includes("/") || text.includes("\\")) return true;
  return /\.[a-z0-9]{1,8}$/i.test(text);
}

const SOURCE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|htm|py|rs|go|toml|ya?ml|sql|sh|bash|ps1|svg|txt|map|vue|svelte|kt|java|c|cc|cpp|h|hpp)$/i;

/** True for a workspace file mention such as preload.ts or electron/main.ts. */
export function looksLikeSourceFile(value: string): boolean {
  const text = value.trim().replace(/^file:\/\//i, "").replace(/^[`'"]+|[`'"]+$/g, "");
  if (!looksLikePath(text) || /^https?:\/\//i.test(text)) return false;
  return SOURCE_EXT.test(text);
}

/** Write rows may be `Write · completed — path` or `Write \`path\` · completed`. */
export function pathFromWriteTool(text: string): string {
  const extracted = pathFromToolText(text);
  if (looksLikePath(extracted)) return extracted;
  const { title } = splitToolLine(text);
  const rest = title.replace(WRITE_TITLE, "").replace(/^[`\s]+|[`\s]+$/g, "");
  return looksLikePath(rest) ? rest.trim() : "";
}

export function fileNameFromPath(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function fileFolderFromPath(path: string, roots: string[] = []): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  for (const root of roots) {
    const prefix = root.replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
    if (!prefix) continue;
    if (normalized.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) {
      const rel = normalized.slice(prefix.length + 1);
      const dir = rel.split("/").slice(0, -1).join("/");
      return dir || ".";
    }
  }
  const parts = normalized.replace(/\/+$/, "").split("/");
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

export function formatEditWhen(at: number, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (at >= today.getTime()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (at >= yesterday.getTime()) return "yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function projectEdits(sessions: Session[], folderRoots: string[] = []): ProjectEdit[] {
  const map = new Map<string, ProjectEdit>();
  for (const session of sessions) {
    for (const message of session.messages) {
      if (message.kind !== "tool") continue;
      const { title } = splitToolLine(message.text);
      const path = pathFromWriteTool(message.text);
      if (!isWriteToolTitle(title) || !path) continue;
      const key = path.replaceAll("\\", "/").toLowerCase();
      const current = map.get(key);
      if (current) {
        current.edits += 1;
        if (message.createdAt >= current.at) {
          current.at = message.createdAt;
          current.provider = session.provider;
        }
        continue;
      }
      map.set(key, {
        path,
        name: fileNameFromPath(path),
        folder: fileFolderFromPath(path, folderRoots),
        edits: 1,
        at: message.createdAt,
        provider: session.provider,
      });
    }
  }
  return mergeEdits([...map.values()], []);
}

export function editPathKey(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/{2,}/g, "/").toLowerCase();
}

export function sameEditPath(left: string, right: string): boolean {
  const a = editPathKey(left);
  const b = editPathKey(right);
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function mergeEdits(base: ProjectEdit[], extra: ProjectEdit[]): ProjectEdit[] {
  const out: ProjectEdit[] = [];
  for (const item of [...base, ...extra]) {
    const index = out.findIndex((row) => sameEditPath(row.path, item.path));
    if (index < 0) {
      out.push({ ...item });
      continue;
    }
    const current = out[index]!;
    out[index] = {
      ...current,
      ...item,
      path: item.path.length >= current.path.length ? item.path : current.path,
      edits: Math.max(current.edits, item.edits, 1),
      at: Math.max(current.at, item.at),
    };
  }
  return out.sort((a, b) => b.at - a.at);
}

import { pathFromToolText, splitToolLine } from "./grok-events";
import type { ProviderId, Session } from "./types";

export type FileChangeKind = "created" | "edited";

export type ProjectEdit = {
  path: string;
  name: string;
  folder: string;
  edits: number;
  at: number;
  provider: ProviderId;
  kind?: FileChangeKind;
};

const WRITE_TITLE =
  /^(write|writefile|edit|strreplace|str_replace|search_replace|search-replace|apply_patch|apply-patch|applypatch|create|created|creating|save|update_file|update-file|replace|patch|insert)$/i;

const WRITE_HINT =
  /\b(write|writing|wrote|edit|editing|edited|strreplace|str_replace|search_replace|apply_patch|applypatch|apply(?:ing|ed)?\s*patch|update(?:d|s|_file)?|updating|replace|patch(?:ed|ing)?|insert|save|created?|creating)\b/i;

const CREATE_HINT =
  /\b(write|writing|wrote|created?|creating|save[ds]?|saving)\b/i;

const READ_HINT = /^(read|reading|list|grep|glob|find|ls|cat|view|stat)\b/i;

export function isWriteToolTitle(title: string): boolean {
  const text = title.trim();
  if (!text) return false;
  const key = text.toLowerCase().replace(/[\s-]+/g, "_");
  if (READ_HINT.test(text) || READ_HINT.test(key)) return false;
  const head = key.split(/[\s_./\\]/)[0] ?? "";
  return WRITE_TITLE.test(head) || WRITE_HINT.test(text) || WRITE_HINT.test(key);
}

export function writeChangeKind(title: string, nearby = ""): FileChangeKind | null {
  if (!isWriteToolTitle(title)) return null;
  const text = title.trim();
  const key = text.toLowerCase().replace(/[\s-]+/g, "_");
  const head = key.split(/[\s_./\\]/)[0] ?? "";
  if (/^edit$/i.test(head) && !/\bfile\b/i.test(text)) return "edited";
  if (
    CREATE_HINT.test(text) ||
    CREATE_HINT.test(head) ||
    CREATE_HINT.test(nearby) ||
    /^(write|create|created|creating|save)$/i.test(head)
  ) {
    return "created";
  }
  return "edited";
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

/** Path from a completed write/edit tool event (title, detail, or write:path id). */
export function writePathFromToolEvent(title: string, detail = "", toolCallId = ""): string {
  const fromId = toolCallId.match(/^(?:edit|write):(.+)$/i)?.[1] ?? "";
  const line = detail ? `${title} — ${detail}` : title;
  return (
    pathFromWriteTool(line) ||
    pathFromWriteTool(detail) ||
    pathFromWriteTool(title) ||
    (looksLikePath(fromId) ? fromId : "")
  );
}

/** Write rows may be `Write · completed — path` or `Write \`path\` · completed`. */
export function pathFromWriteTool(text: string): string {
  const extracted = pathFromToolText(text);
  if (looksLikePath(extracted)) return extracted;
  const { title } = splitToolLine(text);
  const rest = title.replace(WRITE_TITLE, "").replace(/^[`\s]+|[`\s]+$/g, "");
  return looksLikePath(rest) ? rest.trim() : "";
}

/** Cursor/Composer often stores `Edit File · completed` with the path only in nearby thought/assistant text. */
export function pathFromNearbyWrite(text: string): string {
  const ticks = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]?.trim() ?? "");
  const named = [...text.matchAll(/\bnamed\s+([^\s`]+)/gi)].map((match) =>
    (match[1] ?? "").trim().replace(/[.,;:]+$/, ""),
  );
  for (const raw of [...ticks, ...named]) {
    if (looksLikeSourceFile(raw)) return raw;
  }
  return "";
}

function nearbyWriteContext(messages: Session["messages"], index: number): string {
  let start = index;
  while (start > 0 && messages[start - 1]?.role !== "user") start -= 1;
  let end = index;
  while (end + 1 < messages.length && messages[end + 1]?.role !== "user") end += 1;
  const parts: string[] = [];
  for (let i = start; i <= end; i += 1) {
    const message = messages[i];
    if (!message || i === index) continue;
    if (message.kind === "thought" || message.role === "assistant") parts.push(message.text);
  }
  return parts.join("\n");
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

function collectWrites(sessions: Session[], folderRoots: string[] = []): ProjectEdit[] {
  const map = new Map<string, ProjectEdit>();
  for (const session of sessions) {
    for (const [index, message] of session.messages.entries()) {
      if (message.kind !== "tool") continue;
      const { title } = splitToolLine(message.text);
      const nearby = nearbyWriteContext(session.messages, index);
      const fromId = (message.toolCallId ?? "").match(/^(?:edit|write):(.+)$/i)?.[1] ?? "";
      const path =
        pathFromWriteTool(message.text) ||
        (looksLikePath(fromId) ? fromId : "") ||
        pathFromNearbyWrite(nearby);
      const kind = writeChangeKind(title, nearby);
      if (!kind || !path) continue;
      const key = path.replaceAll("\\", "/").toLowerCase();
      const current = map.get(key);
      if (current) {
        current.edits += 1;
        if (message.createdAt >= current.at) {
          current.at = message.createdAt;
          current.provider = session.provider;
          if (kind === "edited") current.kind = "edited";
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
        kind,
      });
    }
  }
  return mergeEdits([...map.values()], []);
}

export function projectEdits(sessions: Session[], folderRoots: string[] = []): ProjectEdit[] {
  return collectWrites(sessions, folderRoots);
}

export function projectFileChanges(
  sessions: Session[],
  folderRoots: string[] = [],
): { created: ProjectEdit[]; edited: ProjectEdit[] } {
  const all = collectWrites(sessions, folderRoots);
  return {
    created: all.filter((item) => item.kind === "created"),
    edited: all.filter((item) => item.kind !== "created"),
  };
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

export type EditLineStat = { added: number; deleted: number };

/** Look up +/- by exact path or the same file under a longer/shorter path. */
export function statForPath(
  stats: Record<string, EditLineStat>,
  filePath: string,
): EditLineStat | undefined {
  if (Object.prototype.hasOwnProperty.call(stats, filePath)) return stats[filePath];
  for (const [key, value] of Object.entries(stats)) {
    if (sameEditPath(key, filePath)) return value;
  }
  return undefined;
}

/**
 * Keep last known +/- while a refresh is in flight. An empty next map is not
 * a real zero — only an explicit { added, deleted } replaces a path.
 */
export function holdEditStats(
  previous: Record<string, EditLineStat>,
  next: Record<string, EditLineStat> | null | undefined,
  paths: string[],
): Record<string, EditLineStat> {
  if (paths.length === 0) return previous;
  const incoming = next ?? {};
  const out: Record<string, EditLineStat> = {};
  for (const filePath of paths) {
    const fresh = statForPath(incoming, filePath);
    const prior = statForPath(previous, filePath);
    if (fresh) out[filePath] = fresh;
    else if (prior) out[filePath] = prior;
  }
  return out;
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
      kind: item.kind ?? current.kind,
    };
  }
  return out.sort((a, b) => b.at - a.at);
}

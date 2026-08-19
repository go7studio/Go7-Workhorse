import { hasLineBreak, pathFromToolText, splitToolLine, stripPathSizeSuffix } from "./grok-events";

export { stripPathSizeSuffix };
import type { ProviderId, Session } from "./types";

export type FileChangeKind = "created" | "edited";

export type ProjectEdit = {
  path: string;
  name: string;
  folder: string;
  edits: number;
  at: number;
  provider: ProviderId;
  customBotId?: string;
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

const PARENT_SHELL =
  /^(bash|shell|zsh|cmd|powershell|pwsh|terminal|exec|execute|run_command|runcommand|run_terminal_command|command)$/i;

/** Parent shell or patch work after a Workhorse dispatch. Not a worker’s own writes. */
export function isParentTakeoverTool(title: string): boolean {
  if (isWriteToolTitle(title)) return true;
  const key = title.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const head = key.split(/[./\\]/)[0] ?? "";
  return PARENT_SHELL.test(head);
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
  const text = stripPathSizeSuffix(value.trim());
  if (!text || hasLineBreak(text)) return false;
  if (isCitedAbsolutePath(text)) return true;
  if (text.includes("/") || text.includes("\\")) return true;
  return /\.[a-z0-9]{1,8}$/i.test(text);
}

/** Drive, UNC, or POSIX root. `C:\nothing.md` is a path, not a newline. */
export function isCitedAbsolutePath(value: string): boolean {
  const text = value.trim();
  if (!text || hasLineBreak(text)) return false;
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\")) return true;
  // `/Users/foo/bar`, not the `/file.ts` tail of a relative `src/file.ts`.
  return /^\/(?!\/)/.test(text) && text.split("/").filter(Boolean).length >= 2;
}

const CITED_ABS = /(?:^|[\s`"'([<])((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s`"'<>|*?]+)/g;

/** Absolute paths an agent typed in chat or a tool line. */
export function citedAbsolutePaths(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(CITED_ABS)) {
    const value = (match[1] ?? "").replace(/[.,;:)\]"]+$/, "");
    if (value && isCitedAbsolutePath(value)) out.push(value);
  }
  return out;
}

function joinCited(dir: string, rel: string): string {
  const win = dir.includes("\\") || dir.startsWith("\\\\") || /^[A-Za-z]:\\/.test(dir);
  const sep = win ? "\\" : "/";
  const base = dir.replace(/[\\/]+$/, "");
  const tail = rel.replace(/^[\\/]+/, "").replaceAll(win ? "/" : "\\", sep);
  return `${base}${sep}${tail}`;
}

/** Project roots plus the tool folder tag (`audio/` under each root). */
export function editSearchRoots(roots: string[], folder = ""): string[] {
  const tag = folder.trim().replace(/^[\\/]+|[\\/]+$/g, "");
  const bases = roots.map((item) => item.trim()).filter(Boolean);
  if (!tag || tag === ".") return bases;
  const extra = bases.map((root) => joinCited(root, tag));
  return [...bases, ...extra.filter((item) => !bases.some((root) => editPathKey(root) === editPathKey(item)))];
}

function isRelativeFolderTag(tag: string): boolean {
  return Boolean(tag) && !/^[A-Za-z]:/.test(tag) && !tag.startsWith("/");
}

function folderTagsFromText(name: string, mention: string, nearby: string): { sure: string[]; guess: string[] } {
  const sure: string[] = [];
  const guess: string[] = [];
  const fromMention = stripPathSizeSuffix(mention).replaceAll("\\", "/").replace(/\/+$/, "");
  if (fromMention.includes("/")) {
    const parts = fromMention.split("/").filter(Boolean);
    parts.pop();
    const tag = parts.join("/");
    if (isRelativeFolderTag(tag)) sure.push(tag);
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hay = `${mention}\n${nearby}`.replaceAll("\\", "/");
  const withName = hay.match(new RegExp(`(?:^|[\\s\`"'(])((?:[^\\s\`"'<>|*?:]+/)+)${escaped}(?:\\s|[)\`"']|$)`, "i"));
  const named = (withName?.[1] ?? "").replace(/\/+$/, "");
  if (isRelativeFolderTag(named)) sure.push(named);
  for (const match of hay.matchAll(/(?:^|[\s`"'(/\\])([A-Za-z0-9_.-]+)\/(?=\s|$|`|"|'|)/g)) {
    const tag = match[1] ?? "";
    if (isRelativeFolderTag(tag) && !/\.[a-z0-9]{1,8}$/i.test(tag)) guess.push(tag);
  }
  return { sure, guess };
}

/** Directory write, or a linked project folder itself — not a file to preview. */
export function isDirectoryEditPath(filePath: string, folderRoots: string[] = []): boolean {
  const cleaned = stripPathSizeSuffix(filePath).replace(/[\\/]+$/, "");
  if (!cleaned) return false;
  const name = fileNameFromPath(cleaned);
  if (/\.[a-z0-9]{1,8}$/i.test(name)) return false;
  const norm = cleaned.replaceAll("\\", "/").toLowerCase();
  for (const root of folderRoots) {
    const rootNorm = root.replace(/[\\/]+$/, "").replaceAll("\\", "/").toLowerCase();
    if (!rootNorm) continue;
    if (norm === rootNorm) return true;
    if (name.toLowerCase() === fileNameFromPath(rootNorm).toLowerCase()) return true;
  }
  return isCitedAbsolutePath(cleaned);
}

function dottedCite(cite: string): string {
  const name = fileNameFromPath(cite);
  if (!name || name.startsWith(".")) return "";
  const parent = cite.replace(/[\\/]+$/, "").slice(0, Math.max(0, cite.replace(/[\\/]+$/, "").length - name.length));
  if (!parent) return "";
  return joinCited(parent, `.${name}`);
}

/**
 * Keep an agent-cited absolute path. A bare `openclaw.json` next to
 * `C:\Users\someone\openclaw` becomes that folder's file — not the project folder.
 */
export function harvestFilePath(
  mention: string,
  nearby = "",
  existsSync?: (filePath: string) => boolean,
  folderRoots: string[] = [],
): string {
  const raw = stripPathSizeSuffix(mention.trim().replace(/^file:\/\//i, "").replace(/^[`'"]+|[`'"]+$/g, "")).replace(
    /^(?:wrote|write|created?)\s+/i,
    "",
  );
  if (!raw || hasLineBreak(raw)) return "";
  const name = fileNameFromPath(raw);
  if (isCitedAbsolutePath(raw)) {
    if (!existsSync || existsSync(raw) || !name) return raw;
  } else if (!name) {
    return raw;
  }
  const hay = nearby.includes(mention) ? nearby : `${mention}\n${nearby}`;
  const needle = raw.replaceAll("\\", "/").toLowerCase();
  const nameKey = name.toLowerCase();
  const stem = name.replace(/\.[a-z0-9]{1,8}$/i, "").toLowerCase();
  const folderTags = folderTagsFromText(name, raw, hay);
  const hits: { path: string; score: number }[] = [];
  for (const cite of citedAbsolutePaths(hay)) {
    const variants = [cite, dottedCite(cite)].filter(Boolean);
    for (const folderCite of variants) {
      const posix = folderCite.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
      if (posix === needle || posix.endsWith(`/${needle}`) || posix.endsWith(`/${nameKey}`)) {
        if (!existsSync || existsSync(folderCite)) hits.push({ path: folderCite, score: 3 });
        continue;
      }
      if (SOURCE_EXT.test(folderCite)) continue;
      const candidate = joinCited(folderCite, raw.includes("/") || raw.includes("\\") ? raw : name);
      if (existsSync && !existsSync(candidate)) continue;
      const folder = fileNameFromPath(folderCite).toLowerCase();
      const dotted = folder.startsWith(".");
      hits.push({
        path: candidate,
        score: folder === stem || folder === nameKey || folder === `.${stem}` ? (dotted && existsSync ? 4 : 2) : 1,
      });
    }
  }
  for (const root of folderRoots) {
    if (!root.trim()) continue;
    for (const tag of folderTags.sure) {
      const tagged = joinCited(root, joinCited(tag, name));
      if (!existsSync || existsSync(tagged)) hits.push({ path: tagged, score: existsSync ? 5 : 2 });
    }
    if (existsSync) {
      for (const tag of folderTags.guess) {
        const tagged = joinCited(root, joinCited(tag, name));
        if (existsSync(tagged)) hits.push({ path: tagged, score: 5 });
      }
      const direct = joinCited(root, name);
      if (existsSync(direct)) hits.push({ path: direct, score: 3 });
    }
  }
  hits.sort((left, right) => right.score - left.score);
  return hits[0]?.path || raw;
}

const SOURCE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|htm|py|rs|go|toml|ya?ml|sql|sh|bash|ps1|svg|txt|map|vue|svelte|kt|java|c|cc|cpp|h|hpp)$/i;

/** True for a workspace file mention such as preload.ts or electron/main.ts. */
export function looksLikeSourceFile(value: string): boolean {
  const text = stripPathSizeSuffix(value.trim().replace(/^file:\/\//i, "").replace(/^[`'"]+|[`'"]+$/g, ""));
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
export function pathFromWriteTool(text: string, nearby = "", existsSync?: (filePath: string) => boolean, folderRoots: string[] = []): string {
  const hay = nearby ? `${text}\n${nearby}` : text;
  const extracted = stripPathSizeSuffix(pathFromToolText(text));
  const harvested = extracted ? harvestFilePath(extracted, hay, existsSync, folderRoots) : "";
  if (looksLikePath(harvested)) return harvested;
  const { title } = splitToolLine(text);
  const rest = stripPathSizeSuffix(title.replace(WRITE_TITLE, "").replace(/^[`\s]+|[`\s]+$/g, ""));
  const fromTitle = harvestFilePath(rest, hay, existsSync, folderRoots);
  return looksLikePath(fromTitle) ? fromTitle.trim() : "";
}

/** Cursor/Composer often stores `Edit File · completed` with the path only in nearby thought/assistant text. */
export function pathFromNearbyWrite(text: string): string {
  const ticks = [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]?.trim() ?? "");
  const named = [...text.matchAll(/\bnamed\s+([^\s`]+)/gi)].map((match) =>
    (match[1] ?? "").trim().replace(/[.,;:]+$/, ""),
  );
  let fallback = "";
  for (const raw of [...ticks, ...named]) {
    if (!looksLikeSourceFile(raw)) continue;
    const harvested = harvestFilePath(raw, text);
    if (!looksLikeSourceFile(harvested)) continue;
    if (isCitedAbsolutePath(harvested)) return harvested;
    if (!fallback) fallback = harvested;
  }
  return fallback;
}

type TurnWriteContext = {
  start: number;
  end: number;
  parts: { index: number; text: string }[];
};

/** One user-to-user span. Nearby text is rebuilt per tool so the current row stays out. */
function turnWriteContext(messages: Session["messages"], index: number): TurnWriteContext {
  let start = index;
  while (start > 0 && messages[start - 1]?.role !== "user") start -= 1;
  let end = index;
  while (end + 1 < messages.length && messages[end + 1]?.role !== "user") end += 1;
  const parts: { index: number; text: string }[] = [];
  for (let i = start; i <= end; i += 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.kind === "thought" || message.role === "assistant") parts.push({ index: i, text: message.text });
  }
  return { start, end, parts };
}

function nearbyFromTurn(turn: TurnWriteContext, index: number): string {
  if (turn.parts.length === 0) return "";
  if (turn.parts.length === 1 && turn.parts[0]?.index === index) return "";
  const parts: string[] = [];
  for (const part of turn.parts) {
    if (part.index !== index) parts.push(part.text);
  }
  return parts.join("\n");
}

export function fileNameFromPath(path: string): string {
  const cleaned = stripPathSizeSuffix(path.replace(/[\\/]+$/, ""));
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned || path;
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
    let turn: TurnWriteContext | null = null;
    for (const [index, message] of session.messages.entries()) {
      if (message.kind !== "tool") continue;
      const { title } = splitToolLine(message.text);
      if (!isWriteToolTitle(title)) continue;
      if (!turn || index < turn.start || index > turn.end) turn = turnWriteContext(session.messages, index);
      const nearby = nearbyFromTurn(turn, index);
      const fromId = (message.toolCallId ?? "").match(/^(?:edit|write):(.+)$/i)?.[1] ?? "";
      const extracted =
        pathFromWriteTool(message.text, nearby, undefined, folderRoots) ||
        (looksLikePath(fromId) ? stripPathSizeSuffix(fromId) : "") ||
        pathFromNearbyWrite(nearby);
      const path = extracted ? harvestFilePath(extracted, `${message.text}\n${nearby}`, undefined, folderRoots) : "";
      const kind = writeChangeKind(title, nearby);
      if (!kind || !path || isDirectoryEditPath(path, folderRoots)) continue;
      const key = editPathKey(path);
      const current = map.get(key);
      if (current) {
        current.edits += 1;
        if (message.createdAt >= current.at) {
          current.at = message.createdAt;
          current.provider = session.provider;
          current.customBotId = session.customBotId;
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
        customBotId: session.customBotId,
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
  return stripPathSizeSuffix(path).replaceAll("\\", "/").replace(/\/{2,}/g, "/").toLowerCase();
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

export function editStatStamp(item: Pick<ProjectEdit, "edits" | "at">, rootKey = ""): string {
  return `${rootKey}\n${item.edits}:${item.at}`;
}

/** Fingerprint of write-tool rows. Store ticks that only change other fields stay put. */
export function projectWritesKey(
  sessions: Pick<Session, "id" | "projectId" | "messages">[],
  projectId?: string,
): string {
  let key = "";
  for (const session of sessions) {
    if (projectId && session.projectId !== projectId) continue;
    key += `${session.id}\n`;
    for (const message of session.messages) {
      if (message.kind !== "tool") continue;
      key += `${message.id}:${message.createdAt}:${message.text.length}:${message.toolCallId ?? ""}\n`;
    }
  }
  return key;
}

export function sameEditList(
  left: Pick<ProjectEdit, "path" | "edits" | "at">[],
  right: Pick<ProjectEdit, "path" | "edits" | "at">[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every(
    (item, index) =>
      item.path === right[index]?.path && item.edits === right[index]?.edits && item.at === right[index]?.at,
  );
}

export function editListKey(items: Pick<ProjectEdit, "path" | "edits" | "at">[]): string {
  return items.map((item) => `${item.path}:${item.edits}:${item.at}`).join("\n");
}

/** Null when every path already has a stamp for this root — no editStats call. */
export function planEditStatsHarvest(
  items: Pick<ProjectEdit, "path" | "edits" | "at" | "kind">[],
  fetched: Record<string, string>,
  rootKey = "",
): { stale: Pick<ProjectEdit, "path" | "edits" | "at">[]; created: string[] } | null {
  const stale = pathsNeedingStats(items, fetched, rootKey);
  if (stale.length === 0) return null;
  return {
    stale,
    created: items
      .filter((item) => item.kind === "created" && stale.some((row) => sameEditPath(row.path, item.path)))
      .map((item) => item.path),
  };
}

/** One created file per turn. Edited paths share one `git diff --numstat`. */
export function takeEditStatsChunk(
  items: Pick<ProjectEdit, "path" | "edits" | "at" | "kind">[],
  fetched: Record<string, string>,
  rootKey = "",
): { stale: Pick<ProjectEdit, "path" | "edits" | "at">[]; created: string[] } | null {
  const plan = planEditStatsHarvest(items, fetched, rootKey);
  if (!plan) return null;
  const createdKeys = new Set(plan.created.map((item) => editPathKey(item)));
  const edited = plan.stale.filter((row) => !createdKeys.has(editPathKey(row.path)));
  if (edited.length > 0) return { stale: edited, created: [] };
  const one = plan.stale.slice(0, 1);
  return { stale: one, created: one.map((row) => row.path) };
}

function defaultHarvestSchedule(work: () => void): () => void {
  const idle = (globalThis as { requestIdleCallback?: (fn: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  const cancelIdle = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
  if (typeof idle === "function") {
    const id = idle(work, { timeout: 120 });
    return () => {
      if (typeof cancelIdle === "function") cancelIdle(id);
    };
  }
  const timer = setTimeout(work, 0);
  return () => clearTimeout(timer);
}

/**
 * After-paint harvest. First turn never runs during render — idle / next tick,
 * then one chunk at a time so 14 created files are not one sync burst.
 */
export function startEditStatsHarvest(input: {
  items: Pick<ProjectEdit, "path" | "edits" | "at" | "kind">[];
  getFetched: () => Record<string, string>;
  rootKey: string;
  roots: string[];
  editStats: (
    paths: string[],
    roots: string[],
    created: string[],
  ) => Promise<Record<string, EditLineStat> | null | undefined>;
  onChunk: (next: Record<string, EditLineStat>, stale: Pick<ProjectEdit, "path" | "edits" | "at">[]) => void;
  schedule?: (work: () => void) => () => void;
}): () => void {
  const schedule = input.schedule ?? defaultHarvestSchedule;
  let cancelled = false;
  let cancelSchedule = () => {};

  const pump = () => {
    if (cancelled) return;
    const plan = takeEditStatsChunk(input.items, input.getFetched(), input.rootKey);
    if (!plan) return;
    void Promise.resolve()
      .then(() => input.editStats(plan.stale.map((row) => row.path), input.roots, plan.created))
      .then((next) => {
        if (cancelled) return;
        input.onChunk(next ?? {}, plan.stale);
        cancelSchedule = schedule(pump);
      });
  };

  cancelSchedule = schedule(pump);
  return () => {
    cancelled = true;
    cancelSchedule();
  };
}

export function pathsNeedingStats(
  items: Pick<ProjectEdit, "path" | "edits" | "at">[],
  fetched: Record<string, string>,
  rootKey = "",
): Pick<ProjectEdit, "path" | "edits" | "at">[] {
  return items.filter((item) => fetched[editPathKey(item.path)] !== editStatStamp(item, rootKey));
}

export function markStatsFetched(
  fetched: Record<string, string>,
  items: Pick<ProjectEdit, "path" | "edits" | "at">[],
  rootKey = "",
): Record<string, string> {
  const next = { ...fetched };
  for (const item of items) next[editPathKey(item.path)] = editStatStamp(item, rootKey);
  return next;
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
    const newer = item.at >= current.at ? item : current;
    out[index] = {
      ...current,
      ...item,
      path: item.path.length >= current.path.length ? item.path : current.path,
      edits: Math.max(current.edits, item.edits, 1),
      at: Math.max(current.at, item.at),
      kind: item.kind ?? current.kind,
      provider: newer.provider,
      customBotId: newer.customBotId,
    };
  }
  return out.sort((a, b) => b.at - a.at);
}

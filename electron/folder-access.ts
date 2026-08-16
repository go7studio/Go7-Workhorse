import fs from "node:fs";
import path from "node:path";

export type FolderAccessStore = {
  bookmarks: Record<string, string>;
};

export type FolderAccessIo = {
  userData: string;
  startAccessing?: (bookmark: string) => boolean;
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, text: string) => void;
  mkdir?: (dirPath: string) => void;
};

const FILE = "folder-bookmarks.json";

export function folderBookmarksPath(userData: string): string {
  return path.join(userData, FILE);
}

export function normalizeFolderKey(folderPath: string): string {
  return folderPath.trim().replace(/[\\/]+$/, "");
}

export function parseFolderBookmarks(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  const bookmarks: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const folder = normalizeFolderKey(key);
    const bookmark = typeof value === "string" ? value.trim() : "";
    if (folder && bookmark) bookmarks[folder] = bookmark;
  }
  return bookmarks;
}

export function loadFolderBookmarks(input: Pick<FolderAccessIo, "userData" | "readFile">): Record<string, string> {
  const file = folderBookmarksPath(input.userData);
  try {
    const text = (input.readFile ?? ((target) => fs.readFileSync(target, "utf8")))(file);
    return parseFolderBookmarks(JSON.parse(text) as unknown);
  } catch {
    return {};
  }
}

export function rememberFolderBookmark(
  folderPath: string,
  bookmark: string | undefined,
  input: FolderAccessIo,
): Record<string, string> {
  const folder = normalizeFolderKey(folderPath);
  const token = bookmark?.trim() ?? "";
  const bookmarks = loadFolderBookmarks(input);
  if (!folder || !token) return bookmarks;
  if (bookmarks[folder] === token) return bookmarks;
  const next = { ...bookmarks, [folder]: token };
  const dest = folderBookmarksPath(input.userData);
  try {
    (input.mkdir ?? ((dirPath) => fs.mkdirSync(dirPath, { recursive: true })))(path.dirname(dest));
    (input.writeFile ?? ((filePath, text) => fs.writeFileSync(filePath, text)))(dest, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    /* a bookmark miss must not block linking the folder */
  }
  return next;
}

export function bookmarksFromProjects(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const projects = (raw as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return {};
  const bookmarks: Record<string, string> = {};
  for (const project of projects) {
    if (!project || typeof project !== "object") continue;
    const folders = (project as { folders?: unknown }).folders;
    if (!Array.isArray(folders)) continue;
    for (const folder of folders) {
      if (!folder || typeof folder !== "object") continue;
      const record = folder as { path?: unknown; bookmark?: unknown };
      const folderPath = typeof record.path === "string" ? normalizeFolderKey(record.path) : "";
      const bookmark = typeof record.bookmark === "string" ? record.bookmark.trim() : "";
      if (folderPath && bookmark) bookmarks[folderPath] = bookmark;
    }
  }
  return bookmarks;
}

export function claimFolderBookmarks(
  bookmarks: Record<string, string>,
  startAccessing: (bookmark: string) => boolean,
): string[] {
  const claimed: string[] = [];
  for (const [folder, bookmark] of Object.entries(bookmarks)) {
    if (!bookmark) continue;
    try {
      if (startAccessing(bookmark)) claimed.push(folder);
    } catch {
      /* stale bookmark — next picker grant replaces it */
    }
  }
  return claimed;
}

export function mergeFolderBookmarks(
  ...bags: Array<Record<string, string> | undefined>
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const bag of bags) {
    if (!bag) continue;
    for (const [folder, bookmark] of Object.entries(bag)) {
      const key = normalizeFolderKey(folder);
      const token = bookmark.trim();
      if (key && token) next[key] = token;
    }
  }
  return next;
}

import { folderName, uid } from "./id";
import type { LinkedFolder, LinkedReference, Project, ReferenceKind } from "./types";

export type CreateWorkhorseProjectInput = {
  name: string;
  folder?: string;
  fromSessionId?: string;
};

export type CreateWorkhorseProjectResult = {
  ok: true;
  name: string;
  projectId: string;
  folder: string | null;
  folders: string[];
  alreadyExists?: boolean;
  movedThisChat: boolean;
};

/** Bind sidebar name to this project only. Never attach the folder to a different existing name. */
export function applyCreateWorkhorseProject<S extends { id: string; projectId?: string | null }>(
  projects: Project[],
  sessions: S[],
  input: CreateWorkhorseProjectInput,
  now = Date.now(),
): {
  projects: Project[];
  sessions: S[];
  activeProjectId: string;
  activeSessionId: string | null;
  result: CreateWorkhorseProjectResult;
} {
  const name = input.name.trim() || "Untitled";
  const folder = input.folder?.trim() || "";
  const existing = projects.find((project) => !project.archivedAt && project.name.toLowerCase() === name.toLowerCase());
  let project: Project;
  let nextProjects: Project[];
  const alreadyExists = Boolean(existing);
  if (existing) {
    project = {
      ...existing,
      folders: folder ? appendProjectFolder(existing.folders, folder) : existing.folders,
      openedAt: now,
    };
    nextProjects = projects.map((item) => (item.id === existing.id ? project : item));
  } else {
    project = emptyProject(name, folder ? [folder] : []);
    project = { ...project, createdAt: now, openedAt: now };
    nextProjects = [project, ...projects];
  }
  const fromId = input.fromSessionId?.trim() || "";
  const nextSessions = sessions.map((session) =>
    session.id === fromId ? { ...session, projectId: project.id } : session,
  );
  return {
    projects: nextProjects,
    sessions: nextSessions,
    activeProjectId: project.id,
    activeSessionId: fromId && nextSessions.some((session) => session.id === fromId) ? fromId : null,
    result: {
      ok: true,
      name: project.name,
      projectId: project.id,
      folder: folder || null,
      folders: project.folders.map((item) => item.path),
      alreadyExists: alreadyExists || undefined,
      movedThisChat: Boolean(fromId),
    },
  };
}

export function emptyProject(name: string, folderPaths: string[] = []): Project {
  const now = Date.now();
  const folders = uniqueFolders(folderPaths);
  const trimmed = name.trim() || folders[0]?.label || "Untitled";
  return {
    id: uid("proj"),
    name: trimmed,
    createdAt: now,
    openedAt: now,
    folders,
    references: [],
  };
}

export function uniqueFolders(folderPaths: string[]): LinkedFolder[] {
  const seen = new Set<string>();
  const folders: LinkedFolder[] = [];
  for (const raw of folderPaths) {
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    folders.push(folderFromPath(path));
  }
  return folders;
}

/** Keep existing folder ids; append a new path only if it is not already linked. */
export function appendProjectFolder(folders: LinkedFolder[], folderPath: string, bookmark?: string): LinkedFolder[] {
  const next = folderPath.trim();
  if (!next || folders.some((item) => item.path === next)) return folders;
  return [...folders, folderFromPath(next, bookmark)];
}

export type PickedFolder = { path: string; bookmark?: string };

export function asPickedFolder(raw: unknown): PickedFolder | null {
  if (typeof raw === "string" && raw.trim()) return { path: raw.trim() };
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { path?: unknown; bookmark?: unknown };
  const folderPath = typeof record.path === "string" ? record.path.trim() : "";
  if (!folderPath) return null;
  const bookmark = typeof record.bookmark === "string" ? record.bookmark.trim() : "";
  return { path: folderPath, ...(bookmark ? { bookmark } : {}) };
}

export function folderFromPath(path: string, bookmark?: string): LinkedFolder {
  const token = bookmark?.trim();
  return { id: uid("fold"), path, label: folderName(path), ...(token ? { bookmark: token } : {}) };
}

/**
 * The folder a chat runs in.
 *
 * A folder that has been moved or deleted is skipped when a live one is linked
 * beside it. A project that kept a link to a repo after it moved went on
 * choosing the dead path, and every agent in it died with
 * `spawn ~/.grok/bin/grok ENOENT` — Node reports a missing working directory
 * by naming the command, so the error blamed a CLI that was present and fine.
 *
 * When nothing exists this still answers the first folder, so the caller fails
 * naming a path the person actually linked rather than an empty string.
 */
export function primaryFolder(
  project: Project | undefined,
  folderExists?: (path: string) => boolean,
): LinkedFolder | null {
  const folders = project?.folders ?? [];
  if (folderExists) {
    const live = folders.find((folder) => folderExists(folder.path));
    if (live) return live;
  }
  return folders[0] ?? null;
}

/**
 * The project's folders as the desk actually sees them: the ones still on disk,
 * in their linked order. A folder that has been moved is dropped rather than
 * reported, because every consumer treats the first entry as *the* project
 * folder — the session preface hands it to the model, and workhorse_list_projects
 * hands it to a harness that will pass it straight back as a working folder.
 *
 * If none of them is there, the full list stands. The person linked those paths
 * and needs to see which ones, and an error that names a real link beats one
 * that names nothing.
 */
export function projectFolderPaths(
  project: Pick<Project, "folders"> | undefined,
  folderExists?: (path: string) => boolean,
): string[] {
  const paths = project?.folders.map((folder) => folder.path) ?? [];
  if (!folderExists) return paths;
  const live = paths.filter((path) => folderExists(path));
  return live.length > 0 ? live : paths;
}

export function folderSummary(project: Project): string {
  if (project.folders.length === 0) return "No folders linked";
  if (project.folders.length === 1) return project.folders[0].label;
  return `${project.folders.length} folders`;
}

export function normalizeProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : uid("proj");
  const openedAt = typeof record.openedAt === "number" ? record.openedAt : Date.now();
  const createdAt = typeof record.createdAt === "number" ? record.createdAt : openedAt;

  const folders: LinkedFolder[] = [];
  if (Array.isArray(record.folders)) {
    for (const item of record.folders) {
      if (!item || typeof item !== "object") continue;
      const folder = item as Record<string, unknown>;
      if (typeof folder.path !== "string" || !folder.path) continue;
      const bookmark = typeof folder.bookmark === "string" ? folder.bookmark.trim() : "";
      folders.push({
        id: typeof folder.id === "string" ? folder.id : uid("fold"),
        path: folder.path,
        label: typeof folder.label === "string" ? folder.label : folderName(folder.path),
        ...(bookmark ? { bookmark } : {}),
      });
    }
  } else if (typeof record.path === "string" && record.path) {
    folders.push(folderFromPath(record.path));
  }

  const references: LinkedReference[] = [];
  if (Array.isArray(record.references)) {
    for (const item of record.references) {
      if (!item || typeof item !== "object") continue;
      const ref = item as Record<string, unknown>;
      if (ref.kind !== "file" && ref.kind !== "url" && ref.kind !== "note") continue;
      if (typeof ref.value !== "string" || !ref.value) continue;
      const kind: ReferenceKind = ref.kind;
      references.push({
        id: typeof ref.id === "string" ? ref.id : uid("ref"),
        kind,
        value: ref.value,
        label: typeof ref.label === "string" ? ref.label : ref.value,
      });
    }
  }

  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : folders[0]?.label ?? "Untitled";

  return {
    id,
    name,
    createdAt,
    openedAt,
    folders,
    references,
    archivedAt: typeof record.archivedAt === "number" ? record.archivedAt : undefined,
  };
}

export function applyArchiveProject(
  projects: Project[],
  id: string,
  archived: boolean,
  at = Date.now(),
): Project[] | null {
  if (!projects.some((project) => project.id === id)) return null;
  return projects.map((project) =>
    project.id === id ? { ...project, archivedAt: archived ? at : null } : project,
  );
}

export function findProjectByQuery<T extends { id: string; name: string; archivedAt?: number | null }>(
  projects: T[],
  query: string,
): T | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const live = projects.filter((item) => typeof item.archivedAt !== "number");
  return (
    live.find((item) => item.id.toLowerCase() === q) ??
    live.find((item) => item.name.toLowerCase() === q) ??
    live.find((item) => item.name.toLowerCase().includes(q))
  );
}

function folderKey(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * Keep an existing project authoritative. For an unfiled chat, an explicit
 * working folder may recover the most specific live project that already
 * links it. The folder is a starting context, not a filesystem boundary.
 */
export function projectForSpawn<T extends Pick<Project, "id" | "folders" | "archivedAt">>(
  projects: T[],
  currentProjectId: string | null | undefined,
  workingFolder: string | null | undefined,
): T | undefined {
  const current = currentProjectId
    ? projects.find((project) => project.id === currentProjectId)
    : undefined;
  if (current) return current;

  const working = folderKey(workingFolder ?? "");
  if (!working) return undefined;
  let match: { project: T; rootLength: number } | undefined;
  for (const project of projects) {
    if (typeof project.archivedAt === "number") continue;
    for (const folder of project.folders) {
      const root = folderKey(folder.path);
      if (!root || (working !== root && !working.startsWith(`${root}/`))) continue;
      if (!match || root.length > match.rootLength) match = { project, rootLength: root.length };
    }
  }
  return match?.project;
}

export function visibleProjectNames(projects: { name: string; archivedAt?: number | null }[]): string[] {
  return projects.filter((item) => typeof item.archivedAt !== "number").map((item) => item.name);
}

/** True only when a live project row uses this exact name. */
export function renameTookOnDesk(projects: { name: string; archivedAt?: number | null }[], requested: string): boolean {
  const want = requested.trim().toLowerCase();
  if (!want) return false;
  return visibleProjectNames(projects).some((name) => name.trim().toLowerCase() === want);
}

export function renameProject(projects: Project[], id: string, name: string): Project[] | null {
  const next = name.trim();
  if (!next) return null;
  if (!projects.some((project) => project.id === id && typeof project.archivedAt !== "number")) return null;
  return projects.map((project) => (project.id === id ? { ...project, name: next } : project));
}

export function applyRenameDeskProject(
  projects: Project[],
  input: { name: string; project?: string; fromProjectId?: string },
):
  | { ok: true; projects: Project[]; renamed: Project; previous: string }
  | { ok: false; error: string; projects: Project[] } {
  const title = input.name.trim();
  if (!title) return { ok: false, error: "name is required", projects };
  const query = input.project?.trim() || "";
  const target = query
    ? findProjectByQuery(projects, query)
    : projects.find((item) => item.id === input.fromProjectId?.trim() && typeof item.archivedAt !== "number");
  if (!target) {
    return {
      ok: false,
      error: query ? `No project matches “${query}”` : "No project is selected to rename.",
      projects,
    };
  }
  if (target.name === title) {
    return { ok: true, projects, renamed: target, previous: target.name };
  }
  const next = renameProject(projects, target.id, title);
  if (!next) return { ok: false, error: "Could not rename that project.", projects };
  const renamed = next.find((item) => item.id === target.id);
  if (!renamed) return { ok: false, error: "Could not rename that project.", projects };
  return { ok: true, projects: next, renamed, previous: target.name };
}

export function applyDeleteProject(projects: Project[], id: string): Project[] | null {
  if (!projects.some((project) => project.id === id)) return null;
  return projects.filter((project) => project.id !== id);
}

export function applyProjectChatFate<T extends { id: string; projectId?: string | null; parentId?: string }>(
  sessions: T[],
  projectId: string,
  fate: "keep" | "remove",
): T[] {
  if (fate === "keep") {
    return sessions.map((session) =>
      session.projectId === projectId ? { ...session, projectId: undefined } : session,
    );
  }
  const gone = new Set(sessions.filter((session) => session.projectId === projectId).map((session) => session.id));
  return sessions.filter((session) => !gone.has(session.id) && !(session.parentId && gone.has(session.parentId)));
}

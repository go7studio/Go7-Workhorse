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
export function appendProjectFolder(folders: LinkedFolder[], folderPath: string): LinkedFolder[] {
  const next = folderPath.trim();
  if (!next || folders.some((item) => item.path === next)) return folders;
  return [...folders, folderFromPath(next)];
}

export function folderFromPath(path: string): LinkedFolder {
  return { id: uid("fold"), path, label: folderName(path) };
}

export function primaryFolder(project: Project): LinkedFolder | null {
  return project.folders[0] ?? null;
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
      folders.push({
        id: typeof folder.id === "string" ? folder.id : uid("fold"),
        path: folder.path,
        label: typeof folder.label === "string" ? folder.label : folderName(folder.path),
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

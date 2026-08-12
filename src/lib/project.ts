import { folderName, uid } from "./id";
import type { LinkedFolder, LinkedReference, Project, ReferenceKind } from "./types";

export function emptyProject(name: string): Project {
  const now = Date.now();
  const trimmed = name.trim() || "Untitled";
  return {
    id: uid("proj"),
    name: trimmed,
    createdAt: now,
    openedAt: now,
    folders: [],
    references: [],
  };
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

  return { id, name, createdAt, openedAt, folders, references };
}

import type { SessionEnvironment } from "./types";

export type SessionEnvironmentKind = SessionEnvironment["kind"];

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeSessionEnvironment(raw: unknown): SessionEnvironment {
  if (!raw || typeof raw !== "object") return { kind: "local" };
  const record = raw as Partial<SessionEnvironment> & Record<string, unknown>;
  if (record.kind === "worktree") {
    const path = clean(record.path);
    const gitRoot = clean(record.gitRoot);
    if (path && gitRoot) {
      const head = clean(record.head);
      return { kind: "worktree", path, gitRoot, ...(head ? { head } : {}) };
    }
  }
  if (record.kind === "cloud") {
    const environmentId = clean(record.environmentId);
    if (environmentId) {
      const cwd = clean(record.cwd);
      return { kind: "cloud", environmentId, ...(cwd ? { cwd } : {}) };
    }
  }
  return { kind: "local" };
}

export function sessionEnvironmentKind(environment: SessionEnvironment | undefined): SessionEnvironmentKind {
  return normalizeSessionEnvironment(environment).kind;
}

export function sessionExecutionCwd(environment: SessionEnvironment | undefined, localCwd: string): string {
  const normalized = normalizeSessionEnvironment(environment);
  if (normalized.kind === "worktree") return normalized.path;
  if (normalized.kind === "cloud" && normalized.cwd) return normalized.cwd;
  return localCwd;
}

export function sessionEnvironmentLabel(environment: SessionEnvironment | undefined): string {
  const normalized = normalizeSessionEnvironment(environment);
  if (normalized.kind === "worktree") return "Worktree";
  if (normalized.kind === "cloud") return "Cloud";
  return "Local";
}

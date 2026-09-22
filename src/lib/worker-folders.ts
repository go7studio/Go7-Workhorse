import type { Session } from "./types";
import type { SettledWorker } from "./worker-settled";

/** What the last launch sweep found, as main reports it. Settings reads it and never walks the folders. */
export type WorkerFoldersReport = {
  at: number;
  trees: number;
  maxTrees: number;
  overTrees: boolean;
  removed: number;
  rescued: number;
  held: Array<{ name: string; reason: string }>;
};

/**
 * Workers whose run just ended in a folder of their own.
 *
 * Only a worker the desk gave a managed worktree is counted. A shared worker
 * ran in the person's own checkout, and that checkout's changes are theirs.
 */
export function foldersToCount(settled: SettledWorker[], sessions: Session[]): Array<{ id: string; runKey: string }> {
  const ids = new Set(settled.map((item) => item.workerId));
  return sessions
    .filter((session) => ids.has(session.id) && session.environment?.kind === "worktree")
    .map((session) => ({
      id: session.id,
      runKey: `${session.id}:${session.agentRun?.runId ?? session.agentRun?.startedAt ?? ""}`,
    }));
}

/** The name a person knows the worker by. */
export function workerLabel(session: Pick<Session, "workerName" | "title">): string {
  return session.workerName?.trim() || session.title.split(" · ")[0]?.trim() || "A worker";
}

export function leftInFolderNote(name: string, files: number): string {
  return `${name}'s folder holds ${files} uncommitted ${files === 1 ? "file" : "files"}.`;
}

/** The Settings line: how many folders, and which ones the sweep kept. */
export function workerFoldersLine(report: WorkerFoldersReport | null, titleOf: (id: string) => string | undefined): string {
  if (!report) return "The desk counts them shortly after it opens.";
  const count = `${report.trees} ${report.trees === 1 ? "folder" : "folders"}`;
  const over = report.overTrees ? `, over the limit of ${report.maxTrees}` : "";
  const saved =
    report.rescued > 0 ? ` Git keeps the work of ${report.rescued} removed ${report.rescued === 1 ? "folder" : "folders"}.` : "";
  if (report.held.length === 0) return `${count}${over}.${saved} None stay.`;
  const names = report.held.slice(0, 3).map((row) => titleOf(row.name) ?? row.name);
  const more = report.held.length > 3 ? ` and ${report.held.length - 3} more` : "";
  return `${count}${over}.${saved} ${report.held.length === 1 ? "One stays" : `${report.held.length} stay`}: ${names.join(", ")}${more}.`;
}

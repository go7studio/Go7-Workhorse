/**
 * Grok Build background Tasks and Watchers.
 *
 * The TUI strip is not Settings → Watch leftover pools. Grok ACP emits
 * `task_backgrounded` / `task_completed` on `_x.ai/session/update`. Those
 * used to classify as `other` and vanish; the desk only showed a generic
 * tool chip that the turn-end closer then marked finished while the script
 * was still running.
 */

export type VendorTaskKind = "task" | "watcher";

export type VendorTaskStatus = "running" | "completed" | "killed" | "failed";

export type VendorBackgroundTask = {
  id: string;
  kind: VendorTaskKind;
  name: string;
  status: VendorTaskStatus;
  startedAt: number;
  endedAt?: number;
  toolCallId?: string;
  command?: string;
};

const NAME_LIMIT = 96;
const KEEP_FINISHED = 8;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clipName(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= NAME_LIMIT) return text;
  return `${text.slice(0, NAME_LIMIT - 1).trimEnd()}…`;
}

export function parseEpochMs(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const record = asRecord(value);
  const secs = Number(record.secs ?? record.seconds ?? record.secs_since_epoch);
  if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
  return fallback;
}

function updateName(update: Record<string, unknown>): string {
  return (
    trimmed(update.sessionUpdate) ??
    trimmed(update.kind) ??
    trimmed(update.type) ??
    trimmed(update.update) ??
    ""
  );
}

function snapshotOf(update: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(update.task_snapshot ?? update.taskSnapshot ?? update.snapshot);
  return Object.keys(nested).length > 0 ? nested : update;
}

function kindOf(update: Record<string, unknown>, snapshot: Record<string, unknown>): VendorTaskKind {
  const monitor = trimmed(update.monitor_description) ?? trimmed(snapshot.monitor_description);
  if (monitor) return "watcher";
  const kind = (trimmed(snapshot.kind) ?? "").toLowerCase();
  if (kind === "monitor" || kind === "watcher") return "watcher";
  return "task";
}

function nameOf(
  kind: VendorTaskKind,
  update: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): string {
  const monitor = trimmed(update.monitor_description) ?? trimmed(snapshot.monitor_description);
  const description =
    trimmed(update.description) ??
    trimmed(snapshot.description) ??
    trimmed(snapshot.display_command) ??
    trimmed(snapshot.displayCommand);
  const command = trimmed(update.command) ?? trimmed(snapshot.command);
  const preferred = kind === "watcher" ? monitor || description || command : description || command;
  return clipName(preferred ?? "");
}

function completionStatus(snapshot: Record<string, unknown>): VendorTaskStatus {
  if (snapshot.explicitly_killed === true || snapshot.explicitlyKilled === true) return "killed";
  const signal = trimmed(snapshot.signal);
  if (signal) return "killed";
  const code = snapshot.exit_code ?? snapshot.exitCode;
  if (typeof code === "number" && Number.isFinite(code) && code !== 0) return "failed";
  return "completed";
}

function taskIdOf(update: Record<string, unknown>, snapshot: Record<string, unknown>): string | undefined {
  return (
    trimmed(update.task_id) ??
    trimmed(update.taskId) ??
    trimmed(snapshot.task_id) ??
    trimmed(snapshot.taskId)
  );
}

function toolCallIdOf(update: Record<string, unknown>, snapshot: Record<string, unknown>): string | undefined {
  return (
    trimmed(update.tool_call_id) ??
    trimmed(update.toolCallId) ??
    trimmed(snapshot.tool_call_id) ??
    trimmed(snapshot.toolCallId)
  );
}

export function parseVendorBackgroundTask(update: unknown, now = Date.now()): VendorBackgroundTask | null {
  if (!update || typeof update !== "object") return null;
  const record = update as Record<string, unknown>;
  const name = updateName(record);
  const snapshot = snapshotOf(record);
  const id = taskIdOf(record, snapshot);
  if (!id) return null;
  const kind = kindOf(record, snapshot);
  const label = nameOf(kind, record, snapshot);
  const toolCallId = toolCallIdOf(record, snapshot);
  const command = trimmed(record.command) ?? trimmed(snapshot.command);
  if (name === "task_backgrounded" || name === "taskBackgrounded") {
    return {
      id,
      kind,
      name: label || (kind === "watcher" ? "Monitor" : "Task"),
      status: "running",
      startedAt: parseEpochMs(record.start_time ?? record.startTime ?? snapshot.start_time ?? snapshot.startTime, now),
      ...(toolCallId ? { toolCallId } : {}),
      ...(command ? { command } : {}),
    };
  }
  if (name === "task_completed" || name === "taskCompleted") {
    const startedAt = parseEpochMs(snapshot.start_time ?? snapshot.startTime ?? record.start_time ?? record.startTime, now);
    const endedAt = parseEpochMs(snapshot.end_time ?? snapshot.endTime ?? record.end_time ?? record.endTime, now);
    return {
      id,
      kind,
      name: label || (kind === "watcher" ? "Monitor" : "Task"),
      status: completionStatus(snapshot),
      startedAt,
      endedAt: endedAt >= startedAt ? endedAt : now,
      ...(toolCallId ? { toolCallId } : {}),
      ...(command ? { command } : {}),
    };
  }
  return null;
}

function sameTask(left: VendorBackgroundTask, right: VendorBackgroundTask): boolean {
  if (left.id === right.id) return true;
  return Boolean(left.toolCallId && right.toolCallId && left.toolCallId === right.toolCallId);
}

export function applyVendorBackgroundTask(
  list: VendorBackgroundTask[] | undefined,
  incoming: VendorBackgroundTask,
): VendorBackgroundTask[] {
  const tasks = list ?? [];
  const index = tasks.findIndex((item) => sameTask(item, incoming));
  const next =
    index < 0
      ? [...tasks, incoming]
      : tasks.map((item, at) => {
          if (at !== index) return item;
          const merged: VendorBackgroundTask = {
            ...item,
            ...incoming,
            startedAt: item.startedAt || incoming.startedAt,
            name: incoming.name && incoming.name !== "Task" && incoming.name !== "Monitor" ? incoming.name : item.name,
            kind: item.kind === "watcher" || incoming.kind === "watcher" ? "watcher" : "task",
            command: incoming.command || item.command,
            toolCallId: incoming.toolCallId || item.toolCallId,
          };
          return merged;
        });
  const finished = next.filter((item) => item.status !== "running");
  if (finished.length <= KEEP_FINISHED) return next;
  const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((item) => item.id));
  return next.filter((item) => item.status === "running" || !drop.has(item.id));
}

export function visibleVendorTasks(list: VendorBackgroundTask[] | undefined): VendorBackgroundTask[] {
  return (list ?? []).filter((item) => item.status === "running" || item.status === "killed" || item.status === "failed" || item.status === "completed");
}

export function groupVendorTasks(list: VendorBackgroundTask[] | undefined): {
  tasks: VendorBackgroundTask[];
  watchers: VendorBackgroundTask[];
} {
  const visible = visibleVendorTasks(list);
  return {
    tasks: visible.filter((item) => item.kind === "task"),
    watchers: visible.filter((item) => item.kind === "watcher"),
  };
}

export function vendorTaskElapsedMs(task: VendorBackgroundTask, now: number): number {
  const end = task.status === "running" ? now : (task.endedAt ?? now);
  return Math.max(0, end - task.startedAt);
}

export function vendorTaskStatusLabel(status: VendorTaskStatus): string {
  if (status === "running") return "";
  if (status === "killed") return "killed";
  if (status === "failed") return "failed";
  return "done";
}

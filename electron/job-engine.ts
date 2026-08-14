import fs from "node:fs";
import type { ScheduledRun, Session } from "../src/lib/types";
import { atomicWriteJson } from "./state-persistence";

type DurableJobStatus = "pending" | "dispatched";

export type DurableJob = {
  id: string;
  sessionId: string;
  prompt: string;
  dueAt: number;
  createdAt: number;
  status: DurableJobStatus;
  repeatEveryMs?: number;
  occurrence?: number;
};

export type DurableJobEvent = {
  sessionId: string;
  run: ScheduledRun;
  nextRun?: ScheduledRun;
  recovered: boolean;
};

type JobJournal = {
  version: 1;
  jobs: DurableJob[];
  goals: Array<{ sessionId: string; status: "active" | "paused"; objective: string }>;
  updatedAt: number;
};

const validNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function normalizeJob(raw: unknown): DurableJob | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<DurableJob>;
  if (typeof row.id !== "string" || typeof row.sessionId !== "string" || typeof row.prompt !== "string") return null;
  if (!validNumber(row.dueAt) || !validNumber(row.createdAt)) return null;
  return {
    id: row.id,
    sessionId: row.sessionId,
    prompt: row.prompt,
    dueAt: row.dueAt,
    createdAt: row.createdAt,
    status: row.status === "dispatched" ? "dispatched" : "pending",
    ...(validNumber(row.repeatEveryMs) && row.repeatEveryMs > 0 ? { repeatEveryMs: row.repeatEveryMs } : {}),
    ...(validNumber(row.occurrence) && row.occurrence > 0 ? { occurrence: Math.floor(row.occurrence) } : {}),
  };
}

/** Electron-main journal for provider-independent scheduled work and goal lifecycle. */
export class DurableJobEngine {
  private jobs = new Map<string, DurableJob>();
  private goals: JobJournal["goals"] = [];
  private emitted = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string, private readonly onDue?: (events: DurableJobEvent[]) => void) {
    this.load();
  }

  private load() {
    for (const candidate of [this.file, `${this.file}.bak`]) {
      try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as Partial<JobJournal>;
      if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) continue;
      for (const raw of Array.isArray(parsed.jobs) ? parsed.jobs : []) {
        const job = normalizeJob(raw);
        if (job) this.jobs.set(job.id, job);
      }
      this.goals = Array.isArray(parsed.goals)
        ? parsed.goals.filter((goal): goal is JobJournal["goals"][number] => Boolean(
            goal && typeof goal.sessionId === "string" && typeof goal.objective === "string" &&
            (goal.status === "active" || goal.status === "paused"),
          ))
        : [];
      // A dispatched job means the renderer accepted it before the previous process ended.
      // Re-emitting it is intentional crash recovery; provider processes do not survive app exit.
      if (candidate !== this.file) {
        try { atomicWriteJson(this.file, parsed); } catch { /* backup remains valid */ }
      }
      return;
      } catch {
        continue;
      }
    }
    this.jobs.clear();
    this.goals = [];
  }

  private persist() {
    const journal: JobJournal = {
      version: 1,
      jobs: [...this.jobs.values()],
      goals: this.goals,
      updatedAt: Date.now(),
    };
    try {
      const previous = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<JobJournal>;
      if (previous.version === 1 && Array.isArray(previous.jobs)) atomicWriteJson(`${this.file}.bak`, previous);
    } catch {
      /* first write or corrupt primary */
    }
    atomicWriteJson(this.file, journal);
  }

  sync(rawSessions: unknown): DurableJobEvent[] {
    const sessions = Array.isArray(rawSessions) ? rawSessions as Partial<Session>[] : [];
    const sessionIds = new Set(sessions.flatMap((session) => typeof session.id === "string" ? [session.id] : []));
    for (const [id, job] of this.jobs) {
      if (!sessionIds.has(job.sessionId)) {
        this.jobs.delete(id);
        this.emitted.delete(id);
      }
    }
    this.goals = [];
    for (const session of sessions) {
      if (typeof session.id !== "string") continue;
      const queuedRunIds = new Set(
        (Array.isArray(session.queue) ? session.queue : []).flatMap((item) => item?.scheduledRunId ? [item.scheduledRunId] : []),
      );
      if (session.goal && (session.goal.status === "active" || session.goal.status === "paused") && session.goal.objective.trim()) {
        this.goals.push({ sessionId: session.id, status: session.goal.status, objective: session.goal.objective.trim() });
      }
      for (const run of Array.isArray(session.scheduledRuns) ? session.scheduledRuns : []) {
        if (!run || typeof run.id !== "string") continue;
        if (run.status === "completed" || run.status === "failed") {
          this.jobs.delete(run.id);
          this.emitted.delete(run.id);
          continue;
        }
        const normalized: DurableJob = {
          id: run.id,
          sessionId: session.id,
          prompt: run.prompt,
          dueAt: run.dueAt,
          createdAt: run.createdAt,
          status: run.status === "pending" ? "pending" : "dispatched",
          ...(run.repeatEveryMs ? { repeatEveryMs: run.repeatEveryMs } : {}),
          ...(run.occurrence ? { occurrence: run.occurrence } : {}),
        };
        this.jobs.set(run.id, normalized);
        // A queued prompt already present in durable renderer state will flush on load.
        // A running record has no queue item; after a fresh process starts, leave it
        // un-emitted so takeDue re-queues the interrupted occurrence.
        if (run.status === "queued" && queuedRunIds.has(run.id)) this.emitted.add(run.id);
      }
    }
    this.persist();
    return this.takeDue();
  }

  takeDue(now = Date.now()): DurableJobEvent[] {
    const events: DurableJobEvent[] = [];
    for (const job of [...this.jobs.values()].sort((a, b) => a.dueAt - b.dueAt)) {
      if (job.dueAt > now || this.emitted.has(job.id)) continue;
      const recovered = job.status === "dispatched";
      job.status = "dispatched";
      this.emitted.add(job.id);
      let nextRun: ScheduledRun | undefined;
      if (job.repeatEveryMs) {
        let nextDue = job.dueAt + job.repeatEveryMs;
        while (nextDue <= now) nextDue += job.repeatEveryMs;
        const occurrence = (job.occurrence ?? 1) + 1;
        const nextId = `${job.id.replace(/-r\d+$/, "")}-r${occurrence}`;
        const next: DurableJob = {
          ...job,
          id: nextId,
          dueAt: nextDue,
          createdAt: now,
          status: "pending",
          occurrence,
        };
        this.jobs.set(next.id, next);
        nextRun = { ...next, status: "pending" };
      }
      events.push({
        sessionId: job.sessionId,
        run: {
          id: job.id,
          prompt: job.prompt,
          dueAt: job.dueAt,
          createdAt: job.createdAt,
          status: "queued",
          ...(job.repeatEveryMs ? { repeatEveryMs: job.repeatEveryMs, occurrence: job.occurrence ?? 1 } : {}),
        },
        ...(nextRun ? { nextRun } : {}),
        recovered,
      });
    }
    if (events.length) this.persist();
    return events;
  }

  start(intervalMs = 1_000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const due = this.takeDue();
      if (due.length) this.onDue?.(due);
    }, intervalMs);
    this.timer.unref?.();
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.persist();
  }

  snapshot(): JobJournal {
    return { version: 1, jobs: [...this.jobs.values()], goals: [...this.goals], updatedAt: Date.now() };
  }
}

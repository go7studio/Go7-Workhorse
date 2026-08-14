import type { ScheduledRun } from "./types";

const DELAY = /^(\d+(?:\.\d+)?)(s|m|h|d)$/i;

export function parseScheduleCommand(text: string, now = Date.now()): Omit<ScheduledRun, "id" | "createdAt"> | null {
  const input = text.replace(/^\/schedule\s*/i, "").trim();
  const recurring = /^every\s+/i.test(input);
  const body = recurring ? input.replace(/^every\s+/i, "") : input;
  const space = body.indexOf(" ");
  if (space < 1) return null;
  const delay = body.slice(0, space).trim().match(DELAY);
  const prompt = body.slice(space + 1).trim();
  if (!delay || !prompt) return null;
  const amount = Number(delay[1]);
  const scale = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[delay[2]!.toLowerCase() as "s" | "m" | "h" | "d"];
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const duration = amount * scale;
  return {
    dueAt: now + duration,
    prompt,
    status: "pending",
    ...(recurring ? { repeatEveryMs: duration, occurrence: 1 } : {}),
  };
}

export function normalizeScheduledRuns(raw: unknown): ScheduledRun[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const runs = raw.flatMap((item): ScheduledRun[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Partial<ScheduledRun>;
    if (typeof row.id !== "string" || typeof row.prompt !== "string" || !row.prompt.trim()) return [];
    if (typeof row.dueAt !== "number" || !Number.isFinite(row.dueAt)) return [];
    const status = row.status === "queued" || row.status === "running" || row.status === "completed" || row.status === "failed" ? row.status : "pending";
    const repeatEveryMs = typeof row.repeatEveryMs === "number" && Number.isFinite(row.repeatEveryMs) && row.repeatEveryMs > 0
      ? row.repeatEveryMs
      : undefined;
    const occurrence = typeof row.occurrence === "number" && Number.isInteger(row.occurrence) && row.occurrence > 0
      ? row.occurrence
      : undefined;
    return [{
      id: row.id,
      prompt: row.prompt.trim(),
      dueAt: row.dueAt,
      createdAt: typeof row.createdAt === "number" ? row.createdAt : row.dueAt,
      status,
      ...(repeatEveryMs ? { repeatEveryMs, occurrence: occurrence ?? 1 } : {}),
    }];
  });
  return runs.length ? runs : undefined;
}

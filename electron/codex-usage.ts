import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGrokUsage, usageHasBilledTokens, type GrokUsageDraft } from "./grok-agent";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function eventTime(record: Record<string, unknown>): number {
  const raw = record.timestamp ?? record.created_at ?? record.createdAt;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function usageFromCodexPayload(payload: Record<string, unknown>): ReturnType<typeof parseGrokUsage> {
  return parseGrokUsage(
    payload.usage ??
      payload.last_token_usage ??
      asRecord(payload.info).last_token_usage ??
      asRecord(payload.info).usage ??
      payload,
  );
}

export function harvestCodexJsonlBills(text: string, after = 0): GrokUsageDraft[] {
  const records: GrokUsageDraft[] = [];
  const counts: GrokUsageDraft[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    const payload = asRecord(record.payload);
    const type = typeof payload.type === "string" ? payload.type : typeof record.sessionUpdate === "string" ? record.sessionUpdate : "";
    if (type !== "token_count" && type !== "token_usage_record") continue;
    if (after > 0 && eventTime(record) > 0 && eventTime(record) < after) continue;
    const draft = usageFromCodexPayload(type === "token_usage_record" ? payload : asRecord(payload.info ?? record.info));
    if (!draft || !usageHasBilledTokens(draft)) continue;
    (type === "token_usage_record" ? records : counts).push({ ...draft, source: "request" });
  }
  // Newer rollouts write both. The record is the API call; counting both doubles the turn.
  // Take the book that billed more in case one stream omitted calls.
  if (records.length === 0) return counts;
  if (counts.length === 0) return records;
  const billed = (drafts: GrokUsageDraft[]) =>
    drafts.reduce((sum, draft) => sum + draft.inputTokens + draft.outputTokens, 0);
  return billed(records) >= billed(counts) ? records : counts;
}

function walkForRollout(dir: string, sessionId: string, depth = 0): string | undefined {
  if (depth > 6 || !existsSync(dir)) return undefined;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    if (name.includes(sessionId) && name.endsWith(".jsonl")) return path.join(dir, name);
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const hit = walkForRollout(full, sessionId, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

export function findCodexSessionRollout(
  nativeSessionId: string,
  home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"),
): string | undefined {
  const id = nativeSessionId.trim();
  if (!id) return undefined;
  return walkForRollout(path.join(home, "sessions"), id) ?? walkForRollout(path.join(home, "archived_sessions"), id);
}

export function harvestCodexSessionBills(
  nativeSessionId: string,
  after = 0,
  home?: string,
): GrokUsageDraft[] {
  const file = findCodexSessionRollout(nativeSessionId, home);
  if (!file) return [];
  try {
    return harvestCodexJsonlBills(readFileSync(file, "utf8"), after);
  } catch {
    return [];
  }
}

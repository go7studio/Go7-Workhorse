import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isGenericVendorTitle, isWorkhorseInstructionTitle } from "../src/lib/titles";

export function grokHome(): string {
  const override = process.env.GROK_HOME?.trim();
  return override || path.join(os.homedir(), ".grok");
}

export function grokSummaryPath(cwd: string, vendorSessionId: string): string {
  return path.join(grokHome(), "sessions", encodeURIComponent(cwd), vendorSessionId, "summary.json");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function looksLikeId(value: string): boolean {
  return (
    /^(sess_|session_|thread_|conv_|chat_|agent_)/i.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    /^[0-9a-f]{16,}$/i.test(value)
  );
}

function usableTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const next = value.replace(/\s+/g, " ").trim();
  if (!next || next.length > 80) return undefined;
  if (/^(new chat|untitled|untitled chat)$/i.test(next)) return undefined;
  if (isGenericVendorTitle(next)) return undefined;
  if (isWorkhorseInstructionTitle(next)) return undefined;
  if (looksLikeId(next)) return undefined;
  return next;
}

/**
 * Steal a sidebar title from vendor session metadata. Cheap fields only:
 * title / generated_title / displayName / sessionTitle / threadTitle / name.
 * Ignores ids and empty defaults. Never calls a model.
 */
export function titleFromRecord(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = asRecord(value);
  const nested = [
    record._meta,
    record.sessionInfo,
    record.info,
    record.session,
    record.thread,
    record.agent,
  ].map(asRecord);
  const keys = [
    "title",
    "generated_title",
    "displayName",
    "display_name",
    "sessionTitle",
    "session_title",
    "threadTitle",
    "thread_title",
    "name",
  ];
  for (const bag of [record, ...nested]) {
    for (const key of keys) {
      const title = usableTitle(bag[key]);
      if (title) return title;
    }
  }
  return undefined;
}

export function readGrokGeneratedTitle(cwd: string, vendorSessionId: string): string | undefined {
  if (!cwd || !vendorSessionId) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(grokSummaryPath(cwd, vendorSessionId), "utf8")) as Record<string, unknown>;
    return titleFromRecord(raw);
  } catch {
    return undefined;
  }
}

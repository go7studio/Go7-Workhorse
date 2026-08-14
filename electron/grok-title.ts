import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function grokHome(): string {
  const override = process.env.GROK_HOME?.trim();
  return override || path.join(os.homedir(), ".grok");
}

export function grokSummaryPath(cwd: string, vendorSessionId: string): string {
  return path.join(grokHome(), "sessions", encodeURIComponent(cwd), vendorSessionId, "summary.json");
}

export function titleFromRecord(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const meta = record._meta && typeof record._meta === "object" ? (record._meta as Record<string, unknown>) : {};
  for (const candidate of [record.title, record.generated_title, meta.title, meta.generated_title]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
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

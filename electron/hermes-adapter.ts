import { parseCatalogAgents, type ExternalAgent } from "../src/lib/external-catalog";
import { createEnvelope, newId } from "../src/lib/agent-runtime";
import type { ExternalAgentRef, ExternalTask } from "../src/lib/types";
import type { AgentCapabilities, ExternalSession } from "./openclaw-adapter";

export type HermesIo = {
  exec: (file: string, args: string[]) => { status: number; stdout: string; stderr: string } | Promise<{ status: number; stdout: string; stderr: string }>;
  binary?: string;
};

function binary(io: HermesIo): string {
  return io.binary?.trim() || "hermes";
}

export function parseHermesProfiles(text: string): ExternalAgent[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? ((parsed as { profiles?: unknown; agents?: unknown }).profiles ??
            (parsed as { agents?: unknown }).agents ??
            [])
        : [];
    const agents = parseCatalogAgents("hermes", Array.isArray(list) ? list : []);
    return agents.length > 0 ? agents : [{ runtimeId: "hermes", agentId: "default", name: "hermes/default" }];
  } catch {
    const names = text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*-\s*/, "").trim())
      .filter((line) => line && !line.startsWith("#"));
    if (names.length === 0) return [{ runtimeId: "hermes", agentId: "default", name: "hermes/default" }];
    return names.map((name) => ({ runtimeId: "hermes" as const, agentId: name, name: `hermes/${name}` }));
  }
}

export function parseHermesSessions(text: string): ExternalSession[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { sessions?: unknown }).sessions)
        ? (parsed as { sessions: unknown[] }).sessions
        : [];
    const sessions: ExternalSession[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const record = item as { id?: unknown; session?: unknown; profile?: unknown };
      const id = typeof record.id === "string" ? record.id : typeof record.session === "string" ? record.session : "";
      if (!id) continue;
      sessions.push({
        id,
        agentId: typeof record.profile === "string" ? record.profile : "default",
      });
    }
    return sessions;
  } catch {
    return [];
  }
}

export function parseHermesInspect(text: string): AgentCapabilities {
  try {
    const parsed = JSON.parse(text) as { workspace?: unknown; workspaces?: unknown; sandbox?: unknown };
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces.filter((item): item is string => typeof item === "string")
      : typeof parsed.workspace === "string"
        ? [parsed.workspace]
        : [];
    return { workspaces, ...(typeof parsed.sandbox === "string" ? { sandbox: parsed.sandbox } : {}) };
  } catch {
    return { workspaces: [] };
  }
}

export async function listHermesAgents(io: HermesIo): Promise<ExternalAgent[]> {
  const result = await io.exec(binary(io), ["profiles", "--json"]);
  if (result.status !== 0) {
    const fallback = await io.exec(binary(io), ["status"]);
    return parseHermesProfiles(fallback.stdout || "");
  }
  return parseHermesProfiles(result.stdout);
}

export async function startHermesTask(
  io: HermesIo,
  request: { ref: ExternalAgentRef; prompt: string; now?: number },
): Promise<ExternalTask> {
  const result = await io.exec(binary(io), ["chat", "--profile", request.ref.agentId, "--json", request.prompt]);
  const now = request.now ?? Date.now();
  let id = newId("hm", now);
  let status: ExternalTask["status"] = "running";
  let text: string | undefined;
  try {
    const parsed = JSON.parse(result.stdout || "{}") as { id?: unknown; status?: unknown; text?: unknown };
    if (typeof parsed.id === "string" && parsed.id.trim()) id = parsed.id.trim();
    if (
      parsed.status === "queued" ||
      parsed.status === "running" ||
      parsed.status === "completed" ||
      parsed.status === "failed" ||
      parsed.status === "cancelled"
    ) {
      status = parsed.status;
    }
    if (typeof parsed.text === "string") text = parsed.text;
  } catch {
    text = result.stdout.trim() || undefined;
  }
  return {
    id,
    ref: request.ref,
    status,
    startedAt: now,
    envelope: createEnvelope({ origin: "workhorse" }, now),
    grantId: "",
    ...(text ? { result: text } : {}),
  };
}

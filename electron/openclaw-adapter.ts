import { parseCatalogAgents, type ExternalAgent } from "../src/lib/external-catalog";
import type { ExternalAgentRef, ExternalTask } from "../src/lib/types";
import { createEnvelope, formatExternalAgentRef, newId } from "../src/lib/agent-runtime";

export type ExecResult = { status: number; stdout: string; stderr: string };

export type ExecFn = (file: string, args: string[]) => ExecResult | Promise<ExecResult>;

export type OpenClawIo = {
  exec: ExecFn;
  binary?: string;
};

export type AgentCapabilities = {
  workspaces: string[];
  sandbox?: string;
  tools?: string[];
};

export type ExternalSession = {
  id: string;
  agentId: string;
  title?: string;
};

function binary(io: OpenClawIo): string {
  return io.binary?.trim() || "openclaw";
}

export function parseOpenClawAgentsList(text: string): ExternalAgent[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { agents?: unknown }).agents)
        ? (parsed as { agents: unknown[] }).agents
        : [];
    const agents = parseCatalogAgents("openclaw", list);
    return agents.length > 0 ? agents : [{ runtimeId: "openclaw", agentId: "main", name: "openclaw/main" }];
  } catch {
    return [];
  }
}

export function parseOpenClawSessions(text: string): ExternalSession[] {
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
      const record = item as { id?: unknown; sessionId?: unknown; agent?: unknown; agentId?: unknown; title?: unknown };
      const id = typeof record.id === "string" ? record.id : typeof record.sessionId === "string" ? record.sessionId : "";
      if (!id) continue;
      const agentId =
        typeof record.agentId === "string"
          ? record.agentId
          : typeof record.agent === "string"
            ? record.agent
            : "main";
      sessions.push({
        id,
        agentId,
        ...(typeof record.title === "string" ? { title: record.title } : {}),
      });
    }
    return sessions;
  } catch {
    return [];
  }
}

export function parseOpenClawInspect(text: string): AgentCapabilities {
  try {
    const parsed = JSON.parse(text) as { workspace?: unknown; workspaces?: unknown; sandbox?: unknown; tools?: unknown };
    const workspaces = Array.isArray(parsed.workspaces)
      ? parsed.workspaces.filter((item): item is string => typeof item === "string")
      : typeof parsed.workspace === "string"
        ? [parsed.workspace]
        : [];
    return {
      workspaces,
      ...(typeof parsed.sandbox === "string" ? { sandbox: parsed.sandbox } : {}),
      ...(Array.isArray(parsed.tools)
        ? { tools: parsed.tools.filter((item): item is string => typeof item === "string") }
        : {}),
    };
  } catch {
    return { workspaces: [] };
  }
}

export async function listOpenClawAgents(io: OpenClawIo): Promise<ExternalAgent[]> {
  const result = await io.exec(binary(io), ["agents", "list", "--json"]);
  if (result.status !== 0) return [];
  return parseOpenClawAgentsList(result.stdout);
}

export async function listOpenClawSessions(io: OpenClawIo, agent?: ExternalAgentRef): Promise<ExternalSession[]> {
  const args = ["sessions", "--all-agents", "--json"];
  if (agent) args.push("--agent", agent.agentId);
  const result = await io.exec(binary(io), args);
  if (result.status !== 0) return [];
  return parseOpenClawSessions(result.stdout);
}

export async function inspectOpenClaw(io: OpenClawIo, agent: ExternalAgentRef): Promise<AgentCapabilities> {
  const result = await io.exec(binary(io), ["agent", "--agent", agent.agentId, "inspect", "--json"]);
  if (result.status !== 0) return { workspaces: [] };
  return parseOpenClawInspect(result.stdout);
}

export function taskFromOpenClawJson(text: string, ref: ExternalAgentRef, now = Date.now()): ExternalTask {
  let id = newId("oc", now);
  let status: ExternalTask["status"] = "running";
  let result: string | undefined;
  try {
    const parsed = JSON.parse(text) as { id?: unknown; taskId?: unknown; status?: unknown; result?: unknown; text?: unknown };
    if (typeof parsed.id === "string" && parsed.id.trim()) id = parsed.id.trim();
    else if (typeof parsed.taskId === "string" && parsed.taskId.trim()) id = parsed.taskId.trim();
    if (
      parsed.status === "queued" ||
      parsed.status === "running" ||
      parsed.status === "completed" ||
      parsed.status === "failed" ||
      parsed.status === "cancelled"
    ) {
      status = parsed.status;
    }
    if (typeof parsed.result === "string") result = parsed.result;
    else if (typeof parsed.text === "string") result = parsed.text;
  } catch {
    result = text.trim() || undefined;
  }
  return {
    id,
    ref,
    status,
    startedAt: now,
    envelope: createEnvelope({ origin: "workhorse" }, now),
    grantId: "",
    ...(result ? { result } : {}),
  };
}

export async function startOpenClawTask(
  io: OpenClawIo,
  request: { ref: ExternalAgentRef; prompt: string; now?: number },
): Promise<ExternalTask> {
  const result = await io.exec(binary(io), ["agent", "--agent", request.ref.agentId, request.prompt, "--json"]);
  return taskFromOpenClawJson(result.stdout || result.stderr, request.ref, request.now);
}

export { formatExternalAgentRef };

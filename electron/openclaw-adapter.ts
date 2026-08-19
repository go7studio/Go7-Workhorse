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

export function taskFromOpenClawJson(text: string, ref: ExternalAgentRef, now = Date.now()): ExternalTask {
  let id = newId("oc", now);
  let status: ExternalTask["status"] = "running";
  let result: string | undefined;
  let durationMs = 0;
  try {
    const parsed = JSON.parse(text) as {
      id?: unknown;
      taskId?: unknown;
      runId?: unknown;
      status?: unknown;
      summary?: unknown;
      result?: unknown;
      text?: unknown;
    };
    const externalId = [parsed.id, parsed.taskId, parsed.runId].find(
      (value): value is string => typeof value === "string" && Boolean(value.trim()),
    );
    if (externalId) id = externalId.trim();
    if (
      parsed.status === "queued" ||
      parsed.status === "running" ||
      parsed.status === "completed" ||
      parsed.status === "failed" ||
      parsed.status === "cancelled"
    ) {
      status = parsed.status;
    } else if (parsed.status === "error") {
      status = "failed";
    } else if (parsed.status === "ok" || parsed.summary === "completed") {
      status = "completed";
    }
    if (typeof parsed.result === "string") result = parsed.result;
    else if (parsed.result && typeof parsed.result === "object") {
      const resultRecord = parsed.result as { payloads?: unknown; meta?: unknown };
      const payloads = resultRecord.payloads;
      const meta = resultRecord.meta;
      if (meta && typeof meta === "object") {
        const rawDuration = (meta as { durationMs?: unknown }).durationMs;
        if (typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration > 0) {
          durationMs = rawDuration;
        }
      }
      if (Array.isArray(payloads)) {
        const textParts = payloads
          .map((payload) =>
            payload && typeof payload === "object" && typeof (payload as { text?: unknown }).text === "string"
              ? (payload as { text: string }).text.trim()
              : "",
          )
          .filter(Boolean);
        if (textParts.length > 0) result = textParts.join("\n");
      }
    } else if (typeof parsed.text === "string") result = parsed.text;
  } catch {
    result = text.trim() || undefined;
  }
  return {
    id,
    ref,
    status,
    startedAt: now,
    ...(["completed", "failed", "cancelled"].includes(status) ? { finishedAt: now + durationMs } : {}),
    envelope: createEnvelope({ origin: "workhorse" }, now),
    grantId: "",
    ...(result ? { result } : {}),
  };
}

export async function startOpenClawTask(
  io: OpenClawIo,
  request: { ref: ExternalAgentRef; prompt: string; taskId?: string; now?: number },
): Promise<ExternalTask> {
  const result = await io.exec(binary(io), [
    "agent",
    "--agent",
    request.ref.agentId,
    ...(request.taskId ? ["--session-id", request.taskId] : []),
    "--message",
    request.prompt,
    "--json",
  ]);
  const task = taskFromOpenClawJson(result.stdout || result.stderr, request.ref, request.now);
  if (result.status === 0) return task;
  return {
    ...task,
    status: "failed",
    finishedAt: request.now ?? Date.now(),
    result: (result.stderr || result.stdout).trim() || `OpenClaw exited ${result.status}`,
  };
}

export { formatExternalAgentRef };

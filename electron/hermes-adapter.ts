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

function cleanTerminalText(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "")
    .trim();
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
    const names = cleanTerminalText(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !/^[-─\s]+$/.test(line))
      .map((line) => line.replace(/^[◆*]\s*/, "").split(/\s{2,}/)[0]?.trim() ?? "")
      .filter((name) => name && name.toLowerCase() !== "profile");
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
  const current = await io.exec(binary(io), ["profile", "list"]);
  if (current.status === 0) return parseHermesProfiles(current.stdout);
  const legacy = await io.exec(binary(io), ["profiles", "--json"]);
  if (legacy.status === 0) return parseHermesProfiles(legacy.stdout);
  const fallback = await io.exec(binary(io), ["status"]);
  return parseHermesProfiles(fallback.stdout || "");
}

export async function startHermesTask(
  io: HermesIo,
  request: { ref: ExternalAgentRef; prompt: string; now?: number },
): Promise<ExternalTask> {
  const invokedAt = Date.now();
  const now = request.now ?? invokedAt;
  const result = await io.exec(binary(io), [
    "-p",
    request.ref.agentId,
    "chat",
    "-Q",
    "--source",
    "tool",
    "--max-turns",
    "32",
    "-q",
    request.prompt,
  ]);
  const finishedAt = now + Math.max(0, Date.now() - invokedAt);
  let id = newId("hm", now);
  let status: ExternalTask["status"] = result.status === 0 ? "completed" : "failed";
  let text: string | undefined;
  try {
    const parsed = JSON.parse(result.stdout || "{}") as {
      id?: unknown;
      sessionId?: unknown;
      status?: unknown;
      text?: unknown;
      result?: unknown;
    };
    if (typeof parsed.id === "string" && parsed.id.trim()) id = parsed.id.trim();
    else if (typeof parsed.sessionId === "string" && parsed.sessionId.trim()) id = parsed.sessionId.trim();
    if (parsed.status === "completed" || parsed.status === "failed" || parsed.status === "cancelled") {
      status = parsed.status;
    }
    if (typeof parsed.text === "string") text = parsed.text;
    else if (typeof parsed.result === "string") text = parsed.result;
  } catch {
    const output = cleanTerminalText(result.status === 0 ? result.stdout : result.stderr || result.stdout);
    const session = output.match(/(?:^|\n)Session:\s*([^\s]+)\s*$/i);
    if (session?.[1]) id = session[1];
    text = output.replace(/(?:^|\n)Session:\s*[^\s]+\s*$/i, "").trim() || undefined;
  }
  if (result.status !== 0) status = "failed";
  if (!text && result.status !== 0) text = cleanTerminalText(result.stderr || result.stdout) || undefined;
  return {
    id,
    ref: request.ref,
    status,
    startedAt: now,
    finishedAt,
    envelope: createEnvelope({ origin: "workhorse" }, now),
    grantId: "",
    ...(text ? { result: text } : result.status !== 0 ? { result: `Hermes exited ${result.status}` } : {}),
  };
}

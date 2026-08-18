import { detectAllRuntimes, catalogFromStatuses, type CatalogPaths, type DetectIo } from "../src/lib/external-catalog";
import { installWorkhorseExternalMcp, type InstallIo } from "./mcp-install";
import { listOpenClawAgents, startOpenClawTask, type OpenClawIo } from "./openclaw-adapter";
import { listHermesAgents, startHermesTask, type HermesIo } from "./hermes-adapter";
import type { RuntimeStartRequest } from "../src/lib/external-task";

export function runtimeTaskPrompt(request: Pick<RuntimeStartRequest, "prompt" | "taskId" | "envelope" | "parentSessionId">): string {
  const parent = request.parentSessionId ? ` Parent chat: ${request.parentSessionId}.` : "";
  return `Workhorse task ${request.taskId}. Trace: ${request.envelope.traceId}.${parent} Pass traceId and fromSessionId on Workhorse MCP calls.\n\n${request.prompt}`;
}

export function detectRuntimesOnHost(paths: CatalogPaths, io: DetectIo) {
  const statuses = detectAllRuntimes(paths, io);
  return { statuses, agents: catalogFromStatuses(statuses) };
}

export async function listRuntimeAgents(
  runtimeId: "openclaw" | "hermes",
  io: OpenClawIo & HermesIo,
): Promise<{ runtimeId: "openclaw" | "hermes"; agents: Awaited<ReturnType<typeof listOpenClawAgents>> }> {
  const agents = runtimeId === "openclaw" ? await listOpenClawAgents(io) : await listHermesAgents(io);
  return { runtimeId, agents };
}

export async function startRuntimeTask(
  io: OpenClawIo & HermesIo,
  request: RuntimeStartRequest,
) {
  const correlated = { ...request, prompt: runtimeTaskPrompt(request) };
  return request.ref.runtimeId === "openclaw" ? startOpenClawTask(io, correlated) : startHermesTask(io, correlated);
}

export function installExternalMcpConfig(
  input: {
    home: string;
    platform: "darwin" | "win32" | "linux";
    command: string;
    script: string;
    statePath: string;
  },
  io: InstallIo,
) {
  return installWorkhorseExternalMcp({ ...input, io });
}

import { detectAllRuntimes, catalogFromStatuses, type CatalogPaths, type DetectIo } from "../src/lib/external-catalog";
import { installWorkhorseExternalMcp, type InstallIo } from "./mcp-install";
import { listOpenClawAgents, startOpenClawTask, type OpenClawIo } from "./openclaw-adapter";
import { listHermesAgents, startHermesTask, type HermesIo } from "./hermes-adapter";
import type { ExternalAgentRef } from "../src/lib/types";

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
  request: { ref: ExternalAgentRef; prompt: string; now?: number },
) {
  return request.ref.runtimeId === "openclaw" ? startOpenClawTask(io, request) : startHermesTask(io, request);
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

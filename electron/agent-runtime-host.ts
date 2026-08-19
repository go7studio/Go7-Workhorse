import { detectAllRuntimes, catalogFromStatuses, type CatalogPaths, type DetectIo } from "../src/lib/external-catalog";
import { startOpenClawTask, type OpenClawIo } from "./openclaw-adapter";
import { startHermesTask, type HermesIo } from "./hermes-adapter";
import type { RuntimeStartRequest } from "../src/lib/external-task";

export function runtimeTaskPrompt(request: Pick<RuntimeStartRequest, "prompt" | "taskId" | "envelope" | "parentSessionId">): string {
  const parent = request.parentSessionId ? ` Parent chat: ${request.parentSessionId}.` : "";
  return `Workhorse task ${request.taskId}. Trace: ${request.envelope.traceId}.${parent} Pass traceId and fromSessionId on Workhorse MCP calls.\n\n${request.prompt}`;
}

export function detectRuntimesOnHost(paths: CatalogPaths, io: DetectIo) {
  const statuses = detectAllRuntimes(paths, io);
  return { statuses, agents: catalogFromStatuses(statuses) };
}

export async function startRuntimeTask(
  io: OpenClawIo & HermesIo,
  request: RuntimeStartRequest,
) {
  const correlated = { ...request, prompt: runtimeTaskPrompt(request) };
  return request.ref.runtimeId === "openclaw" ? startOpenClawTask(io, correlated) : startHermesTask(io, correlated);
}


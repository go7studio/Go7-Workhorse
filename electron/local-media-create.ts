/**
 * Desk-local media create via Local Compute capability invoke.
 * Workshop HTTP stays GET-only; this module owns the mutate path.
 */
import { randomUUID } from "node:crypto";
import { LocalCapabilityHostClient, LocalCapabilityHostError, type LocalCapabilityHostConfig } from "./local-capability-host";
import { localComputeHostCallable, type LocalComputeHostSettings } from "../src/lib/local-compute";
import type { LocalJobRequest } from "../src/lib/local-capability-contract";

const CAPABILITY_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9]*){1,7}$/;
const TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type MediaCreateTemplateField = string | number | boolean;

export type MediaCreateInput = {
  hostId: string;
  capability: string;
  templateId: string;
  fields?: Record<string, MediaCreateTemplateField>;
};

export type MediaCreateResult =
  | { ok: true; jobId?: string; message: string }
  | { ok: false; reason: string };

export type MediaCreateDeps = {
  hosts: LocalComputeHostSettings[];
  stateDir: string;
  /** Optional override for tests. */
  client?: LocalCapabilityHostClient | null;
};

function refuse(reason: string): MediaCreateResult {
  return { ok: false, reason };
}

function hostConfigs(hosts: LocalComputeHostSettings[]): LocalCapabilityHostConfig[] {
  const out: LocalCapabilityHostConfig[] = [];
  for (const host of hosts) {
    if (!host.enabled) continue;
    if (typeof host.id !== "string" || typeof host.baseUrl !== "string" || typeof host.tokenFile !== "string") continue;
    out.push({ id: host.id, baseUrl: host.baseUrl, tokenFile: host.tokenFile });
  }
  return out;
}

/** Validate create input and report why Queue cannot run (empty caps, unknown host, bad id). */
export function mediaCreateGate(
  hosts: LocalComputeHostSettings[],
  input: MediaCreateInput,
): { ok: true; host: LocalComputeHostSettings } | { ok: false; reason: string } {
  const hostId = typeof input.hostId === "string" ? input.hostId.trim() : "";
  const capability = typeof input.capability === "string" ? input.capability.trim() : "";
  const templateId = typeof input.templateId === "string" ? input.templateId.trim() : "";
  if (!hostId) return { ok: false, reason: "No Local Compute host selected for this pack." };
  if (!CAPABILITY_ID.test(capability)) return { ok: false, reason: "Template capability id is invalid." };
  if (!TEMPLATE_ID.test(templateId)) return { ok: false, reason: "Template id is invalid." };
  const host = hosts.find((row) => row.id === hostId && row.enabled);
  if (!host) return { ok: false, reason: "Local Compute host is not configured." };
  if (host.allowedCapabilities.length === 0) {
    return { ok: false, reason: "Local Compute host has no allowed capabilities" };
  }
  if (!localComputeHostCallable(host, "desk", capability)) {
    return { ok: false, reason: `Capability ${capability} is not allowed on this host.` };
  }
  return { ok: true, host };
}

function buildRequest(input: MediaCreateInput, fields: Record<string, MediaCreateTemplateField>): LocalJobRequest {
  const requestId = `req_${randomUUID().replace(/-/g, "")}`;
  const traceId = `trace_${randomUUID().replace(/-/g, "")}`;
  const idempotencyKey = `media-create:${input.templateId}:${requestId}`;
  return {
    protocolVersion: "1.0",
    requestId,
    traceId,
    idempotencyKey,
    origin: "workhorse",
    visitedSystems: ["workhorse"],
    hopCount: 1,
    capability: input.capability.trim(),
    priority: 1,
    deadline: null,
    inputs: [],
    requiredOutputs: [{ role: "output", kind: "file", mediaTypes: ["image/*", "video/*"], required: true }],
    constraints: {
      templateId: input.templateId.trim(),
      ...fields,
    },
    workflow: { autoContinue: false, approvedCapabilities: [], maxContinuations: 0 },
    metadata: { surface: "media-create" },
  };
}

/**
 * Queue a media template through Local Compute when the host advertises the capability.
 * If the LC client cannot POST (misconfigured token / unreachable), return a clear reason —
 * never a silent success and never a workshop POST.
 */
export async function invokeMediaCreate(deps: MediaCreateDeps, raw: unknown): Promise<MediaCreateResult> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse("Create request is invalid.");
  const input = raw as MediaCreateInput;
  const gate = mediaCreateGate(deps.hosts, input);
  if (!gate.ok) return refuse(gate.reason);

  const fields =
    input.fields && typeof input.fields === "object" && !Array.isArray(input.fields)
      ? Object.fromEntries(
          Object.entries(input.fields).filter(
            ([key, value]) =>
              /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) &&
              (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
          ),
        )
      : {};

  const configs = hostConfigs(deps.hosts);
  if (configs.length === 0) {
    return refuse("Local Compute host has no allowed capabilities");
  }

  const client =
    deps.client === undefined
      ? new LocalCapabilityHostClient({ hosts: configs, stateDir: deps.stateDir })
      : deps.client;
  if (!client) {
    return refuse("Local Compute host has no allowed capabilities");
  }

  try {
    const job = await client.submit(gate.host.id, buildRequest(input, fields));
    return { ok: true, jobId: job.id, message: `Queued ${input.templateId} as ${job.id}` };
  } catch (error) {
    if (error instanceof LocalCapabilityHostError) {
      if (error.code === "unknown_host" || error.code === "invalid_config") {
        return refuse("Local Compute host has no allowed capabilities");
      }
      return refuse(error.message || error.code);
    }
    const message = error instanceof Error ? error.message : "create failed";
    return refuse(message);
  }
}

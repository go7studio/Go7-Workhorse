import { isStockProviderId, parseExternalAgentRef, type ExternalErrorCode } from "../src/lib/agent-runtime";
import type { McpExposureProfile, ProviderId } from "../src/lib/types";

export const EXTERNAL_RUNTIME_ALLOW = [
  "workhorse_list_chats",
  "workhorse_read_chat",
  "workhorse_ask_chat",
  "workhorse_list_projects",
  "workhorse_list_agents",
  "workhorse_list_external_agents",
  "workhorse_spawn_agent",
  "workhorse_await_agents",
  "workhorse_agent_status",
  "workhorse_cancel_agent",
] as const;

export const EXTERNAL_RUNTIME_FORBIDDEN = [
  "workhorse_delete_chat",
  "workhorse_delete_project",
  "workhorse_rename_chat",
  "workhorse_rename_project",
  "workhorse_create_project",
  "workhorse_move_chat",
  "workhorse_add_reference",
  "workhorse_delete_reference",
  "workhorse_list_references",
  "workhorse_setup_custom_bot",
  "workhorse_detect_custom",
  "workhorse_delete_bot",
  "workhorse_request_permission",
  "workhorse_request_vendor",
  "workhorse_plan",
  "workhorse_probe_runtime",
  "workhorse_list_skills",
  "workhorse_read_skill",
  "workhorse_list_bots",
] as const;

export function mcpExposureProfile(raw: unknown): McpExposureProfile {
  if (raw === "worker" || raw === "external-runtime" || raw === "desk") return raw;
  return "desk";
}

export function isMcpToolAllowed(profile: McpExposureProfile, tool: string): boolean {
  if (profile !== "external-runtime") return true;
  return (EXTERNAL_RUNTIME_ALLOW as readonly string[]).includes(tool);
}

export function assertMcpToolAllowed(profile: McpExposureProfile, tool: string): void {
  if (!isMcpToolAllowed(profile, tool)) {
    const error = new Error("profile_forbidden");
    (error as Error & { code: ExternalErrorCode }).code = "profile_forbidden";
    throw error;
  }
}

export type InboundParentInput = {
  profile: McpExposureProfile;
  fromSessionId?: string;
  defaultSessionId?: string;
  defaultProjectId?: string;
  runningVisibleSessionId?: string;
};

export type InboundParentResult =
  | { ok: true; sessionId: string; source: "from" | "default" }
  | { ok: true; discoveryOnly: true }
  | { ok: false; code: "context_required" };

export function resolveInboundParent(input: InboundParentInput): InboundParentResult {
  const from = input.fromSessionId?.trim() ?? "";
  if (from) return { ok: true, sessionId: from, source: "from" };
  const configured = input.defaultSessionId?.trim() ?? "";
  if (configured) return { ok: true, sessionId: configured, source: "default" };
  if (input.profile === "external-runtime") {
    if (input.defaultProjectId?.trim()) return { ok: true, discoveryOnly: true };
    return { ok: true, discoveryOnly: true };
  }
  const ambient = input.runningVisibleSessionId?.trim() ?? "";
  if (ambient) return { ok: true, sessionId: ambient, source: "from" };
  return { ok: true, discoveryOnly: true };
}

export function inboundSpawnParent(input: InboundParentInput): { parentId: string } | { code: "context_required" } {
  const resolved = resolveInboundParent(input);
  if (resolved.ok && "sessionId" in resolved) return { parentId: resolved.sessionId };
  return { code: "context_required" };
}

export function inboundSessionIdFromState(state: { settings?: unknown } | undefined): string {
  if (!state?.settings || typeof state.settings !== "object") return "";
  const systems = (state.settings as { agentSystems?: { inboundSessionId?: unknown } }).agentSystems;
  return typeof systems?.inboundSessionId === "string" ? systems.inboundSessionId.trim() : "";
}

export function resolveMcpSpawnFrom(input: {
  profile: McpExposureProfile;
  fromSessionId?: string;
  inboundSessionId?: string;
}): { parentId: string } | { code: "context_required" } {
  return inboundSpawnParent({
    profile: input.profile,
    fromSessionId: input.fromSessionId,
    defaultSessionId: input.inboundSessionId,
  });
}

export type InboundActionInput = InboundParentInput & {
  tool: string;
  spawnProvider?: string;
};

export type InboundActionResult =
  | { ok: true; kind: "allowed" }
  | { ok: true; kind: "spawn-workhorse"; parentId: string; provider: ProviderId }
  | { ok: false; code: ExternalErrorCode };

export function inboundDeskAction(input: InboundActionInput): InboundActionResult {
  if (!isMcpToolAllowed(input.profile, input.tool)) return { ok: false, code: "profile_forbidden" };
  if (input.tool !== "workhorse_spawn_agent") return { ok: true, kind: "allowed" };
  const parent = inboundSpawnParent(input);
  if ("code" in parent) return { ok: false, code: "context_required" };
  const external = parseExternalAgentRef(input.spawnProvider);
  if (external) return { ok: false, code: "cycle_rejected" };
  const provider = (input.spawnProvider ?? "").trim().toLowerCase();
  if (provider && !isStockProviderId(provider)) return { ok: false, code: "not_callable" };
  return {
    ok: true,
    kind: "spawn-workhorse",
    parentId: parent.parentId,
    provider: isStockProviderId(provider) ? provider : "codex",
  };
}

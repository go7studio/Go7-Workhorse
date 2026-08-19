import { isStockProviderId, parseExternalAgentRef, type ExternalErrorCode } from "../src/lib/agent-runtime";
import { AUDITOR_DESK_TOOLS, WORKER_DESK_TOOLS } from "../src/lib/subagents";
import type { McpExposureProfile, ProviderId } from "../src/lib/types";
import type { DeskRole } from "../src/lib/workhorse-rules";

export const EXTERNAL_RUNTIME_ALLOW = [
  "workhorse_capabilities",
  "workhorse_delegate",
  "workhorse_continue_mission",
  "workhorse_list_bots",
  "workhorse_query_capacity",
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
] as const;


/**
 * `link` is the product-facing spelling of the external profile (Workhorse
 * Link); `external-runtime` stays the internal value every written config
 * carries, so a config from before the name existed still restricts. A
 * value this build does not recognise is treated as the restricted profile,
 * not the open desk: an unknown word in a harness config is far more likely
 * a newer spelling than a grant of everything. Absent means the desk's own
 * CLIs, which set nothing.
 */
export function mcpExposureProfile(raw: unknown): McpExposureProfile {
  if (raw === "worker" || raw === "auditor" || raw === "external-runtime" || raw === "desk") return raw;
  if (raw === "link") return "external-runtime";
  if (typeof raw === "string" && raw.trim()) return "external-runtime";
  return "desk";
}

export function isMcpToolAllowed(profile: McpExposureProfile, tool: string): boolean {
  if (profile === "desk") return true;
  if (profile === "worker") return (WORKER_DESK_TOOLS as readonly string[]).includes(tool);
  if (profile === "auditor") return (AUDITOR_DESK_TOOLS as readonly string[]).includes(tool);
  return (EXTERNAL_RUNTIME_ALLOW as readonly string[]).includes(tool);
}

/**
 * The profile a call runs under. The process env names the transport the
 * server was launched for (an external runtime gets `external-runtime`); a
 * Workhorse worker chat is a `worker` whatever transport it arrived on, because
 * the caller session decides what the caller is, not the pipe.
 */
export function profileForCaller(envProfile: McpExposureProfile, callerRole: DeskRole | undefined): McpExposureProfile {
  if (envProfile === "external-runtime") return envProfile;
  if (callerRole === "auditor") return "auditor";
  if (callerRole === "worker") return "worker";
  return envProfile;
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
  if (input.profile !== "external-runtime") {
    const ambient = input.runningVisibleSessionId?.trim() ?? "";
    if (ambient) return { ok: true, sessionId: ambient, source: "from" };
  }
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

export function inboundAmbientSessionIdFromState(state: { activeSessionId?: unknown; sessions?: unknown } | undefined): string {
  const active = typeof state?.activeSessionId === "string" ? state.activeSessionId.trim() : "";
  if (!active) return "";
  if (!Array.isArray(state?.sessions)) return active;
  const hit = state.sessions.find(
    (item) => item && typeof item === "object" && (item as { id?: unknown }).id === active,
  ) as { hidden?: boolean; archivedAt?: unknown } | undefined;
  if (!hit || hit.hidden || hit.archivedAt) return "";
  return active;
}

export function resolveMcpSpawnFrom(input: {
  profile: McpExposureProfile;
  fromSessionId?: string;
  inboundSessionId?: string;
  runningVisibleSessionId?: string;
}): { parentId: string } | { code: "context_required" } {
  return inboundSpawnParent({
    profile: input.profile,
    fromSessionId: input.fromSessionId,
    defaultSessionId: input.inboundSessionId,
    runningVisibleSessionId: input.runningVisibleSessionId,
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

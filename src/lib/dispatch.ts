import { authorizeExternalCall, isExternalAgentAddress, isStockProviderId, parseExternalAgentRef } from "./agent-runtime";
import type { AgentGrant, AgentRuntimeId, RoutingDecision } from "./types";

export type DispatchDecision =
  | { kind: "desk-model"; route: RoutingDecision }
  | { kind: "external-agent"; runtimeId: AgentRuntimeId; agentId: string }
  | { kind: "refuse"; code: "grant_required" | "not_callable" };

export type DispatchInput = {
  namedProvider?: unknown;
  namedModel?: unknown;
  namedChat?: unknown;
  namedExternal?: unknown;
  routing: { enabled?: boolean; includeExternalAgents?: boolean };
  grant?: AgentGrant | null;
  deskRoute?: RoutingDecision;
  needsWorkhorseSandbox?: boolean;
  runtimeCanEnforceSandbox?: boolean;
  externalCandidates?: import("./types").ExternalAgentRef[];
};

export function decideDispatch(input: DispatchInput): DispatchDecision {
  const namedDesk =
    (typeof input.namedProvider === "string" && isStockProviderId(input.namedProvider.trim().toLowerCase())) ||
    (typeof input.namedModel === "string" && input.namedModel.trim() && !isExternalAgentAddress(input.namedModel)) ||
    (typeof input.namedChat === "string" && input.namedChat.trim() && !isExternalAgentAddress(input.namedChat));
  if (namedDesk && !isExternalAgentAddress(input.namedProvider) && input.deskRoute) {
    return { kind: "desk-model", route: input.deskRoute };
  }

  const explicit =
    parseExternalAgentRef(input.namedExternal) ||
    parseExternalAgentRef(input.namedProvider) ||
    parseExternalAgentRef(input.namedChat);
  if (explicit) {
    const auth = authorizeExternalCall({ grant: input.grant, explicitTarget: explicit, routing: input.routing });
    if (!auth.ok) return { kind: "refuse", code: auth.code === "not_callable" ? "not_callable" : "grant_required" };
    if (input.needsWorkhorseSandbox && !input.runtimeCanEnforceSandbox) {
      if (input.deskRoute) return { kind: "desk-model", route: input.deskRoute };
      return { kind: "refuse", code: "not_callable" };
    }
    return { kind: "external-agent", runtimeId: auth.ref.runtimeId, agentId: auth.ref.agentId };
  }

  if (!input.routing.enabled) {
    if (input.deskRoute) return { kind: "desk-model", route: input.deskRoute };
    return { kind: "refuse", code: "grant_required" };
  }

  if (!input.routing.includeExternalAgents) {
    if (input.deskRoute) return { kind: "desk-model", route: input.deskRoute };
    return { kind: "refuse", code: "grant_required" };
  }

  const auth = authorizeExternalCall({
    grant: input.grant,
    routing: input.routing,
    selectFrom: input.externalCandidates,
  });
  if (!auth.ok) {
    if (input.deskRoute) return { kind: "desk-model", route: input.deskRoute };
    return { kind: "refuse", code: "grant_required" };
  }
  if (input.needsWorkhorseSandbox && !input.runtimeCanEnforceSandbox) {
    if (input.deskRoute) return { kind: "desk-model", route: input.deskRoute };
    return { kind: "refuse", code: "not_callable" };
  }
  return { kind: "external-agent", runtimeId: auth.ref.runtimeId, agentId: auth.ref.agentId };
}

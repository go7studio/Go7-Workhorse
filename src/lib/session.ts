import { modeLabel } from "./commands";
import { normalizeQueuedPrompt } from "./chats";
import { collapseToolText } from "./grok-events";
import { normalizeImages } from "./images";
import { defaultModel, effortLabel, modelName, normalizeModelId, withEffort } from "./models";
import { isProviderId } from "./providers";
import { normalizeGoal } from "./goal";
import { normalizeSessionEnvironment } from "./session-environment";
import { normalizeScheduledRuns } from "./schedule";
import { normalizeLineup } from "./lineup";
import { normalizePlanRun } from "./plan";
import { normalizeAgentRun } from "./subagents";
import { normalizePortableCheckpoint } from "./portable-compaction";
import { normalizeRoutingDecision } from "./routing";
import type { ChatMessage, CustomBot, EffortLevel, PermissionMode, ProviderId, SandboxProfile, Session } from "./types";

export type BrainStamp = {
  provider: ProviderId;
  model: string;
  customBotId?: string;
};

export function brainStamp(session: Pick<Session, "provider" | "model" | "customBotId">): BrainStamp {
  return {
    provider: session.provider,
    model: session.model,
    ...(session.customBotId ? { customBotId: session.customBotId } : {}),
  };
}

export function stampUnstampedMessages(messages: ChatMessage[], stamp: BrainStamp): ChatMessage[] {
  return messages.map((message) => (message.provider ? message : { ...message, ...stamp }));
}

export function messageBrain(
  message: Pick<ChatMessage, "provider" | "model" | "customBotId">,
  fallback: BrainStamp,
): BrainStamp {
  if (!message.provider) return fallback;
  return {
    provider: message.provider,
    model: message.model ?? fallback.model,
    ...(message.customBotId ? { customBotId: message.customBotId } : {}),
  };
}

export function asProviderId(value: string | undefined): ProviderId {
  return isProviderId(value) ? value : "grok";
}

/** Visible sidebar subtitle: model · effort · mode. Not the last-message preview. */
export function formatChatSidebar(input: {
  provider: string;
  model: string;
  effort?: string | null;
  mode?: string;
  botName?: string;
}): string {
  const provider = asProviderId(input.provider);
  const name = input.botName?.trim() || modelName(provider, input.model);
  const effort = effortLabel((input.effort as EffortLevel | null) ?? null);
  const mode = modeLabel(parsePermissionMode(input.mode ?? "") ?? "ask");
  return [name, effort, mode].filter(Boolean).join(" · ");
}

export function applySessionPolicyChange(
  session: Session,
  patch: { mode?: PermissionMode; sandbox?: SandboxProfile; securityPolicy?: import("./types").SessionSecurityPolicy },
): Session {
  const mode = patch.mode ?? session.mode;
  const sandbox = patch.sandbox ?? session.sandbox;
  const securityPolicy = patch.securityPolicy ?? session.securityPolicy;
  const changed =
    mode !== session.mode ||
    sandbox !== session.sandbox ||
    JSON.stringify(securityPolicy) !== JSON.stringify(session.securityPolicy);
  return {
    ...session,
    mode,
    sandbox,
    securityPolicy,
    vendorSessionId: changed ? undefined : session.vendorSessionId,
    vendorProvider: changed ? undefined : session.vendorProvider,
    permissionGrants: changed ? undefined : session.permissionGrants,
    status: changed && (session.status === "running" || session.status === "needs-input") ? "idle" : session.status,
  };
}

/** Raise Permission/Sandbox for a live turn without dropping the vendor session. */
export function applySessionElevation(
  session: Session,
  patch: { mode?: PermissionMode; sandbox?: SandboxProfile },
): Session {
  return {
    ...session,
    mode: patch.mode ?? session.mode,
    sandbox: patch.sandbox ?? session.sandbox,
  };
}

export function applySessionModelChange(
  session: Session,
  next: { provider: ProviderId; model: string; effort: EffortLevel | null; customBotId?: string },
): Session {
  const providerChanged = session.provider !== next.provider || session.customBotId !== next.customBotId;
  const switched = providerChanged || session.model !== next.model;
  return {
    ...session,
    provider: next.provider,
    model: next.model,
    effort: next.effort,
    customBotId: next.customBotId,
    vendorSessionId: providerChanged ? undefined : session.vendorSessionId,
    vendorProvider: providerChanged ? undefined : session.vendorProvider,
    permissionGrants: providerChanged ? undefined : session.permissionGrants,
    status: providerChanged && (session.status === "running" || session.status === "needs-input") ? "idle" : session.status,
    messages: switched ? stampUnstampedMessages(session.messages, brainStamp(session)) : session.messages,
  };
}

export function vendorSessionForSend(
  session: Pick<Session, "provider" | "vendorSessionId" | "vendorProvider">,
): string | undefined {
  if (!session.vendorSessionId?.trim()) return undefined;
  if (session.vendorProvider && session.vendorProvider !== session.provider) return undefined;
  return session.vendorSessionId;
}

export function brainCaption(
  stamp: BrainStamp,
  bots: CustomBot[],
  llms?: import("./types").Settings["llms"],
): { name: string; provider: ProviderId; color?: string } {
  if (stamp.customBotId) {
    const bot = bots.find((item) => item.id === stamp.customBotId);
    if (bot) return { name: bot.name, provider: "custom", color: bot.color };
  }
  const link = stamp.provider !== "custom" ? llms?.[stamp.provider] : undefined;
  return {
    name: link?.name?.trim() || modelName(stamp.provider, stamp.model),
    provider: stamp.provider,
    color: link?.color,
  };
}

export const SANDBOX_PROFILES: SandboxProfile[] = ["off", "workspace", "read-only", "strict"];

export function parsePermissionMode(value: string): PermissionMode | null {
  if (value === "ask" || value === "accept-edits" || value === "always-approve" || value === "plan") return value;
  return null;
}

export function parseSandbox(value: string): SandboxProfile | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "readonly") return "read-only";
  if (SANDBOX_PROFILES.includes(trimmed as SandboxProfile)) return trimmed as SandboxProfile;
  return null;
}

export function normalizeSandbox(raw: unknown): SandboxProfile {
  return typeof raw === "string" ? parseSandbox(raw) ?? "off" : "off";
}

export function normalizeSessionSecurityPolicy(_raw?: unknown): import("./types").SessionSecurityPolicy {
  return { network: "allowed", root: "allowed" };
}

export function normalizeSession(raw: unknown): Session | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<Session>;
  if (typeof record.id !== "string") return null;
  const provider = isProviderId(record.provider) ? record.provider : "grok";
  const model = normalizeModelId(
    provider,
    typeof record.model === "string" && record.model ? record.model : defaultModel(provider).id,
  );
  const mode = parsePermissionMode(String(record.mode ?? "")) ?? "ask";
  return {
    id: record.id,
    projectId: typeof record.projectId === "string" && record.projectId ? record.projectId : null,
    parentId: typeof record.parentId === "string" && record.parentId.trim() ? record.parentId.trim() : undefined,
    hidden: record.hidden === true || (typeof record.parentId === "string" && Boolean(record.parentId.trim())) || undefined,
    provider,
    model,
    customBotId:
      typeof record.customBotId === "string" && record.customBotId.trim() ? record.customBotId.trim() : undefined,
    effort: withEffort(provider, model, record.effort ?? "medium"),
    title: typeof record.title === "string" ? record.title : "New chat",
    titleLocked: record.titleLocked === true,
    mode,
    sandbox: normalizeSandbox(record.sandbox),
    securityPolicy: normalizeSessionSecurityPolicy(record.securityPolicy),
    environment: normalizeSessionEnvironment(record.environment),
    vendorSessionId:
      typeof record.vendorSessionId === "string" && record.vendorSessionId.trim()
        ? record.vendorSessionId.trim()
        : undefined,
    vendorProvider: isProviderId(record.vendorProvider) ? record.vendorProvider : undefined,
    status: record.status === "needs-input" ? "needs-input" : "idle",
    messages: Array.isArray(record.messages)
      ? record.messages
          .map(normalizeMessage)
          .filter((item): item is ChatMessage => item !== null && !isSessionIntro(item))
      : [],
    contextUsed: typeof record.contextUsed === "number" ? Math.max(0, record.contextUsed) : 0,
    archivedAt: typeof record.archivedAt === "number" ? record.archivedAt : null,
    permissionGrants: Array.isArray(record.permissionGrants)
      ? record.permissionGrants.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : undefined,
    queue: (() => {
      if (!Array.isArray(record.queue)) return undefined;
      const rows = record.queue.map(normalizeQueuedPrompt).filter((item): item is NonNullable<typeof item> => item !== null);
      return rows.length > 0 ? rows : undefined;
    })(),
    scheduledRuns: normalizeScheduledRuns(record.scheduledRuns),
    contextCheckpoint: normalizePortableCheckpoint(record.contextCheckpoint),
    composerDraft:
      typeof record.composerDraft === "string" && record.composerDraft ? record.composerDraft : undefined,
    composerImages: (() => {
      const images = normalizeImages(record.composerImages);
      return images.length > 0 ? images : undefined;
    })(),
    goal: normalizeGoal(record.goal),
    agentRun: normalizeAgentRun(record.agentRun),
    lineup: normalizeLineup(record.lineup),
    planRun: normalizePlanRun(record.planRun),
    routingMode: record.routingMode === "auto" ? "auto" : "manual",
    routingDecision: normalizeRoutingDecision(record.routingDecision),
  };
}

export function isSessionIntro(message: Pick<ChatMessage, "role" | "kind" | "text">): boolean {
  if (message.role !== "system" || message.kind) return false;
  return /\bis live via Grok Build\b/.test(message.text) || /\bis not connected yet\./.test(message.text);
}

export function normalizeMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<ChatMessage>;
  if (typeof record.id !== "string") return null;
  if (typeof record.text !== "string" && !Array.isArray(record.images)) return null;
  const role = record.role === "user" || record.role === "assistant" || record.role === "system" ? record.role : null;
  if (!role) return null;
  const kind =
    record.kind === "tool" ||
    record.kind === "compact" ||
    record.kind === "thought" ||
    record.kind === "peer" ||
    record.kind === "subagent"
      ? record.kind
      : undefined;
  const images = normalizeImages(record.images);
  return {
    id: record.id,
    role,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    ...(images.length > 0 ? { images } : {}),
    kind,
    fromTitle: typeof record.fromTitle === "string" && record.fromTitle.trim() ? record.fromTitle.trim() : undefined,
    subagentSessionId:
      typeof record.subagentSessionId === "string" && record.subagentSessionId.trim()
        ? record.subagentSessionId.trim()
        : undefined,
    toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : undefined,
    toolStatus: typeof record.toolStatus === "string" ? record.toolStatus : undefined,
    thought: typeof record.thought === "string" && record.thought ? record.thought : undefined,
    workedMs: typeof record.workedMs === "number" && record.workedMs >= 0 ? Math.round(record.workedMs) : undefined,
    provider: isProviderId(record.provider) ? record.provider : undefined,
    model:
      typeof record.model === "string" && record.model.trim()
        ? normalizeModelId(isProviderId(record.provider) ? record.provider : "grok", record.model)
        : undefined,
    customBotId:
      typeof record.customBotId === "string" && record.customBotId.trim() ? record.customBotId.trim() : undefined,
    peerFromSessionId:
      typeof record.peerFromSessionId === "string" && record.peerFromSessionId.trim() ? record.peerFromSessionId.trim() : undefined,
    correlationId:
      typeof record.correlationId === "string" && record.correlationId.trim() ? record.correlationId.trim() : undefined,
    text:
      kind === "tool"
        ? collapseToolText(
            typeof record.text === "string" ? record.text : "",
            typeof record.toolStatus === "string" ? record.toolStatus : undefined,
          )
        : typeof record.text === "string"
          ? record.text
          : "",
  };
}

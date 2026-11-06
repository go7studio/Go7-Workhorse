import type { DeskAccess, EffortLevel, ProviderId, Session } from "./types";

/** Title of the desk's Link parent. It is a session, and it is not a sidebar chat. */
export const LINK_BRIDGE_TITLE = "Workhorse Link";

export function isLinkBridgeSession(session: { linkBridge?: boolean } | null | undefined): boolean {
  return session?.linkBridge === true;
}

export type LinkBridgeChoice = {
  provider: ProviderId;
  model: string;
  customBotId?: string;
  effort: EffortLevel | null;
};

/**
 * The parent for an external call that named no chat.
 * One host per project (loose when projectId is null). Reuse keeps its transcript
 * and lineup. Permission and Sandbox follow the desk default passed in, never
 * whichever chat happens to be open.
 */
export function linkBridgeHostFor(input: {
  sessions: Session[];
  projectId: string | null;
  choice: LinkBridgeChoice;
  access: DeskAccess;
  id: string;
}): Session {
  const projectId = input.projectId;
  const existing = input.sessions.find(
    (session) => session.linkBridge === true && (session.projectId ?? null) === projectId && typeof session.archivedAt !== "number",
  );
  if (existing) {
    return {
      ...existing,
      mode: input.access.mode,
      sandbox: input.access.sandbox,
      linkBridge: true,
      title: existing.title?.trim() || LINK_BRIDGE_TITLE,
      titleLocked: true,
      previewUsed: true,
    };
  }
  return {
    id: input.id,
    projectId,
    linkBridge: true,
    provider: input.choice.provider,
    model: input.choice.model,
    ...(input.choice.customBotId ? { customBotId: input.choice.customBotId } : {}),
    effort: input.choice.effort,
    title: LINK_BRIDGE_TITLE,
    titleLocked: true,
    previewUsed: true,
    mode: input.access.mode,
    sandbox: input.access.sandbox,
    environment: { kind: "local" },
    securityPolicy: { network: "allowed", root: "allowed" },
    status: "idle",
    contextUsed: 0,
    messages: [],
    routingMode: "manual",
  };
}

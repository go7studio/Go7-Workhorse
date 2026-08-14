import { toolIsFinished } from "./grok-events";
import { parseProviderId, subagentTurns } from "./subagents";
import { peerToolFromMessage } from "./tool-labels";
import type { ChatMessage, ProviderId, Session } from "./types";

export type AgentThreadTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  fromTitle?: string;
};

export type AgentThread = {
  id: string;
  childId: string;
  title: string;
  live: boolean;
  fromLabel: string;
  toLabel: string;
  turns: AgentThreadTurn[];
  provider?: ProviderId;
  error?: string;
  run?: Session["agentRun"];
};

function displayTarget(raw: string): string {
  const value = raw.trim();
  if (!value || /^workhorse[_-]/i.test(value)) return "";
  return value;
}

export function agentThreadsForSession(session: Session, sessions: Session[]): AgentThread[] {
  const threads: AgentThread[] = [];
  const seen = new Set<string>();
  const parentTitle = session.title.trim() || "This chat";

  const add = (child: Session, marker?: ChatMessage) => {
    if (seen.has(child.id)) return;
    seen.add(child.id);
    const toLabel = (marker?.fromTitle || child.title || "the other agent").trim();
    const live =
      child.status === "running" || child.status === "needs-input" || marker?.toolStatus === "running";
    const failed = marker?.toolStatus === "failed";
    threads.push({
      id: child.id,
      childId: child.id,
      title: toLabel,
      live,
      fromLabel: parentTitle,
      toLabel,
      turns: subagentTurns(child, marker?.createdAt ?? 0),
      provider: child.provider,
      error: failed ? marker?.text?.trim() || undefined : undefined,
      run: child.agentRun,
    });
  };

  for (const message of session.messages) {
    if (message.kind !== "subagent") continue;
    const child = message.subagentSessionId
      ? sessions.find((item) => item.id === message.subagentSessionId)
      : undefined;
    if (child) {
      add(child, message);
      continue;
    }
    if (message.toolStatus !== "failed" && !message.text.trim()) continue;
    const id = message.subagentSessionId || message.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const toLabel = (message.fromTitle || message.text || "the other agent").trim();
    const failed = message.toolStatus === "failed" || /watch safety|no leftover|day bank|daily bank|not connected/i.test(message.text);
    threads.push({
      id,
      childId: "",
      title: failed ? toLabel.split(/[.—]/)[0]?.trim() || toLabel : toLabel,
      live: false,
      fromLabel: parentTitle,
      toLabel,
      turns: [],
      provider: parseProviderId(message.fromTitle || "") ?? undefined,
      error: failed ? message.text.trim() : undefined,
    });
  }

  for (const child of sessions) {
    if (child.parentId === session.id) add(child);
  }

  for (const message of session.messages) {
    if (message.kind !== "tool") continue;
    const peer = peerToolFromMessage(message);
    if (!peer || (peer.kind !== "ask" && peer.kind !== "call")) continue;
    const target = displayTarget(peer.target);
    const failed = /fail|error|denied/i.test(message.toolStatus ?? "") || toolIsFinished(message.toolStatus) && /watch safety|no leftover|day bank|daily bank|not connected/i.test(message.text);
    const live = !toolIsFinished(message.toolStatus);
    if (!live && !failed) continue;
    if (target && threads.some((thread) => thread.title.toLowerCase() === target.toLowerCase())) continue;
    if (live && threads.some((thread) => thread.live)) continue;
    const id = `${failed ? "failed" : "pending"}:${message.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const toLabel = target || "the other agent";
    threads.push({
      id,
      childId: "",
      title: toLabel,
      live,
      fromLabel: parentTitle,
      toLabel,
      turns: [],
      provider: parseProviderId(target) ?? undefined,
      error: failed ? message.text.replace(/^[^—]+—\s*/, "").trim() || message.text : undefined,
    });
  }

  threads.sort((left, right) => Number(right.live) - Number(left.live) || Number(Boolean(right.error)) - Number(Boolean(left.error)));
  return threads;
}

export function liveAgentThreadId(threads: AgentThread[]): string | null {
  return threads.find((thread) => thread.live)?.id ?? threads.find((thread) => thread.error)?.id ?? null;
}

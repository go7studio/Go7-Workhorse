import { boundStatement } from "./learning-redact";
import { validateBrief } from "./learning-policy";
import type { LearningBrief, LearningEvent, MemoryItem } from "./learning-types";

/** Deterministic compiler used by tests, smoke, and when no ephemeral provider is eligible. */
export function stubCompile(events: LearningEvent[], _memories: MemoryItem[] = []): LearningBrief {
  const intent: LearningBrief["intent"] = [];
  const operations: LearningBrief["operations"] = [];
  for (const event of events) {
    if (event.tombstone || event.purged) continue;
    if (event.actorClass !== "human") continue;
    if (event.kind === "human-prompt" || event.kind === "human-edit" || event.kind === "human-correction") {
      const text = boundStatement(String(event.payload.summary ?? event.payload.text ?? ""));
      if (!text) continue;
      intent.push({
        action: event.kind === "human-correction" ? "supersede" : "add",
        memoryClass: "intent",
        scope: event.projectId ? "project" : "global-user",
        projectId: event.projectId,
        statement: text,
        sourceEventIds: [event.id],
        tags: ["intent"],
      });
    }
  }
  return validateBrief({ intent, operations }) ?? { intent: [], operations: [] };
}

export function stubCompileAgent(events: LearningEvent[], _memories: MemoryItem[] = []): LearningBrief {
  const operations: LearningBrief["operations"] = [];
  for (const event of events) {
    if (event.tombstone || event.purged || event.actorClass !== "agent") continue;
    if (event.kind !== "outcome" && event.kind !== "tool") continue;
    const status = String(event.payload.status ?? event.payload.outcome ?? "").trim();
    const summary = boundStatement(String(event.payload.summary ?? event.payload.error ?? `${event.provider ?? "Agent"} ${status}`));
    if (!summary) continue;
    operations.push({
      action: "add",
      memoryClass: "operations",
      scope: "project",
      projectId: event.projectId,
      providerScope: event.provider,
      statement: summary,
      sourceEventIds: [event.id],
      tags: ["agent-performance", event.kind],
    });
  }
  return validateBrief({ intent: [], operations }) ?? { intent: [], operations: [] };
}

export function stubReconcile(memories: MemoryItem[]): LearningBrief {
  const humans = memories.filter((item) => item.intelligenceLane === "human-intent");
  const agents = memories.filter((item) => item.intelligenceLane === "agent-performance");
  const operations: LearningBrief["operations"] = [];
  for (const human of humans) {
    for (const agent of agents) {
      const correlations = (human.correlationIds ?? []).filter((id) => agent.correlationIds?.includes(id));
      if (correlations.length === 0 || !/fail|error|missing|without|unverified|denied|cancel|pause/i.test(agent.statement)) continue;
      operations.push({
        action: "add",
        memoryClass: "operations",
        scope: "project",
        projectId: human.projectId ?? agent.projectId,
        providerScope: agent.providerScope,
        statement: boundStatement(`Requested: ${human.statement}; observed: ${agent.statement}`),
        sourceEventIds: [],
        sourceMemoryIds: [human.id, agent.id],
        tags: ["mismatch"],
      });
    }
  }
  return validateBrief({ intent: [], operations }) ?? { intent: [], operations: [] };
}

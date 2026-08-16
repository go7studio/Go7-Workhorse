import { boundStatement } from "./learning-redact";
import { validateBrief } from "./learning-policy";
import type { LearningBrief, LearningEvent, MemoryItem } from "./learning-types";

/** Deterministic compiler used by tests, smoke, and when no ephemeral provider is eligible. */
export function stubCompile(events: LearningEvent[], _memories: MemoryItem[] = []): LearningBrief {
  const intent: LearningBrief["intent"] = [];
  const operations: LearningBrief["operations"] = [];
  for (const event of events) {
    if (event.tombstone || event.purged) continue;
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
    if (event.kind === "outcome" || event.kind === "routing" || event.kind === "skill") {
      const text = boundStatement(String(event.payload.summary ?? event.payload.reason ?? event.payload.skill ?? event.kind));
      if (!text || !event.provider) continue;
      operations.push({
        action: "add",
        memoryClass: "operations",
        scope: "project",
        projectId: event.projectId,
        providerScope: event.provider,
        statement: text,
        sourceEventIds: [event.id],
        tags: event.skillIds,
      });
    }
  }
  return validateBrief({ intent, operations }) ?? { intent: [], operations: [] };
}

import type { LearningExportPayload } from "./learning-types";

export function exportJsonl(payload: LearningExportPayload): string {
  const header = JSON.stringify({
    kind: "workhorse-learning-export",
    exportedAt: payload.exportedAt,
    schemaVersion: payload.schemaVersion,
  });
  const lines = [header];
  for (const event of payload.events) lines.push(JSON.stringify({ type: "event", ...event }));
  for (const memory of payload.memories) lines.push(JSON.stringify({ type: "memory", ...memory }));
  for (const run of payload.compilerRuns) lines.push(JSON.stringify({ type: "compiler", ...run }));
  for (const audit of payload.audits) lines.push(JSON.stringify({ type: "audit", ...audit }));
  return `${lines.join("\n")}\n`.replace(/\r\n/g, "\n");
}

export function exportMarkdown(payload: LearningExportPayload): string {
  const lines = [
    "# Workhorse learning export",
    "",
    `Exported ${new Date(payload.exportedAt).toISOString()} · schema ${payload.schemaVersion}`,
    "",
    "## Memories",
  ];
  for (const memory of payload.memories) {
    lines.push(`- \`${memory.id}\` (${memory.intelligenceLane}, ${memory.memoryClass}, ${memory.scope}, ${memory.status}): ${memory.statement}`);
  }
  lines.push("", "## Events");
  for (const event of payload.events) {
    lines.push(`- \`${event.id}\` ${event.kind} ${event.tombstone ? "(forgotten)" : ""}`.trimEnd());
  }
  return `${lines.join("\n")}\n`.replace(/\r\n/g, "\n");
}

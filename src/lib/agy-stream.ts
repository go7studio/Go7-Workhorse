import { readAgyUsage, type AgyTokenTotals } from "./agy-usage";

export type AgyStreamEvent =
  | { kind: "init"; conversationId?: string }
  | { kind: "text"; step: number; state: "ACTIVE" | "DONE"; delta: string; usage?: AgyTokenTotals }
  | { kind: "step-usage"; step: number; usage: AgyTokenTotals }
  | { kind: "tool"; step: number; name: string; state: string; detail: string; failed: boolean }
  | { kind: "result"; status: string; response: string; conversationId?: string; error?: string; usage?: AgyTokenTotals }
  | { kind: "ignore" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function detailOf(info: Record<string, unknown> | undefined): { detail: string; failed: boolean } {
  if (!info) return { detail: "", failed: false };
  const error = asRecord(info.error);
  const message = textOf(error?.message).trim();
  if (message) return { detail: message.slice(0, 500), failed: true };
  const output = textOf(info.output).trim();
  if (output) return { detail: output.slice(0, 500), failed: false };
  const parameters = info.parameters;
  if (parameters && typeof parameters === "object") {
    try {
      return { detail: JSON.stringify(parameters).slice(0, 500), failed: false };
    } catch {
      return { detail: "", failed: false };
    }
  }
  return { detail: "", failed: false };
}

/** One NDJSON line from `agy --output-format stream-json`. Bad JSON is ignored. */
export function parseAgyStreamLine(line: string): AgyStreamEvent {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "ignore" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { kind: "ignore" };
  }
  const row = asRecord(parsed);
  if (!row) return { kind: "ignore" };
  if (row.event === "init") {
    const init = asRecord(row.init);
    const conversationId = textOf(row.conversation_id || init?.conversation_id).trim();
    return { kind: "init", ...(conversationId ? { conversationId } : {}) };
  }
  if (row.event === "result") {
    const result = asRecord(row.result) ?? row;
    const conversationId = textOf(result.conversation_id).trim();
    const error = textOf(result.error).trim();
    const usage = readAgyUsage(result.usage);
    return {
      kind: "result",
      status: textOf(result.status).trim() || "ERROR",
      response: textOf(result.response),
      ...(conversationId ? { conversationId } : {}),
      ...(error ? { error } : {}),
      ...(usage ? { usage } : {}),
    };
  }
  if (row.event !== "step_update") return { kind: "ignore" };
  const step = asRecord(row.step_update);
  if (!step) return { kind: "ignore" };
  const stepIndex = typeof step.step_index === "number" && Number.isFinite(step.step_index) ? step.step_index : 0;
  const state = textOf(step.state).toUpperCase();
  if (step.step_type === "agent_response") {
    // DONE carries this model call's usage, even when the response only
    // invoked a tool and produced no text. Result usage spans the conversation.
    const usage = state === "DONE" ? readAgyUsage(step.usage) : undefined;
    if (typeof step.text_delta === "string" && step.text_delta) {
      return { kind: "text", step: stepIndex, state: state === "ACTIVE" ? "ACTIVE" : "DONE", delta: step.text_delta, ...(usage ? { usage } : {}) };
    }
    if (usage) return { kind: "step-usage", step: stepIndex, usage };
  }
  if (step.step_type === "tool") {
    const info = asRecord(step.tool_info);
    const name = textOf(step.tool_name || info?.name).trim() || "tool";
    const detail = detailOf(info);
    return { kind: "tool", step: stepIndex, name, state: state || "DONE", ...detail };
  }
  return { kind: "ignore" };
}

export type AgyModelRow = { id: string; name: string };

/** `agy models` prints `id<TAB>Name`. The fetching line on stderr never arrives here. */
export function parseAgyModelsOutput(raw: string): AgyModelRow[] {
  const rows: AgyModelRow[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    const name = line.slice(tab + 1).trim();
    if (!id || !name || seen.has(id) || id.toLowerCase().startsWith("fetching")) continue;
    seen.add(id);
    rows.push({ id, name });
  }
  return rows;
}

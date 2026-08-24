import { pathFromToolText, splitToolLine, toolIsFinished } from "./grok-events";
import { boundText } from "./learning-redact";
import { outcomeVerification, type OutcomeSignals } from "./learning-policy";
import type { ChatMessage } from "./types";

export type AgentTurnOutcome = "completed" | "failed" | "safety-paused" | "cancelled";
export type AgentTurnDeliveryState = "delivered" | "interrupted" | "not-delivered";
export type AgentTurnEvidenceClass =
  | "verified-success"
  | "verified-failure"
  | "infrastructure-failure"
  | "unverified"
  | "safety-paused"
  | "cancelled";

export const OUTCOME_EVIDENCE_VERSION = 1;

export type AgentTurnEvidenceInput = {
  messages: ChatMessage[];
  assistantId: string;
  outcome: AgentTurnOutcome;
  queuedText?: string;
  stopReason?: string;
  error?: string;
  workedMs?: number;
};

function isFailure(status?: string): boolean {
  return /fail|error|denied|cancel|timed out|timeout/i.test(status ?? "");
}

function isTestTool(title: string, detail: string): boolean {
  return /\b(test|tests|verify|check|lint|build)\b/i.test(`${title} ${detail}`);
}

function isArtifactTool(title: string): boolean {
  return /\b(write|edit|create|patch|render|export|save|screenshot)\b/i.test(title);
}

function isInfrastructureFailure(error?: string, stopReason?: string): boolean {
  return /\b(?:429|5\d\d|connection|connectivity|disconnect|gateway|network|offline|process exited|rate limit|socket|timed? out|timeout|transport|unavailable)\b/i.test(
    `${error ?? ""} ${stopReason ?? ""}`,
  );
}

function classifyOutcome(input: {
  outcome: AgentTurnOutcome;
  hasActivity: boolean;
  infrastructureFailure: boolean;
  signals: OutcomeSignals;
}): { deliveryState: AgentTurnDeliveryState; evidenceClass: AgentTurnEvidenceClass } {
  const deliveryState: AgentTurnDeliveryState =
    input.outcome === "failed" ? (input.hasActivity ? "interrupted" : "not-delivered") : "delivered";
  if (input.outcome === "safety-paused") return { deliveryState, evidenceClass: "safety-paused" };
  if (input.outcome === "cancelled") return { deliveryState, evidenceClass: "cancelled" };
  const verification = outcomeVerification(input.signals);
  // A failed test or rejected artifact is direct task evidence even when the
  // adapter later disconnects while reporting it.
  if (verification === "negative") return { deliveryState, evidenceClass: "verified-failure" };
  if (input.infrastructureFailure) return { deliveryState, evidenceClass: "infrastructure-failure" };
  if (verification === "positive" && input.outcome === "completed") {
    return { deliveryState, evidenceClass: "verified-success" };
  }
  return { deliveryState, evidenceClass: "unverified" };
}

export function agentTurnEvidence(input: AgentTurnEvidenceInput): {
  payload: Record<string, unknown>;
  toolIds: string[];
} {
  const start = input.messages.findIndex((message) => message.id === input.assistantId);
  const nextUser = start >= 0 ? input.messages.findIndex((message, index) => index > start && message.role === "user") : -1;
  const turn = start >= 0 ? input.messages.slice(start, nextUser >= 0 ? nextUser : undefined) : [];
  const assistant = turn.find((message) => message.id === input.assistantId);
  const tools = turn.filter((message) => message.kind === "tool");
  const thoughts = turn.filter((message) => message.kind === "thought");
  const toolCalls = tools.map((message) => {
    const line = splitToolLine(message.text);
    return {
      id: message.toolCallId ?? message.id,
      title: boundText(line.title, 240),
      status: message.toolStatus ?? line.status,
      detail: boundText(line.detail, 600),
    };
  });
  const testCalls = toolCalls.filter((tool) => isTestTool(tool.title, tool.detail));
  const failedTools = toolCalls.filter((tool) => isFailure(tool.status));
  const artifactPaths = tools
    .filter((message) => isArtifactTool(splitToolLine(message.text).title))
    .map((message) => pathFromToolText(message.text))
    .filter(Boolean);
  const finalOutput = (assistant?.text ?? "").trim() || input.queuedText?.trim() || "";
  const testsPassed = testCalls.length > 0 && testCalls.every((tool) => toolIsFinished(tool.status) && !isFailure(tool.status));
  const testsFailed = testCalls.some((tool) => isFailure(tool.status));
  const signals: OutcomeSignals = {
    adapterTerminal: true,
    testsPassed,
    testsFailed,
    agentClaimed: Boolean(finalOutput),
  };
  const classification = classifyOutcome({
    outcome: input.outcome,
    hasActivity: Boolean(finalOutput || toolCalls.length || thoughts.length),
    infrastructureFailure: input.outcome === "failed" && isInfrastructureFailure(input.error, input.stopReason),
    signals,
  });
  return {
    toolIds: toolCalls.map((tool) => tool.id),
    payload: {
      outcomeEvidenceVersion: OUTCOME_EVIDENCE_VERSION,
      summary: boundText(
        finalOutput || input.error || `Agent turn ${input.outcome.replace("-", " ")}`,
        1_200,
      ),
      status: input.outcome,
      stopReason: input.stopReason,
      error: input.error ? boundText(input.error, 1_200) : undefined,
      finalOutput: finalOutput ? boundText(finalOutput, 2_400) : undefined,
      outputChars: finalOutput.length,
      workedMs: input.workedMs,
      toolCalls,
      toolCount: toolCalls.length,
      failedToolCount: failedTools.length,
      testCount: testCalls.length,
      artifactPaths: [...new Set(artifactPaths)].slice(0, 20),
      reasoningObserved: thoughts.length > 0,
      reasoningStepCount: thoughts.length,
      deliveryState: classification.deliveryState,
      evidenceClass: classification.evidenceClass,
      signals,
    },
  };
}

export function learningEvidenceId(...parts: Array<string | undefined>): string {
  return `lev_${parts
    .filter((part): part is string => Boolean(part))
    .join("_")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .slice(0, 220)}`;
}

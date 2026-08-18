import { pathFromToolText, splitToolLine, toolIsFinished } from "./grok-events";
import { boundText } from "./learning-redact";
import type { ChatMessage } from "./types";

export type AgentTurnOutcome = "completed" | "failed" | "safety-paused" | "cancelled";

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
  return {
    toolIds: toolCalls.map((tool) => tool.id),
    payload: {
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
      signals: {
        adapterTerminal: true,
        testsPassed,
        agentClaimed: Boolean(finalOutput),
      },
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

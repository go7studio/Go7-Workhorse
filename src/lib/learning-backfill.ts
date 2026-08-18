import type { EffortLevel, ProviderId } from "./types";
import type { CompileResult, LearningEventKind } from "./learning-types";

export const BACKFILL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BACKFILL_COMPILE_RUN_CAP = 24;
export const BACKFILL_SUMMARY_CHARS = 800;

export type BackfillMessage = {
  id: string;
  role: string;
  text: string;
  createdAt: number;
  kind?: string;
};

export type BackfillSession = {
  id: string;
  projectId?: string | null;
  provider?: ProviderId;
  model?: string;
  effort?: EffortLevel | null;
  hidden?: boolean;
  messages: BackfillMessage[];
};

export type BackfillEventDraft = {
  id: string;
  createdAt: number;
  kind: Extract<LearningEventKind, "human-prompt">;
  actorClass: "human";
  projectId?: string;
  sessionId: string;
  provider?: ProviderId;
  model?: string;
  effort?: EffortLevel | null;
  payload: { summary: string };
};

export function backfillEventId(messageId: string): string {
  return `lev_msg_${messageId}`;
}

export function isBackfillableUserMessage(
  message: BackfillMessage,
  now: number,
  windowMs = BACKFILL_WINDOW_MS,
): boolean {
  if (message.role !== "user") return false;
  if (message.kind) return false;
  const text = message.text.trim();
  if (!text) return false;
  if (typeof message.createdAt !== "number") return false;
  if (message.createdAt < now - windowMs || message.createdAt > now) return false;
  return true;
}

export function backfillHumanPromptEvents(input: {
  sessions: BackfillSession[];
  now?: number;
  windowMs?: number;
}): BackfillEventDraft[] {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? BACKFILL_WINDOW_MS;
  const drafts: BackfillEventDraft[] = [];
  const seen = new Set<string>();
  for (const session of input.sessions) {
    if (session.hidden) continue;
    for (const message of session.messages) {
      if (!isBackfillableUserMessage(message, now, windowMs)) continue;
      const id = backfillEventId(message.id);
      if (seen.has(id)) continue;
      seen.add(id);
      drafts.push({
        id,
        createdAt: message.createdAt,
        kind: "human-prompt",
        actorClass: "human",
        projectId: session.projectId ?? undefined,
        sessionId: session.id,
        provider: session.provider,
        model: session.model,
        effort: session.effort,
        payload: { summary: message.text.trim().slice(0, BACKFILL_SUMMARY_CHARS) },
      });
    }
  }
  return drafts;
}

export function compileBatchSettled(result: Pick<CompileResult, "ran" | "skipped">): boolean {
  return !result.ran;
}

export function describeCompileResult(result: CompileResult, botName?: string): string {
  if (result.ran) {
    const count = result.memories ?? 0;
    const memories = count === 1 ? "1 memory" : `${count} memories`;
    return botName ? `Compiled. ${memories}. ${botName}.` : `Compiled. ${memories}.`;
  }
  if (result.skipped === "no-ephemeral-provider") return "Skipped. The compiler bot has no key, or ACP cannot do a title-less call.";
  if (result.skipped === "invalid-brief") return "Skipped. The compiler bot did not return a learning brief.";
  if (result.skipped === "empty") return "Skipped. No new events.";
  if (result.skipped === "threshold") return "Skipped. Below the event threshold.";
  if (result.skipped === "duplicate") return "Skipped. Same events already compiled.";
  if (result.skipped === "mode") return "Skipped. This mode does not compile.";
  if (result.skipped === "busy") return "Skipped. A compile is already running.";
  if (result.skipped === "paused") return "Skipped. Learning is paused.";
  if (result.skipped === "max-attempts") return "Skipped. Compile reached its attempt limit.";
  return result.skipped ? `Skipped. ${result.skipped}.` : "Skipped.";
}

export function describeBackfillResult(input: {
  recorded: number;
  compile: CompileResult;
  botName?: string;
}): string {
  const recorded =
    input.recorded === 1 ? "Recorded 1 prompt from the last day." : `Recorded ${input.recorded} prompts from the last day.`;
  return `${recorded} ${describeCompileResult(input.compile, input.botName)}`;
}

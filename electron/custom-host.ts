import type { ChatImage, CrewMode, EffortLevel, McpServerConfig, PermissionGrant, PermissionMode, SandboxProfile, SessionSecurityPolicy } from "../src/lib/types";
import { buildPolicyContext } from "../src/lib/context-preface";
import {
  classifyElevationInput,
  elevationForBlock,
  securityPolicyAnswer,
  type PermissionAnswer,
} from "../src/lib/permissions";
import { uid } from "../src/lib/id";
import { deskRoleOf, parseProviderId } from "../src/lib/subagents";
import { vendorDeclinedForBot } from "../src/lib/vendor-decline";
import { withCrewModeHint, withCustomPeerHint, withLooseDeleteHint, withPermissionHint, withSpawnHint, withWriteLimitHint } from "../src/lib/workhorse-rules";
import { hydrateChatImages, hydrateHistoryMessage } from "./attachment-store";
import type { GrokPromptResult } from "./grok-agent";
import type { GrokEventSink } from "./grok-host";
import { CUSTOM_NOT_CONFIGURED, streamCustomHttp, type CustomChatMessage, type CustomHttpConfig, type CustomHttpUsage } from "./custom-http";
import {
  customToolPolicy,
  executeCustomTool,
  groupFanOutToolUses,
  limitCustomToolResult,
  toolDetail,
  type CustomToolResult,
  type CustomToolUse,
} from "./custom-tools";
import { McpToolBridge } from "./mcp-tool-bridge";

export type CustomPromptInput = {
  sessionId: string;
  projectId?: string;
  text: string;
  images?: ChatImage[];
  model: string;
  effort: EffortLevel | null;
  cwd: string;
  mode?: PermissionMode;
  sandbox?: SandboxProfile;
  preface?: string;
  history?: CustomChatMessage[];
  mcpServers?: McpServerConfig[];
  securityPolicy?: SessionSecurityPolicy;
  permissionGrants?: PermissionGrant[];
  folders?: string[];
  parentId?: string;
  hidden?: boolean;
  role?: import("../src/lib/workhorse-rules").DeskRole;
  crewModes?: CrewMode[];
  customBotId?: string;
  config: CustomHttpConfig;
};

export function customPrefaceForLimits(
  preface: string | undefined,
  mode?: PermissionMode,
  sandbox?: SandboxProfile,
): string {
  // Threaded, never read ambiently inside the shared lib — that lib also runs
  // in the renderer, where process.platform is not the machine's answer.
  const policy = buildPolicyContext({ mode, sandbox, platform: process.platform });
  const head = preface?.trim() ?? "";
  if (!head) return policy;
  if (head.includes("This chat’s live desk limits")) return head;
  return `${head}\n\n${policy}`;
}

export const CUSTOM_TURN_SAFETY_DEFAULTS = {
  emergencyModelCalls: 512,
  maxElapsedMs: 2 * 60 * 60 * 1000,
  repeatedToolRounds: 5,
  failedToolRounds: 8,
  unfulfilledContinuations: 4,
  maxTranscriptChars: 240_000,
} as const;

type ResolvedCustomTurnSafety = {
  [Key in keyof typeof CUSTOM_TURN_SAFETY_DEFAULTS]: number;
};

export type CustomTurnSafetyOptions = Partial<ResolvedCustomTurnSafety> & {
  now?: () => number;
  executeTool?: typeof executeCustomTool;
};

type SafetyPause = "elapsed" | "emergency-calls" | "repeated-tools" | "failed-tools" | "no-tool-progress";

const CONTINUE_NUDGE =
  "Continue. You said you would keep looking — run the next tool now. Do not stop after announcing a search.";

/** True when the model asked the user to pick and must wait — do not auto-continue. */
export function looksLikeWaitingOnUser(text: string): boolean {
  const hay = text.trim();
  if (!hay) return false;
  if (/\?\s*$/.test(hay)) return true;
  if (
    /\b(which direction|pick one|say which|tell me which|which one|which should i|your (?:pick|choice)|want me to|say the word)\b/i.test(
      hay,
    )
  ) {
    return true;
  }
  return /(?:^|\n)\s*(?:\d+[.)]|[-*])\s+\S[\s\S]{0,800}\b(which|pick|say which|want me)\b/i.test(hay);
}

/** Post-dispatch last-act: “I’ll check back” / status snapshot — do not CONTINUE_NUDGE. */
export function looksLikeDispatchCheckBack(text: string): boolean {
  const hay = text.trim();
  if (!hay) return false;
  return (
    /\b(check back|circle back|get back to you|status snapshot|sit tight|stand by)\b/i.test(hay) ||
    /\bi(?:'ll| will) wait\b/i.test(hay) ||
    /\bworkers? (are|is) (out|running|started|on (it|the))\b/i.test(hay)
  );
}

export function spawnDispatchStarted(result: { name?: string; content?: string; isError?: boolean }): boolean {
  if (result.isError) return false;
  const name = (result.name ?? "").toLowerCase();
  if (!name.includes("spawn")) return false;
  const content = result.content ?? "";
  try {
    const parsed = JSON.parse(content) as { started?: unknown };
    return parsed.started === true;
  } catch {
    return /"started"\s*:\s*true/.test(content);
  }
}

/** After wait=false spawn results, the orchestrator turn is over. Do not call the model again. */
export function shouldEndDispatchTurn(
  results: Array<{ name?: string; content?: string; isError?: boolean }>,
): boolean {
  return results.some(spawnDispatchStarted);
}

/**
 * A dispatch turn ends on purpose the moment the workers are away, so the model
 * is never asked for a closing line. When it also wrote no prose — it thought,
 * then spawned — the chat used to show "finished without a visible reply" over
 * a turn that had just started seven workers. Say what it did instead.
 */
export function dispatchSummary(
  results: Array<{ name?: string; content?: string; isError?: boolean }>,
): string {
  const titles = results
    .filter(spawnDispatchStarted)
    .map((result) => {
      try {
        const parsed = JSON.parse(result.content ?? "") as { title?: unknown };
        return typeof parsed.title === "string" ? parsed.title.trim() : "";
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  if (titles.length === 0) return "";
  const shown = titles.slice(0, 4).join(", ");
  const rest = titles.length - 4;
  const list = rest > 0 ? `${shown} and ${rest} more` : shown;
  return `Started ${titles.length} ${titles.length === 1 ? "worker" : "workers"}: ${list}.`;
}

/** Worker already wrote enough of a report — do not keep nudging or safety-pause it. */
export function workerHasDeliverableReport(text: string): boolean {
  const hay = text.replace(/\n*Workhorse paused[\s\S]*$/i, "").trim();
  if (hay.length >= 600) return true;
  if ((hay.match(/res:\/\//g) ?? []).length >= 6) return true;
  return false;
}

export function looksLikeUnfinishedDeskTurn(
  text: string,
  stopReason?: string,
  role?: import("../src/lib/workhorse-rules").DeskRole,
): boolean {
  const reason = (stopReason ?? "").toLowerCase();
  if (reason === "max_tokens" || reason === "length") return true;
  const hay = text.trim();
  if (!hay) return false;
  if (looksLikeWaitingOnUser(hay)) return false;
  if (looksLikeDispatchCheckBack(hay)) return false;
  if (role === "worker" && workerHasDeliverableReport(hay)) return false;
  return /\b(let me|i(?:'ll| will)|i am going to|next i(?:'ll| will)|search more|look(?:ing)? more broadly|dig (?:deeper|further)|keep (?:looking|searching)|try another|one more)\b/i.test(
    hay,
  );
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, ordered(item)]),
  );
}

function shortFingerprint(value: unknown): string {
  const raw = JSON.stringify(ordered(value));
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function customToolRoundFingerprint(toolUses: CustomToolUse[], results: CustomToolResult[]): string {
  return shortFingerprint(
    toolUses.map((use, index) => ({
      name: use.name,
      input: use.input,
      result: results[index]
        ? { content: results[index].content, isError: results[index].isError === true }
        : null,
    })),
  );
}

function transcriptChars(messages: CustomChatMessage[]): number {
  return messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
}

function checkpointLine(message: CustomChatMessage): string {
  if (message.toolUses?.length) {
    return message.toolUses
      .map((tool) => `Called ${tool.name} with ${JSON.stringify(ordered(tool.input)).slice(0, 600)}`)
      .join("\n");
  }
  if (message.toolResults?.length) {
    return message.toolResults
      .map((result) => `${result.isError ? "Failed" : "Result from"} ${result.name}: ${result.content.slice(0, 900)}`)
      .join("\n");
  }
  return message.text.trim().slice(0, 900);
}

export function compactCustomTurnTranscript(
  messages: CustomChatMessage[],
  baseMessageCount: number,
  maxChars: number = CUSTOM_TURN_SAFETY_DEFAULTS.maxTranscriptChars,
): CustomChatMessage[] {
  if (transcriptChars(messages) <= maxChars || messages.length <= baseMessageCount + 8) return messages;
  const recentStart = Math.max(baseMessageCount, messages.length - 8);
  const older = messages.slice(baseMessageCount, recentStart);
  const summary = older.map(checkpointLine).filter(Boolean).join("\n").slice(-24_000);
  const checkpoint = `Workhorse continuation checkpoint. Older tool transcript was compacted to protect the model context. Preserve this progress and continue the original task:\n${summary}`;
  const base = messages.slice(0, baseMessageCount);
  const lastBase = base.at(-1);
  if (lastBase?.role === "user") {
    base[base.length - 1] = { ...lastBase, text: `${lastBase.text}\n\n${checkpoint}` };
  } else {
    base.push({ role: "user", text: checkpoint });
  }
  return [...base, ...messages.slice(recentStart)];
}

function safetyPauseMessage(reason: SafetyPause): string {
  if (reason === "repeated-tools") {
    return "Workhorse paused because the same tool action kept returning the same result. Your work was not marked complete; adjust the request or send Continue to try a different approach.";
  }
  if (reason === "failed-tools") {
    return "Workhorse paused after repeated tool failures. Your work was not marked complete; fix the failing access or command, then send Continue.";
  }
  if (reason === "no-tool-progress") {
    return "Workhorse paused because the model repeatedly promised another action without calling a tool. Your work was not marked complete; send Continue to retry.";
  }
  return "Workhorse paused after an unusually long continuous run. Progress is preserved in this chat; send Continue to resume.";
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Custom HTTP has no session_info / generated_title. Models rename via workhorse_rename_chat. */
export class CustomSessionHost {
  private tails = new Map<string, Promise<unknown>>();
  private aborts = new Map<string, AbortController>();
  private waiting = new Map<string, (answer: PermissionAnswer) => void>();
  private readonly stream: typeof streamCustomHttp;
  private readonly safety: ResolvedCustomTurnSafety;
  private readonly now: () => number;
  private readonly executeTool: typeof executeCustomTool;

  constructor(stream = streamCustomHttp, options: CustomTurnSafetyOptions = {}) {
    this.stream = stream;
    this.executeTool = options.executeTool ?? executeCustomTool;
    this.safety = {
      emergencyModelCalls: positiveLimit(options.emergencyModelCalls, CUSTOM_TURN_SAFETY_DEFAULTS.emergencyModelCalls),
      maxElapsedMs: positiveLimit(options.maxElapsedMs, CUSTOM_TURN_SAFETY_DEFAULTS.maxElapsedMs),
      repeatedToolRounds: positiveLimit(options.repeatedToolRounds, CUSTOM_TURN_SAFETY_DEFAULTS.repeatedToolRounds),
      failedToolRounds: positiveLimit(options.failedToolRounds, CUSTOM_TURN_SAFETY_DEFAULTS.failedToolRounds),
      unfulfilledContinuations: positiveLimit(
        options.unfulfilledContinuations,
        CUSTOM_TURN_SAFETY_DEFAULTS.unfulfilledContinuations,
      ),
      maxTranscriptChars: positiveLimit(options.maxTranscriptChars, CUSTOM_TURN_SAFETY_DEFAULTS.maxTranscriptChars),
    };
    this.now = options.now ?? Date.now;
  }

  answerPermission(requestId: string, answer: PermissionAnswer): boolean {
    const wait = this.waiting.get(requestId);
    if (!wait) return false;
    this.waiting.delete(requestId);
    wait(answer);
    return true;
  }

  async prompt(input: CustomPromptInput, emit: GrokEventSink): Promise<GrokPromptResult> {
    const previous = this.tails.get(input.sessionId) ?? Promise.resolve();
    const run = previous.then(
      () => this.promptUnlocked(input, emit),
      () => this.promptUnlocked(input, emit),
    );
    this.tails.set(
      input.sessionId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async promptUnlocked(input: CustomPromptInput, emit: GrokEventSink): Promise<GrokPromptResult> {
    this.aborts.get(input.sessionId)?.abort();
    const abort = new AbortController();
    this.aborts.set(input.sessionId, abort);
    const history = (input.history ?? [])
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map((item) => hydrateHistoryMessage(item));
    let mode = input.mode ?? "ask";
    let sandbox = input.sandbox ?? "off";
    const role = input.role ?? deskRoleOf({ parentId: input.parentId, hidden: input.hidden });
    let messages: CustomChatMessage[] = [
      ...history,
      {
        role: "user",
        text: withCrewModeHint(
          withLooseDeleteHint(
            withCustomPeerHint(
              withSpawnHint(withPermissionHint(withWriteLimitHint(input.text, mode, sandbox), role), role),
              role,
            ),
            role,
          ),
          input.crewModes,
          role,
        ),
        ...(input.images?.length ? { images: hydrateChatImages(input.images) } : {}),
      },
    ];
    const baseMessageCount = messages.length;
    const preface = customPrefaceForLimits(input.preface, input.mode, input.sandbox);
    const mcp = new McpToolBridge(input.mcpServers ?? [], { cwd: input.cwd });
    const mcpTools = await mcp.tools();
    let text = "";
    const startedAt = this.now();
    let modelCalls = 0;
    let previousToolRound = "";
    let repeatedToolRounds = 0;
    let failedToolRounds = 0;
    let unfulfilledContinuations = 0;
    let previousContinuation = "";
    let safetyPause: SafetyPause | null = null;
    // Every HTTP call in the tool loop is its own bill, and goes out on its own
    // tagged `request` so the store adds them. Folding them into one snapshot
    // here lost the count: replace-if-nonzero kept only the last request, and
    // the store then guessed the rest from the sizes. The last prompt's size is
    // also the context the model holds now, which is a gauge, sent once at the
    // end.
    let lastUsage: CustomHttpUsage | undefined;
    let requestsBilled = 0;
    const emitRequestUsage = (usage: CustomHttpUsage) => {
      lastUsage = usage;
      requestsBilled += 1;
      emit({
        type: "usage",
        sessionId: input.sessionId,
        model: input.model || input.config.model,
        projectId: input.projectId,
        provider: "custom",
        customBotId: input.customBotId,
        source: "request",
        ...usage,
      });
    };
    const emitTurnUsage = () => {
      if (!lastUsage || requestsBilled === 0) return;
      emit({
        type: "usage",
        sessionId: input.sessionId,
        model: input.model || input.config.model,
        projectId: input.projectId,
        provider: "custom",
        customBotId: input.customBotId,
        source: "gauge",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        contextUsed: lastUsage.inputTokens + lastUsage.cacheReadTokens,
      });
    };
    try {
      while (true) {
        if (abort.signal.aborted) throw new Error("cancelled");
        if (this.now() - startedAt >= this.safety.maxElapsedMs) {
          safetyPause = "elapsed";
          break;
        }
        if (modelCalls >= this.safety.emergencyModelCalls) {
          safetyPause = "emergency-calls";
          break;
        }
        modelCalls += 1;
        const result = await this.stream(
          {
            ...input.config,
            model: input.model || input.config.model,
          },
          {
            messages,
            preface,
            effort: input.effort,
            signal: abort.signal,
            tools: mcpTools,
            role,
            sessionUser: input.sessionId,
          },
          {
            onChunk: (chunk) => {
              text += chunk;
              emit({ type: "chunk", sessionId: input.sessionId, text: chunk });
            },
            onThought: (chunk) => emit({ type: "thought", sessionId: input.sessionId, text: chunk }),
          },
        );
        text = result.text || text;
        if (result.usage) emitRequestUsage(result.usage);
        const toolUses = result.toolUses ?? [];
        if (toolUses.length === 0) {
          if (looksLikeUnfinishedDeskTurn(result.text || text, result.stopReason, role)) {
            const continuation = (result.text || text).trim().toLowerCase().replace(/\s+/g, " ");
            const tokenLimited = ["max_tokens", "length"].includes((result.stopReason ?? "").toLowerCase());
            if (!tokenLimited || !continuation || continuation === previousContinuation) {
              unfulfilledContinuations += 1;
            } else {
              unfulfilledContinuations = 0;
            }
            previousContinuation = continuation;
            if (unfulfilledContinuations >= this.safety.unfulfilledContinuations) {
              safetyPause = "no-tool-progress";
              break;
            }
            messages = [
              ...messages,
              { role: "assistant", text: result.text || text, reasoning: result.thought },
              { role: "user", text: CONTINUE_NUDGE },
            ];
            messages = compactCustomTurnTranscript(messages, baseMessageCount, this.safety.maxTranscriptChars);
            continue;
          }
          break;
        }
        unfulfilledContinuations = 0;
        previousContinuation = "";
        const results: CustomToolResult[] = [];
        const toolGroups = groupFanOutToolUses(toolUses);
        const executeSpawnUse = async (use: CustomToolUse): Promise<CustomToolResult> => {
          const detail = toolDetail(use);
          emit({
            type: "tool",
            sessionId: input.sessionId,
            toolCallId: use.id,
            title: use.name,
            status: "running",
            detail: detail.detail,
          });
          const executed = limitCustomToolResult(
            await this.executeTool(use, {
              mode,
              sandbox,
              cwd: input.cwd,
              sessionId: input.sessionId,
              folders: input.folders,
              parentId: input.parentId,
              hidden: input.hidden,
              role,
              signal: abort.signal,
            }),
          );
          emit({
            type: "tool",
            sessionId: input.sessionId,
            toolCallId: use.id,
            title: use.name,
            status: executed.isError ? "failed" : "completed",
            detail: executed.content.slice(0, 240),
          });
          return executed;
        };
        for (const group of toolGroups) {
          if (group.length > 1 && group.every((use) => use.name === "workhorse_spawn_agent" || use.name.endsWith("spawn_agent"))) {
            results.push(...(await Promise.all(group.map((use) => executeSpawnUse(use)))));
            continue;
          }
          const use = group[0]!;
          const detail = toolDetail(use);
          emit({
            type: "tool",
            sessionId: input.sessionId,
            toolCallId: use.id,
            title: use.name,
            status: "running",
            detail: detail.detail,
          });
          const spawnTarget =
            use.name === "workhorse_request_vendor"
              ? parseProviderId(String(use.input.vendor ?? use.input.provider ?? use.input.name ?? ""))
              : null;
          if (spawnTarget && spawnTarget !== "custom") {
            const vendorName = { grok: "Grok", claude: "Claude", codex: "Codex", cursor: "Cursor" }[spawnTarget];
            const requestId = uid("perm");
            emit({
              type: "permission",
              sessionId: input.sessionId,
              requestId,
              tool: use.name,
              detail: `${vendorName} will run inside this conversation.`,
              vendor: { provider: spawnTarget, name: vendorName, status: "ok" },
            });
            const answer = await new Promise<PermissionAnswer>((resolve) => {
              this.waiting.set(requestId, resolve);
            });
            if (answer === "deny") {
              results.push({
                id: use.id,
                name: use.name,
                content: vendorDeclinedForBot(vendorName),
                isError: true,
              });
              emit({
                type: "tool",
                sessionId: input.sessionId,
                toolCallId: use.id,
                title: use.name,
                status: "failed",
                detail: `${vendorName} denied`,
              });
              continue;
            }
            if (use.name === "workhorse_request_vendor") {
              results.push({
                id: use.id,
                name: use.name,
                content: JSON.stringify({
                  ok: true,
                  allowed: true,
                  vendor: vendorName,
                  howToUse: `${vendorName} is allowed for this chat. Spawn or ask it now.`,
                }),
              });
              emit({
                type: "tool",
                sessionId: input.sessionId,
                toolCallId: use.id,
                title: use.name,
                status: "completed",
                detail: `${vendorName} allowed`,
              });
              continue;
            }
          }
          if (use.name === "workhorse_request_permission") {
            const classified = classifyElevationInput(use.input, { mode, sandbox });
            if (classified.kind !== "raise" || !classified.need) {
              const downgrade = classified.kind === "downgrade";
              results.push({
                id: use.id,
                name: use.name,
                content: JSON.stringify({
                  ok: true,
                  alreadyElevated: !downgrade,
                  refusedDowngrade: downgrade,
                  mode,
                  sandbox,
                  howToUse: downgrade
                    ? "This tool only raises access. You cannot lower Permission or Sandbox from here. The user does that in This chat. Do not offer to dial limits back."
                    : "This chat already has that access. Do not offer to lower Permission or Sandbox.",
                }),
              });
              emit({
                type: "tool",
                sessionId: input.sessionId,
                toolCallId: use.id,
                title: use.name,
                status: "completed",
                detail: downgrade ? "refused downgrade" : "already elevated",
              });
              continue;
            }
            const need = classified.need;
            const requestId = uid("perm");
            const reason =
              typeof use.input.reason === "string" && use.input.reason.trim()
                ? use.input.reason.trim()
                : detail.detail || "needs more access to finish the work";
            emit({
              type: "permission",
              sessionId: input.sessionId,
              requestId,
              tool: use.name,
              detail: reason,
              elevate: need,
            });
            const answer = await new Promise<PermissionAnswer>((resolve) => {
              this.waiting.set(requestId, resolve);
            });
            if (answer === "deny") {
              results.push({
                id: use.id,
                name: use.name,
                content: JSON.stringify({ ok: false, denied: true, howToUse: "The user kept the current desk limits." }),
                isError: true,
              });
              emit({
                type: "tool",
                sessionId: input.sessionId,
                toolCallId: use.id,
                title: use.name,
                status: "failed",
                detail: "denied",
              });
              continue;
            }
            if (need.mode) mode = need.mode;
            if (need.sandbox) sandbox = need.sandbox;
            results.push({
              id: use.id,
              name: use.name,
              content: JSON.stringify({
                ok: true,
                elevated: true,
                mode,
                sandbox,
                howToUse: "Elevated. Continue the work.",
              }),
            });
            emit({
              type: "tool",
              sessionId: input.sessionId,
              toolCallId: use.id,
              title: use.name,
              status: "completed",
              detail: "elevated",
            });
            continue;
          }
          const security = securityPolicyAnswer({
            policy: input.securityPolicy,
            tool: use.name,
            detail: detail.detail,
            path: detail.path,
            roots: [input.cwd, ...(input.folders ?? [])],
          });
          const decision = security.answer === "deny"
            ? "deny"
            : mcp.has(use.name)
            ? mode === "always-approve"
              ? "once"
              : mode === "plan" || sandbox === "read-only" || sandbox === "strict"
                ? "deny"
                : "ask"
            : customToolPolicy(use, {
                mode,
                sandbox,
                grants: input.permissionGrants,
                cwd: input.cwd,
                sessionId: input.sessionId,
                folders: input.folders,
              });
          let answer: PermissionAnswer | "ask" = decision;
          const blocked = security.answer === "deny" ? null : elevationForBlock({
            mode,
            sandbox,
            tool: use.name,
            detail: detail.detail,
            path: detail.path,
          });
          if (answer === "deny" && blocked) {
            const requestId = uid("perm");
            emit({
              type: "permission",
              sessionId: input.sessionId,
              requestId,
              tool: use.name,
              detail: detail.detail,
              path: detail.path,
              elevate: blocked,
            });
            answer = await new Promise<PermissionAnswer>((resolve) => {
              this.waiting.set(requestId, resolve);
            });
            if (answer !== "deny") {
              if (blocked.mode) mode = blocked.mode;
              if (blocked.sandbox) sandbox = blocked.sandbox;
              answer = "once";
            }
          } else if (answer === "ask") {
            const requestId = uid("perm");
            emit({
              type: "permission",
              sessionId: input.sessionId,
              requestId,
              tool: use.name,
              detail: detail.detail,
              path: detail.path,
            });
            answer = await new Promise<PermissionAnswer>((resolve) => {
              this.waiting.set(requestId, resolve);
            });
          }
          if (answer === "deny") {
            results.push({ id: use.id, name: use.name, content: `Denied by permission/sandbox: ${use.name}`, isError: true });
            emit({
              type: "tool",
              sessionId: input.sessionId,
              toolCallId: use.id,
              title: use.name,
              status: "failed",
              detail: "denied",
            });
            continue;
          }
          const executed = limitCustomToolResult(mcp.has(use.name)
            ? await mcp.call(use)
            : await this.executeTool(use, {
                mode,
                sandbox,
                cwd: input.cwd,
                sessionId: input.sessionId,
                folders: input.folders,
                parentId: input.parentId,
                hidden: input.hidden,
                role,
                signal: abort.signal,
              }));
          results.push(executed);
          emit({
            type: "tool",
            sessionId: input.sessionId,
            toolCallId: use.id,
            title: use.name,
            status: executed.isError ? "failed" : "completed",
            detail: executed.content.slice(0, 240),
          });
        }
        messages = [
          ...messages,
          { role: "assistant", text: result.text || "", toolUses, reasoning: result.thought },
          { role: "user", text: "", toolResults: results },
        ];
        const roundFingerprint = customToolRoundFingerprint(toolUses, results);
        repeatedToolRounds = roundFingerprint === previousToolRound ? repeatedToolRounds + 1 : 1;
        previousToolRound = roundFingerprint;
        failedToolRounds = results.length > 0 && results.every((item) => item.isError) ? failedToolRounds + 1 : 0;
        if (repeatedToolRounds >= this.safety.repeatedToolRounds) {
          if (role === "worker" && workerHasDeliverableReport(text)) break;
          safetyPause = "repeated-tools";
          break;
        }
        if (failedToolRounds >= this.safety.failedToolRounds) {
          if (role === "worker" && workerHasDeliverableReport(text)) break;
          safetyPause = "failed-tools";
          break;
        }
        if (shouldEndDispatchTurn(results)) {
          if (!text.trim()) {
            const summary = dispatchSummary(results);
            if (summary) {
              text = summary;
              emit({ type: "chunk", sessionId: input.sessionId, text: summary });
            }
          }
          break;
        }
        messages = compactCustomTurnTranscript(messages, baseMessageCount, this.safety.maxTranscriptChars);
      }
      if (safetyPause) {
        if (role === "worker" && workerHasDeliverableReport(text)) {
          emitTurnUsage();
          emit({ type: "done", sessionId: input.sessionId, stopReason: "end_turn" });
          return { text, stopReason: "end_turn" };
        }
        const message = safetyPauseMessage(safetyPause);
        const separator = text.trim() ? "\n\n" : "";
        const notice = `${separator}${message}`;
        text = `${text.trimEnd()}${notice}`;
        emit({ type: "chunk", sessionId: input.sessionId, text: notice });
        emitTurnUsage();
        emit({ type: "done", sessionId: input.sessionId, stopReason: "safety_pause" });
        return { text, stopReason: "safety_pause" };
      }
      emitTurnUsage();
      emit({ type: "done", sessionId: input.sessionId, stopReason: "end_turn" });
      return { text, stopReason: "end_turn" };
    } catch (error) {
      if (abort.signal.aborted) {
        emitTurnUsage();
        emit({ type: "done", sessionId: input.sessionId, stopReason: "cancelled" });
        return { text, stopReason: "cancelled" };
      }
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", sessionId: input.sessionId, message: message || CUSTOM_NOT_CONFIGURED });
      throw error;
    } finally {
      mcp.dispose();
      if (this.aborts.get(input.sessionId) === abort) this.aborts.delete(input.sessionId);
    }
  }

  cancel(sessionId: string): void {
    this.aborts.get(sessionId)?.abort();
    for (const [id, wait] of this.waiting) {
      wait("deny");
      this.waiting.delete(id);
    }
  }
}

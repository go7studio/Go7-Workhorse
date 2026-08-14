import type { ChatImage, EffortLevel, McpServerConfig, PermissionMode, SandboxProfile, SessionSecurityPolicy } from "../src/lib/types";
import { buildPolicyContext } from "../src/lib/context-preface";
import {
  classifyElevationInput,
  elevationForBlock,
  securityPolicyAnswer,
  type PermissionAnswer,
} from "../src/lib/permissions";
import { uid } from "../src/lib/id";
import { parseProviderId } from "../src/lib/subagents";
import { vendorDeclinedForBot } from "../src/lib/vendor-decline";
import { withCustomPeerHint, withPermissionHint, withWriteLimitHint } from "../src/lib/workhorse-rules";
import type { GrokPromptResult } from "./grok-agent";
import type { GrokEventSink } from "./grok-host";
import { CUSTOM_NOT_CONFIGURED, streamCustomHttp, type CustomChatMessage, type CustomHttpConfig } from "./custom-http";
import { customToolPolicy, executeCustomTool, toolDetail, type CustomToolResult } from "./custom-tools";
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
  folders?: string[];
  config: CustomHttpConfig;
};

export function customPrefaceForLimits(
  preface: string | undefined,
  mode?: PermissionMode,
  sandbox?: SandboxProfile,
): string {
  const policy = buildPolicyContext({ mode, sandbox });
  const head = preface?.trim() ?? "";
  if (!head) return policy;
  if (head.includes("This chat’s live desk limits")) return head;
  return `${head}\n\n${policy}`;
}

const MAX_TOOL_ROUNDS = 8;

export class CustomSessionHost {
  private tails = new Map<string, Promise<unknown>>();
  private aborts = new Map<string, AbortController>();
  private waiting = new Map<string, (answer: PermissionAnswer) => void>();

  constructor(private readonly stream = streamCustomHttp) {}

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
    const history = (input.history ?? []).filter((item) => item.role === "user" || item.role === "assistant");
    let mode = input.mode ?? "ask";
    let sandbox = input.sandbox ?? "off";
    let messages: CustomChatMessage[] = [
      ...history,
      {
        role: "user",
        text: withCustomPeerHint(withPermissionHint(withWriteLimitHint(input.text, mode, sandbox))),
        images: input.images,
      },
    ];
    const preface = customPrefaceForLimits(input.preface, input.mode, input.sandbox);
    const mcp = new McpToolBridge(input.mcpServers ?? []);
    const mcpTools = await mcp.tools();
    let text = "";
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
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
          },
          {
            onChunk: (chunk) => {
              text += chunk;
              emit({ type: "chunk", sessionId: input.sessionId, text: chunk });
            },
            onThought: (chunk) => emit({ type: "thought", sessionId: input.sessionId, text: chunk }),
            onUsage: (usage) =>
              emit({
                type: "usage",
                sessionId: input.sessionId,
                model: input.model || input.config.model,
                projectId: input.projectId,
                ...usage,
              }),
          },
        );
        text = result.text || text;
        if (result.usage) {
          emit({
            type: "usage",
            sessionId: input.sessionId,
            model: input.model || input.config.model,
            projectId: input.projectId,
            ...result.usage,
          });
        }
        const toolUses = result.toolUses ?? [];
        if (toolUses.length === 0) break;
        const results: CustomToolResult[] = [];
        for (const use of toolUses) {
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
            const vendorName = { grok: "Grok", claude: "Claude", codex: "Codex" }[spawnTarget];
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
          const executed = mcp.has(use.name)
            ? await mcp.call(use)
            : await executeCustomTool(use, {
                mode,
                sandbox,
                cwd: input.cwd,
                sessionId: input.sessionId,
                folders: input.folders,
              });
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
          { role: "assistant", text: result.text || "", toolUses },
          { role: "user", text: "", toolResults: results },
        ];
      }
      emit({ type: "done", sessionId: input.sessionId, stopReason: "end_turn" });
      return { text, stopReason: "end_turn" };
    } catch (error) {
      if (abort.signal.aborted) {
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

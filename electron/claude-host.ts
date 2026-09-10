import { spawnCwd } from "./spawn-cwd";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { groupSpawnOptions } from "./process-registry";
import { deskRoleOf } from "../src/lib/subagents";
import fs from "node:fs";
import path from "node:path";
import { GrokAgent, type GrokPromptResult, type GrokToolEvent } from "./grok-agent";
import {
  isWorkerRuntime,
  shouldLoadVendorSession,
  type GrokCompactInput,
  type GrokEventSink,
  type GrokPromptInput,
  type GrokSessionOpenInput,
} from "./grok-host";
import { CLAUDE_ACP_NOT_INSTALLED } from "./claude-login";
import { buildClaudeLaunchSpec, claudeSpawnArgs, type ClaudeLaunchSpec } from "./claude-launch";
import { composeVendorPrompt } from "../src/lib/context-preface";
import { advertisedModelIds } from "../src/lib/advertised-models";
import { titleFromRecord } from "./grok-title";
import { claudeAuthFailure } from "../src/lib/claude-auth-failure";
import { clearClaudeCredentialRejection, markClaudeCredentialRejected } from "./claude-stored-token";
import type { PermissionAnswer } from "../src/lib/permissions";

export type ClaudePromptInput = GrokPromptInput;
export type ClaudeEventSink = GrokEventSink;
type ClaudeSpawnFn = (spec: ReturnType<typeof buildClaudeLaunchSpec>) => ChildProcessWithoutNullStreams;

export function claudeLaunchKey(
  input: Pick<GrokSessionOpenInput, "model" | "effort" | "fastMode" | "agentName" | "mode" | "cwd" | "sandbox" | "mcpServers">,
  spec: ClaudeLaunchSpec = buildClaudeLaunchSpec({
    model: input.model,
    effort: input.effort,
    fastMode: input.fastMode,
    agentName: input.agentName,
    cwd: input.cwd,
    mode: input.mode,
    sandbox: input.sandbox,
    mcpServers: input.mcpServers,
  }),
): string {
  return `${spec.command}\0${spec.argv.join("\0")}\0${spec.cwd}\0${JSON.stringify(spec.sessionParams.mcpServers)}\0${spec.model}\0${spec.env?.ANTHROPIC_MODEL ?? ""}\0${spec.effort}\0${spec.sandbox}\0${input.mode}\0${spec.permissionMode}\0${spec.credential.source}\0${spec.credential.fingerprint}`;
}

function isBareWindowsCmd(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command) && path.basename(command).toLowerCase() !== "cmd.exe";
}

export function spawnClaudeProcess(spec: ReturnType<typeof buildClaudeLaunchSpec>): ChildProcessWithoutNullStreams {
  const { command, args, cwd, env } = claudeSpawnArgs(spec);
  if (!command.trim()) throw new Error(CLAUDE_ACP_NOT_INSTALLED);
  if (command.toLowerCase() === "grok" || /(^|[\\/])grok(\.exe)?$/i.test(command)) {
    throw new Error("Claude ACP refused to spawn grok");
  }
  if (isBareWindowsCmd(command)) {
    throw new Error(CLAUDE_ACP_NOT_INSTALLED);
  }
  if (!fs.existsSync(command)) {
    throw new Error(CLAUDE_ACP_NOT_INSTALLED);
  }
  const script = args[0];
  if (script && /\.(c?js|mjs)$/i.test(script) && !fs.existsSync(script)) {
    throw new Error(CLAUDE_ACP_NOT_INSTALLED);
  }
  return spawn(command, args, {
    cwd: spawnCwd(cwd),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // The CLI leads its own group, so a stop reaches what the CLI started too.
    ...groupSpawnOptions(),
  }) as ChildProcessWithoutNullStreams;
}

export class ClaudeSessionHost {
  private slots = new Map<string, { key: string; agent: GrokAgent }>();

  /**
   * The sessions this host is still driving right now.
   *
   * A window reload is not a crash. The desk used to rewrite every run marked
   * running straight to interrupted on any state load, so reopening the window
   * killed live work that this process was still carrying.
   */
  liveSessionIds(): string[] {
    return [...this.slots.keys()];
  }
  private tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly spawn: ClaudeSpawnFn = spawnClaudeProcess,
    private readonly build: typeof buildClaudeLaunchSpec = buildClaudeLaunchSpec,
  ) {}

  async prompt(input: ClaudePromptInput, emit: ClaudeEventSink): Promise<GrokPromptResult> {
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

  private async promptUnlocked(input: ClaudePromptInput, emit: ClaudeEventSink): Promise<GrokPromptResult> {
    let previousRefusal: { fingerprint: string; error: unknown } | undefined;
    // Retry once, and only before output or actions could have reached the user.
    for (let attempt = 0; attempt < 2; attempt++) {
      const spec = this.build({
        ...input,
        unlistedModel: input.unlistedModel,
        role: input.role ?? deskRoleOf({ parentId: input.parentId, hidden: input.hidden }),
      });
      if (previousRefusal && (spec.credential.source === "none" || spec.credential.fingerprint === previousRefusal.fingerprint)) {
        const error = previousRefusal.error;
        emit({ type: "error", sessionId: input.sessionId, message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      let activity = false;
      const forward: ClaudeEventSink = (event) => {
        if (["chunk", "thought", "tool", "permission", "usage", "background-task"].includes(event.type)) activity = true;
        emit(event);
      };
      try {
        await this.ensureAgent(input, forward, spec);
        const slot = this.slots.get(input.sessionId);
        if (!slot) throw new Error("Claude agent is not running");
        const text = composeVendorPrompt(input.text, input.preface, slot.agent.opened, {
          mode: input.mode,
          sandbox: input.sandbox,
          role: input.role ?? (input.parentId || input.hidden ? "worker" : "orchestrator"),
          crewMode: input.crewModes,
          spawnNames: input.spawnNames,
        }, input.visibleText);
        const result = await slot.agent.prompt(text, this.handlersFor(input, forward), input.images ?? []);
        if (result.stopReason !== "cancelled") clearClaudeCredentialRejection(spec.credential.fingerprint);
        emit({ type: "done", sessionId: input.sessionId, stopReason: result.stopReason });
        return result;
      } catch (error) {
        const problem = claudeAuthFailure(error);
        if (problem) {
          markClaudeCredentialRejected(problem, spec.credential.fingerprint);
          this.dispose(input.sessionId);
          if (attempt === 0 && !activity && spec.credential.source !== "none") {
            previousRefusal = { fingerprint: spec.credential.fingerprint, error };
            continue;
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "error", sessionId: input.sessionId, message });
        throw error;
      } finally {
        if (isWorkerRuntime(input)) this.dispose(input.sessionId);
      }
    }
    throw new Error("Claude credential retry exhausted");
  }

  private handlersFor(
    input: Pick<ClaudePromptInput, "sessionId" | "projectId" | "model">,
    emit: ClaudeEventSink,
  ) {
    return {
      onChunk: (text: string) => emit({ type: "chunk" as const, sessionId: input.sessionId, text }),
      onThought: (text: string) => emit({ type: "thought" as const, sessionId: input.sessionId, text }),
      onUsage: (usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        costUsd?: number;
        contextUsed?: number;
        source?: import("../src/lib/types").UsageSource;
      }) =>
        emit({
          type: "usage" as const,
          sessionId: input.sessionId,
          model: input.model,
          projectId: input.projectId,
          provider: "claude",
          ...usage,
        }),
      onPermission: (ask: { requestId: string; tool: string; rawTool?: string; detail: string; path?: string }) =>
        emit({
          type: "permission" as const,
          sessionId: input.sessionId,
          requestId: ask.requestId,
          tool: ask.tool,
          rawTool: ask.rawTool,
          detail: ask.detail,
          path: ask.path,
        }),
      onTool: (tool: GrokToolEvent) => emit({ type: "tool" as const, sessionId: input.sessionId, ...tool }),
      onBackgroundTask: (task: import("../src/lib/vendor-tasks").VendorBackgroundTask) =>
        emit({ type: "background-task" as const, sessionId: input.sessionId, ...task }),
      onTitle: (title: string) => emit({ type: "title" as const, sessionId: input.sessionId, title }),
      onCommands: (commands: import("../src/lib/types").Command[]) =>
        emit({ type: "commands" as const, sessionId: input.sessionId, commands }),
    };
  }

  private async ensureAgent(input: GrokSessionOpenInput, emit: ClaudeEventSink, spec: ClaudeLaunchSpec): Promise<void> {
    const key = claudeLaunchKey(input, spec);
    let slot = this.slots.get(input.sessionId);
    if (slot && !slot.agent.canReuse) {
      slot.agent.dispose();
      this.slots.delete(input.sessionId);
      slot = undefined;
    }
    const action = shouldLoadVendorSession({
      vendorSessionId: input.vendorSessionId,
      existingSlotKey: slot?.key,
      nextKey: key,
      restartRuntime: input.restartRuntime,
    });
    if (action === "reuse" && slot) return;
    slot?.agent.dispose();
    const agent = new GrokAgent(spec, (launchSpec) => this.spawn(launchSpec as typeof spec));
    try {
      const started = await agent.start({
        vendorSessionId: action === "load" ? input.vendorSessionId : undefined,
      });
      emit({
        type: "vendor-session",
        sessionId: input.sessionId,
        vendorSessionId: started.sessionId,
        opened: started.opened,
      });
      // Steal Claude ACP session/new title/displayName when present. No billed generate.
      const titled = titleFromRecord(started.sessionNew);
      if (titled) emit({ type: "title", sessionId: input.sessionId, title: titled });
      const models = advertisedModelIds(started.sessionNew);
      if (models.length > 0) emit({ type: "vendor-models", sessionId: input.sessionId, provider: "claude", models });
    } catch (error) {
      agent.dispose();
      throw error;
    }
    this.slots.set(input.sessionId, { key, agent });
  }

  answerPermission(requestId: string, answer: PermissionAnswer): boolean {
    for (const item of this.slots.values()) {
      if (item.agent.answerPermission(requestId, answer)) return true;
    }
    return false;
  }

  cancel(sessionId: string): void {
    this.slots.get(sessionId)?.agent.cancel();
  }

  dispose(sessionId: string): void {
    this.slots.get(sessionId)?.agent.dispose();
    this.slots.delete(sessionId);
  }

  disposeAll(): void {
    for (const item of this.slots.values()) item.agent.dispose();
    this.slots.clear();
  }
}

export type ClaudeCompactInput = GrokCompactInput;

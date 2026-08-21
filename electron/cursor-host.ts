import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { deskRoleOf } from "../src/lib/subagents";
import fs from "node:fs";
import path from "node:path";
import { GrokAgent, type GrokPromptResult, type GrokToolEvent } from "./grok-agent";
import {
  shouldLoadVendorSession,
  type GrokEventSink,
  type GrokPromptInput,
  type GrokSessionOpenInput,
} from "./grok-host";
import { CURSOR_ACP_NOT_INSTALLED, isCursorAppCommand, isGrokCommand } from "./cursor-login";
import { buildCursorLaunchSpec, cursorSpawnArgs } from "./cursor-launch";
import { composeVendorPrompt } from "../src/lib/context-preface";
import { titleFromRecord } from "./grok-title";
import type { PermissionAnswer } from "../src/lib/permissions";

export type CursorPromptInput = GrokPromptInput;
export type CursorEventSink = GrokEventSink;
type CursorSpawnFn = (spec: ReturnType<typeof buildCursorLaunchSpec>) => ChildProcessWithoutNullStreams;

export function cursorLaunchKey(
  input: Pick<GrokSessionOpenInput, "model" | "effort" | "mode" | "cwd" | "sandbox" | "mcpServers">,
): string {
  const spec = buildCursorLaunchSpec({
    model: input.model,
    effort: input.effort,
    cwd: input.cwd,
    mode: input.mode,
    sandbox: input.sandbox,
    mcpServers: input.mcpServers,
  });
  return `${spec.command}\0${spec.argv.join("\0")}\0${spec.cwd}\0${JSON.stringify(spec.sessionParams.mcpServers)}\0${spec.model}\0${spec.effort}\0${spec.sandbox}\0${input.mode}`;
}

function isBareWindowsCmd(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command) && path.basename(command).toLowerCase() !== "cmd.exe";
}

export function spawnCursorProcess(spec: ReturnType<typeof buildCursorLaunchSpec>): ChildProcessWithoutNullStreams {
  const { command, args, cwd, env } = cursorSpawnArgs(spec);
  if (!command.trim()) throw new Error(CURSOR_ACP_NOT_INSTALLED);
  if (isGrokCommand(command)) throw new Error("Cursor ACP refused to spawn grok");
  if (isCursorAppCommand(command)) throw new Error("Cursor ACP refused to spawn Cursor.app");
  if (isBareWindowsCmd(command)) throw new Error(CURSOR_ACP_NOT_INSTALLED);
  if (!fs.existsSync(command)) throw new Error(CURSOR_ACP_NOT_INSTALLED);
  return spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
}

export class CursorSessionHost {
  private slots = new Map<string, { key: string; agent: GrokAgent }>();
  private tails = new Map<string, Promise<unknown>>();

  constructor(private readonly spawn: CursorSpawnFn = spawnCursorProcess) {}

  async prompt(input: CursorPromptInput, emit: CursorEventSink): Promise<GrokPromptResult> {
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

  private async promptUnlocked(input: CursorPromptInput, emit: CursorEventSink): Promise<GrokPromptResult> {
    await this.ensureAgent(input, emit);
    const slot = this.slots.get(input.sessionId);
    if (!slot) throw new Error("Cursor agent is not running");
    const text = composeVendorPrompt(input.text, input.preface, slot.agent.opened, {
      mode: input.mode,
      sandbox: input.sandbox,
      role: input.role ?? (input.parentId || input.hidden ? "worker" : "orchestrator"),
      crewMode: input.crewModes,
    });
    try {
      const result = await slot.agent.prompt(text, this.handlersFor(input, emit), input.images ?? []);
      emit({ type: "done", sessionId: input.sessionId, stopReason: result.stopReason });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", sessionId: input.sessionId, message });
      throw error;
    }
  }

  private handlersFor(input: Pick<CursorPromptInput, "sessionId" | "projectId" | "model">, emit: CursorEventSink) {
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
          provider: "cursor",
          ...usage,
        }),
      onPermission: (ask: { requestId: string; tool: string; detail: string; path?: string }) =>
        emit({
          type: "permission" as const,
          sessionId: input.sessionId,
          requestId: ask.requestId,
          tool: ask.tool,
          detail: ask.detail,
          path: ask.path,
        }),
      onTool: (tool: GrokToolEvent) => emit({ type: "tool" as const, sessionId: input.sessionId, ...tool }),
      onTitle: (title: string) => emit({ type: "title" as const, sessionId: input.sessionId, title }),
      onCommands: (commands: import("../src/lib/types").Command[]) =>
        emit({ type: "commands" as const, sessionId: input.sessionId, commands }),
    };
  }

  private async ensureAgent(input: GrokSessionOpenInput, emit: CursorEventSink): Promise<void> {
    const key = cursorLaunchKey(input);
    const slot = this.slots.get(input.sessionId);
    const action = shouldLoadVendorSession({
      vendorSessionId: input.vendorSessionId,
      existingSlotKey: slot?.key,
      nextKey: key,
      restartRuntime: input.restartRuntime,
    });
    if (action === "reuse" && slot) return;
    slot?.agent.dispose();
    const spec = buildCursorLaunchSpec({
      sessionId: input.sessionId,
      role: input.role ?? deskRoleOf({ parentId: input.parentId, hidden: input.hidden }),
      model: input.model,
      effort: input.effort,
      cwd: input.cwd,
      mode: input.mode,
      sandbox: input.sandbox,
      mcpServers: input.mcpServers,
    });
    const agent = new GrokAgent({ ...spec, agentLabel: "Cursor" }, (launchSpec) => this.spawn(launchSpec as typeof spec));
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
      // Steal Cursor ACP session/new display name when present. No billed generate.
      const titled = titleFromRecord(started.sessionNew);
      if (titled) emit({ type: "title", sessionId: input.sessionId, title: titled });
    } catch (error) {
      agent.dispose();
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", sessionId: input.sessionId, message });
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

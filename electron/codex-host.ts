import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { deskRoleOf } from "../src/lib/subagents";
import fs from "node:fs";
import path from "node:path";
import { GrokAgent, usageHasBilledTokens, type GrokPromptResult, type GrokToolEvent } from "./grok-agent";
import { harvestCodexSessionBills } from "./codex-usage";
import { shouldLoadVendorSession, type GrokCompactInput, type GrokEventSink, type GrokPromptInput, type GrokSessionOpenInput } from "./grok-host";
import { CODEX_ACP_NOT_INSTALLED } from "./codex-login";
import { buildCodexLaunchSpec, codexSpawnArgs } from "./codex-launch";
import { composeVendorPrompt } from "../src/lib/context-preface";
import { titleFromRecord } from "./grok-title";
import type { PermissionAnswer } from "../src/lib/permissions";

export type CodexPromptInput = GrokPromptInput;
export type CodexEventSink = GrokEventSink;
type CodexSpawnFn = (spec: ReturnType<typeof buildCodexLaunchSpec>) => ChildProcessWithoutNullStreams;

const CODEX_SKILL_BUDGET_WARNING =
  "Warning: Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.";

export function stripCodexRuntimeNotices(text: string): string {
  return text.replace(`${CODEX_SKILL_BUDGET_WARNING}\n\n`, "").replace(CODEX_SKILL_BUDGET_WARNING, "");
}

export function createCodexChunkFilter(emit: (text: string) => void) {
  let pending = "";
  return {
    push(chunk: string) {
      const combined = pending + chunk;
      if (CODEX_SKILL_BUDGET_WARNING.startsWith(combined.trimEnd())) {
        pending = combined;
        return;
      }
      pending = "";
      const clean = stripCodexRuntimeNotices(combined);
      if (clean) emit(clean);
    },
    flush() {
      const clean = stripCodexRuntimeNotices(pending);
      pending = "";
      if (clean) emit(clean);
    },
  };
}

export function codexLaunchKey(
  input: Pick<GrokSessionOpenInput, "model" | "effort" | "mode" | "cwd" | "sandbox" | "securityPolicy" | "mcpServers">,
): string {
  const spec = buildCodexLaunchSpec({
    model: input.model,
    effort: input.effort,
    cwd: input.cwd,
    mode: input.mode,
    sandbox: input.sandbox,
    securityPolicy: input.securityPolicy,
    mcpServers: input.mcpServers,
  });
  return `${spec.command}\0${spec.argv.join("\0")}\0${spec.cwd}\0${JSON.stringify(spec.sessionParams.mcpServers)}\0${spec.model}\0${spec.effort}\0${spec.sandbox}\0${input.mode}\0${spec.approvalPolicy}\0${spec.agentMode}\0${spec.env?.INITIAL_AGENT_MODE ?? ""}\0${spec.env?.CODEX_CONFIG ?? ""}`;
}

function isBareWindowsCmd(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command) && path.basename(command).toLowerCase() !== "cmd.exe";
}

export function spawnCodexProcess(spec: ReturnType<typeof buildCodexLaunchSpec>): ChildProcessWithoutNullStreams {
  const { command, args, cwd, env } = codexSpawnArgs(spec);
  if (!command.trim()) throw new Error(CODEX_ACP_NOT_INSTALLED);
  if (command.toLowerCase() === "grok" || /(^|[\\/])grok(\.exe)?$/i.test(command)) {
    throw new Error("Codex ACP refused to spawn grok");
  }
  if (isBareWindowsCmd(command)) {
    throw new Error(CODEX_ACP_NOT_INSTALLED);
  }
  if (!fs.existsSync(command)) {
    throw new Error(CODEX_ACP_NOT_INSTALLED);
  }
  const script = args[0];
  if (script && /\.(c?js|mjs)$/i.test(script) && !fs.existsSync(script)) {
    throw new Error(CODEX_ACP_NOT_INSTALLED);
  }
  return spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
}

export class CodexSessionHost {
  private slots = new Map<string, { key: string; agent: GrokAgent }>();
  private tails = new Map<string, Promise<unknown>>();

  constructor(private readonly spawn: CodexSpawnFn = spawnCodexProcess) {}

  async prompt(input: CodexPromptInput, emit: CodexEventSink): Promise<GrokPromptResult> {
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

  private async promptUnlocked(input: CodexPromptInput, emit: CodexEventSink): Promise<GrokPromptResult> {
    await this.ensureAgent(input, emit);
    const slot = this.slots.get(input.sessionId);
    if (!slot) throw new Error("Codex agent is not running");
    const text = composeVendorPrompt(input.text, input.preface, slot.agent.opened, {
      mode: input.mode,
      sandbox: input.sandbox,
      role: input.role ?? (input.parentId || input.hidden ? "worker" : "orchestrator"),
    });

    try {
      const handlers = this.handlersFor(input, emit);
      const chunks = createCodexChunkFilter(handlers.onChunk);
      const startedAt = Date.now() - 2_000;
      const result = await slot.agent.prompt(text, { ...handlers, onChunk: chunks.push }, input.images ?? []);
      chunks.flush();
      const bills = harvestCodexSessionBills(slot.agent.sessionId, startedAt);
      if (bills.length > 0) {
        for (const bill of bills) handlers.onUsage?.(bill);
      } else if (result.usage && usageHasBilledTokens(result.usage)) {
        handlers.onUsage?.({ ...result.usage, source: "request" });
      }
      let nativeSessionArchived = false;
      if (input.parentId || input.hidden || input.role === "worker") {
        try {
          nativeSessionArchived = await slot.agent.archiveSession();
        } catch (error) {
          console.warn("workhorse Codex worker archive failed", error);
        }
        if (nativeSessionArchived) {
          slot.agent.dispose();
          if (this.slots.get(input.sessionId) === slot) this.slots.delete(input.sessionId);
        }
      }
      emit({ type: "done", sessionId: input.sessionId, stopReason: result.stopReason });
      return {
        ...result,
        ...(nativeSessionArchived ? { vendorSessionId: undefined, nativeSessionArchived: true } : {}),
        text: stripCodexRuntimeNotices(result.text).trimStart(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", sessionId: input.sessionId, message });
      throw error;
    }
  }

  private handlersFor(
    input: Pick<CodexPromptInput, "sessionId" | "projectId" | "model">,
    emit: CodexEventSink,
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
          provider: "codex",
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
      emitResultUsage: false,
    };
  }

  private async ensureAgent(input: GrokSessionOpenInput, emit: CodexEventSink): Promise<void> {
    const key = codexLaunchKey(input);
    const slot = this.slots.get(input.sessionId);
    const action = shouldLoadVendorSession({
      vendorSessionId: input.vendorSessionId,
      existingSlotKey: slot?.key,
      nextKey: key,
      restartRuntime: input.restartRuntime,
    });
    if (action === "reuse" && slot) return;
    slot?.agent.dispose();
    const spec = buildCodexLaunchSpec({
      sessionId: input.sessionId,
      role: input.role ?? deskRoleOf({ parentId: input.parentId, hidden: input.hidden }),
      model: input.model,
      effort: input.effort,
      cwd: input.cwd,
      mode: input.mode,
      sandbox: input.sandbox,
      securityPolicy: input.securityPolicy,
      mcpServers: input.mcpServers,
    });
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
      // Steal Codex ACP session/new / thread title when present. No billed generate.
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

/** Codex ACP has no Workhorse-wired compact/rewind/session-info; do not fake those IPC methods. */
export type CodexCompactInput = GrokCompactInput;

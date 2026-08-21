import fs from "node:fs";
import path from "node:path";
import { deskRoleOf } from "../src/lib/subagents";
import { GrokAgent, spawnGrokProcess, type GrokPromptResult, type GrokSpawnFn, type GrokToolEvent } from "./grok-agent";
import { buildGrokLaunchSpec } from "./grok-launch";
import { readGrokGeneratedTitle, titleFromRecord } from "./grok-title";
import { parseSessionContext, type ChatContextStats } from "../src/lib/context-stats";
import { composeVendorPrompt } from "../src/lib/context-preface";
import type { PermissionAnswer } from "../src/lib/permissions";
import type { CrewMode, EffortLevel, McpServerConfig, PermissionMode, SandboxProfile, SessionSecurityPolicy } from "../src/lib/types";

export type GrokSessionOpenInput = {
  sessionId: string;
  projectId?: string;
  model: string;
  effort: EffortLevel | null;
  fastMode?: boolean;
  agentName?: string | null;
  mode: PermissionMode;
  cwd: string;
  vendorSessionId?: string;
  sandbox?: SandboxProfile;
  securityPolicy?: SessionSecurityPolicy;
  mcpServers?: McpServerConfig[];
  preface?: string;
  parentId?: string;
  hidden?: boolean;
  role?: import("../src/lib/workhorse-rules").DeskRole;
  /** Reopen the vendor runtime while loading the same native session. */
  restartRuntime?: boolean;
};

export type GrokPromptInput = GrokSessionOpenInput & {
  text: string;
  images?: import("../src/lib/types").ChatImage[];
  crewModes?: CrewMode[];
};

export type GrokCompactInput = GrokSessionOpenInput & {
  note?: string;
};

export type GrokIpcEvent =
  | { type: "chunk"; sessionId: string; text: string }
  | { type: "thought"; sessionId: string; text: string }
  | { type: "done"; sessionId: string; stopReason?: string }
  | { type: "error"; sessionId: string; message: string }
  | {
      type: "permission";
      sessionId: string;
      requestId: string;
      tool: string;
      detail: string;
      path?: string;
      elevate?: { mode?: import("../src/lib/types").PermissionMode; sandbox?: import("../src/lib/types").SandboxProfile };
      vendor?: { provider: import("../src/lib/types").ProviderId; name: string; status?: string };
    }
  | { type: "tool"; sessionId: string } & GrokToolEvent
  | { type: "compact"; sessionId: string } & import("./grok-agent").GrokCompactEvent
  | {
      type: "usage";
      sessionId: string;
      model: string;
      projectId?: string;
      provider?: import("../src/lib/types").ProviderId;
      customBotId?: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd?: number;
      contextUsed?: number;
      source?: import("../src/lib/types").UsageSource;
    }
  | {
      type: "vendor-session";
      sessionId: string;
      vendorSessionId: string;
      opened: "session/new" | "session/load";
    }
  | { type: "title"; sessionId: string; title: string }
  | { type: "commands"; sessionId: string; commands: import("../src/lib/types").Command[] };

export type GrokEventSink = (event: GrokIpcEvent) => void;

export function launchKey(input: Pick<GrokSessionOpenInput, "model" | "effort" | "mode" | "cwd" | "sandbox" | "mcpServers">): string {
  const spec = buildGrokLaunchSpec({
    model: input.model,
    effort: input.effort,
    cwd: input.cwd,
    mode: input.mode,
    sandbox: input.sandbox,
    mcpServers: input.mcpServers,
  });
  return `${spec.argv.join("\0")}\0${spec.cwd}\0${JSON.stringify(spec.sessionParams.mcpServers)}`;
}

export function shouldLoadVendorSession(input: {
  vendorSessionId?: string;
  existingSlotKey?: string;
  nextKey: string;
  restartRuntime?: boolean;
}): "reuse" | "load" | "new" {
  if (input.restartRuntime) return input.vendorSessionId?.trim() ? "load" : "new";
  if (input.existingSlotKey && input.existingSlotKey === input.nextKey) return "reuse";
  if (input.existingSlotKey && input.existingSlotKey !== input.nextKey) return "new";
  if (input.vendorSessionId?.trim()) return "load";
  return "new";
}

export function resolveSessionCwd(folderPath?: string | null): string {
  const candidate = folderPath?.trim() ?? "";
  return candidate && path.isAbsolute(candidate) ? candidate : "";
}

/** Empty bootstrap under userData. Not the app launch directory and not a project. */
export const DESK_BASE_DIR = "base";

export function deskBaseCwd(userData?: string | null): string {
  const root = userData?.trim() ?? "";
  return root ? path.join(root, DESK_BASE_DIR) : "";
}

/**
 * Bound project folder, or the desk base so an unbound chat can still start,
 * search the machine, and then link a folder. Never the app launch cwd.
 */
export function resolveOrBaseSessionCwd(
  folderPath?: string | null,
  userData?: string | null,
  mkdir: typeof fs.mkdirSync = fs.mkdirSync,
): string {
  const bound = resolveSessionCwd(folderPath);
  if (bound) return bound;
  const base = deskBaseCwd(userData);
  if (!base) return "";
  mkdir(base, { recursive: true });
  return base;
}

export class GrokSessionHost {
  private slots = new Map<string, { key: string; agent: GrokAgent }>();
  private tails = new Map<string, Promise<unknown>>();

  constructor(private readonly spawn: GrokSpawnFn = spawnGrokProcess) {}

  async prompt(input: GrokPromptInput, emit: GrokEventSink): Promise<GrokPromptResult> {
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

  private async promptUnlocked(input: GrokPromptInput, emit: GrokEventSink): Promise<GrokPromptResult> {
    await this.ensureAgent(input, emit);
    const slot = this.slots.get(input.sessionId);
    if (!slot) throw new Error("grok agent is not running");
    const text = composeVendorPrompt(input.text, input.preface, slot.agent.opened, {
      mode: input.mode,
      sandbox: input.sandbox,
      role: input.role ?? (input.parentId || input.hidden ? "worker" : "orchestrator"),
      crewMode: input.crewModes,
    });

    try {
      const result = await slot.agent.prompt(text, this.handlersFor(input, emit), input.images ?? []);
      this.emitDiscoveredTitle(input, emit, result.vendorSessionId ?? slot.agent.sessionId);
      emit({ type: "done", sessionId: input.sessionId, stopReason: result.stopReason });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", sessionId: input.sessionId, message });
      throw error;
    }
  }

  async compact(input: GrokCompactInput, emit: GrokEventSink): Promise<import("./grok-agent").GrokCompactEvent> {
    const previous = this.tails.get(input.sessionId) ?? Promise.resolve();
    const run = previous.then(
      () => this.compactUnlocked(input, emit),
      () => this.compactUnlocked(input, emit),
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

  private async compactUnlocked(input: GrokCompactInput, emit: GrokEventSink) {
    await this.ensureAgent(input, emit);
    const slot = this.slots.get(input.sessionId);
    if (!slot) throw new Error("grok agent is not running");
    try {
      const result = await slot.agent.compact(input.note, this.handlersFor(input, emit));
      emit({ type: "compact", sessionId: input.sessionId, ...result });
      emit({ type: "done", sessionId: input.sessionId, stopReason: "compacted" });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", sessionId: input.sessionId, message });
      throw error;
    }
  }

  private handlersFor(
    input: Pick<GrokPromptInput, "sessionId" | "projectId" | "model">,
    emit: GrokEventSink,
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
          provider: "grok",
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
      onCompact: (compact: import("./grok-agent").GrokCompactEvent) =>
        emit({ type: "compact" as const, sessionId: input.sessionId, ...compact }),
      onTitle: (title: string) => emit({ type: "title" as const, sessionId: input.sessionId, title }),
      onCommands: (commands: import("../src/lib/types").Command[]) =>
        emit({ type: "commands" as const, sessionId: input.sessionId, commands }),
    };
  }

  private emitDiscoveredTitle(
    input: Pick<GrokPromptInput, "sessionId" | "cwd">,
    emit: GrokEventSink,
    vendorSessionId?: string,
  ): void {
    const title = vendorSessionId ? readGrokGeneratedTitle(input.cwd, vendorSessionId) : undefined;
    if (title) emit({ type: "title", sessionId: input.sessionId, title });
    if (!vendorSessionId || title) return;
    let left = 4;
    const tick = () => {
      const next = readGrokGeneratedTitle(input.cwd, vendorSessionId);
      if (next) {
        emit({ type: "title", sessionId: input.sessionId, title: next });
        return;
      }
      left -= 1;
      if (left > 0) setTimeout(tick, 2000);
    };
    setTimeout(tick, 2000);
  }

  private async ensureAgent(input: GrokSessionOpenInput, emit: GrokEventSink): Promise<void> {
    const key = launchKey(input);
    const slot = this.slots.get(input.sessionId);
    const action = shouldLoadVendorSession({
      vendorSessionId: input.vendorSessionId,
      existingSlotKey: slot?.key,
      nextKey: key,
      restartRuntime: input.restartRuntime,
    });
    if (action === "reuse" && slot) return;
    slot?.agent.dispose();
    const spec = buildGrokLaunchSpec({
      sessionId: input.sessionId,
      role: input.role ?? deskRoleOf({ parentId: input.parentId, hidden: input.hidden }),
      model: input.model,
      effort: input.effort,
      cwd: input.cwd,
      mode: input.mode,
      sandbox: input.sandbox,
      mcpServers: input.mcpServers,
    });
    const agent = new GrokAgent(spec, this.spawn);
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
      // Steal Grok session/new + ~/.grok summary.json generated_title. No billed generate.
      const titled = titleFromRecord(started.sessionNew) ?? readGrokGeneratedTitle(input.cwd, started.sessionId);
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

  async fork(
    input: GrokSessionOpenInput,
    emit: GrokEventSink = () => undefined,
  ): Promise<{ vendorSessionId?: string }> {
    await this.ensureAgent(input, emit);
    const slot = this.slots.get(input.sessionId);
    if (!slot) return {};
    try {
      const vendorSessionId = await slot.agent.forkSession();
      return vendorSessionId ? { vendorSessionId } : {};
    } catch {
      return {};
    }
  }

  async sessionInfo(sessionId: string): Promise<ChatContextStats | null> {
    const slot = this.slots.get(sessionId);
    if (!slot) return null;
    try {
      return parseSessionContext(await slot.agent.sessionInfo());
    } catch {
      return null;
    }
  }

  async rewind(
    input: GrokSessionOpenInput & { keepUserIndex: number },
    emit: GrokEventSink = () => undefined,
  ): Promise<{ reset: boolean; rewound: boolean }> {
    if (input.keepUserIndex < 0) {
      this.dispose(input.sessionId);
      return { reset: true, rewound: true };
    }
    await this.ensureAgent(input, emit);
    const slot = this.slots.get(input.sessionId);
    if (!slot) return { reset: true, rewound: false };
    try {
      const rewound = await slot.agent.rewindToUser(input.keepUserIndex);
      return { reset: false, rewound };
    } catch {
      return { reset: false, rewound: false };
    }
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

import { spawn, type ChildProcess } from "node:child_process";
import { composeVendorPrompt } from "../src/lib/context-preface";
import { deltaAgyUsage, type AgyTokenTotals } from "../src/lib/agy-usage";
import { parseAgyStreamLine } from "../src/lib/agy-stream";
import type { ChatImage } from "../src/lib/types";
import type { GrokPromptResult, GrokToolEvent } from "./grok-agent";
import {
  isWorkerRuntime,
  stoppedBeforePrompt,
  type GrokEventSink,
  type GrokPromptInput,
} from "./grok-host";
import { agySkipsPermissions, buildAgyLaunchSpec } from "./agy-launch";
import { resolveAgyBinary } from "./agy-login";
import { deskToolEnv } from "./desk-path";
import { groupSpawnOptions } from "./process-registry";
import { createAgyMcpOverlay } from "./agy-mcp";
import { workhorseMcpServer } from "./grok-launch";

const STDERR_CAP = 4_096;

export type AgyChild = {
  stdin: { write(chunk: string): boolean | void; end?: () => void } | null;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type AgySpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => AgyChild;

type Turn = {
  sessionId: string;
  model: string;
  projectId?: string;
  emit: GrokEventSink;
  streamed: Set<number>;
  text: string;
  settled: boolean;
  resolve: (result: GrokPromptResult) => void;
  reject: (error: Error) => void;
};

type Slot = {
  key: string;
  child: AgyChild;
  opened: "session/new" | "session/load";
  conversationId?: string;
  announced: boolean;
  usage?: AgyTokenTotals;
  buffer: string;
  stderr: string;
  dead: boolean;
  disposeMcp?: () => void;
  turn?: Turn;
};

function killAgyChild(child: AgyChild): void {
  const pid = child.pid;
  if (pid && pid > 0 && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGINT");
      return;
    } catch {
      /* not a process group */
    }
  }
  try {
    child.kill("SIGINT");
  } catch {
    /* already gone */
  }
}

function defaultSpawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): AgyChild {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    ...groupSpawnOptions(),
  }) as ChildProcess;
}

function imageNote(images: ChatImage[] | undefined): string {
  const paths = (images ?? []).map((image) => image.sourcePath?.trim() || image.name?.trim()).filter((item): item is string => Boolean(item));
  if (paths.length === 0) return "";
  return `Files to read from the workspace:\n${paths.map((item) => `- ${item}`).join("\n")}\n\n`;
}

function permissionNotice(stderr: string): string {
  const line = stderr
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => /permission|denied|not allowed/i.test(item));
  return line ? line.slice(0, 300) : "";
}

function launchKey(input: GrokPromptInput): string {
  return [input.model, input.effort ?? "", input.cwd, input.mode, input.sandbox ?? "off", JSON.stringify(input.mcpServers ?? [])].join("\0");
}

export class AgySessionHost {
  private slots = new Map<string, Slot>();
  private tails = new Map<string, Promise<unknown>>();
  private starting = new Set<string>();
  private stoppedWhileStarting = new Set<string>();

  constructor(
    private readonly spawn: AgySpawnFn = defaultSpawn,
    private readonly kill: (child: AgyChild) => void = killAgyChild,
    private readonly binary?: string,
    private readonly builtInMcp = workhorseMcpServer,
  ) {}

  liveSessionIds(): string[] {
    return [...this.slots.entries()].filter(([, slot]) => !slot.dead).map(([id]) => id);
  }

  /** Headless `agy` has no permission callback. Soft denies arrive on stderr. */
  answerPermission(_requestId: string, _answer: unknown): boolean {
    return false;
  }

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

  cancel(sessionId: string): void {
    if (this.starting.has(sessionId)) this.stoppedWhileStarting.add(sessionId);
    const slot = this.slots.get(sessionId);
    if (!slot || slot.dead) return;
    slot.dead = true;
    this.kill(slot.child);
    slot.disposeMcp?.();
    this.finishTurn(slot, { text: slot.turn?.text ?? "", stopReason: "cancelled", vendorSessionId: slot.conversationId, opened: slot.opened });
  }

  dispose(sessionId: string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    slot.dead = true;
    try {
      slot.child.stdin?.end?.();
    } catch {
      /* already closed */
    }
    this.kill(slot.child);
    slot.disposeMcp?.();
    this.slots.delete(sessionId);
  }

  disposeAll(): void {
    for (const id of [...this.slots.keys()]) this.dispose(id);
  }

  private async promptUnlocked(input: GrokPromptInput, emit: GrokEventSink): Promise<GrokPromptResult> {
    this.stoppedWhileStarting.delete(input.sessionId);
    const slot = await this.ensure(input, emit);
    if (this.stoppedWhileStarting.delete(input.sessionId)) {
      return stoppedBeforePrompt(input.sessionId, { sessionId: slot.conversationId ?? "", opened: slot.opened }, emit);
    }
    const text = composeVendorPrompt(
      `${imageNote(input.images)}${input.text}`,
      input.preface,
      slot.opened,
      {
        mode: input.mode,
        sandbox: input.sandbox,
        role: input.role ?? (input.parentId || input.hidden ? "worker" : "orchestrator"),
        crewMode: input.crewModes,
        spawnNames: input.spawnNames,
      },
      input.visibleText,
    );
    try {
      const result = await this.sendTurn(slot, input, text, emit);
      emit({ type: "done", sessionId: input.sessionId, stopReason: result.stopReason });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", sessionId: input.sessionId, message });
      throw error;
    } finally {
      if (isWorkerRuntime(input)) this.dispose(input.sessionId);
    }
  }

  private async ensure(input: GrokPromptInput, emit: GrokEventSink): Promise<Slot> {
    const key = launchKey(input);
    const existing = this.slots.get(input.sessionId);
    if (existing && !existing.dead && existing.key === key) return existing;
    if (existing) this.dispose(input.sessionId);
    const command = this.binary || resolveAgyBinary() || "agy";
    const overlay = createAgyMcpOverlay(input, this.builtInMcp(input.sessionId));
    let child: AgyChild;
    try {
      const spec = buildAgyLaunchSpec({
        model: input.model,
        effort: input.effort,
        cwd: input.cwd,
        mode: input.mode,
        sandbox: input.sandbox,
        conversationId: input.vendorSessionId,
        command,
        mcpOverlay: overlay?.folder,
      });
      child = this.spawn(spec.command, spec.argv, { cwd: spec.cwd, env: { ...deskToolEnv(), ...overlay?.env } });
    } catch (error) {
      overlay?.dispose();
      throw error;
    }
    const slot: Slot = {
      key,
      child,
      opened: input.vendorSessionId?.trim() ? "session/load" : "session/new",
      conversationId: input.vendorSessionId?.trim() || undefined,
      announced: false,
      buffer: "",
      stderr: "",
      dead: false,
      disposeMcp: overlay?.dispose,
    };
    this.slots.set(input.sessionId, slot);
    this.starting.add(input.sessionId);
    child.stdout?.on("data", (chunk) => {
      if (this.slots.get(input.sessionId) === slot) this.onStdout(input.sessionId, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      const live = this.slots.get(input.sessionId);
      if (live !== slot || live.dead) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      live.stderr = `${live.stderr}${text}`.slice(-STDERR_CAP);
    });
    child.on("error", (error) => {
      const live = this.slots.get(input.sessionId);
      if (!live || live !== slot || live.dead) return;
      live.dead = true;
      live.disposeMcp?.();
      this.failTurn(live, error.message || "Gemini agent failed to start");
    });
    child.on("exit", () => {
      const live = this.slots.get(input.sessionId);
      if (!live || live !== slot || live.dead) return;
      live.dead = true;
      live.disposeMcp?.();
      if (!live.turn) return;
      if (live.turn.text && live.turn.settled) return;
      const tail = live.stderr.trim().slice(-400);
      this.failTurn(live, tail || "Gemini agent stopped before the turn finished");
    });
    this.starting.delete(input.sessionId);
    if (agySkipsPermissions(input.mode)) {
      emit({
        type: "tool",
        sessionId: input.sessionId,
        toolCallId: "agy-skip-permissions",
        title: "permissions",
        status: "completed",
        detail: "This chat is always-approve, so agy is started with --dangerously-skip-permissions.",
      });
    }
    if (slot.conversationId && !slot.announced) {
      slot.announced = true;
      emit({ type: "vendor-session", sessionId: input.sessionId, vendorSessionId: slot.conversationId, opened: slot.opened });
    }
    return slot;
  }

  private sendTurn(slot: Slot, input: GrokPromptInput, text: string, emit: GrokEventSink): Promise<GrokPromptResult> {
    return new Promise((resolve, reject) => {
      slot.turn = { sessionId: input.sessionId, model: input.model, projectId: input.projectId, emit, streamed: new Set(), text: "", settled: false, resolve, reject };
      const line = `${JSON.stringify({ event: "user", message: { content: text } })}\n`;
      try {
        slot.child.stdin?.write(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.failTurn(slot, message);
      }
    });
  }

  private onStdout(sessionId: string, chunk: Buffer | string): void {
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    slot.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = slot.buffer.split(/\r?\n/);
    slot.buffer = lines.pop() ?? "";
    for (const line of lines) this.onLine(slot, line);
  }

  private onLine(slot: Slot, line: string): void {
    const event = parseAgyStreamLine(line);
    if (event.kind === "init" || (event.kind === "result" && event.conversationId)) {
      const id = event.kind === "init" ? event.conversationId : event.conversationId;
      if (id) slot.conversationId = id;
      if (slot.conversationId && !slot.announced && slot.turn) {
        slot.announced = true;
        slot.turn.emit({
          type: "vendor-session",
          sessionId: slot.turn.sessionId,
          vendorSessionId: slot.conversationId,
          opened: slot.opened,
        });
      }
    }
    const turn = slot.turn;
    if (!turn || turn.settled) return;
    if (event.kind === "text") {
      if (event.state === "ACTIVE") {
        turn.streamed.add(event.step);
        turn.text += event.delta;
        turn.emit({ type: "chunk", sessionId: turn.sessionId, text: event.delta });
      } else if (!turn.streamed.has(event.step)) {
        turn.text += event.delta;
        turn.emit({ type: "chunk", sessionId: turn.sessionId, text: event.delta });
      }
      return;
    }
    if (event.kind === "tool") {
      const tool: GrokToolEvent = {
        toolCallId: `agy-${event.step}`,
        title: event.name,
        status: event.failed ? "failed" : event.state === "DONE" ? "completed" : "running",
        detail: event.detail,
      };
      turn.emit({ type: "tool", sessionId: turn.sessionId, ...tool });
      return;
    }
    if (event.kind !== "result") return;
    const notice = permissionNotice(slot.stderr);
    const response = event.response.trim() || turn.text.trim();
    const text = notice && !response.includes(notice) ? `${response}${response ? "\n\n" : ""}${notice}`.trim() : response;
    if (event.usage) {
      const delta = deltaAgyUsage(slot.usage, event.usage);
      slot.usage = event.usage;
      if (delta.inputTokens || delta.outputTokens || delta.cacheReadTokens) {
        turn.emit({
          type: "usage",
          sessionId: turn.sessionId,
          model: turn.model,
          projectId: turn.projectId,
          provider: "gemini",
          source: "turn",
          ...delta,
        });
      }
    }
    if (event.status === "SUCCESS") {
      this.finishTurn(slot, { text, stopReason: "end_turn", vendorSessionId: slot.conversationId, opened: slot.opened });
      return;
    }
    if (event.status === "CANCELED" || event.status === "INTERRUPTED" || event.error === "interrupted") {
      this.finishTurn(slot, { text, stopReason: "cancelled", vendorSessionId: slot.conversationId, opened: slot.opened });
      return;
    }
    this.failTurn(slot, event.error || text || `Gemini agent status ${event.status}`);
  }

  private finishTurn(slot: Slot, result: GrokPromptResult): void {
    const turn = slot.turn;
    if (!turn || turn.settled) return;
    turn.settled = true;
    slot.turn = undefined;
    turn.resolve(result);
  }

  private failTurn(slot: Slot, message: string): void {
    const turn = slot.turn;
    if (!turn || turn.settled) return;
    turn.settled = true;
    slot.turn = undefined;
    turn.reject(new Error(message));
  }
}



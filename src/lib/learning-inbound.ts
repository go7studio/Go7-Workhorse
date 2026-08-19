import { learningEvidenceId } from "./learning-agent-evidence";
import { LEARNING_DIR_NAME, LEARNING_INBOUND_FILE, type LearningEvent } from "./learning-types";
import { LINK_MUTATING_TOOLS } from "./workhorse-link";
import { boundText } from "./learning-redact";

export const INBOUND_SURFACE = "workhorse-link";

const KEEP_ARGS = new Set([
  "fromSessionId",
  "traceId",
  "idempotencyKey",
  "origin",
  "hopCount",
  "visitedSystems",
  "route",
  "wait",
  "loop",
  "chat",
  "sessionId",
  "provider",
  "model",
  "effort",
  "workerId",
  "workerIds",
  "agentId",
  "callable",
  "callableOnly",
  "pass",
  "previousPass",
  "previousWorkerIds",
  "exclude",
  "constraints",
  "capabilities",
  "skills",
  "tools",
  "planStepId",
  "supplied",
]);

const BOUND_ARGS = new Set(["task", "description", "message", "prompt", "remainingWork", "evidence", "rationale", "handoff"]);

const DROP_KEY = /key|token|secret|password|passwd|authorization|credential|bearer/i;
const DROP_PATH = /^(folder|path|cwd|files|attachments|images|content|transcript|messages|apiKey|api_key)$/i;

const ERROR_CODES = [
  "profile_forbidden",
  "context_required",
  "cycle_rejected",
  "hop_limit",
  "grant_required",
  "duplicate_task",
  "not_callable",
  "unknown_runtime",
] as const;

const EXTRA_MUTATING = ["workhorse_spawn_agent", "workhorse_cancel_agent"] as const;

export type InboundLearningDraft = Omit<
  LearningEvent,
  "sourceHash" | "redactionVersion" | "sensitivity" | "schemaVersion" | "localDay" | "payload"
> & {
  payload: Record<string, unknown>;
};

export type InboundCallObservation = {
  tool: string;
  args?: Record<string, unknown>;
  fromSessionId?: string;
  ok: boolean;
  resultText?: string;
  errorDetail?: string;
  rpcId?: string | number;
  now?: number;
};

export type InboundFileIo = {
  mkdirSync: (dir: string, opts: { recursive: true }) => unknown;
  appendFileSync: (file: string, data: string, encoding: "utf8") => void;
  renameSync: (from: string, to: string) => void;
  readFileSync: (file: string, encoding: "utf8") => string;
  unlinkSync: (file: string) => void;
};

export function shouldCaptureInboundProfile(profile: string): boolean {
  return profile === "external-runtime";
}

export function isInboundMutatingTool(tool: string): boolean {
  return (LINK_MUTATING_TOOLS as readonly string[]).includes(tool) || (EXTRA_MUTATING as readonly string[]).includes(tool);
}

export function inboundCallStatus(errorDetail?: string): "ok" | "error" | "forbidden" {
  if (!errorDetail) return "ok";
  if (/profile_forbidden/.test(errorDetail)) return "forbidden";
  return "error";
}

export function inboundErrorCode(detail: string): string | undefined {
  return ERROR_CODES.find((code) => detail.includes(code));
}

export function inboundJsonlFromStatePath(statePath: string): string | undefined {
  const trimmed = statePath.trim();
  if (!trimmed) return undefined;
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = slash < 0 ? trimmed : trimmed.slice(slash + 1);
  if (base !== "workhorse-state.json") return undefined;
  const dir = slash < 0 ? "." : trimmed.slice(0, slash);
  const sep = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  return `${dir}${sep}${LEARNING_DIR_NAME}${sep}${LEARNING_INBOUND_FILE}`;
}

function asTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

function sanitizeValue(value: unknown, bound: boolean, depth: number): unknown {
  if (depth > 4) return undefined;
  if (typeof value === "string") return boundText(value, bound ? 240 : 80);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, bound, depth + 1)).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") return sanitizeRecord(value as Record<string, unknown>, depth + 1);
  return undefined;
}

export function sanitizeInboundArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return sanitizeRecord(args ?? {}, 0);
}

function sanitizeRecord(args: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (DROP_KEY.test(key) || DROP_PATH.test(key)) continue;
    if (key === "initialBrain" && value && typeof value === "object" && !Array.isArray(value)) {
      const brain = value as Record<string, unknown>;
      const slim: Record<string, unknown> = {};
      for (const field of ["provider", "model", "effort"] as const) {
        if (typeof brain[field] === "string" && brain[field].trim()) slim[field] = brain[field].trim();
      }
      if (Object.keys(slim).length) out.initialBrain = slim;
      continue;
    }
    if (KEEP_ARGS.has(key)) {
      const next = sanitizeValue(value, false, depth + 1);
      if (next !== undefined) out[key] = next;
      continue;
    }
    if (BOUND_ARGS.has(key) && typeof value === "string") {
      out[key] = boundText(value, 240);
    }
  }
  if (out.origin !== "openclaw" && out.origin !== "hermes" && out.origin !== "workhorse") delete out.origin;
  return out;
}

function resultBits(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const rec = parsed as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of ["worker", "workerId", "status", "desk"] as const) {
      const value = rec[key];
      if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function inboundLearningDraft(input: InboundCallObservation): InboundLearningDraft {
  const tool = input.tool.trim() || "unknown";
  const args = sanitizeInboundArgs(input.args);
  const fromSessionId = asTrimmed(args.fromSessionId) ?? asTrimmed(input.fromSessionId);
  const traceId = asTrimmed(args.traceId);
  const idempotencyKey = asTrimmed(args.idempotencyKey);
  const status = inboundCallStatus(input.ok ? undefined : input.errorDetail);
  const error = input.errorDetail ? inboundErrorCode(input.errorDetail) ?? boundText(input.errorDetail, 120) : undefined;
  const mutating = isInboundMutatingTool(tool);
  const createdAt = input.now ?? Date.now();
  const id = learningEvidenceId(
    "link",
    tool,
    mutating ? idempotencyKey || traceId : undefined,
    mutating ? undefined : String(input.rpcId ?? createdAt),
  );
  const summary =
    status === "forbidden"
      ? `Harness called ${tool}; refused profile_forbidden`
      : status === "error"
        ? `Harness called ${tool}; error ${error ?? "failed"}`
        : `Harness called ${tool}`;
  return {
    id,
    createdAt,
    kind: "tool",
    actorClass: "agent",
    sessionId: fromSessionId,
    correlationId: traceId,
    toolIds: [tool],
    payload: {
      surface: INBOUND_SURFACE,
      tool,
      status,
      summary,
      mutating,
      ...(error ? { error } : {}),
      ...(fromSessionId ? { fromSessionId } : {}),
      ...(typeof args.hopCount === "number" ? { hopCount: args.hopCount } : {}),
      ...(Array.isArray(args.visitedSystems) ? { visitedSystems: args.visitedSystems } : {}),
      ...(asTrimmed(args.origin) ? { origin: args.origin } : {}),
      args,
      ...resultBits(input.resultText),
    },
  };
}

function dirnameOf(file: string): string {
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return slash <= 0 ? "." : file.slice(0, slash);
}

export function appendInboundJsonl(file: string, draft: object, io: InboundFileIo): void {
  io.mkdirSync(dirnameOf(file), { recursive: true });
  io.appendFileSync(file, `${JSON.stringify(draft)}\n`, "utf8");
}

export function drainInboundJsonl(file: string, io: InboundFileIo): unknown[] {
  const drainTo = `${file}.drain`;
  try {
    io.renameSync(file, drainTo);
  } catch {
    return [];
  }
  let text = "";
  try {
    text = io.readFileSync(drainTo, "utf8");
  } catch {
    text = "";
  }
  try {
    io.unlinkSync(drainTo);
  } catch {
    /* already gone */
  }
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* skip a broken line */
    }
  }
  return rows;
}

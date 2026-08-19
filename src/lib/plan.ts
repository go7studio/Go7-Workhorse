import type {
  AgentGrant,
  PlanConstraints,
  PlanAssignment,
  PlanEvent,
  PlanEvidence,
  PlanEvidenceKind,
  PlanRun,
  PlanRunStatus,
  PlanSource,
  PlanStep,
  PlanStepStatus,
  EffortLevel,
} from "./types";
import { isProviderId } from "./providers";
import { createWaveGrant } from "./agent-runtime";

export type PlanTransition = { ok: true; plan: PlanRun } | { ok: false; error: string };

export type PlanStepPatch = Partial<
  Pick<PlanStep, "title" | "details" | "dependsOn" | "evidenceRequired" | "assignedSessionId">
>;

export type PlanAssignmentInput = Omit<PlanAssignment, "assignedAt"> & { assignedAt?: number };

export type MarkdownPlanInput = {
  markdown: string;
  label?: string;
  path?: string;
  now?: number;
  id?: string;
  constraints?: PlanConstraints;
};

const RUN_STATUSES: PlanRunStatus[] = [
  "draft",
  "approved",
  "running",
  "paused",
  "completed",
  "blocked",
  "cancelled",
];

const STEP_STATUSES: PlanStepStatus[] = [
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
];

const EVIDENCE_KINDS: PlanEvidenceKind[] = ["note", "file", "test", "screenshot", "runtime"];

const STEP_TRANSITIONS: Record<PlanStepStatus, PlanStepStatus[]> = {
  pending: ["ready", "blocked", "cancelled"],
  ready: ["running", "blocked", "cancelled"],
  running: ["completed", "failed", "blocked", "cancelled"],
  completed: [],
  failed: ["ready", "cancelled"],
  blocked: ["ready", "cancelled"],
  cancelled: ["ready"],
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = finite(value);
  return number !== undefined && number > 0 ? Math.floor(number) : undefined;
}

function uniqueStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(clean).filter(Boolean))];
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44) || "step";
}

/** Small browser-safe content fingerprint. The algorithm is named so it is never mistaken for a security signature. */
export function hashPlanSource(markdown: string): string {
  const bytes = new TextEncoder().encode(markdown.replace(/\r\n?/g, "\n"));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function markdownObjective(markdown: string, fallback: string): string {
  const goal = markdown.match(/^\s*\*\*Goal:\*\*\s*(.+?)\s*$/im)?.[1]?.trim();
  if (goal) return goal;
  const heading = markdown.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
  return heading || fallback || "Imported plan";
}

function taskHeadingSteps(markdown: string): PlanStep[] {
  const matches = [...markdown.matchAll(/^\s*#{2,6}\s+Task\s+(\d+)(?:\s*[:.)-]\s*|\s+)(.+?)\s*$/gim)];
  return matches.map((match, index) => {
    const number = match[1] ?? String(index + 1);
    const title = clean(match[2]) || `Task ${number}`;
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    const details = markdown.slice(start, end).replace(/^\s*---\s*$/gm, "").trim();
    return {
      id: `step_${number}_${slug(title)}`,
      title: `Task ${number}: ${title}`,
      ...(details ? { details } : {}),
      status: "pending",
      dependsOn: [],
      evidenceRequired: true,
      evidence: [],
    };
  });
}

function checkboxSteps(markdown: string): PlanStep[] {
  const matches = [...markdown.matchAll(/^\s*-\s+\[([ xX])\]\s+(.+?)\s*$/gm)];
  return matches.map((match, index) => {
    const title = clean(match[2]) || `Step ${index + 1}`;
    return {
      id: `step_${index + 1}_${slug(title)}`,
      title,
      status: "pending",
      dependsOn: [],
      evidenceRequired: true,
      evidence: [],
    };
  });
}

/** Import a Markdown plan without executing it or trusting checked boxes as runtime evidence. */
export function parseMarkdownPlan(input: MarkdownPlanInput): PlanRun {
  const markdown = input.markdown.replace(/\r\n?/g, "\n");
  const now = input.now ?? Date.now();
  const hash = hashPlanSource(markdown);
  const steps = taskHeadingSteps(markdown);
  const parsedSteps = steps.length > 0 ? steps : checkboxSteps(markdown);
  const label = clean(input.label) || clean(input.path).split(/[\\/]/).pop() || "Imported plan";
  const source: PlanSource = {
    kind: "markdown",
    label,
    ...(clean(input.path) ? { path: clean(input.path) } : {}),
    contentHash: hash,
    importedAt: now,
  };
  const constraints = normalizeConstraints(input.constraints);
  const gate = parsePlanGate(markdown);
  return {
    id: clean(input.id) || `plan_${now.toString(36)}_${hash.slice(-8)}`,
    objective: markdownObjective(markdown, label),
    status: "draft",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    source,
    ...(constraints ? { constraints } : {}),
    ...(gate ? { gate } : {}),
    steps:
      parsedSteps.length > 0
        ? parsedSteps
        : [{
            id: "step_1_execute-plan",
            title: "Execute imported plan",
            ...(markdown.trim() ? { details: markdown.trim() } : {}),
            status: "pending",
            dependsOn: [],
            evidenceRequired: true,
            evidence: [],
          }],
    events: [{ id: `event_${now}_imported`, at: now, type: "plan.imported", detail: hash }],
  };
}

function normalizeAssignment(raw: unknown): PlanAssignment | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Partial<PlanAssignment>;
  const provider = isProviderId(record.provider) ? record.provider : undefined;
  if (!provider || !clean(record.sessionId) || !clean(record.model) || !clean(record.rationale)) return undefined;
  return {
    sessionId: clean(record.sessionId),
    assignedAt: finite(record.assignedAt) ?? 0,
    provider,
    model: clean(record.model),
    ...(["off", "adaptive", "low", "medium", "high", "xhigh"] as EffortLevel[]).includes(record.effort as EffortLevel)
      ? { effort: record.effort as EffortLevel }
      : {},
    ...(clean(record.customBotId) ? { customBotId: clean(record.customBotId) } : {}),
    rationale: clean(record.rationale),
    skills: uniqueStrings(record.skills),
    tools: uniqueStrings(record.tools),
    constraints: uniqueStrings(record.constraints),
    ...(clean(record.requested) ? { requested: clean(record.requested) } : {}),
  };
}

function normalizeEvent(raw: unknown): PlanEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<PlanEvent>;
  if (!clean(record.id) || !clean(record.type)) return null;
  return {
    id: clean(record.id),
    at: finite(record.at) ?? 0,
    type: clean(record.type),
    ...(clean(record.stepId) ? { stepId: clean(record.stepId) } : {}),
    ...(clean(record.sessionId) ? { sessionId: clean(record.sessionId) } : {}),
    ...(clean(record.correlationId) ? { correlationId: clean(record.correlationId) } : {}),
    ...(clean(record.detail) ? { detail: clean(record.detail) } : {}),
  };
}

function normalizeEvidence(raw: unknown): PlanEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<PlanEvidence>;
  const id = clean(record.id);
  const label = clean(record.label);
  const value = clean(record.value);
  if (!id || !label || !value) return null;
  const kind = EVIDENCE_KINDS.includes(record.kind as PlanEvidenceKind)
    ? (record.kind as PlanEvidenceKind)
    : "note";
  const head = clean(record.head).toLowerCase();
  const lastLine = typeof record.lastLine === "string" ? record.lastLine.trim() : "";
  return {
    id,
    kind,
    label,
    value,
    recordedAt: finite(record.recordedAt) ?? 0,
    ...(clean(record.sessionId) ? { sessionId: clean(record.sessionId) } : {}),
    ...(GIT_HEAD.test(head) ? { head } : {}),
    ...(clean(record.gate) ? { gate: clean(record.gate) } : {}),
    ...(lastLine ? { lastLine } : {}),
    ...(record.role === "auditor" ? { role: "auditor" as const } : {}),
    ...(record.status === "pass" || record.status === "fail" ? { status: record.status } : {}),
  };
}

const GIT_HEAD = /^[0-9a-f]{40}$/;

/** Named gate from plan markdown (`Named test gate: \`npm test\``). */
export function parsePlanGate(markdown: string): string | undefined {
  const named = markdown.match(/named test gate[^\n`]*`([^`]+)`/i);
  if (named?.[1]?.trim()) return named[1].trim();
  const line = markdown.match(/^\s*(?:named test gate|gate)\s*[:.—-]\s*`?(.+?)`?\s*$/im);
  const value = line?.[1]?.trim();
  return value || undefined;
}

export type AuditorReport = {
  head: string;
  gate: string;
  lastLine: string;
  status: "pass" | "fail";
};

/** Parse the auditor’s required four-line receipt. */
export function parseAuditorReport(text: string): AuditorReport | undefined {
  const body = text.replace(/\r\n/g, "\n");
  const head = body.match(/^\s*HEAD:\s*([0-9a-f]{40})\s*$/im)?.[1]?.toLowerCase();
  const gate = body.match(/^\s*GATE:\s*(.+?)\s*$/im)?.[1]?.trim();
  const lastLine = body.match(/^\s*LAST:\s*(.+?)\s*$/im)?.[1]?.trim();
  const statusRaw = body.match(/^\s*STATUS:\s*(pass|fail)\s*$/im)?.[1]?.toLowerCase();
  if (!head || !GIT_HEAD.test(head) || !gate || !lastLine || (statusRaw !== "pass" && statusRaw !== "fail")) {
    return undefined;
  }
  return { head, gate, lastLine, status: statusRaw };
}

export function isAuditorGateEvidence(
  evidence: PlanEvidence,
  builderSessionId?: string,
): boolean {
  if (evidence.role !== "auditor") return false;
  if (!GIT_HEAD.test((evidence.head ?? "").toLowerCase())) return false;
  if (!clean(evidence.gate) || !(evidence.lastLine ?? "").trim()) return false;
  if (!clean(evidence.sessionId)) return false;
  if (builderSessionId && evidence.sessionId === builderSessionId) return false;
  return evidence.status === "pass";
}

export function stepHasAuditorAdmission(step: PlanStep): boolean {
  const list = step.reopenedAt === undefined
    ? step.evidence
    : step.evidence.filter((item) => item.recordedAt >= step.reopenedAt!);
  return list.some((item) => isAuditorGateEvidence(item, step.assignedSessionId));
}

/** Auditor receipt is required only when a builder was assigned this step. */
export function stepNeedsAuditorAdmission(step: PlanStep): boolean {
  return step.evidenceRequired && Boolean(step.assignedSessionId);
}

function normalizeStep(raw: unknown): PlanStep | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<PlanStep>;
  const id = clean(record.id);
  const title = clean(record.title);
  if (!id || !title) return null;
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.map(normalizeEvidence).filter((item): item is PlanEvidence => item !== null)
    : [];
  return {
    id,
    title,
    ...(clean(record.details) ? { details: clean(record.details) } : {}),
    status: STEP_STATUSES.includes(record.status as PlanStepStatus)
      ? (record.status as PlanStepStatus)
      : "pending",
    dependsOn: uniqueStrings(record.dependsOn).filter((item) => item !== id),
    evidenceRequired: record.evidenceRequired !== false,
    evidence,
    ...(clean(record.assignedSessionId) ? { assignedSessionId: clean(record.assignedSessionId) } : {}),
    ...(normalizeAssignment(record.assignment) ? { assignment: normalizeAssignment(record.assignment) } : {}),
    ...(finite(record.startedAt) !== undefined ? { startedAt: finite(record.startedAt) } : {}),
    ...(finite(record.finishedAt) !== undefined ? { finishedAt: finite(record.finishedAt) } : {}),
    ...(finite(record.reopenedAt) !== undefined ? { reopenedAt: finite(record.reopenedAt) } : {}),
    ...(clean(record.error) ? { error: clean(record.error) } : {}),
  };
}

function normalizeSource(raw: unknown): PlanSource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Partial<PlanSource>;
  const kind = record.kind === "markdown" || record.kind === "generated" || record.kind === "manual"
    ? record.kind
    : undefined;
  if (!kind) return undefined;
  return {
    kind,
    ...(clean(record.label) ? { label: clean(record.label) } : {}),
    ...(clean(record.path) ? { path: clean(record.path) } : {}),
    ...(clean(record.contentHash) ? { contentHash: clean(record.contentHash) } : {}),
    ...(finite(record.importedAt) !== undefined ? { importedAt: finite(record.importedAt) } : {}),
  };
}

function normalizeConstraints(raw: unknown): PlanConstraints | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Partial<PlanConstraints>;
  const tokenBudget = positiveInteger(record.tokenBudget);
  const timeoutMs = positiveInteger(record.timeoutMs);
  const maxConcurrency = positiveInteger(record.maxConcurrency);
  if (!tokenBudget && !timeoutMs && !maxConcurrency) return undefined;
  return {
    ...(tokenBudget ? { tokenBudget } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(maxConcurrency ? { maxConcurrency: Math.min(8, maxConcurrency) } : {}),
  };
}

export function normalizePlanRun(raw: unknown): PlanRun | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Partial<PlanRun>;
  const id = clean(record.id);
  const objective = clean(record.objective);
  if (!id || !objective) return undefined;
  const seen = new Set<string>();
  const steps = (Array.isArray(record.steps) ? record.steps : [])
    .map(normalizeStep)
    .filter((item): item is PlanStep => {
      if (!item || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  const ids = new Set(steps.map((step) => step.id));
  const normalizedSteps = steps.map((step) => ({
    ...step,
    dependsOn: step.dependsOn.filter((dependency) => ids.has(dependency)),
  }));
  const createdAt = finite(record.createdAt) ?? 0;
  const source = normalizeSource(record.source);
  const constraints = normalizeConstraints(record.constraints);
  const events = (Array.isArray(record.events) ? record.events : [])
    .map(normalizeEvent)
    .filter((item): item is PlanEvent => item !== null);
  return {
    id,
    objective,
    status: RUN_STATUSES.includes(record.status as PlanRunStatus)
      ? (record.status as PlanRunStatus)
      : "draft",
    revision: positiveInteger(record.revision) ?? 1,
    createdAt,
    updatedAt: finite(record.updatedAt) ?? createdAt,
    ...(source ? { source } : {}),
    ...(constraints ? { constraints } : {}),
    ...(clean(record.gate) ? { gate: clean(record.gate) } : {}),
    steps: normalizedSteps,
    events,
    ...(finite(record.approvedAt) !== undefined ? { approvedAt: finite(record.approvedAt) } : {}),
    ...(finite(record.startedAt) !== undefined ? { startedAt: finite(record.startedAt) } : {}),
    ...(finite(record.pausedAt) !== undefined ? { pausedAt: finite(record.pausedAt) } : {}),
    ...(finite(record.completedAt) !== undefined ? { completedAt: finite(record.completedAt) } : {}),
    ...(clean(record.blockedReason) ? { blockedReason: clean(record.blockedReason) } : {}),
    ...(normalizeGrant(record.externalGrant) ? { externalGrant: normalizeGrant(record.externalGrant) } : {}),
  };
}

function normalizeGrant(raw: unknown): AgentGrant | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Partial<AgentGrant>;
  const id = clean(record.id);
  const waveId = clean(record.waveId);
  if (!id || !waveId) return undefined;
  return {
    id,
    waveId,
    createdAt: finite(record.createdAt) ?? 0,
    ...(record.runtimeId === "openclaw" || record.runtimeId === "hermes" ? { runtimeId: record.runtimeId } : {}),
    ...(clean(record.agentId) ? { agentId: clean(record.agentId) } : {}),
    ...(finite(record.consumedAt) !== undefined ? { consumedAt: finite(record.consumedAt) } : {}),
  };
}

export function grantExternalAgents(plan: PlanRun, now = Date.now()): PlanRun {
  return {
    ...plan,
    updatedAt: now,
    externalGrant: createWaveGrant({ waveId: plan.id, now, id: `grant_${plan.id}` }),
  };
}

export function revokeExternalAgents(plan: PlanRun, now = Date.now()): PlanRun {
  const { externalGrant: _drop, ...rest } = plan;
  return { ...rest, updatedAt: now };
}

function appendEvent(plan: PlanRun, event: Omit<PlanEvent, "id" | "at"> & { id?: string; at?: number }): PlanRun {
  const at = event.at ?? Date.now();
  return {
    ...plan,
    events: [
      ...(plan.events ?? []),
      { ...event, id: event.id ?? `event_${at}_${(plan.events?.length ?? 0) + 1}`, at },
    ],
  };
}

export function assignPlanStep(
  plan: PlanRun,
  stepId: string,
  assignment: PlanAssignmentInput,
  now = Date.now(),
): PlanTransition {
  if (plan.status !== "running") return failed("Agents can be assigned only while the plan is running.");
  const index = plan.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return failed(`No plan step matches ${stepId}.`);
  const step = plan.steps[index]!;
  if (step.status !== "ready") return failed("Only a ready step can be assigned.");
  const normalized = normalizeAssignment({ ...assignment, assignedAt: assignment.assignedAt ?? now });
  if (!normalized) return failed("An assignment needs a session, provider, model, and rationale.");
  const steps = plan.steps.map((item, offset) => offset === index
    ? { ...item, assignedSessionId: normalized.sessionId, assignment: normalized }
    : item);
  const next = changed(plan, { steps }, now);
  return succeeded(appendEvent(next, {
    at: now,
    type: "agent.assigned",
    stepId,
    sessionId: normalized.sessionId,
    detail: `${normalized.provider}:${normalized.model} · ${normalized.rationale}`,
  }));
}

export function recordPlanEvent(
  plan: PlanRun,
  event: Omit<PlanEvent, "id" | "at"> & { id?: string; at?: number },
  now = Date.now(),
): PlanTransition {
  const next = appendEvent(changed(plan, {}, now), { ...event, at: event.at ?? now });
  return succeeded(next);
}

function changed(plan: PlanRun, patch: Partial<PlanRun>, now: number): PlanRun {
  return { ...plan, ...patch, revision: plan.revision + 1, updatedAt: now };
}

function failed(error: string): PlanTransition {
  return { ok: false, error };
}

function succeeded(plan: PlanRun): PlanTransition {
  return { ok: true, plan };
}

function hasDependencyCycle(steps: PlanStep[]): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const active = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) return true;
    if (done.has(id)) return false;
    active.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (visit(dependency)) return true;
    }
    active.delete(id);
    done.add(id);
    return false;
  };
  return steps.some((step) => visit(step.id));
}

function dependenciesComplete(step: PlanStep, steps: PlanStep[]): boolean {
  const byId = new Map(steps.map((item) => [item.id, item]));
  return step.dependsOn.every((id) => byId.get(id)?.status === "completed");
}

function promoteReadySteps(steps: PlanStep[]): PlanStep[] {
  return steps.map((step) =>
    step.status === "pending" && dependenciesComplete(step, steps) ? { ...step, status: "ready" as const } : step,
  );
}

export function readyPlanStepIds(plan: PlanRun): string[] {
  return plan.steps
    .filter((step) => (step.status === "pending" || step.status === "ready") && dependenciesComplete(step, plan.steps))
    .map((step) => step.id);
}

export function approvePlanRun(plan: PlanRun, now = Date.now()): PlanTransition {
  if (plan.status !== "draft") return failed("Only a draft plan can be approved.");
  if (plan.steps.length === 0) return failed("A plan needs at least one step.");
  if (hasDependencyCycle(plan.steps)) return failed("Plan dependencies contain a cycle.");
  return succeeded(changed(plan, { status: "approved", approvedAt: now }, now));
}

export function startPlanRun(plan: PlanRun, now = Date.now()): PlanTransition {
  if (plan.status !== "approved") return failed("Only an approved plan can start.");
  return succeeded(changed(plan, { status: "running", startedAt: plan.startedAt ?? now, steps: promoteReadySteps(plan.steps) }, now));
}

export function pausePlanRun(plan: PlanRun, now = Date.now()): PlanTransition {
  if (plan.status !== "running") return failed("Only a running plan can pause.");
  return succeeded(changed(plan, { status: "paused", pausedAt: now }, now));
}

export function resumePlanRun(plan: PlanRun, now = Date.now()): PlanTransition {
  if (plan.status !== "paused") return failed("Only a paused plan can resume.");
  return succeeded(changed(plan, { status: "running", pausedAt: undefined, steps: promoteReadySteps(plan.steps) }, now));
}

export function revisePlanStep(plan: PlanRun, stepId: string, patch: PlanStepPatch, now = Date.now()): PlanTransition {
  if (plan.status === "completed" || plan.status === "cancelled") return failed("A terminal plan cannot be revised.");
  const index = plan.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return failed(`No plan step matches ${stepId}.`);
  const current = plan.steps[index]!;
  if (current.status === "running" || current.status === "completed") return failed("A running or completed step cannot be revised.");
  const title = patch.title === undefined ? current.title : clean(patch.title);
  if (!title) return failed("A plan step needs a title.");
  const ids = new Set(plan.steps.map((step) => step.id));
  const dependsOn = patch.dependsOn === undefined
    ? current.dependsOn
    : [...new Set(patch.dependsOn.map(clean).filter((id) => id && id !== stepId && ids.has(id)))];
  const nextStep: PlanStep = {
    ...current,
    title,
    ...(patch.details === undefined
      ? {}
      : clean(patch.details)
        ? { details: clean(patch.details) }
        : { details: undefined }),
    dependsOn,
    evidenceRequired: patch.evidenceRequired ?? current.evidenceRequired,
    ...(patch.assignedSessionId === undefined
      ? {}
      : clean(patch.assignedSessionId)
        ? { assignedSessionId: clean(patch.assignedSessionId) }
        : { assignedSessionId: undefined }),
  };
  const steps = plan.steps.map((step, offset) => (offset === index ? nextStep : step));
  if (hasDependencyCycle(steps)) return failed("Plan dependencies contain a cycle.");
  return succeeded(changed(plan, { steps }, now));
}

function dependsOnStep(step: PlanStep, targetId: string, byId: Map<string, PlanStep>, seen = new Set<string>()): boolean {
  if (seen.has(step.id)) return false;
  seen.add(step.id);
  return step.dependsOn.some((dependencyId) => {
    if (dependencyId === targetId) return true;
    const dependency = byId.get(dependencyId);
    return dependency ? dependsOnStep(dependency, targetId, byId, new Set(seen)) : false;
  });
}

/** Reopen verified work when later evidence invalidates it, preserving the prior audit trail. */
export function reopenPlanStep(plan: PlanRun, stepId: string, reason: string, now = Date.now()): PlanTransition {
  if (plan.status === "draft" || plan.status === "approved" || plan.status === "cancelled") {
    return failed("Only an active, blocked, or completed plan can reopen work.");
  }
  const target = plan.steps.find((step) => step.id === stepId);
  if (!target) return failed(`No plan step matches ${stepId}.`);
  if (target.status !== "completed") return failed("Only a completed step can be reopened.");
  const reopenReason = clean(reason);
  if (!reopenReason) return failed("Reopening a completed step needs a reason.");
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const affected = new Set([stepId]);
  for (const step of plan.steps) {
    if (dependsOnStep(step, stepId, byId)) affected.add(step.id);
  }
  if (plan.steps.some((step) => affected.has(step.id) && step.status === "running")) {
    return failed("Stop running dependent work before reopening this step.");
  }
  const reset = (step: PlanStep, status: PlanStepStatus): PlanStep => ({
    ...step,
    status,
    assignedSessionId: undefined,
    assignment: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    reopenedAt: now,
    error: undefined,
  });
  let steps = plan.steps.map((step) => {
    if (!affected.has(step.id)) return step;
    return reset(step, step.id === stepId && dependenciesComplete(step, plan.steps) ? "ready" : "pending");
  });
  steps = promoteReadySteps(steps);
  return succeeded(changed(plan, {
    status: "running",
    steps,
    completedAt: undefined,
    pausedAt: undefined,
    blockedReason: undefined,
  }, now));
}

export function recordPlanEvidence(
  plan: PlanRun,
  stepId: string,
  evidence: PlanEvidence,
  now = Date.now(),
): PlanTransition {
  if (plan.status === "draft" || plan.status === "cancelled") return failed("This plan is not accepting evidence.");
  const normalized = normalizeEvidence(evidence);
  if (!normalized) return failed("Evidence needs an id, label, and value.");
  const step = plan.steps.find((item) => item.id === stepId);
  if (!step) return failed(`No plan step matches ${stepId}.`);
  if (step.evidence.some((item) => item.id === normalized.id)) return failed(`Evidence ${normalized.id} already exists.`);
  const steps = plan.steps.map((item) =>
    item.id === stepId
      ? { ...item, evidence: [...item.evidence, { ...normalized, recordedAt: normalized.recordedAt || now }] }
      : item,
  );
  return succeeded(changed(plan, { steps }, now));
}

export function setPlanStepStatus(
  plan: PlanRun,
  stepId: string,
  status: PlanStepStatus,
  options: { error?: string; now?: number } = {},
): PlanTransition {
  const now = options.now ?? Date.now();
  if (plan.status !== "running") return failed("Plan steps can advance only while the plan is running.");
  const step = plan.steps.find((item) => item.id === stepId);
  if (!step) return failed(`No plan step matches ${stepId}.`);
  if (!STEP_TRANSITIONS[step.status].includes(status)) {
    return failed(`Plan step cannot move from ${step.status} to ${status}.`);
  }
  if ((status === "ready" || status === "running") && !dependenciesComplete(step, plan.steps)) {
    return failed("Plan step dependencies are not complete.");
  }
  const qualifyingEvidence = step.reopenedAt === undefined
    ? step.evidence
    : step.evidence.filter((evidence) => evidence.recordedAt >= step.reopenedAt!);
  if (status === "completed" && step.evidenceRequired) {
    const current = { ...step, evidence: qualifyingEvidence };
    if (stepNeedsAuditorAdmission(current)) {
      if (!stepHasAuditorAdmission(current)) {
        return failed("Plan step needs auditor evidence at a git SHA before completion.");
      }
    } else if (qualifyingEvidence.length === 0) {
      return failed("Plan step needs evidence before completion.");
    }
  }
  const updated: PlanStep = {
    ...step,
    status,
    ...(status === "running" ? { startedAt: step.startedAt ?? now, finishedAt: undefined, error: undefined } : {}),
    ...(status === "completed" || status === "failed" || status === "blocked" || status === "cancelled"
      ? { finishedAt: now }
      : {}),
    ...(clean(options.error) ? { error: clean(options.error) } : status === "ready" ? { error: undefined } : {}),
  };
  let steps = plan.steps.map((item) => (item.id === stepId ? updated : item));
  if (status === "completed") steps = promoteReadySteps(steps);
  return succeeded(changed(plan, { steps }, now));
}

export function completePlanRun(plan: PlanRun, now = Date.now()): PlanTransition {
  if (plan.status !== "running") return failed("Only a running plan can complete.");
  if (plan.steps.length === 0 || plan.steps.some((step) => step.status !== "completed")) {
    return failed("Every plan step must be completed first.");
  }
  if (plan.steps.some((step) => stepNeedsAuditorAdmission(step) && !stepHasAuditorAdmission(step))) {
    return failed("Every builder step needs auditor evidence at a git SHA.");
  }
  if (plan.steps.some((step) => step.evidenceRequired && !step.assignedSessionId && step.evidence.length === 0)) {
    return failed("Every required plan step needs evidence.");
  }
  return succeeded(changed(plan, { status: "completed", completedAt: now }, now));
}

export function blockPlanRun(plan: PlanRun, reason: string, now = Date.now()): PlanTransition {
  if (plan.status !== "running" && plan.status !== "paused") return failed("Only an active plan can be blocked.");
  const blockedReason = clean(reason);
  if (!blockedReason) return failed("A blocked plan needs a reason.");
  return succeeded(changed(plan, { status: "blocked", blockedReason }, now));
}

export function cancelPlanRun(plan: PlanRun, now = Date.now()): PlanTransition {
  if (plan.status === "completed" || plan.status === "cancelled") return failed("This plan is already terminal.");
  return succeeded(changed(plan, { status: "cancelled" }, now));
}

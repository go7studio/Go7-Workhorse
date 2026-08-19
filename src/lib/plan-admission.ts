import { defaultModel } from "./models";
import {
  parseAuditorReport,
  recordPlanEvidence,
  setPlanStepStatus,
  type PlanTransition,
} from "./plan";
import { addLineupRow, lineupIsTerminal, maybeEnqueueLineupJoin } from "./lineup";
import { formatAuditorPrompt, nextWorkerName, workerTaskTitle } from "./subagents";
import type { PlanEvidence, PlanRun, ProviderId, Session } from "./types";

export type AuditorCatalogRow = {
  provider: ProviderId;
  canCall: boolean;
  id?: string;
  model?: string;
  kind?: "vendor" | "custom";
};

export type AuditorPick = {
  provider: ProviderId;
  model: string;
  customBotId?: string;
};

/** First callable vendor none of the builders used. */
export function pickAuditorVendor(
  builders: Array<{ provider: ProviderId; customBotId?: string }>,
  catalog: AuditorCatalogRow[],
): AuditorPick | null {
  const used = new Set(
    builders.map((row) => `${row.provider}:${row.customBotId ?? ""}`),
  );
  for (const row of catalog) {
    if (!row.canCall) continue;
    const customBotId = row.kind === "custom" && row.id?.startsWith("bot:") ? row.id.slice(4) : undefined;
    const key = `${row.provider}:${customBotId ?? ""}`;
    if (used.has(key)) continue;
    const model = row.model?.trim() || defaultModel(row.provider).id;
    return { provider: row.provider, model, ...(customBotId ? { customBotId } : {}) };
  }
  return null;
}

export function auditorEvidenceFromReport(
  report: string,
  input: { id: string; sessionId: string; now: number; gate?: string },
): PlanEvidence | undefined {
  const parsed = parseAuditorReport(report);
  if (!parsed) return undefined;
  if (input.gate && parsed.gate !== input.gate) return undefined;
  return {
    id: input.id,
    kind: "test",
    label: "Auditor gate",
    value: `${parsed.head} ${parsed.gate} ${parsed.lastLine}`,
    recordedAt: input.now,
    sessionId: input.sessionId,
    head: parsed.head,
    gate: parsed.gate,
    lastLine: parsed.lastLine,
    role: "auditor",
    status: parsed.status,
  };
}

function planFrom(result: PlanTransition, fallback: PlanRun): PlanRun {
  return result.ok ? result.plan : fallback;
}

/** Apply a finished auditor report onto incomplete plan steps. */
export function applyAuditorWaveAdmission(
  sessions: Session[],
  parentId: string,
  now = Date.now(),
): Session[] {
  const parent = sessions.find((session) => session.id === parentId);
  const plan = parent?.planRun;
  if (!parent || !plan || plan.status !== "running") return sessions;
  const auditors = sessions.filter(
    (session) => session.parentId === parentId && session.agentRun?.role === "auditor" && session.agentRun.status !== "running",
  );
  if (auditors.length === 0) return sessions;
  let next = plan;
  for (const auditor of auditors) {
    const report = [...auditor.messages].reverse().find((message) => message.role === "assistant" && message.text.trim())?.text
      ?? "";
    const evidence = auditorEvidenceFromReport(report, {
      id: `evidence_${auditor.id}_${now}`,
      sessionId: auditor.id,
      now,
      gate: next.gate,
    });
    if (!evidence) continue;
    const targets = next.steps.filter((step) =>
      step.status === "running" || Boolean(step.assignedSessionId) && step.status !== "completed" && step.status !== "failed" && step.status !== "cancelled",
    );
    for (const step of targets) {
      const recorded = recordPlanEvidence(next, step.id, { ...evidence, id: `${evidence.id}_${step.id}` }, now);
      next = planFrom(recorded, next);
      if (evidence.status === "pass") {
        next = planFrom(setPlanStepStatus(next, step.id, "completed", { now }), next);
      } else {
        next = planFrom(setPlanStepStatus(next, step.id, "failed", { error: evidence.lastLine, now }), next);
      }
    }
  }
  return sessions.map((session) => (session.id === parentId ? { ...session, planRun: next } : session));
}

export type PlanAuditorSpawn = {
  sessions: Session[];
  auditor?: { id: string; brief: string };
};

export function joinAndAdmit(
  sessions: Session[],
  parentId: string,
  catalog: AuditorCatalogRow[],
  ids: { childId: string; now?: number; workerName?: string },
): PlanAuditorSpawn {
  return applyPlanAuditorSpawn(maybeEnqueueLineupJoin(sessions, parentId, ids.now), parentId, catalog, ids);
}

/**
 * After a builder wave joins: spawn one sibling auditor on a different vendor,
 * or admit if the finished wave was already the auditor.
 */
export function applyPlanAuditorSpawn(
  sessions: Session[],
  parentId: string,
  catalog: AuditorCatalogRow[],
  ids: { childId: string; userId?: string; assistantId?: string; now?: number; workerName?: string },
): PlanAuditorSpawn {
  const now = ids.now ?? Date.now();
  const parent = sessions.find((session) => session.id === parentId);
  if (!parent?.planRun || parent.planRun.status !== "running" || !parent.lineup || !lineupIsTerminal(parent.lineup)) {
    return { sessions };
  }
  const isAuditor = (id: string) =>
    sessions.find((session) => session.id === id)?.agentRun?.role === "auditor";
  const builderRows = parent.lineup.rows.filter((row) => !isAuditor(row.childId));
  const auditorRows = parent.lineup.rows.filter((row) => isAuditor(row.childId));
  if (auditorRows.length > 0 && builderRows.length === 0) {
    return { sessions: applyAuditorWaveAdmission(sessions, parentId, now) };
  }
  if (sessions.some((session) => session.parentId === parentId && session.agentRun?.role === "auditor" && session.agentRun.status === "running")) {
    return { sessions };
  }
  if (builderRows.length === 0) return { sessions };
  const builders = builderRows.map((row) => {
    const child = sessions.find((session) => session.id === row.childId);
    return { provider: child?.provider ?? "grok", customBotId: child?.customBotId };
  });
  const pick = pickAuditorVendor(builders, catalog);
  if (!pick) return { sessions };
  const folder = parent.lineup.folder;
  const gate = parent.planRun.gate?.trim() || "npm test";
  const brief = formatAuditorPrompt({ folder, gate });
  const taken = sessions.flatMap((session) => (session.workerName ? [session.workerName] : []));
  const workerName = ids.workerName ?? nextWorkerName(taken);
  const child: Session = {
    id: ids.childId,
    workerName,
    projectId: parent.projectId,
    parentId: parent.id,
    hidden: true,
    provider: pick.provider,
    model: pick.model,
    customBotId: pick.customBotId,
    effort: parent.effort,
    title: workerTaskTitle(workerName, "Plan admission"),
    titleLocked: true,
    mode: parent.mode,
    sandbox: "read-only",
    securityPolicy: parent.securityPolicy,
    environment: parent.environment?.kind === "worktree" ? parent.environment : { kind: "local" },
    status: "idle",
    contextUsed: 0,
    agentRun: {
      status: "running",
      startedAt: now,
      isolation: "shared",
      seed: "fresh",
      role: "auditor",
    },
    messages: [],
  };
  const lineup = addLineupRow(parent.lineup, {
    childId: child.id,
    title: child.title,
    slice: "Plan admission",
    folder,
    vendor: pick.provider,
    status: "running",
    startedAt: now,
  });
  const next = sessions.map((session) =>
    session.id === parentId ? { ...session, lineup } : session,
  );
  return { sessions: [...next, child], auditor: { id: child.id, brief } };
}

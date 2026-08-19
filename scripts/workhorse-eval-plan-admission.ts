import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { objectiveAskPolicy } from "../src/lib/ask-default";
import { auditorEvidenceFromReport, joinAndAdmit } from "../src/lib/plan-admission";
import {
  approvePlanRun,
  assignPlanStep,
  completePlanRun,
  parseMarkdownPlan,
  recordPlanEvidence,
  setPlanStepStatus,
  startPlanRun,
} from "../src/lib/plan";
import { addLineupRow, applyChildIdleSync, emptyLineup } from "../src/lib/lineup";
import type { Session } from "../src/lib/types";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const RECEIPT = `HEAD: ${HEAD}\nGATE: npm test\nLAST: tests 1\nSTATUS: pass\n`;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_parent",
    projectId: "project_eval",
    provider: "codex",
    model: "gpt-5.4",
    effort: "medium",
    title: "Admission eval",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [],
    contextUsed: 0,
    ...overrides,
  };
}

function requirePlan<T extends { ok: boolean; plan?: unknown; error?: string }>(result: T) {
  assert.equal(result.ok, true, result.error);
  return result as T & { plan: NonNullable<T["plan"]> };
}

function ordinaryChecklist() {
  let plan = parseMarkdownPlan({
    id: "plan_checklist",
    markdown: "# Checklist\n- [ ] Write copy\n",
    now: 1,
  });
  plan = startPlanRun(approvePlanRun(plan, 2).plan, 3).plan;
  const stepId = plan.steps[0]!.id;
  plan = setPlanStepStatus(plan, stepId, "running", { now: 4 }).plan;
  plan = recordPlanEvidence(plan, stepId, {
    id: "evidence_checklist",
    kind: "note",
    label: "done",
    value: "copy written",
    recordedAt: 5,
  }, 5).plan;
  plan = requirePlan(setPlanStepStatus(plan, stepId, "completed", { now: 6 })).plan;
  const completed = requirePlan(completePlanRun(plan, 7)).plan;
  const joined = joinAndAdmit([session({ planRun: completed })], "sess_parent", [
    { provider: "grok", canCall: true },
  ], { childId: "sess_unused", now: 8 });
  assert.equal(joined.auditor, undefined);
  return { status: completed.status, auditorSpawned: false };
}

function admittedObjective() {
  let plan = parseMarkdownPlan({
    id: "plan_objective",
    markdown: "# Objective\n### Task 1: Build\nNamed test gate: `npm test`\n### Task 2: Human follow-up\n",
    now: 10,
  });
  plan = startPlanRun(approvePlanRun(plan, 11).plan, 12).plan;
  const builderStepId = plan.steps[0]!.id;
  const untouchedStepId = plan.steps[1]!.id;
  plan = requirePlan(assignPlanStep(plan, builderStepId, {
    sessionId: "sess_builder",
    provider: "codex",
    model: "gpt-5.4",
    rationale: "bounded builder",
    skills: [],
    tools: [],
    constraints: [],
  }, 13)).plan;
  plan = setPlanStepStatus(plan, builderStepId, "running", { now: 14 }).plan;
  plan = recordPlanEvidence(plan, builderStepId, {
    id: "evidence_builder_note",
    kind: "note",
    label: "builder",
    value: "tests passed",
    recordedAt: 15,
    sessionId: "sess_builder",
  }, 15).plan;
  assert.equal(setPlanStepStatus(plan, builderStepId, "completed", { now: 16 }).ok, false);

  const builder = session({
    id: "sess_builder",
    parentId: "sess_parent",
    hidden: true,
    agentRun: { status: "completed", startedAt: 13, finishedAt: 17, isolation: "worktree" },
  });
  const lineup = addLineupRow(emptyLineup("/fixture", 13, "build", "desk"), {
    childId: builder.id,
    title: "Builder",
    slice: "Build",
    folder: "/fixture",
    vendor: "codex",
    status: "completed",
    startedAt: 13,
    finishedAt: 17,
    report: "builder done",
  });
  const builderWave = [session({ planRun: plan, lineup }), builder];
  const noSecondVendor = joinAndAdmit(
    builderWave,
    "sess_parent",
    [{ provider: "codex", canCall: true }],
    { childId: "sess_unavailable_auditor", now: 17 },
  );
  assert.equal(noSecondVendor.auditor, undefined);
  assert.equal(noSecondVendor.sessions.find((item) => item.id === "sess_parent")?.planRun?.steps[0]?.status, "running");

  const first = joinAndAdmit(
    builderWave,
    "sess_parent",
    [
      { provider: "codex", canCall: true },
      { provider: "grok", model: "grok-4.6", canCall: true },
    ],
    { childId: "sess_auditor", workerName: "Piper", now: 18 },
  );
  assert.equal(first.auditor?.id, "sess_auditor");
  const auditor = first.sessions.find((item) => item.id === "sess_auditor");
  assert.equal(auditor?.provider, "grok");
  assert.equal(auditor?.agentRun?.role, "auditor");
  assert.equal(auditor?.sandbox, "read-only");
  const duplicate = joinAndAdmit(first.sessions, "sess_parent", [{ provider: "claude", canCall: true }], {
    childId: "sess_duplicate_auditor",
    now: 19,
  });
  assert.equal(duplicate.auditor, undefined);
  assert.equal(duplicate.sessions.some((item) => item.id === "sess_duplicate_auditor"), false);
  assert.equal(auditorEvidenceFromReport(RECEIPT.replace("GATE: npm test", "GATE: npm run build"), {
    id: "wrong_gate",
    sessionId: "sess_auditor",
    now: 19,
    gate: "npm test",
  }), undefined);
  assert.equal(auditorEvidenceFromReport(RECEIPT.replace(HEAD, "not-a-sha"), {
    id: "bad_head",
    sessionId: "sess_auditor",
    now: 19,
    gate: "npm test",
  }), undefined);

  let sessions = first.sessions.map((item) => item.id === "sess_auditor"
    ? {
        ...item,
        messages: [{ id: "receipt", role: "assistant" as const, text: RECEIPT, createdAt: 19 }],
      }
    : item);
  sessions = applyChildIdleSync(sessions, "sess_auditor", "completed", { report: RECEIPT, now: 20 });
  const second = joinAndAdmit(sessions, "sess_parent", [{ provider: "grok", canCall: true }], {
    childId: "sess_unused",
    now: 21,
  });
  const admitted = second.sessions.find((item) => item.id === "sess_parent")?.planRun;
  assert.equal(admitted?.steps.find((step) => step.id === builderStepId)?.status, "completed");
  assert.equal(admitted?.steps.find((step) => step.id === untouchedStepId)?.status, "ready");
  assert.equal(admitted?.steps.find((step) => step.id === untouchedStepId)?.evidence.length, 0);
  assert.equal(admitted?.steps.find((step) => step.id === builderStepId)?.evidence.some((item) =>
    item.role === "auditor" && item.head === HEAD && item.gate === "npm test" && item.status === "pass"), true);
  return {
    builderNoteAdmitted: false,
    auditorProvider: auditor?.provider,
    auditorRole: auditor?.agentRun?.role,
    builderStepStatus: admitted?.steps.find((step) => step.id === builderStepId)?.status,
    untouchedStepStatus: admitted?.steps.find((step) => step.id === untouchedStepId)?.status,
    receiptHead: HEAD,
    singleVendorBlocked: true,
    duplicateAuditorBlocked: true,
    invalidReceiptRejected: true,
  };
}

function askDefaults() {
  const result = {
    elevate: objectiveAskPolicy({ kind: "elevate", planRunning: true }),
    vendor: objectiveAskPolicy({ kind: "vendor", goalActive: true }),
    runningPlanProduct: objectiveAskPolicy({ kind: "product", planRunning: true }),
    activeGoalProduct: objectiveAskPolicy({ kind: "product", goalActive: true }),
    ordinaryProduct: objectiveAskPolicy({ kind: "product" }),
  };
  assert.deepEqual(result, {
    elevate: "wait",
    vendor: "wait",
    runningPlanProduct: "default-and-continue",
    activeGoalProduct: "default-and-continue",
    ordinaryProduct: "wait",
  });
  return result;
}

export function runAdmissionFixture() {
  return {
    schemaVersion: 1,
    checklist: ordinaryChecklist(),
    objective: admittedObjective(),
    asks: askDefaults(),
    externalCalls: 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(runAdmissionFixture(), null, 2)}\n`);
}

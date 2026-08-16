import assert from "node:assert/strict";
import test from "node:test";
import {
  approvePlanRun,
  assignPlanStep,
  completePlanRun,
  hashPlanSource,
  normalizePlanRun,
  parseMarkdownPlan,
  pausePlanRun,
  readyPlanStepIds,
  recordPlanEvidence,
  reopenPlanStep,
  resumePlanRun,
  revisePlanStep,
  setPlanStepStatus,
  startPlanRun,
  type PlanTransition,
} from "../src/lib/plan";
import { normalizeSession } from "../src/lib/session";
import type { PlanRun } from "../src/lib/types";

function planFrom(result: PlanTransition): PlanRun {
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  return result.plan;
}

test("Markdown imports keep source identity and executable task bodies", () => {
  const markdown = [
    "# Production plan",
    "",
    "**Goal:** Ship the verified release",
    "",
    "### Task 1: Audit visuals",
    "- [ ] Inspect every screen",
    "",
    "### Task 2: Repair defects",
    "Run the focused tests.",
  ].join("\r\n");
  const plan = parseMarkdownPlan({
    markdown,
    path: "C:\\plans\\release.md",
    now: 100,
    constraints: { maxConcurrency: 99 },
  });

  assert.equal(plan.objective, "Ship the verified release");
  assert.equal(plan.source?.label, "release.md");
  assert.equal(plan.source?.path, "C:\\plans\\release.md");
  assert.equal(plan.source?.contentHash, hashPlanSource(markdown));
  assert.equal(hashPlanSource(markdown), hashPlanSource(markdown.replace(/\r\n/g, "\n")));
  assert.equal(plan.constraints?.maxConcurrency, 8);
  assert.deepEqual(plan.steps.map((step) => step.title), ["Task 1: Audit visuals", "Task 2: Repair defects"]);
  assert.match(plan.steps[0]?.details ?? "", /Inspect every screen/);
  assert.ok(plan.steps.every((step) => step.status === "pending" && step.evidenceRequired));
});

test("checked Markdown boxes import as unverified pending work", () => {
  const plan = parseMarkdownPlan({ markdown: "# Checklist\n- [x] Existing claim\n- [ ] Remaining work", now: 10 });
  assert.deepEqual(plan.steps.map((step) => step.status), ["pending", "pending"]);
  assert.ok(plan.steps.every((step) => step.evidence.length === 0));
});

test("plan lifecycle follows dependencies and requires evidence", () => {
  let plan = parseMarkdownPlan({
    markdown: "### Task 1: Inspect\nLook.\n### Task 2: Repair\nFix.",
    now: 1,
    id: "plan_release",
  });
  plan = planFrom(revisePlanStep(plan, plan.steps[1]!.id, { dependsOn: [plan.steps[0]!.id] }, 2));
  plan = planFrom(approvePlanRun(plan, 3));
  plan = planFrom(startPlanRun(plan, 4));

  const firstId = plan.steps[0]!.id;
  const secondId = plan.steps[1]!.id;
  assert.deepEqual(readyPlanStepIds(plan), [firstId]);
  assert.deepEqual(plan.steps.map((step) => step.status), ["ready", "pending"]);

  plan = planFrom(setPlanStepStatus(plan, firstId, "running", { now: 5 }));
  const missingEvidence = setPlanStepStatus(plan, firstId, "completed", { now: 6 });
  assert.deepEqual(missingEvidence, { ok: false, error: "Plan step needs evidence before completion." });
  plan = planFrom(recordPlanEvidence(plan, firstId, {
    id: "evidence_1",
    kind: "test",
    label: "Visual audit",
    value: "artifacts/audit.png",
    recordedAt: 0,
    sessionId: "agent_kimi",
  }, 7));
  plan = planFrom(setPlanStepStatus(plan, firstId, "completed", { now: 8 }));
  assert.equal(plan.steps[1]?.status, "ready");

  plan = planFrom(setPlanStepStatus(plan, secondId, "running", { now: 9 }));
  plan = planFrom(recordPlanEvidence(plan, secondId, {
    id: "evidence_2",
    kind: "test",
    label: "Focused tests",
    value: "pass",
    recordedAt: 10,
  }, 10));
  plan = planFrom(setPlanStepStatus(plan, secondId, "completed", { now: 11 }));
  plan = planFrom(completePlanRun(plan, 12));

  assert.equal(plan.status, "completed");
  assert.equal(plan.completedAt, 12);
  assert.equal(plan.revision, 11);
});

test("plan assignments preserve model fit and agent identity", () => {
  let plan = parseMarkdownPlan({ markdown: "### Task 1: Audit visuals\nInspect UI.", now: 1 });
  plan = planFrom(approvePlanRun(plan, 2));
  plan = planFrom(startPlanRun(plan, 3));
  const stepId = plan.steps[0]!.id;
  plan = planFrom(assignPlanStep(plan, stepId, {
    sessionId: "session_kimi",
    provider: "custom",
    model: "hf:moonshotai/Kimi-K3",
    effort: "medium",
    customBotId: "bot_kimi",
    rationale: "Visual audit and image input",
    skills: ["UI/UX"],
    tools: ["screenshots"],
    constraints: ["audit-only", "no-commit"],
  }, 4));
  assert.equal(plan.steps[0]?.assignment?.sessionId, "session_kimi");
  assert.equal(plan.steps[0]?.assignment?.rationale, "Visual audit and image input");
  assert.equal(plan.steps[0]?.assignment?.effort, "medium");
  assert.deepEqual(plan.steps[0]?.assignment?.constraints, ["audit-only", "no-commit"]);
  assert.equal(plan.events?.at(-1)?.type, "agent.assigned");
});

test("plan validation rejects cycles and supports pause and resume", () => {
  let plan = parseMarkdownPlan({ markdown: "- [ ] First\n- [ ] Second", now: 1 });
  const firstId = plan.steps[0]!.id;
  const secondId = plan.steps[1]!.id;
  plan = planFrom(revisePlanStep(plan, firstId, { dependsOn: [secondId] }, 2));
  const cycle = revisePlanStep(plan, secondId, { dependsOn: [firstId] }, 3);
  assert.deepEqual(cycle, { ok: false, error: "Plan dependencies contain a cycle." });

  plan = planFrom(approvePlanRun(plan, 4));
  plan = planFrom(startPlanRun(plan, 5));
  plan = planFrom(pausePlanRun(plan, 6));
  assert.equal(plan.status, "paused");
  plan = planFrom(resumePlanRun(plan, 7));
  assert.equal(plan.status, "running");
  assert.equal(plan.pausedAt, undefined);
});

test("completed work can reopen with fresh evidence and dependent invalidation", () => {
  let plan = parseMarkdownPlan({ markdown: "- [ ] Build adapter\n- [ ] Package plugin", now: 1 });
  const firstId = plan.steps[0]!.id;
  const secondId = plan.steps[1]!.id;
  plan = planFrom(revisePlanStep(plan, secondId, { dependsOn: [firstId] }, 2));
  plan = planFrom(approvePlanRun(plan, 3));
  plan = planFrom(startPlanRun(plan, 4));
  plan = planFrom(setPlanStepStatus(plan, firstId, "running", { now: 5 }));
  plan = planFrom(recordPlanEvidence(plan, firstId, { id: "old_1", kind: "test", label: "Old", value: "pass", recordedAt: 6 }, 6));
  plan = planFrom(setPlanStepStatus(plan, firstId, "completed", { now: 7 }));
  plan = planFrom(setPlanStepStatus(plan, secondId, "running", { now: 8 }));
  plan = planFrom(recordPlanEvidence(plan, secondId, { id: "old_2", kind: "test", label: "Old", value: "pass", recordedAt: 9 }, 9));
  plan = planFrom(setPlanStepStatus(plan, secondId, "completed", { now: 10 }));
  plan = planFrom(completePlanRun(plan, 11));

  plan = planFrom(reopenPlanStep(plan, firstId, "Packaged plugin was missing", 12));
  assert.equal(plan.status, "running");
  assert.equal(plan.completedAt, undefined);
  assert.equal(plan.steps[0]?.status, "ready");
  assert.equal(plan.steps[1]?.status, "pending");
  assert.equal(plan.steps[0]?.reopenedAt, 12);
  assert.equal(setPlanStepStatus(planFrom(setPlanStepStatus(plan, firstId, "running", { now: 13 })), firstId, "completed", { now: 14 }).ok, false);
});

test("normalization removes malformed records and persists through sessions", () => {
  const normalized = normalizePlanRun({
    id: " plan_1 ",
    objective: " Execute safely ",
    revision: 0,
    createdAt: 20,
    steps: [
      { id: "a", title: " First ", dependsOn: ["missing", "a"], evidence: [] },
      { id: "a", title: "Duplicate", evidence: [] },
      { id: "b", title: "Second", dependsOn: ["a"], evidenceRequired: false, evidence: [] },
      { id: "", title: "Invalid" },
    ],
  });
  assert.equal(normalized?.revision, 1);
  assert.deepEqual(normalized?.steps.map((step) => step.id), ["a", "b"]);
  assert.deepEqual(normalized?.steps[0]?.dependsOn, []);
  assert.deepEqual(normalized?.steps[1]?.dependsOn, ["a"]);

  const session = normalizeSession({
    id: "session_1",
    projectId: null,
    provider: "codex",
    model: "gpt-5.6-terra",
    title: "Plan",
    messages: [],
    contextUsed: 0,
    planRun: normalized,
  });
  assert.deepEqual(session?.planRun, normalized);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyPlanAuditorSpawn,
  auditorEvidenceFromReport,
  joinAndAdmit,
  pickAuditorVendor,
} from "../src/lib/plan-admission";
import {
  approvePlanRun,
  parseAuditorReport,
  parseMarkdownPlan,
  parsePlanGate,
  recordPlanEvidence,
  setPlanStepStatus,
  startPlanRun,
} from "../src/lib/plan";
import { addLineupRow, emptyLineup, lineupJoinPrompt, maybeEnqueueLineupJoin } from "../src/lib/lineup";
import { admitSpawn, deskRoleOf, formatAuditorPrompt, toolsForDeskRole, vendorTextForSpawn } from "../src/lib/subagents";
import { AUDITOR_SESSION_RULES, sessionRulesFor } from "../src/lib/workhorse-rules";
import type { Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function parent(over: Partial<Session> = {}): Session {
  return {
    id: "sess_parent",
    projectId: "p1",
    provider: "codex",
    model: "gpt-5.4",
    effort: "medium",
    title: "Orchestrator",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [],
    contextUsed: 0,
    ...over,
  };
}

function builder(id: string, provider: Session["provider"] = "codex"): Session {
  return parent({
    id,
    parentId: "sess_parent",
    hidden: true,
    provider,
    title: `${id} builder`,
    agentRun: { status: "completed", startedAt: 1, finishedAt: 2, isolation: "worktree" },
  });
}

test("a note cannot complete a plan step; auditor SHA+gate+last line can", () => {
  let plan = parseMarkdownPlan({
    markdown: "### Task 1: Add\nNamed test gate: `npm test`\n",
    now: 1,
  });
  assert.equal(parsePlanGate(plan.source ? "Named test gate: `npm test`" : ""), "npm test");
  assert.equal(plan.gate, "npm test");
  plan = startPlanRun(approvePlanRun(plan, 2).plan, 3).plan;
  const stepId = plan.steps[0]!.id;
  plan = setPlanStepStatus(plan, stepId, "running", { now: 4 }).plan;
  plan = recordPlanEvidence(plan, stepId, {
    id: "note",
    kind: "note",
    label: "builder",
    value: "I ran the tests",
    recordedAt: 5,
    sessionId: "sess_wren",
  }, 5).plan;
  assert.equal(setPlanStepStatus(plan, stepId, "completed", { now: 6 }).ok, false);
  const parsed = parseAuditorReport(`HEAD: ${HEAD}\nGATE: npm test\nLAST: tests 1\nSTATUS: pass\n`);
  assert.equal(parsed?.head, HEAD);
  const evidence = auditorEvidenceFromReport(`HEAD: ${HEAD}\nGATE: npm test\nLAST: tests 1\nSTATUS: pass\n`, {
    id: "aud",
    sessionId: "sess_auditor",
    now: 7,
    gate: "npm test",
  });
  assert.ok(evidence);
  plan = recordPlanEvidence(plan, stepId, evidence!, 7).plan;
  assert.equal(setPlanStepStatus(plan, stepId, "completed", { now: 8 }).ok, true);
});

test("pickAuditorVendor skips builder vendors and spent rows", () => {
  const pick = pickAuditorVendor(
    [{ provider: "codex" }],
    [
      { provider: "codex", canCall: true },
      { provider: "claude", canCall: false },
      { provider: "grok", canCall: true, model: "grok-4.6" },
    ],
  );
  assert.deepEqual(pick, { provider: "grok", model: "grok-4.6" });
  assert.equal(pickAuditorVendor([{ provider: "codex" }], [{ provider: "codex", canCall: true }]), null);
});

test("builder wave join spawns a sibling auditor on a different vendor; the parent still joins", () => {
  let plan = parseMarkdownPlan({ markdown: "### Task 1: Add\nNamed test gate: `npm test`\n", now: 1, id: "plan_1" });
  plan = startPlanRun(approvePlanRun(plan, 2).plan, 3).plan;
  plan = setPlanStepStatus(plan, plan.steps[0]!.id, "running", { now: 4 }).plan;
  const wren = builder("sess_wren", "codex");
  let lineup = emptyLineup("/repo", 10, "assign bots", "desk");
  lineup = addLineupRow(lineup, {
    childId: "sess_wren",
    title: "Wren",
    slice: "add",
    folder: "/repo",
    vendor: "codex",
    status: "completed",
    startedAt: 10,
    finishedAt: 11,
    report: "add done",
  });
  const orch = parent({ planRun: plan, lineup });
  const joined = maybeEnqueueLineupJoin([orch, wren], "sess_parent", 12);
  assert.ok(joined[0]?.queue?.some((item) => item.text.includes("ORCHESTRATION CALL")));
  const spawned = applyPlanAuditorSpawn(joined, "sess_parent", [
    { provider: "codex", canCall: true },
    { provider: "grok", canCall: true, model: "grok-4.6" },
  ], { childId: "sess_auditor", now: 13, workerName: "Piper" });
  assert.equal(spawned.auditor?.id, "sess_auditor");
  const auditor = spawned.sessions.find((session) => session.id === "sess_auditor");
  assert.equal(deskRoleOf(auditor), "auditor");
  assert.equal(auditor?.provider, "grok");
  assert.equal(auditor?.sandbox, "read-only");
  assert.equal(auditor?.agentRun?.seed, "fresh");
  assert.equal(auditor?.parentId, "sess_parent");
  assert.equal(auditor?.hidden, true);
  assert.match(spawned.auditor?.brief ?? "", /ROLE: auditor/);
  assert.match(lineupJoinPrompt(orch.lineup, { continuePlan: true }), /cannot mark a plan step done/);
});

test("auditor report admits the running step; builder report does not", () => {
  let plan = parseMarkdownPlan({ markdown: "### Task 1: Add\nNamed test gate: `npm test`\n", now: 1 });
  plan = startPlanRun(approvePlanRun(plan, 2).plan, 3).plan;
  const stepId = plan.steps[0]!.id;
  plan = setPlanStepStatus(plan, stepId, "running", { now: 4 }).plan;
  const wren = builder("sess_wren");
  const auditor: Session = parent({
    id: "sess_auditor",
    parentId: "sess_parent",
    hidden: true,
    provider: "grok",
    sandbox: "read-only",
    status: "idle",
    agentRun: { status: "completed", startedAt: 5, finishedAt: 6, isolation: "shared", seed: "fresh", role: "auditor" },
    messages: [{
      id: "a1",
      role: "assistant",
      text: `HEAD: ${HEAD}\nGATE: npm test\nLAST: tests 1\nSTATUS: pass\n`,
      createdAt: 6,
    }],
  });
  let lineup = addLineupRow(emptyLineup("/repo", 20), {
    childId: "sess_auditor",
    title: "Piper",
    slice: "Plan admission",
    folder: "/repo",
    vendor: "grok",
    status: "completed",
    startedAt: 20,
    finishedAt: 21,
  });
  const orch = parent({ planRun: plan, lineup });
  const admitted = applyPlanAuditorSpawn([orch, wren, auditor], "sess_parent", [{ provider: "grok", canCall: true }], {
    childId: "sess_unused",
    now: 30,
  });
  const next = admitted.sessions.find((session) => session.id === "sess_parent")?.planRun;
  assert.equal(next?.steps[0]?.status, "completed");
  assert.equal(next?.steps[0]?.evidence.some((row) => row.role === "auditor" && row.head === HEAD), true);
});

test("no second callable vendor means no auditor and the step stays incomplete", () => {
  let plan = parseMarkdownPlan({ markdown: "### Task 1: Add\n", now: 1 });
  plan = startPlanRun(approvePlanRun(plan, 2).plan, 3).plan;
  plan = setPlanStepStatus(plan, plan.steps[0]!.id, "running", { now: 4 }).plan;
  const wren = builder("sess_wren", "codex");
  const lineup = addLineupRow(emptyLineup("/repo", 10), {
    childId: "sess_wren",
    title: "Wren",
    slice: "add",
    folder: "/repo",
    vendor: "codex",
    status: "completed",
    startedAt: 10,
  });
  const orch = parent({ planRun: plan, lineup });
  const spawned = joinAndAdmit([orch, wren], "sess_parent", [{ provider: "codex", canCall: true }], { childId: "sess_auditor", now: 12 });
  assert.equal(spawned.auditor, undefined);
  assert.equal(spawned.sessions.some((session) => session.agentRun?.role === "auditor"), false);
  assert.equal(setPlanStepStatus(plan, plan.steps[0]!.id, "completed", { now: 13 }).ok, false);
});

test("auditor tools and rules forbid spawn; admitSpawn refuses an auditor parent", () => {
  assert.equal(sessionRulesFor("auditor"), AUDITOR_SESSION_RULES);
  assert.doesNotMatch(AUDITOR_SESSION_RULES, /spawn_agent/);
  const tools = toolsForDeskRole([
    { name: "workhorse_spawn_agent" },
    { name: "workhorse_list_chats" },
    { name: "workhorse_request_permission" },
  ], "auditor").map((tool) => tool.name);
  assert.deepEqual(tools, ["workhorse_list_chats"]);
  const refused = admitSpawn({
    parent: { hidden: true, agentRun: { role: "auditor" } },
    prompt: "run the gate",
    folder: "/repo",
  });
  assert.equal(refused.ok, false);
  assert.match(formatAuditorPrompt({ folder: "/repo", gate: "npm test" }), /ROLE: auditor/);
  assert.match(vendorTextForSpawn({
    role: "auditor",
    fromTitle: "Orch",
    text: "npm test",
    folder: "/repo",
    gate: "npm test",
    seed: "fresh",
  }), /STATUS: pass/);
});

test("store joins then admits through joinAndAdmit", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /joinAndAdmit\(/);
  assert.match(store, /applyPlanAuditorSpawn\(/);
});

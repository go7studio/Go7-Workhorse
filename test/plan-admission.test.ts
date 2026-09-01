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
  assignPlanStep,
  completePlanRun,
  parseAuditorReport,
  parseMarkdownPlan,
  parsePlanGate,
  recordPlanEvidence,
  setPlanStepStatus,
  startPlanRun,
  type PlanTransition,
} from "../src/lib/plan";
import { addLineupRow, applyChildIdleSync, emptyLineup, lineupJoinPrompt, maybeEnqueueLineupJoin } from "../src/lib/lineup";
import { admitSpawn, deskRoleOf, formatAuditorPrompt, toolsForDeskRole, vendorTextForSpawn } from "../src/lib/subagents";
import { AUDITOR_SESSION_RULES, sessionRulesFor } from "../src/lib/workhorse-rules";
import type { PlanRun, Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** Setup steps are meant to succeed; a refusal here is a broken fixture, not a finding. */
function planOf(result: PlanTransition): PlanRun {
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

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

test("a builder note cannot complete a step; auditor SHA+gate+last line can", () => {
  let plan = parseMarkdownPlan({
    markdown: "### Task 1: Add\nNamed test gate: `npm test`\n",
    now: 1,
  });
  assert.equal(parsePlanGate(plan.source ? "Named test gate: `npm test`" : ""), "npm test");
  assert.equal(plan.gate, "npm test");
  plan = planOf(startPlanRun(planOf(approvePlanRun(plan, 2)), 3));
  const stepId = plan.steps[0]!.id;
  plan = planOf(assignPlanStep(plan, stepId, {
    sessionId: "sess_wren",
    provider: "codex",
    model: "gpt-5.4",
    rationale: "builder slice",
    skills: [],
    tools: [],
    constraints: [],
  }, 4));
  plan = planOf(setPlanStepStatus(plan, stepId, "running", { now: 5 }));
  plan = planOf(recordPlanEvidence(plan, stepId, {
    id: "note",
    kind: "note",
    label: "builder",
    value: "I ran the tests",
    recordedAt: 6,
    sessionId: "sess_wren",
  }, 6));
  assert.equal(setPlanStepStatus(plan, stepId, "completed", { now: 7 }).ok, false);
  const parsed = parseAuditorReport(`HEAD: ${HEAD}\nGATE: npm test\nLAST: tests 1\nSTATUS: pass\n`);
  assert.equal(parsed?.head, HEAD);
  const evidence = auditorEvidenceFromReport(`HEAD: ${HEAD}\nGATE: npm test\nLAST: tests 1\nSTATUS: pass\n`, {
    id: "aud",
    sessionId: "sess_auditor",
    now: 7,
    gate: "npm test",
  });
  assert.ok(evidence);
  plan = planOf(recordPlanEvidence(plan, stepId, evidence, 7));
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
  plan = planOf(startPlanRun(planOf(approvePlanRun(plan, 2)), 3));
  plan = planOf(setPlanStepStatus(plan, plan.steps[0]!.id, "running", { now: 4 }));
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
  plan = planOf(startPlanRun(planOf(approvePlanRun(plan, 2)), 3));
  const stepId = plan.steps[0]!.id;
  plan = planOf(setPlanStepStatus(plan, stepId, "running", { now: 4 }));
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
  plan = planOf(startPlanRun(planOf(approvePlanRun(plan, 2)), 3));
  plan = planOf(setPlanStepStatus(plan, plan.steps[0]!.id, "running", { now: 4 }));
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

test("an ordinary checklist plan completes without an auditor", () => {
  let plan = parseMarkdownPlan({ markdown: "### Task 1: Write copy\n", now: 1 });
  plan = planOf(startPlanRun(planOf(approvePlanRun(plan, 2)), 3));
  const stepId = plan.steps[0]!.id;
  plan = planOf(setPlanStepStatus(plan, stepId, "running", { now: 4 }));
  plan = planOf(recordPlanEvidence(plan, stepId, {
    id: "e1",
    kind: "note",
    label: "done",
    value: "shipped the copy",
    recordedAt: 5,
  }, 5));
  plan = planOf(setPlanStepStatus(plan, stepId, "completed", { now: 6 }));
  assert.equal(completePlanRun(plan, 7).ok, true);
  const spawned = joinAndAdmit([parent({ planRun: plan })], "sess_parent", [{ provider: "grok", canCall: true }], {
    childId: "sess_auditor",
  });
  assert.equal(spawned.auditor, undefined);
});

test("full objective: builder wave then auditor receipt completes the step", () => {
  let plan = parseMarkdownPlan({
    markdown: "### Task 1: Add\nNamed test gate: `npm test`\n",
    now: 1,
    id: "plan_obj",
  });
  plan = planOf(startPlanRun(planOf(approvePlanRun(plan, 2)), 3));
  const stepId = plan.steps[0]!.id;
  const assigned = planOf(assignPlanStep(plan, stepId, {
    sessionId: "sess_wren",
    provider: "codex",
    model: "gpt-5.4",
    rationale: "fence A",
    skills: [],
    tools: [],
    constraints: [],
  }, 4));
  plan = planOf(setPlanStepStatus(assigned, stepId, "running", { now: 5 }));
  const wren = builder("sess_wren", "codex");
  const lineup = addLineupRow(emptyLineup("/repo", 10, "assign bots", "desk"), {
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
  const first = joinAndAdmit(
    [parent({ planRun: plan, lineup }), wren],
    "sess_parent",
    [
      { provider: "codex", canCall: true },
      { provider: "grok", canCall: true, model: "grok-4.6" },
    ],
    { childId: "sess_auditor", now: 12, workerName: "Piper" },
  );
  assert.equal(first.auditor?.id, "sess_auditor");
  assert.equal(first.sessions.find((session) => session.id === "sess_parent")?.planRun?.steps[0]?.status, "running");

  let sessions = first.sessions.map((session) =>
    session.id === "sess_auditor"
      ? {
          ...session,
          messages: [{
            id: "a1",
            role: "assistant" as const,
            text: `HEAD: ${HEAD}\nGATE: npm test\nLAST: tests 1\nSTATUS: pass\n`,
            createdAt: 20,
          }],
        }
      : session,
  );
  sessions = applyChildIdleSync(sessions, "sess_auditor", "completed", {
    report: `HEAD: ${HEAD}\nGATE: npm test\nLAST: tests 1\nSTATUS: pass\n`,
    now: 21,
  });
  const second = joinAndAdmit(sessions, "sess_parent", [{ provider: "grok", canCall: true }], {
    childId: "sess_unused",
    now: 22,
  });
  const done = second.sessions.find((session) => session.id === "sess_parent")?.planRun;
  assert.equal(done?.steps[0]?.status, "completed");
  assert.equal(done?.steps[0]?.evidence.some((row) => row.role === "auditor" && row.head === HEAD), true);
  assert.equal(completePlanRun(done!, 23).ok, true);
});

test("a spawn onto a folder that is gone is refused at both doors", () => {
  /*
   * The MCP tool has always stat'ed the folder before admitting a spawn. The
   * store did not pass folderExists at all, so a project still linked to a repo
   * that had moved admitted the worker and the worker died on its cwd — a
   * missing-binary ENOENT, not a folder that says its own name.
   */
  const gone = admitSpawn({
    parent: { projectId: "p1" },
    projectFolder: "/repo/moved-away",
    prompt: "audit the store",
    folderExists: (value) => value !== "/repo/moved-away",
  });
  assert.equal(gone.ok, false);
  assert.match((gone as { error: string }).error, /Folder does not exist: \/repo\/moved-away/);

  // A folder that is there still admits, and the explicit folder still wins
  // over the project's own.
  const live = admitSpawn({
    parent: { projectId: "p1" },
    projectFolder: "/repo/moved-away",
    folder: "/repo/here",
    prompt: "audit the store",
    folderExists: (value) => value === "/repo/here",
  });
  assert.equal(live.ok, true);
  assert.equal((live as { cwd: string }).cwd, "/repo/here");

  // The store's spawn block asks the same question the MCP door asks.
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const block = store.match(/const admitted = admitSpawn\(\{[\s\S]*?\n\s*\}\);/);
  assert.ok(block, "the store still admits spawns through admitSpawn");
  assert.match(block![0], /allowNested: isNested,/);
  assert.match(block![0], /\bfolderExists,/, "the store passes its own folderExists to admitSpawn");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyAuditorWaveAdmission,
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

test("the auditor seat never goes to Grok Bot, by model or by name", () => {
  // A desk with Grok and the Grok Bot preset connected: the builders ran on
  // Grok, so the first unused callable row was the bot, and the auditor — a
  // worker seat AGENTS.md keeps off grok-bot — was handed to it.
  const grokBot = { provider: "custom" as const, canCall: true, kind: "custom" as const, id: "bot:bot_gb", model: "grok-bot", name: "Grok Bot" };
  assert.equal(pickAuditorVendor([{ provider: "grok" }], [{ provider: "grok", canCall: true }, grokBot]), null);
  assert.equal(
    pickAuditorVendor([{ provider: "grok" }], [{ ...grokBot, model: "grok-bot-2" }]),
    null,
    "a Grok Bot slot serving another model id is still the bot",
  );
  // Any other custom bot can still audit.
  assert.deepEqual(
    pickAuditorVendor([{ provider: "grok" }], [grokBot, { ...grokBot, id: "bot:bot_kimi", model: "kimi-k3", name: "Kimi" }]),
    { provider: "custom", model: "kimi-k3", customBotId: "bot_kimi" },
  );
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
  assert.match(formatAuditorPrompt({ folder: "/repo", gate: "npm test", debug: true }), /Fail instead of grading the wrong source/);
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
  // The pin is what the law asks of every caller now; the folder is what this
  // test is about.
  const turn = { text: "audit the store", crewModes: ["orchestrate"] };
  const gone = admitSpawn({
    parent: { projectId: "p1" },
    projectFolder: "/repo/moved-away",
    prompt: "audit the store",
    folderExists: (value) => value !== "/repo/moved-away",
    turn,
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
    turn,
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

/** A finished auditor whose receipt says pass or fail, started at `startedAt`. */
function auditorAt(id: string, startedAt: number, status: "pass" | "fail", head = HEAD): Session {
  return parent({
    id,
    parentId: "sess_parent",
    hidden: true,
    provider: "grok",
    sandbox: "read-only",
    agentRun: { status: "completed", startedAt, finishedAt: startedAt + 1, isolation: "shared", seed: "fresh", role: "auditor" },
    messages: [{
      id: `${id}_report`,
      role: "assistant",
      text: `HEAD: ${head}\nGATE: npm test\nLAST: tests ${status === "pass" ? "1 passed" : "1 failed"}\nSTATUS: ${status}\n`,
      createdAt: startedAt + 1,
    }],
  });
}

/** Two independent builder steps under one gate, both assigned in turn. */
function twoStepPlan(): { plan: PlanRun; first: string; second: string } {
  let plan = parseMarkdownPlan({
    markdown: "### Task 1: Add\n### Task 2: Wire\nNamed test gate: `npm test`\n",
    now: 1,
    id: "plan_two",
  });
  plan = planOf(startPlanRun(planOf(approvePlanRun(plan, 2)), 3));
  const [first, second] = plan.steps.map((step) => step.id) as [string, string];
  return { plan, first, second };
}

function assignRunning(plan: PlanRun, stepId: string, sessionId: string, at: number): PlanRun {
  const assigned = planOf(assignPlanStep(plan, stepId, {
    sessionId,
    provider: "codex",
    model: "gpt-5.4",
    rationale: "builder slice",
    skills: [],
    tools: [],
    constraints: [],
  }, at));
  return planOf(setPlanStepStatus(assigned, stepId, "running", { now: at + 1 }));
}

function builderAt(id: string, startedAt: number): Session {
  const row = builder(id);
  return { ...row, agentRun: { ...row.agentRun!, startedAt, finishedAt: startedAt + 5 } };
}

test("an earlier wave's auditor pass cannot admit a later step its own auditor failed", () => {
  const { plan: started, first, second } = twoStepPlan();
  const b1 = builderAt("sess_b1", 4);
  const a1 = auditorAt("sess_a1", 10, "pass");
  let plan = assignRunning(started, first, "sess_b1", 4);
  let sessions = applyAuditorWaveAdmission([parent({ planRun: plan }), b1, a1], "sess_parent", 12);
  plan = sessions.find((session) => session.id === "sess_parent")!.planRun!;
  assert.equal(plan.steps.find((step) => step.id === first)?.status, "completed", "precondition: wave one admitted");

  // Wave two: a new builder, then a new auditor whose gate fails. Wave one's
  // auditor is still a finished child of this parent, and it used to be read
  // first and complete the step on its old pass.
  plan = assignRunning(plan, second, "sess_b2", 20);
  const b2 = builderAt("sess_b2", 20);
  const a2 = auditorAt("sess_a2", 30, "fail", "fedcba9876543210fedcba9876543210fedcba98");
  sessions = applyAuditorWaveAdmission([parent({ planRun: plan }), b1, b2, a1, a2], "sess_parent", 40);
  const after = sessions.find((session) => session.id === "sess_parent")!.planRun!;
  const step = after.steps.find((item) => item.id === second)!;
  assert.equal(step.status, "failed", "the step's own auditor failed it");
  assert.equal(step.evidence.some((row) => row.sessionId === "sess_a1"), false, "wave one's receipt is not evidence for wave two");
  assert.equal(after.steps.find((item) => item.id === first)?.status, "completed", "wave one stays admitted");
});

test("an auditor that finished beside its builders is admitted, not replaced by another auditor", () => {
  // The parent was still talking when the builder finished, so the join did
  // not reset the lineup and the auditor's row was appended beside the
  // builder's. Every settle then read that builder as unaudited and spawned
  // another auditor, and the one that had reported was never admitted.
  const { plan: started, first } = twoStepPlan();
  const plan = assignRunning(started, first, "sess_b1", 4);
  let lineup = addLineupRow(emptyLineup("/repo", 4), {
    childId: "sess_b1", title: "Wren", slice: "add", folder: "/repo", vendor: "codex", status: "completed", startedAt: 4, finishedAt: 9,
  });
  lineup = addLineupRow(lineup, {
    childId: "sess_a1", title: "Piper", slice: "Plan admission", folder: "/repo", vendor: "grok", status: "completed", startedAt: 10, finishedAt: 11,
  });
  const orch = parent({ status: "running", planRun: plan, lineup });
  const result = applyPlanAuditorSpawn(
    [orch, builderAt("sess_b1", 4), auditorAt("sess_a1", 10, "fail")],
    "sess_parent",
    [{ provider: "grok", canCall: true }, { provider: "claude", canCall: true }],
    { childId: "sess_again", now: 12 },
  );
  assert.equal(result.auditor, undefined, "no second auditor for work already audited");
  assert.equal(result.sessions.some((session) => session.id === "sess_again"), false);
  const step = result.sessions.find((session) => session.id === "sess_parent")!.planRun!.steps.find((item) => item.id === first);
  assert.equal(step?.status, "failed", "the auditor that reported is the one admitted");
});

test("a builder that started after the lineup's auditor still gets an auditor of its own", () => {
  const { plan: started, second } = twoStepPlan();
  const plan = assignRunning(started, second, "sess_b2", 20);
  let lineup = addLineupRow(emptyLineup("/repo", 10), {
    childId: "sess_a1", title: "Piper", slice: "Plan admission", folder: "/repo", vendor: "grok", status: "completed", startedAt: 10, finishedAt: 11,
  });
  lineup = addLineupRow(lineup, {
    childId: "sess_b2", title: "Dexter", slice: "wire", folder: "/repo", vendor: "codex", status: "completed", startedAt: 20, finishedAt: 25,
  });
  const result = applyPlanAuditorSpawn(
    [parent({ status: "running", planRun: plan, lineup }), builderAt("sess_b2", 20), auditorAt("sess_a1", 10, "pass")],
    "sess_parent",
    [{ provider: "grok", canCall: true }],
    { childId: "sess_a2", now: 30 },
  );
  assert.equal(result.auditor?.id, "sess_a2", "the old auditor did not see this builder's work");
  const step = result.sessions.find((session) => session.id === "sess_parent")!.planRun!.steps.find((item) => item.id === second);
  assert.equal(step?.status, "running", "and its old pass does not admit it");
});

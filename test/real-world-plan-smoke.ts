import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";

if (process.env.WORKHORSE_REAL_PLAN_SMOKE !== "1") {
  throw new Error("Set WORKHORSE_REAL_PLAN_SMOKE=1 for this live, opt-in test.");
}

const userData = process.env.WORKHORSE_USER_DATA_PATH?.trim();
const workspace = process.env.WORKHORSE_REAL_PLAN_WORKSPACE?.trim();
const planPath = process.env.WORKHORSE_REAL_PLAN_PATH?.trim();
const executablePath = process.env.WORKHORSE_APP_PATH?.trim();
if (!userData || !workspace || !planPath) throw new Error("User data, workspace, and plan path are required.");

const runDir = path.join(process.cwd(), "eval", "runs", `real-plan-${Date.now()}`);
fs.mkdirSync(runDir, { recursive: true });
const startedAt = Date.now();
const seedState = JSON.parse(fs.readFileSync(path.join(userData, "workhorse-state.json"), "utf8"));
const requestedRootId = process.env.WORKHORSE_REAL_PLAN_SESSION_ID?.trim();
const requestedProvider = process.env.WORKHORSE_REAL_PLAN_ORCHESTRATOR?.trim() || "codex";
const rootSessions = (seedState.sessions ?? [])
  .filter((session: any) => session.provider === requestedProvider && !session.archived && !session.parentId && !session.goal)
  .sort((left: any, right: any) => Number(right.updatedAt ?? right.createdAt ?? 0) - Number(left.updatedAt ?? left.createdAt ?? 0));
const requestedRoot = (seedState.sessions ?? []).find((session: any) => session.id === requestedRootId && !session.parentId);
const rootSession = requestedRoot ?? rootSessions[0];
const rootSessionId = rootSession?.id;
const rootTitle = rootSession?.title;
if (!rootSessionId || !rootTitle) throw new Error(`A ${requestedProvider} root chat without an active goal is required.`);
const prompt = (rootSession?.planRun ? [
  "Resume the persisted production plan. Do not import a duplicate plan or repeat completed work.",
  "Preserve the completed Kimi visual audit; do not call Kimi again or repeat its work. Requeue Task 7 and give implementation to a separate coding worker using that audit.",
  "The Kimi assignment is audit-only with read-only, audit-only, no-code, and no-commit constraints.",
  "Keep MiniMax M3 out of this production run. Keep at most two root workers active and preserve routing rationale, skills, tools, and evidence.",
  "Integrate isolated worker commits into the bound branch before dependent steps. Run artifact checks, Saga, and iOS lanes when their dependencies are ready.",
  "Treat an idle worker whose agentRun still says running after restart as interrupted: fail and requeue its step instead of waiting forever.",
  "Continue until the plan is completed or truthfully blocked. Never purchase, change account access, push, or release.",
] : [
  "You are the production Workhorse orchestrator. Execute and track this plan through Workhorse; do not pretend to complete delegated work.",
  `Create project “BoomFront Production Orchestration” bound to ${workspace} and move this chat into it.`,
  `Import ${planPath} with workhorse_plan.`,
  "Inspect canonical docs, then revise task details and dependencies before approving and starting the plan.",
  "Call workhorse_list_bots and workhorse_probe_runtime. Choose callable agents yourself from the live roster and current capacity.",
  "For every plan spawn, pass planStepId, a one-line rationale, required skills, and required tools. Explicit user assignments always win.",
  "Kimi K3 must own the visual/UI/icon audit. Attach tools/ui_walk_out/title.png, campaign_page1.png, hud_level01.png, and settings.png to that Kimi spawn.",
  "Kimi is audit-only for this plan. Pass read-only, audit-only, no-code, and no-commit constraints; route its findings to a separate coding worker.",
  "Do not call MiniMax M3 in this production run. Choose among callable Codex, Grok, Claude, and Kimi agents using capability, capacity, and task risk.",
  "Use at most two root workers at once. Use stronger models for implementation and bounded cheaper models only for low-risk verification.",
  "Request accept-edits plus workspace access before implementation. Never purchase, change account access, push, or release.",
  "Run the artifact-checked Godot suite, export Android, and perform the plan's authorized Saga install and UI pass after code gates are green. Probe iOS and record any unavailable lane truthfully.",
  "Continue through joined child reports, record evidence, repair failures, and complete or truthfully block the plan.",
]).join("\n");

const app = await electron.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [...(executablePath ? [] : ["."]), "--no-sandbox", `--workhorse-user-data=${userData}`],
  cwd: process.cwd(),
  env: { ...process.env, WORKHORSE_VOLATILE_CREDENTIALS: "1" },
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const existingSessionApproval = page.getByRole("button", { name: "Allow for session", exact: true }).first();
  if (await existingSessionApproval.isVisible().catch(() => false)) await existingSessionApproval.click();
  await page.getByText(rootTitle, { exact: true }).first().click();
  await page.screenshot({ path: path.join(runDir, "01-start.png") });
  const liveState = JSON.parse(fs.readFileSync(path.join(userData, "workhorse-state.json"), "utf8"));
  const liveRoot = liveState.sessions?.find((session: any) => session.id === rootSessionId);
  if (liveRoot?.status !== "running") {
    const composer = page.locator("textarea").last();
    await composer.fill(prompt);
    await page.waitForTimeout(250);
    if ((await composer.inputValue()) !== prompt) throw new Error("The orchestration prompt did not reach the composer.");
    await composer.press("Enter");
  }

  let lastPlanStatus = "none";
  let elevated = false;
  let peakRootWorkers = 0;
  const timeoutMinutes = Math.max(10, Number(process.env.WORKHORSE_REAL_PLAN_TIMEOUT_MINUTES ?? 60));
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (Date.now() < deadline) {
    const elevate = page.getByRole("button", { name: /^Elevate(?: to )?/ }).first();
    if (await elevate.isVisible().catch(() => false)) {
      await elevate.click();
      elevated = true;
    }
    let saved: any = {};
    try {
      saved = JSON.parse(fs.readFileSync(path.join(userData, "workhorse-state.json"), "utf8"));
    } catch {
      await page.waitForTimeout(1_000);
      continue;
    }
    const root = saved.sessions?.find((session: any) => session.id === rootSessionId);
    const plan = root?.planRun;
    lastPlanStatus = plan?.status ?? lastPlanStatus;
    const runningChildren = (saved.sessions ?? []).filter(
      (session: any) => session.parentId === rootSessionId && session.agentRun?.status === "running",
    );
    peakRootWorkers = Math.max(peakRootWorkers, runningChildren.length);
    if (["completed", "blocked", "cancelled"].includes(lastPlanStatus)) break;
    const rootIdle = root?.status !== "running";
    const hasUsefulReply = root?.messages?.some(
      (message: any) => message.role === "assistant" && message.createdAt >= startedAt && String(message.text ?? "").trim(),
    );
    if (rootIdle && hasUsefulReply && !plan && Date.now() - startedAt > 20_000) break;
    await page.waitForTimeout(2_000);
  }

  await page.screenshot({ path: path.join(runDir, "02-final.png") });
  const saved = JSON.parse(fs.readFileSync(path.join(userData, "workhorse-state.json"), "utf8"));
  const root = saved.sessions?.find((session: any) => session.id === rootSessionId);
  const children = (saved.sessions ?? []).filter((session: any) => session.parentId === rootSessionId);
  const evidence = {
    startedAt,
    finishedAt: Date.now(),
    elevated,
    peakRootWorkers,
    runDir,
    plan: root?.planRun
      ? {
          id: root.planRun.id,
          status: root.planRun.status,
          source: root.planRun.source,
          steps: root.planRun.steps.map((step: any) => ({
            id: step.id,
            status: step.status,
            evidence: step.evidence?.length ?? 0,
            assignment: step.assignment,
          })),
          events: root.planRun.events,
        }
      : null,
    children: children.map((child: any) => ({
      id: child.id,
      title: child.title,
      provider: child.provider,
      model: child.model,
      customBotId: child.customBotId,
      status: child.agentRun?.status,
      planStepId: child.agentRun?.planStepId,
      rationale: child.agentRun?.rationale,
      effort: child.effort,
      isolation: child.agentRun?.isolation,
      exclusions: child.agentRun?.exclusions,
      startedAt: child.agentRun?.startedAt,
      attachments: child.messages?.[0]?.images?.map((image: any) => ({ name: image.name, kind: image.kind, size: image.size })),
    })),
    usage: (saved.usage ?? [])
      .filter((event: any) => event.at >= startedAt)
      .map((event: any) => ({ provider: event.provider, model: event.model, inputTokens: event.inputTokens, outputTokens: event.outputTokens })),
  };
  fs.writeFileSync(path.join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.plan) throw new Error("The orchestrator did not import a plan.");
  if (!["completed", "blocked"].includes(evidence.plan.status)) {
    throw new Error(`The plan did not reach a truthful terminal state: ${evidence.plan.status}.`);
  }
  if (evidence.peakRootWorkers > 2) throw new Error(`Root concurrency exceeded two: ${evidence.peakRootWorkers}.`);
  if (!evidence.children.some((child: any) => /kimi/i.test(`${child.title} ${child.model}`) && child.attachments?.length)) {
    throw new Error("No Kimi visual child received attachments.");
  }
  const productionChildren = evidence.children.filter((child: any) => child.startedAt >= startedAt);
  if (productionChildren.some((child: any) => !child.planStepId || !String(child.rationale ?? "").trim())) {
    throw new Error("A production worker is missing its plan step or routing rationale.");
  }
  const kimi = evidence.children.find((child: any) => /kimi/i.test(`${child.title} ${child.model}`) && child.attachments?.length);
  const kimiLimits = (kimi?.exclusions ?? []).join(" ");
  if (!/no[- ]code/i.test(kimiLimits) || !/no[- ]commit/i.test(kimiLimits) || !/audit[- ]only/i.test(kimiLimits)) {
    throw new Error("The Kimi visual worker was not constrained to audit-only, no-code, and no-commit work.");
  }
  if (evidence.children.some((child: any) => /minimax|\bm3\b/i.test(`${child.title} ${child.model}`)) ||
      evidence.usage.some((event: any) => /minimax|\bm3\b/i.test(`${event.provider} ${event.model}`))) {
    throw new Error("MiniMax M3 entered the production run.");
  }
  const completedWithoutEvidence = evidence.plan.steps.filter((step: any) => step.status === "completed" && step.evidence === 0);
  if (completedWithoutEvidence.length) throw new Error("A completed plan step has no recorded evidence.");
} finally {
  await app.close().catch(() => undefined);
}

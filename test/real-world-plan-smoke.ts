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
const m3Bot = seedState.settings?.customBots?.find(
  (bot: any) => /minimax[ -]?m3/i.test(`${bot.name ?? ""} ${bot.model ?? ""}`) && bot.enabled !== false,
);
const requestedRootId = process.env.WORKHORSE_REAL_PLAN_SESSION_ID?.trim();
const m3Sessions = (seedState.sessions ?? [])
  .filter((session: any) => session.customBotId === m3Bot?.id && !session.archived && !session.parentId)
  .sort((left: any, right: any) => Number(right.updatedAt ?? right.createdAt ?? 0) - Number(left.updatedAt ?? left.createdAt ?? 0));
const rootSession = m3Sessions.find((session: any) => session.id === requestedRootId) ?? m3Sessions[0];
const rootSessionId = rootSession?.id;
const rootTitle = rootSession?.title;
if (!m3Bot || !rootSessionId || !rootTitle) throw new Error("An enabled MiniMax M3 root chat is required.");
const prompt = [
  "You are the Workhorse orchestrator. Execute this production plan through Workhorse, not by pretending to do it yourself.",
  `Create project “BoomFront Production Orchestration” bound to ${workspace} and move this chat into it.`,
  `Import ${planPath} with workhorse_plan.`,
  "Inspect canonical docs, then revise task details and dependencies before approving and starting the plan.",
  "Call workhorse_list_bots and workhorse_probe_runtime. Choose callable agents yourself from the live roster and current capacity.",
  "For every plan spawn, pass planStepId, a one-line rationale, required skills, and required tools. Explicit user assignments always win.",
  "Kimi K3 must own the visual/UI/icon audit. Attach tools/ui_walk_out/title.png, campaign_page1.png, hud_level01.png, and settings.png to that Kimi spawn.",
  "Use at most two root workers at once. Prefer MiniMax M3 or lower-cost capable models for bounded checks; use stronger models only when the work requires them.",
  "Request accept-edits plus workspace access before implementation. Never purchase, change account access, push, or release.",
  "Run Godot headless tests and read-only device probes. Do not install or launch on Saga/iOS in this smoke run.",
  "Continue through joined child reports, record evidence, repair failures, and complete or truthfully block the plan.",
].join("\n");

const app = await electron.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [...(executablePath ? [] : ["."]), "--no-sandbox", `--workhorse-user-data=${userData}`],
  cwd: process.cwd(),
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByText(rootTitle, { exact: true }).first().click();
  await page.screenshot({ path: path.join(runDir, "01-start.png") });
  const composer = page.locator("textarea").last();
  await composer.fill(prompt);
  await page.waitForTimeout(250);
  if ((await composer.inputValue()) !== prompt) throw new Error("The orchestration prompt did not reach the composer.");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  let lastPlanStatus = "none";
  let elevated = false;
  const deadline = Date.now() + 20 * 60_000;
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
    if (["completed", "blocked", "cancelled"].includes(lastPlanStatus)) break;
    const rootIdle = root?.status !== "running";
    const hasUsefulReply = root?.messages?.some(
      (message: any) => message.role === "assistant" && message.createdAt >= startedAt && String(message.text ?? "").trim(),
    );
    if (rootIdle && hasUsefulReply && !plan && Date.now() - startedAt > 20_000) break;
    if (rootIdle && runningChildren.length === 0 && hasUsefulReply && plan && Date.now() - startedAt > 90_000) break;
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
      attachments: child.messages?.[0]?.images?.map((image: any) => ({ name: image.name, kind: image.kind, size: image.size })),
    })),
    usage: (saved.usage ?? [])
      .filter((event: any) => event.at >= startedAt)
      .map((event: any) => ({ provider: event.provider, model: event.model, inputTokens: event.inputTokens, outputTokens: event.outputTokens })),
  };
  fs.writeFileSync(path.join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.plan) throw new Error("The orchestrator did not import a plan.");
  if (!evidence.children.some((child: any) => /kimi/i.test(`${child.title} ${child.model}`) && child.attachments?.length)) {
    throw new Error("No Kimi visual child received attachments.");
  }
} finally {
  await app.close().catch(() => undefined);
}

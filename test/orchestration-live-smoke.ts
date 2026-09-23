import { _electron as electron } from "playwright";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBotScoresHost } from "../electron/bot-scores-host";

/*
 * Live and opt-in: a custom bot heads an Orchestrate chat on a fresh desk
 * profile and staffs a three-slice task (code, data, writing) on a throwaway
 * project. The desk it drives is this tree, run from source with its own
 * userData, so an installed desk and the agents on it are never touched.
 *
 * Nothing here names a vendor. The head's URL, model and API dialect come from
 * the environment. Its key is not passed in: the desk finds the key it already
 * uses for that host (the OpenClaw config, or the host's env var) when the
 * profile loads, and keeps it in memory.
 *
 *   WORKHORSE_ORCH_SMOKE=1
 *   WORKHORSE_ORCH_HEAD_BASE_URL=<head's base URL>
 *   WORKHORSE_ORCH_HEAD_MODEL=<head's model id>
 *   WORKHORSE_ORCH_HEAD_API=anthropic-messages | openai-completions
 *   WORKHORSE_ORCH_VENDORS=grok,codex,cursor,claude:off   (optional)
 *   WORKHORSE_ORCH_LOOK_ONLY=1   (optional: read Bot knowledge, ask nothing)
 *   npx tsx test/orchestration-live-smoke.ts
 *
 * Workers run on the vendors this machine is signed into, and spend from those
 * plans. Evidence and screenshots land in eval/runs/.
 */

if (process.env.WORKHORSE_ORCH_SMOKE !== "1") {
  throw new Error("Set WORKHORSE_ORCH_SMOKE=1 for this live, opt-in test.");
}
const headBaseUrl = process.env.WORKHORSE_ORCH_HEAD_BASE_URL?.trim() ?? "";
const headModel = process.env.WORKHORSE_ORCH_HEAD_MODEL?.trim() ?? "";
const headApi = process.env.WORKHORSE_ORCH_HEAD_API?.trim() === "anthropic-messages" ? "anthropic-messages" : "openai-completions";
if (!headBaseUrl || !headModel) {
  throw new Error("Name the head with WORKHORSE_ORCH_HEAD_BASE_URL and WORKHORSE_ORCH_HEAD_MODEL; no live call was made.");
}
const timeoutMinutes = Math.max(5, Number(process.env.WORKHORSE_ORCH_TIMEOUT_MINUTES ?? 25));
const lookOnly = process.env.WORKHORSE_ORCH_LOOK_ONLY === "1";
// Which signed-in vendors this profile treats as connected, as an owner's desk
// would after Connect: "grok,codex,cursor,claude:off". A fresh profile has none,
// which leaves the head alone with its own bot.
const vendorLinks = Object.fromEntries(
  (process.env.WORKHORSE_ORCH_VENDORS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^(grok|codex|claude|cursor)(:off)?$/.test(item))
    .map((item) => {
      const [name, off] = item.split(":");
      return [name!, { connected: true, enabled: off !== "off" }];
    }),
);

const stamp = Date.now();
const root = process.env.WORKHORSE_ORCH_ROOT?.trim() || path.join(os.tmpdir(), `workhorse-orch-smoke-${stamp}`);
const userData = path.join(root, "desk");
const workspace = path.join(root, "project");
const runDir = path.join(process.cwd(), "eval", "runs", `orchestration-${stamp}`);
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(runDir, { recursive: true });

function write(relative: string, body: string) {
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

// The project: one code slice with tests that decide it, one data slice, one writing slice.
write("package.json", `${JSON.stringify({ name: "weekly-signups", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
write(
  "README.md",
  "# Weekly signups\n\nCounts product signups per ISO week. `src/stats.mjs` holds the math; `node --test` checks it.\n",
);
write(
  "src/stats.mjs",
  [
    "/**",
    " * Sum signups per ISO-8601 week.",
    " * @param {{ date: string, signups: number }[]} rows  date is YYYY-MM-DD",
    " * @returns {{ week: string, total: number }[]}  week is YYYY-Www, oldest first",
    " */",
    "export function weeklyTotals(rows) {",
    '  throw new Error("not implemented");',
    "}",
    "",
  ].join("\n"),
);
write(
  "test/stats.test.mjs",
  [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { weeklyTotals } from "../src/stats.mjs";',
    "",
    'test("sums signups per ISO week, oldest first", () => {',
    "  assert.deepEqual(",
    "    weeklyTotals([",
    '      { date: "2026-08-31", signups: 3 },',
    '      { date: "2026-09-06", signups: 4 },',
    '      { date: "2026-09-07", signups: 5 },',
    "    ]),",
    '    [{ week: "2026-W36", total: 7 }, { week: "2026-W37", total: 5 }],',
    "  );",
    "});",
    "",
    'test("ISO weeks cross the new year", () => {',
    "  assert.deepEqual(",
    '    weeklyTotals([{ date: "2026-01-01", signups: 3 }, { date: "2025-12-29", signups: 2 }, { date: "2027-01-03", signups: 1 }]),',
    '    [{ week: "2026-W01", total: 5 }, { week: "2026-W53", total: 1 }],',
    "  );",
    "});",
    "",
    'test("no rows, no weeks", () => {',
    "  assert.deepEqual(weeklyTotals([]), []);",
    "});",
    "",
  ].join("\n"),
);
const csv = ["date,signups"];
for (let day = 0; day < 56; day += 1) {
  const date = new Date(Date.UTC(2026, 6, 27 + day));
  const weekday = (date.getUTCDay() + 6) % 7;
  // Growth, weekends lower, one launch spike, one outage dip.
  let value = 40 + day * 1.6 + (weekday >= 5 ? -14 : 0);
  if (day === 31) value += 95;
  if (day === 44) value = 6;
  csv.push(`${date.toISOString().slice(0, 10)},${Math.max(0, Math.round(value))}`);
}
write("data/signups.csv", `${csv.join("\n")}\n`);

const prompt = [
  "Three pieces of work on this project. I want them done in parallel, each by the bot on this desk best suited to it:",
  "1. Implement weeklyTotals in src/stats.mjs so `node --test` passes. Do not change the tests.",
  "2. Analyze data/signups.csv: the busiest week, the quietest week, anything unusual, and the trend. Write it to reports/signups.md.",
  "3. Write a short, friendly release note (under 120 words) for the new weekly totals in docs/RELEASE.md.",
  "Choose who does each slice from what this desk knows about who is good at what and how much each plan has left. Keep every worker inside this project folder.",
  "When the workers have reported, tell me who did which slice and why you picked them.",
].join("\n");

const now = Date.now();
const headBotId = "bot_orch_head";
const rootSessionId = "sess_orch_head";
const title = "Orchestration smoke";
fs.writeFileSync(
  path.join(userData, "workhorse-state.json"),
  JSON.stringify({
    theme: "system",
    projects: [
      {
        id: "proj_orch_smoke",
        name: "Weekly signups",
        createdAt: now,
        openedAt: now,
        folders: [{ id: "fold_orch_smoke", path: workspace, label: "project" }],
        references: [],
      },
    ],
    sessions: [
      {
        id: rootSessionId,
        projectId: "proj_orch_smoke",
        provider: "custom",
        model: headModel,
        customBotId: headBotId,
        effort: "medium",
        title,
        mode: "always-approve",
        sandbox: "workspace",
        crewModes: ["orchestrate"],
        status: "idle",
        messages: [],
        // A chat with neither a sent ask nor a draft is dropped on load as an unsent draft.
        composerDraft: prompt,
      },
    ],
    activeProjectId: "proj_orch_smoke",
    activeSessionId: rootSessionId,
    settings: {
      llms: vendorLinks,
      access: { mode: "always-approve", sandbox: "workspace" },
      routing: { enabled: true, capacityAware: true, preferExcess: true, allowLocal: false, reservePercent: 15 },
      // No key: the desk fills it from what it already uses for this host.
      customBots: [
        {
          id: headBotId,
          name: "Head",
          color: "#ff9f0a",
          baseUrl: headBaseUrl,
          model: headModel,
          api: headApi,
          contextWindow: 1_000_000,
          enabled: true,
          createdAt: now,
        },
      ],
    },
  }),
);

// Public scores are in place before the desk opens, as they are on a desk that has run a day.
const scores = await createBotScoresHost({ dir: () => path.join(userData, "bot-scores") }).refresh({ force: true });
if (!scores.feed) throw new Error(`Could not load public scores first: ${scores.status.lastError ?? "unknown"}`);

type Saved = { sessions?: any[]; usage?: any[] };
const readSaved = (): Saved | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, "workhorse-state.json"), "utf8")) as Saved;
  } catch {
    return null;
  }
};

const app = await electron.launch({
  args: [".", "--no-sandbox"],
  cwd: process.cwd(),
  env: { ...process.env, WORKHORSE_USER_DATA_PATH: userData, WORKHORSE_VOLATILE_CREDENTIALS: "1" },
});

/** Views of Bot knowledge read off the desk before the ask: what the head's brief is built from. */
const BOT_KNOWLEDGE_VIEWS = [
  ["coding", "quick"],
  ["coding", "balanced"],
  ["coding", "deep"],
  ["data", "balanced"],
  ["writing", "balanced"],
  ["general", "quick"],
] as const;
type BotKnowledgeView = { domain: string; tier: string; note: string; rows: string[][]; screenshot: string };

async function readBotKnowledge(page: Awaited<ReturnType<typeof app.firstWindow>>): Promise<BotKnowledgeView[]> {
  const views: BotKnowledgeView[] = [];
  await page.locator("button.sidebar-settings").first().click();
  await page.getByRole("tab", { name: "Bot knowledge", exact: true }).first().click();
  await page.locator("table.bot-knowledge-table").first().waitFor({ timeout: 10_000 });
  for (const [domain, tier] of BOT_KNOWLEDGE_VIEWS) {
    await page.getByLabel("Task domain").selectOption(domain);
    await page.getByLabel("Route tier").selectOption(tier);
    await page.waitForTimeout(600);
    const screenshot = path.join(runDir, `00-bot-knowledge-${domain}-${tier}.png`);
    await page.screenshot({ path: screenshot });
    const rows = await page
      .locator("table.bot-knowledge-table tr")
      .evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("th,td")].map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim())));
    const note = ((await page.locator(".settings-note").first().textContent()) ?? "").replace(/\s+/g, " ").trim();
    views.push({ domain, tier, note, rows, screenshot });
  }
  await page.locator("button.sidebar-settings").first().click();
  await page.waitForTimeout(500);
  return views;
}

const startedAt = Date.now();
let sentAt = 0;
let failure: unknown;
let botKnowledge: BotKnowledgeView[] | { error: string } = [];
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // Vendor sign-ins and plan meters are read at start; give them a moment.
  await page.waitForTimeout(12_000);
  await page.screenshot({ path: path.join(runDir, "01-open.png") });
  // A miss here is recorded, not fatal: the delegation run is the test.
  botKnowledge = await readBotKnowledge(page).catch((error: unknown) => ({ error: String(error).slice(0, 400) }));
  // Look-only: Bot knowledge is read and nothing is asked of the head.
  if (!lookOnly) {
    await page.getByText(title, { exact: true }).first().click();
    await page.waitForTimeout(1_000);
    const composer = page.locator("textarea").last();
    await composer.fill(prompt);
    await page.waitForTimeout(250);
    if ((await composer.inputValue()) !== prompt) throw new Error("The ask did not reach the composer.");
    await composer.press("Enter");
    sentAt = Date.now();
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: path.join(runDir, "02-sent.png") });

    const deadline = Date.now() + timeoutMinutes * 60_000;
    let settledSince = 0;
    while (Date.now() < deadline) {
      const allow = page.getByRole("button", { name: "Allow for session", exact: true }).first();
      if (await allow.isVisible().catch(() => false)) await allow.click();
      if (await page.getByRole("button", { name: /^Elevate(?: to )?/ }).first().isVisible().catch(() => false)) {
        throw new Error("The run asked for elevation instead of staying inside the project.");
      }
      const saved = readSaved();
      if (!saved) {
        await page.waitForTimeout(1_000);
        continue;
      }
      const head = saved.sessions?.find((session) => session.id === rootSessionId);
      const workers = (saved.sessions ?? []).filter((session) => session.parentId === rootSessionId);
      const workersDone = workers.length > 0 && workers.every((session) => session.agentRun && session.agentRun.status !== "running");
      const lastWorkerEnd = Math.max(0, ...workers.map((session) => session.agentRun?.finishedAt ?? 0));
      const headReplied = (head?.messages ?? []).some(
        (message: any) => message.role === "assistant" && message.createdAt > Math.max(sentAt, lastWorkerEnd) && String(message.text ?? "").trim(),
      );
      const headIdle = head?.status !== "running";
      const settled = headIdle && ((workersDone && headReplied) || (workers.length === 0 && headReplied && Date.now() - sentAt > 180_000));
      settledSince = settled ? settledSince || Date.now() : 0;
      // A final reply can be followed by one more join turn; wait a little before calling it.
      if (settledSince && Date.now() - settledSince > 20_000) break;
      await page.waitForTimeout(3_000);
    }
  }
  await page.screenshot({ path: path.join(runDir, "03-final.png") });
} catch (error) {
  // Kept for the end: the evidence is still written and the profile still goes.
  failure = error;
} finally {
  await app.close().catch(() => undefined);
}

const saved = readSaved() ?? {};
const head = saved.sessions?.find((session) => session.id === rootSessionId);
const workers = (saved.sessions ?? []).filter((session) => session.parentId === rootSessionId);
const clip = (value: unknown, max: number) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const ledgerOf = (session: any) => (session?.ledger?.events ?? []) as any[];
const toolCalls = ledgerOf(head)
  .filter((event) => event.type === "tool/call")
  .map((event) => ({ name: event.name, arguments: clip(JSON.stringify(event.arguments ?? {}), 600) }));
const toolResults = ledgerOf(head)
  .filter((event) => event.type === "tool/result")
  .map((event) => clip(event.text, 900));
const tests = spawnSync(process.execPath, ["--test"], { cwd: workspace, encoding: "utf8", timeout: 60_000 });
const fileState = (relative: string) => {
  const file = path.join(workspace, relative);
  return fs.existsSync(file) ? { bytes: fs.statSync(file).size, head: clip(fs.readFileSync(file, "utf8"), 400) } : null;
};
const evidence = {
  head: { provider: head?.provider, model: head?.model, customBotId: head?.customBotId },
  ranForMinutes: Math.round((Date.now() - startedAt) / 6_000) / 10,
  toolCalls,
  toolResults,
  toolRows: (head?.messages ?? []).filter((message: any) => message.kind === "tool").map((message: any) => clip(message.text, 200)),
  workers: workers.map((worker) => ({
    title: worker.title,
    workerName: worker.workerName,
    provider: worker.provider,
    model: worker.model,
    customBotId: worker.customBotId,
    effort: worker.effort,
    routingMode: worker.routingMode,
    route: worker.routingDecision
      ? { tier: worker.routingDecision.taskTier, score: worker.routingDecision.score, reason: clip(worker.routingDecision.reason, 600) }
      : undefined,
    status: worker.agentRun?.status,
    error: worker.agentRun?.error,
    minutes: worker.agentRun?.finishedAt ? Math.round((worker.agentRun.finishedAt - worker.agentRun.startedAt) / 6_000) / 10 : undefined,
    prompt: clip(ledgerOf(worker).find((event) => event.type === "user/message")?.text ?? worker.messages?.find((message: any) => message.role === "user")?.text, 400),
    report: clip(worker.retainedReport ?? [...(worker.messages ?? [])].reverse().find((message: any) => message.role === "assistant")?.text, 500),
  })),
  finalReply: clip([...(head?.messages ?? [])].reverse().find((message: any) => message.role === "assistant")?.text, 2_500),
  botKnowledge,
  usage: (saved.usage ?? [])
    .filter((event: any) => event.at >= startedAt)
    .map((event: any) => ({ provider: event.provider, model: event.model, inputTokens: event.inputTokens, outputTokens: event.outputTokens })),
  project: {
    testsPass: tests.status === 0,
    testsTail: clip(`${tests.stdout ?? ""}${tests.stderr ?? ""}`.split("\n").slice(-12).join("\n"), 800),
    report: fileState("reports/signups.md"),
    releaseNote: fileState("docs/RELEASE.md"),
  },
  scores: (() => {
    try {
      const cached = JSON.parse(fs.readFileSync(path.join(userData, "bot-scores", "lmarena.json"), "utf8"));
      return {
        sha: cached.feed?.sha,
        fetchedAt: cached.feed?.fetchedAt,
        pricedModels: Object.keys(cached.prices?.prices ?? {}).length,
        lastError: cached.lastError,
      };
    } catch {
      return null;
    }
  })(),
  runDir,
  root,
};
fs.writeFileSync(path.join(runDir, "evidence.json"), JSON.stringify(evidence, null, 2));
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
// A run-from-source desk keeps keys on its rows (it has no OS vault), so the
// profile goes as soon as the evidence is out. The project folder stays.
fs.rmSync(userData, { recursive: true, force: true });
if (failure) throw failure;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/lib/settings";
import { DESK_SPAWN_LAW } from "../src/lib/workhorse-rules";
import { JUDGE_NOTE } from "../src/lib/judge";
import { JUDGE_TIMEOUT_MS } from "../electron/judge-client";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8");

test("the judge is off by default and lives under Routing, not a new tab; the switch asks main whether it could run", () => {
  assert.deepEqual(normalizeSettings({}).judge, { enabled: false });
  assert.deepEqual(DEFAULT_SETTINGS.judge ?? { enabled: false }, { enabled: false });
  const settings = read("src", "ui", "Settings.tsx");
  assert.doesNotMatch(settings, /id: "judge"/);
  const pane = read("src", "ui", "RoutingPane.tsx");
  assert.match(pane, /label="Judge reports"/);
  // Only main can read the vault, so the pane asks it, with the bots it shows, since main learns of a
  // saved bot only after the persistence debounce; a switch already on can always be turned off.
  assert.match(pane, /window\.workhorse\?\.judgeReadiness/);
  assert.match(pane, /ask\(\{ bots \}\)/);
  assert.match(pane, /disabled=\{!judgeReady && !judgeOn\}/);
  assert.match(pane, /On, but it cannot score/);
  assert.match(pane, /It ran nothing/);
  assert.match(pane, /every criterion stays on the next pass/);
});

test("scores ride as reportSays on both payloads, computed once at the payload, by main, at most twice per report", () => {
  const store = read("src", "lib", "store.tsx");
  // Both places a caller reads a report: agent-status and await-agents.
  assert.equal((store.match(/await judgeCompletedWorkers\(/g) ?? []).length, 2);
  // A poll that lands mid-call waits on that call instead of starting another; a poll that lands after
  // the call settled but before React committed reads the settled outcome from the slot, not the stale
  // run. The slot is keyed by session and run id, and its outcome fits only that run, so a worker reused
  // meanwhile never wears it.
  assert.match(store, /const slotKey = \(session: Session\) => `\$\{session\.id\}:\$\{judgeRunKey\(session\.agentRun!\)\}`/);
  assert.match(store, /if \(inflight && !inflight\.settled\)/);
  assert.match(store, /slot\.settled = outcome/);
  assert.match(store, /judgeMayTry\(runNow\(session\), now\)/);
  assert.match(store, /judgeRunKey\(item\.agentRun\) === runKey && !item\.agentRun\.verdict/);
  assert.match(store, /return \{ \.\.\.outcome, runKey \}/);
  // Every run gets its own id at spawn; a continuation of a finished worker mints another and drops the score.
  assert.match(store, /startedAt,\s*runId: uid\("run"\),/);
  const subagentsSrc = read("src", "lib", "subagents.ts");
  assert.match(subagentsSrc, /runId: uid\("run"\),\s*verdict: undefined,\s*judgeFailed: undefined,/);
  // Switching the judge back on forgets the failures it gave up on; so does a key, host, model or
  // on-switch edit on a bot the judge could borrow. A name edit, or an edit to another bot, does not.
  assert.ok((store.match(/forgetJudgeFailures\(/g) ?? []).length >= 2);
  assert.match(store, /judgeBotsFor\(\[bot\]\)\.length > 0 &&\s*\(\["apiKey", "credentialId", "baseUrl", "models", "model", "enabled"\] as const\)\.some/);
  assert.match(store, /workerReportText\(session\)/);
  // The renderer cuts the report before IPC.
  assert.match(store, /truncated: bounded\.truncated/);
  // The judge's tokens go on the ledger under the bot whose key it borrowed, verdict or not.
  assert.match(store, /const usage = result\?\.verdict\?\.usage \?\? result\?\.usage/);
  assert.match(store, /recordUsage\(\{\s*provider: "custom",\s*model: JUDGE_MODEL,\s*customBotId: result\.botId/);
  // agent-status resolves against the desk as it is after the wait, not before.
  assert.match(store, /applyJudgeOutcomes\(now\.sessions, outcomes\)/);
  assert.match(store, /applyJudgeOutcomes\(stateRef\.current\.sessions, outcomes\)/);
  // The renderer never sees the key: it asks main.
  assert.match(store, /window\.workhorse\?\.judgeReport/);
  assert.doesNotMatch(store, /ai-gateway\.vercel\.sh/);
  const preload = read("electron", "preload.ts");
  assert.match(preload, /judgeReport: \(input: unknown\) => ipcRenderer\.invoke\("judge:report", input\)/);
  assert.match(preload, /judgeReadiness: \(input: unknown\) => ipcRenderer\.invoke\("judge:readiness", input\)/);
  const main = read("electron", "main.ts");
  assert.match(main, /ipcMain\.handle\("judge:report"/);
  assert.match(main, /ipcMain\.handle\("judge:readiness", async \(_event, raw: \{ bots\?: unknown \}\)/);
  // The judge borrows a bot's key the way a chat on it does: the one resolver, in main.
  assert.match(main, /readKey: botApiKey/);
  assert.match(main, /return \{ bot, apiKey: botApiKey\(bot\) \};/);
  // The bot rides back on a failure too, so a billed call with no verdict still reaches the ledger.
  assert.match(main, /return \{ \.\.\.outcome, botId: ready\.botId \};/);
  const subagents = read("src", "lib", "subagents.ts");
  assert.match(subagents, /reportSaysFor\(session\.agentRun, opts\?\.judge === true\)/);
  assert.match(subagents, /reportSaysFor\(worker\.agentRun, opts\?\.judge === true\)/);
  assert.match(subagents, /normalizeJudgeFailure\(row\.judgeFailed\)/);
});

test("a judge call never outlives the bridge deadline of the status reply it rides in", () => {
  const mcp = read("electron", "workhorse-mcp.ts");
  // The Link gives agent-status 8 seconds. If that changes, the judge's cap must be looked at again.
  assert.match(mcp, /timeoutMs: 8_000, inbox: false/);
  assert.ok(JUDGE_TIMEOUT_MS < 8_000);
});

test("the next pass keeps every criterion; the judge only adds, and never says met", () => {
  const mcp = read("electron", "workhorse-mcp.ts");
  assert.match(mcp, /judgeBlockLines\(waveGaps\(input\.mission\.acceptanceCriteria/);
  // The full acceptance list and the verify-the-whole-mission line stay.
  assert.match(mcp, /\.\.\.input\.mission\.acceptanceCriteria\.map\(\(criterion\) => `- \$\{criterion\}`\)/);
  assert.match(mcp, /verify the whole mission, and report complete, continue, or blocked/);
  const judge = read("src", "lib", "judge.ts");
  assert.doesNotMatch(judge, /"met"|"verified"/);
  assert.match(judge, /"shown" \| "not-shown" \| "unclear"/);
});

test("the judge never touches permissions, and the law names what a score is", () => {
  const permissions = read("src", "lib", "permissions.ts");
  // Not a word match: permissions.ts says "judged" in prose. It must not read the score.
  assert.doesNotMatch(permissions, /from "\.\/judge"|reportSays|JudgeVerdict|judgeReport|agentRun\?\.verdict/);
  // The spawn hint sits at its lean ceiling, so the law is not a standing
  // sentence there. It travels with the score: on the payload's note and how
  // line, and in the next-pass block.
  assert.doesNotMatch(DESK_SPAWN_LAW, /reportSays/);
  assert.match(JUDGE_NOTE, /ran nothing and verified nothing/);
  const subagents = read("src", "lib", "subagents.ts");
  assert.match(subagents, /how: reportSaysFor\(worker\.agentRun, opts\?\.judge === true\) \? `\$\{follow\.how\} \$\{JUDGE_NOTE\}` : follow\.how/);
  const features = read("docs", "FEATURES.md");
  assert.match(features, /\*\*Judge\*\* \(Settings → Routing, off by default\)/);
  assert.match(features, /reportSays/);
  assert.match(features, /It ran nothing and\s+verified nothing/);
  assert.match(features, /at most twice an hour/);
  assert.match(features, /verdict or not/);
});

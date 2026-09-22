import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/lib/settings";
import { DESK_SPAWN_LAW } from "../src/lib/workhorse-rules";
import { JUDGE_NOTE } from "../src/lib/judge";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8");

test("the judge is off by default and lives under Routing, not a new tab", () => {
  assert.deepEqual(normalizeSettings({}).judge, { enabled: false });
  assert.deepEqual(DEFAULT_SETTINGS.judge ?? { enabled: false }, { enabled: false });
  const settings = read("src", "ui", "Settings.tsx");
  assert.doesNotMatch(settings, /id: "judge"/);
  const pane = read("src", "ui", "RoutingPane.tsx");
  assert.match(pane, /label="Judge reports"/);
  assert.match(pane, /disabled=\{!judgeReady\}/);
  assert.match(pane, /It ran nothing/);
  assert.match(pane, /every criterion stays on the next pass/);
});

test("scores ride as reportSays on both payloads, and are computed once at the payload, by main", () => {
  const store = read("src", "lib", "store.tsx");
  // Both places a caller reads a report: agent-status and await-agents.
  assert.equal((store.match(/await judgeCompletedWorkers\(/g) ?? []).length, 2);
  assert.match(store, /!session\.agentRun\.verdict &&/);
  assert.match(store, /judgingRef\.current\.has\(session\.id\)/);
  assert.match(store, /workerReportText\(session\)/);
  // The renderer never sees the key: it asks main.
  assert.match(store, /window\.workhorse\?\.judgeReport/);
  assert.doesNotMatch(store, /ai-gateway\.vercel\.sh/);
  const preload = read("electron", "preload.ts");
  assert.match(preload, /judgeReport: \(input: unknown\) => ipcRenderer\.invoke\("judge:report", input\)/);
  const main = read("electron", "main.ts");
  assert.match(main, /ipcMain\.handle\("judge:report"/);
  assert.match(main, /judgeReadiness\(/);
  const subagents = read("src", "lib", "subagents.ts");
  assert.match(subagents, /reportSaysFor\(session\.agentRun, opts\?\.judge === true\)/);
  assert.match(subagents, /reportSaysFor\(worker\.agentRun, opts\?\.judge === true\)/);
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
});

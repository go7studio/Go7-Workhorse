import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { startRuntimeTask } from "../electron/agent-runtime-host";
import type { AgentRuntimeId } from "../src/lib/types";

const runtimeId = process.argv[2] as AgentRuntimeId | undefined;
if (runtimeId !== "openclaw" && runtimeId !== "hermes") {
  throw new Error("Choose exactly one external harness: openclaw or hermes.");
}

const targetChat = process.env.WORKHORSE_EVAL_HARNESS_TARGET_CHAT?.trim();
const parentSessionId = process.env.WORKHORSE_EVAL_HARNESS_PARENT_CHAT?.trim();
const statePath = process.env.WORKHORSE_STATE_PATH?.trim();
if (!targetChat || !statePath) {
  throw new Error("Set WORKHORSE_EVAL_HARNESS_TARGET_CHAT and WORKHORSE_STATE_PATH; no live call was made.");
}

const nonce = `WH_${runtimeId.toUpperCase()}_${Date.now()}`;
const first = `STEP1_${nonce}`;
const second = `GOAL_${nonce}`;
const terminal = `${runtimeId.toUpperCase()}_COMPLETE_${nonce}`;
const taskId = `smoke_${runtimeId}_${Date.now()}`;
const traceId = `trace_${runtimeId}_${Date.now()}`;
const agentId = runtimeId === "openclaw"
  ? process.env.WORKHORSE_EVAL_OPENCLAW_AGENT?.trim() || "main"
  : process.env.WORKHORSE_EVAL_HERMES_PROFILE?.trim() || "default";
const binary = runtimeId === "openclaw"
  ? process.env.OPENCLAW_BIN?.trim() || "openclaw"
  : process.env.HERMES_BIN?.trim() || "hermes";

const prompt = [
  "Use only Workhorse MCP tools for this bounded goal.",
  `Ask chat ${targetChat}: Return exactly ${first}.`,
  `Read the real reply. Only when it is exactly ${first}, ask the same chat: The prior result was ${first}. Return exactly ${second}.`,
  `Only when the second real reply is exactly ${second}, return exactly ${terminal}. Otherwise return a blocked marker with the mismatch.`,
  "Pass the supplied traceId and fromSessionId on every Workhorse MCP call. Do not spawn another harness or use MiniMax.",
].join(" ");

const task = await startRuntimeTask(
  {
    binary,
    exec: (file, args) => {
      const result = spawnSync(file, args, { encoding: "utf8", timeout: 180_000, windowsHide: true });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.error?.message || result.stderr || "",
      };
    },
  },
  {
    ref: { runtimeId, agentId },
    prompt,
    taskId,
    parentSessionId,
    envelope: { traceId, idempotencyKey: taskId, origin: "workhorse", visitedSystems: ["workhorse"], hopCount: 0 },
    now: Date.now(),
  },
);

if (task.status !== "completed") {
  const reason = task.result || `${runtimeId} did not complete.`;
  if (/no inference provider|not configured|not logged in|authenticate|login|ENOENT|not found/i.test(reason)) {
    console.log(JSON.stringify({ runtimeId, agentId, status: "not_run", reason }, null, 2));
    process.exit(2);
  }
  throw new Error(reason);
}
if (task.result?.trim() !== terminal) throw new Error(`${runtimeId} returned ${JSON.stringify(task.result)} instead of the terminal marker.`);
if (!task.finishedAt || task.finishedAt <= task.startedAt) throw new Error(`${runtimeId} did not record a nonzero terminal duration.`);

type SavedMessage = { role?: string; text?: string; peerFromSessionId?: string; correlationId?: string };
async function savedEvidence(): Promise<SavedMessage[]> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const state = JSON.parse(readFileSync(statePath!, "utf8")) as { sessions?: Array<{ id?: string; messages?: SavedMessage[] }> };
    const rows = state.sessions?.find((session) => session.id === targetChat)?.messages ?? [];
    if (rows.some((message) => message.role === "assistant" && message.text?.trim() === second)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [];
}

const rows = await savedEvidence();
const firstRequest = rows.find((message) => message.role === "user" && message.text?.includes(first));
const hasFirstReply = rows.some((message) => message.role === "assistant" && message.text?.trim() === first);
const secondRequest = rows.find((message) => message.role === "user" && message.text?.includes(second) && message.text?.includes(first));
const hasSecondReply = rows.some((message) => message.role === "assistant" && message.text?.trim() === second);
if (!firstRequest || !hasFirstReply || !secondRequest || !hasSecondReply) {
  throw new Error("The saved Workhorse transcript does not prove both dependent orders and replies.");
}
for (const request of [firstRequest, secondRequest]) {
  if (parentSessionId && request.peerFromSessionId !== parentSessionId) throw new Error("The saved Workhorse request lost its explicit parent chat.");
  if (request.correlationId !== traceId) throw new Error("The saved Workhorse request lost its external task trace.");
}

console.log(JSON.stringify({
  runtimeId,
  agentId,
  taskId,
  traceId,
  parentSessionId: parentSessionId || null,
  status: task.status,
  durationMs: task.finishedAt - task.startedAt,
  workhorseReplies: 2,
  terminal,
}, null, 2));

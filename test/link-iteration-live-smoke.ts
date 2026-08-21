/**
 * Opt-in live Link iteration. Not part of `npm test`.
 *
 * Proves a host can assign an objective as a mission loop, leave, then later
 * read status and the report, and continue remaining work. Desk /goal stays
 * the composer; Link assigns the objective through `workhorse_delegate` + `loop`.
 *
 * Requires a running desk that already has followThrough (0.6.20+).
 *
 *   WORKHORSE_LINK_ITERATION=1 \
 *   WORKHORSE_STATE_PATH="…/workhorse-state.json" \
 *   WORKHORSE_EVAL_LINK_PARENT="sess_…" \
 *   WORKHORSE_MCP_PROFILE=link \
 *   npm run eval:link-iteration
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LINK_FOLLOW_THROUGH, LINK_TOOLS, linkWorkerIdFromReply } from "../src/lib/workhorse-link";
import { handleWorkhorseRpc } from "../electron/workhorse-mcp";

if (process.env.WORKHORSE_LINK_ITERATION !== "1") {
  throw new Error("Set WORKHORSE_LINK_ITERATION=1 for this live, opt-in test.");
}

const statePath = process.env.WORKHORSE_STATE_PATH?.trim();
const parentId = process.env.WORKHORSE_EVAL_LINK_PARENT?.trim();
if (!statePath || !parentId) {
  throw new Error("Set WORKHORSE_STATE_PATH and WORKHORSE_EVAL_LINK_PARENT; no live call was made.");
}

process.env.WORKHORSE_MCP_PROFILE = process.env.WORKHORSE_MCP_PROFILE?.trim() || "link";
process.env.WORKHORSE_STATE_PATH = statePath;

const nonce = `WH_LINK_ITER_${Date.now()}`;
const folder = process.env.WORKHORSE_EVAL_LINK_FOLDER?.trim() || mkdtempSync(path.join(tmpdir(), "wh-link-iter-"));
const markerPath = path.join(folder, "workhorse-link-iteration.txt");
const timeoutMs = Math.max(30_000, Number(process.env.WORKHORSE_EVAL_LINK_TIMEOUT_MS ?? 10 * 60 * 1000));
const pollMs = Math.max(1_000, Number(process.env.WORKHORSE_EVAL_LINK_POLL_MS ?? 2_000));

type RpcText = { error?: { message?: string }; result?: { content?: Array<{ text?: string }> } };

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const reply = (await handleWorkhorseRpc({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name, arguments: args },
  })) as RpcText;
  if (reply.error) throw new Error(reply.error.message ?? "Link call failed");
  return reply.result?.content?.[0]?.text ?? "";
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { text };
  } catch {
    return { text };
  }
}

function listedChats(text: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  } catch {
    /* plain text */
  }
  return [];
}

async function monitor(id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = parseJson(await call("workhorse_agent_status", { id, fromSessionId: parentId }));
    const next = last.next;
    if (next === "done" || next === "failed") return last;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`status stayed ${JSON.stringify(last.next ?? last.status)} past the monitor window`);
}

const capabilities = parseJson(await call("workhorse_capabilities", {}));
if (capabilities.desk !== "online") {
  console.log(JSON.stringify({ status: "not_run", reason: "desk offline" }, null, 2));
  process.exit(2);
}
if (!capabilities.followThrough || JSON.stringify(capabilities.followThrough) !== JSON.stringify(LINK_FOLLOW_THROUGH)) {
  console.log(
    JSON.stringify(
      {
        status: "not_run",
        reason: "desk Link has no followThrough; install 0.6.20+ (merge the open release PR, wait for both signed installers)",
        tools: capabilities.tools,
      },
      null,
      2,
    ),
  );
  process.exit(2);
}
if (!Array.isArray(capabilities.tools) || LINK_TOOLS.some((tool) => !(capabilities.tools as string[]).includes(tool))) {
  throw new Error("capabilities did not list the eight Link tools");
}

const listed = listedChats(await call("workhorse_list_chats", {}));
const parent = listed.find((row) => row.id === parentId);
if (!parent) throw new Error(`parent ${parentId} is not in list_chats`);

const objective = `Prove Link follow-through. Write exactly ${nonce} into ${markerPath}. Do not spawn another worker. Stop when the file exists.`;
const goalAsk = await call("workhorse_ask_chat", {
  chat: parentId,
  message: `set a loop to ${objective}`,
  fromSessionId: parentId,
  idempotencyKey: `goal_${nonce}`,
});

const delegated = parseJson(
  await call("workhorse_delegate", {
    task: objective,
    loop: { acceptanceCriteria: [`${markerPath} exists`, `file contains ${nonce}`], maxIterations: 2 },
    folder,
    fromSessionId: parentId,
    traceId: `trace_${nonce}`,
    idempotencyKey: `deleg_${nonce}`,
  }),
);
const workerId = linkWorkerIdFromReply(JSON.stringify(delegated)) ?? (typeof delegated.childSessionId === "string" ? delegated.childSessionId : "");
if (!workerId) throw new Error(`delegate did not return a worker id: ${JSON.stringify(delegated)}`);
if (delegated.wait === true) throw new Error("Link blocked on wait=true");

const passOne = await monitor(workerId);
if (passOne.next !== "done" && passOne.next !== "failed") throw new Error("pass one did not finish");

let passTwo: Record<string, unknown> | undefined;
let continuedId: string | undefined;
let continueError: string | undefined;
if (passOne.next === "done") {
  const remaining = `Confirm ${markerPath} contains ${nonce}. If it does, say so and stop. If not, write it.`;
  try {
    const continued = parseJson(
      await call("workhorse_continue_mission", {
        previousWorkerIds: [workerId],
        previousPass: 1,
        remainingWork: remaining,
        fromSessionId: parentId,
        traceId: `trace_${nonce}`,
        idempotencyKey: `cont_${nonce}`,
      }),
    );
    continuedId = linkWorkerIdFromReply(JSON.stringify(continued));
    if (continuedId) passTwo = await monitor(continuedId);
    else continueError = `continue_mission returned no worker id: ${JSON.stringify(continued)}`;
  } catch (error) {
    continueError = error instanceof Error ? error.message : String(error);
  }
}

writeFileSync(
  path.join(folder, "iteration-evidence.json"),
  JSON.stringify(
    {
      nonce,
      folder,
      parentId,
      workerId,
      continuedId,
      goalAsk,
      continueError: continueError ?? null,
      passOne: { next: passOne.next, how: passOne.how, status: passOne.status, report: passOne.report ?? passOne.text },
      passTwo: passTwo ? { next: passTwo.next, how: passTwo.how, status: passTwo.status, report: passTwo.report ?? passTwo.text } : null,
    },
    null,
    2,
  ),
);

console.log(
  JSON.stringify(
    {
      status: passOne.next === "failed" && !passTwo ? "failed" : "ok",
      nonce,
      parentId,
      workerId,
      continuedId: continuedId ?? null,
      passOne: passOne.next,
      passTwo: passTwo?.next ?? null,
      report: passTwo?.report ?? passTwo?.text ?? passOne.report ?? passOne.text ?? null,
    },
    null,
    2,
  ),
);
if (passOne.next === "failed" && !passTwo) process.exit(1);

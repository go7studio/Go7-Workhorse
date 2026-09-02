import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  autoAllowPermission,
  deskClampNote,
  elevationForBlock,
  enqueuePermission,
  grantedPolicyAnswer,
  lineageGrant,
  looksLikeDelegationTool,
  looksLikeWriteTool,
  permissionPolicyAnswer,
  promptOwner,
  securityPolicyAnswer,
  classifyElevationInput,
  type LineageChat,
  type PermissionAnswer,
} from "../src/lib/permissions";
import type { DeskAccess, PermissionRequest } from "../src/lib/types";

/**
 * A prompt reaches a person only when a person's own setting blocks the work.
 * The desk's own clamps — a nested helper held read-only, a path-owned worker
 * launched at Ask — are not settings anybody made, so the desk answers those
 * itself from the access the lineage already granted.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Windows CI checks out with autocrlf, so a source pin that reads raw bytes fails there. */
function source(...parts: string[]): string {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
}

const ALWAYS: DeskAccess = { mode: "always-approve", sandbox: "off" };
const PLAN: DeskAccess = { mode: "plan", sandbox: "read-only" };

/** The person's own top-level chat, set to Always at the root. */
const alwaysRoot: LineageChat = { id: "root", mode: "always-approve", sandbox: "off" };
/** The same chat after the person set it to Plan / Read-only. */
const planRoot: LineageChat = { id: "root", mode: "plan", sandbox: "read-only" };

/** A nested helper: read-only because the desk said so, not because anyone asked. */
function helperUnder(root: LineageChat, granted?: DeskAccess): LineageChat {
  return {
    id: "helper",
    parentId: root.id,
    hidden: true,
    mode: root.mode,
    sandbox: "read-only",
    agentRun: { role: "helper", ...(granted ? { grantedAccess: granted } : {}) },
  };
}

/** A path-owned worker: clamped to Ask so its writes still reach the preflight. */
function pathWorkerUnder(root: LineageChat, granted?: DeskAccess): LineageChat {
  return {
    id: "worker",
    parentId: root.id,
    hidden: true,
    mode: "ask",
    sandbox: root.sandbox,
    agentRun: { paths: ["src/lib/permissions.ts"], ...(granted ? { grantedAccess: granted } : {}) },
  };
}

test("lineageGrant reads the grant, then the root chat, then the desk default", () => {
  // 1. The record the desk wrote at spawn, before any clamp (types.ts:389).
  const recorded = helperUnder(planRoot, ALWAYS);
  assert.deepEqual(lineageGrant({ session: recorded, sessions: [planRoot, recorded] }), ALWAYS);

  // 2. No record: climb parentId to the first chat the person can see. Every
  // worker in between is hidden, so the walk does not stop on a clamped seat.
  const helper = helperUnder(alwaysRoot);
  const nested: LineageChat = { ...helper, id: "nested", parentId: "helper" };
  assert.deepEqual(lineageGrant({ session: nested, sessions: [alwaysRoot, helper, nested] }), ALWAYS);
  const tightened = helperUnder(planRoot);
  assert.deepEqual(lineageGrant({ session: tightened, sessions: [planRoot, tightened] }), PLAN);

  // A visible chat is its own lineage — the person set it by hand.
  assert.deepEqual(lineageGrant({ session: planRoot, sessions: [planRoot] }), PLAN);

  // 3. Nothing visible above: Settings › LLMs desk default answers.
  const orphan: LineageChat = { id: "orphan", parentId: "gone", hidden: true, mode: "plan", sandbox: "read-only" };
  assert.deepEqual(lineageGrant({ session: orphan, sessions: [orphan], deskAccess: ALWAYS }), ALWAYS);
  assert.deepEqual(lineageGrant({ session: orphan, sessions: [orphan], deskAccess: PLAN }), PLAN);
  assert.deepEqual(lineageGrant({ sessions: [], deskAccess: PLAN }), PLAN);
  // Shipped fallback when Settings has never been touched.
  assert.deepEqual(lineageGrant({}), ALWAYS);

  // A parent loop must not hang the walk.
  const loopA: LineageChat = { id: "a", parentId: "b", hidden: true, mode: "ask", sandbox: "off" };
  const loopB: LineageChat = { id: "b", parentId: "a", hidden: true, mode: "ask", sandbox: "off" };
  assert.deepEqual(lineageGrant({ session: loopA, sessions: [loopA, loopB], deskAccess: PLAN }), PLAN);
});

test("promptOwner names the person only when the need climbs past the lineage", () => {
  // Under an always-approve root, dropping the sandbox asks for nothing new.
  assert.equal(promptOwner({ sandbox: "off" }, ALWAYS), "desk");
  assert.equal(promptOwner({ mode: "ask", sandbox: "off" }, ALWAYS), "desk");
  assert.equal(promptOwner({}, ALWAYS), "desk");
  // Under a root the person set to Plan / Read-only, it asks for a great deal.
  assert.equal(promptOwner({ sandbox: "off" }, PLAN), "person");
  assert.equal(promptOwner({ mode: "ask" }, PLAN), "person");
  assert.equal(promptOwner({ mode: "ask", sandbox: "off" }, PLAN), "person");
  // A half-step is still the person's: workspace is above read-only.
  assert.equal(promptOwner({ sandbox: "workspace" }, PLAN), "person");
  assert.equal(promptOwner({ sandbox: "workspace" }, { mode: "ask", sandbox: "off" }), "desk");
});

// ---------------------------------------------------------------------------
// Site 1 — the vendor permission event (src/lib/store.tsx).
// ---------------------------------------------------------------------------

type EventInput = { requestId: string; tool: string; detail: string; path?: string };

type SiteOneOutcome = {
  answer: PermissionAnswer | null;
  pending: PermissionRequest[];
  line?: string;
};

/** The order store.tsx runs, so a drift in either one shows up as a failure here. */
function siteOne(input: {
  owner: LineageChat;
  sessions: readonly LineageChat[];
  deskAccess: DeskAccess;
  event: EventInput;
  pending?: PermissionRequest[];
}): SiteOneOutcome {
  const { owner, event } = input;
  const pending = input.pending ?? [];
  const security = securityPolicyAnswer({ tool: event.tool, detail: event.detail, path: event.path, roots: [] });
  const forced =
    security.answer ??
    permissionPolicyAnswer({
      mode: owner.mode,
      sandbox: owner.sandbox,
      tool: event.tool,
      detail: event.detail,
      path: event.path,
    });
  const blocked =
    forced === "deny" && !security.boundary
      ? elevationForBlock({
          mode: owner.mode,
          sandbox: owner.sandbox,
          tool: event.tool,
          detail: event.detail,
          path: event.path,
        })
      : null;
  const lineage = lineageGrant({ session: owner, sessions: input.sessions, deskAccess: input.deskAccess });
  const deskClamp = blocked && promptOwner(blocked, lineage) === "desk" ? deskClampNote(owner.agentRun) : null;
  const need = deskClamp ? null : blocked;
  const request: PermissionRequest = {
    id: event.requestId,
    sessionId: owner.id,
    provider: "grok",
    tool: event.tool,
    detail: event.detail,
    ...(event.path ? { path: event.path } : {}),
  };
  if (need) {
    return { answer: null, pending: enqueuePermission(pending, { ...request, kind: "elevate", elevate: need }) };
  }
  const granted = grantedPolicyAnswer({
    granted: owner.agentRun?.grantedAccess?.mode as DeskAccess["mode"] | undefined,
    sandbox: owner.sandbox,
    tool: event.tool,
    detail: event.detail,
    path: event.path,
  });
  const allowed =
    forced ?? granted ?? autoAllowPermission({ tool: event.tool, detail: event.detail, path: event.path });
  if (allowed) {
    return {
      answer: allowed,
      pending: pending.filter((item) => item.id !== event.requestId),
      ...(allowed === "deny"
        ? {
            line: `Denied by ${security.boundary ?? (owner.sandbox === "read-only" || owner.sandbox === "strict" ? "sandbox" : "plan")}: ${event.tool} — ${event.detail}${deskClamp ? ` · ${deskClamp}` : ""}`,
          }
        : {}),
    };
  }
  return { answer: null, pending: enqueuePermission(pending, request) };
}

const WRITE: EventInput = { requestId: "0", tool: "Write", detail: "src/app.ts", path: "src/app.ts" };

test("a read-only helper under an always-approve root is answered by the desk", () => {
  // The live complaint: five nested helpers held read-only by the desk, under a
  // root the person set to Always, each one asking the person for "elevated
  // permissions" the person had already granted.
  const helper = helperUnder(alwaysRoot, ALWAYS);
  const standing: PermissionRequest[] = [
    { id: "other", sessionId: "elsewhere", provider: "claude", tool: "Read", detail: "notes.md" },
  ];
  const outcome = siteOne({
    owner: helper,
    sessions: [alwaysRoot, helper],
    deskAccess: ALWAYS,
    event: WRITE,
    pending: standing,
  });
  assert.equal(outcome.answer, "deny", "the vendor gets its answer here, not the person");
  assert.deepEqual(outcome.pending, standing, "the pending queue is untouched — nothing was enqueued");
  assert.equal(
    outcome.line,
    "Denied by sandbox: Write — src/app.ts · Helpers are read-only by design; hand this write to your parent.",
    "and the denial names the clamp that stopped it",
  );
});

test("the same helper under a plan/read-only root still asks the person", () => {
  // The person tightened the root. That IS a setting they made, so it prompts.
  const helper = helperUnder(planRoot, PLAN);
  const outcome = siteOne({ owner: helper, sessions: [planRoot, helper], deskAccess: ALWAYS, event: WRITE });
  assert.equal(outcome.answer, null, "no answer is invented on the person's behalf");
  assert.equal(outcome.pending.length, 1);
  assert.equal(outcome.pending[0]?.kind, "elevate");
  assert.deepEqual(outcome.pending[0]?.elevate, { mode: "ask", sandbox: "off" });
});

test("the Ask clamp on a path-owned worker never turns into an elevate", () => {
  // pathOwnerMode holds the vendor session at Ask so in-path writes still reach
  // the ownership preflight. That clamp is the desk's, so it must not raise a
  // need, and the recorded grant answers the write.
  const worker = pathWorkerUnder(alwaysRoot, ALWAYS);
  assert.deepEqual({ mode: worker.mode, sandbox: worker.sandbox }, { mode: "ask", sandbox: "off" });
  const outcome = siteOne({ owner: worker, sessions: [alwaysRoot, worker], deskAccess: ALWAYS, event: WRITE });
  assert.deepEqual(outcome.pending, [], "no prompt for the desk's own path clamp");
  assert.equal(outcome.answer, "session", "the recorded grant answers it");
});

test("a person's read-only sandbox still stops a path-owned worker", () => {
  // The clamp is the mode, never the sandbox. A root the person set to
  // Read-only is their setting, and it reaches them even here.
  const worker = pathWorkerUnder(planRoot, PLAN);
  const outcome = siteOne({ owner: worker, sessions: [planRoot, worker], deskAccess: ALWAYS, event: WRITE });
  assert.equal(outcome.pending[0]?.kind, "elevate");
  assert.deepEqual(outcome.pending[0]?.elevate, { sandbox: "off" });
});

test("a person's own chat set to plan/read-only keeps its prompt", () => {
  const outcome = siteOne({ owner: planRoot, sessions: [planRoot], deskAccess: ALWAYS, event: WRITE });
  assert.equal(outcome.pending[0]?.kind, "elevate", "nothing here was clamped by the desk");
  assert.deepEqual(outcome.pending[0]?.elevate, { mode: "ask", sandbox: "off" });
});

test("the clamp note says which clamp, and says nothing false when there is none", () => {
  assert.equal(deskClampNote({ role: "helper" }), "Helpers are read-only by design; hand this write to your parent.");
  assert.match(deskClampNote({ paths: ["src/app.ts"] }), /path-owned/);
  assert.match(deskClampNote(undefined), /The desk narrowed this launch itself/);
  assert.match(deskClampNote({ paths: [] }), /The desk narrowed this launch itself/);
});

// ---------------------------------------------------------------------------
// Site 2 — workhorse_request_permission from a worker (src/lib/store.tsx).
// ---------------------------------------------------------------------------

type SiteTwoOutcome = { reply: Record<string, unknown>; prompted: boolean };

function siteTwo(input: {
  from: LineageChat;
  sessions: readonly LineageChat[];
  deskAccess: DeskAccess;
  ask: { name?: string; folder?: string; message?: string };
}): SiteTwoOutcome {
  const { from } = input;
  const lineage = lineageGrant({ session: from, sessions: input.sessions, deskAccess: input.deskAccess });
  const classified = classifyElevationInput(
    {
      permission: input.ask.name,
      mode: input.ask.name,
      sandbox: input.ask.folder,
      reason: input.ask.message,
    },
    lineage,
  );
  if (classified.kind !== "raise" || !classified.need) {
    const downgrade = classified.kind === "downgrade";
    if (!downgrade && from.agentRun?.role === "helper") {
      return { reply: { ok: false, reason: "Helpers are read-only by design; the parent owns writes." }, prompted: false };
    }
    if (!downgrade && (from.agentRun?.paths?.length ?? 0) > 0) {
      return {
        reply: {
          ok: true,
          alreadyGranted: true,
          howToUse: "Your writes are answered from the grant this chat carries; keep going.",
        },
        prompted: false,
      };
    }
    return {
      reply: {
        ok: true,
        alreadyElevated: !downgrade,
        refusedDowngrade: downgrade,
        mode: from.mode,
        sandbox: from.sandbox,
      },
      prompted: false,
    };
  }
  return { reply: { need: classified.need }, prompted: true };
}

test("a helper asking for sandbox off is turned back without a prompt", () => {
  const helper = helperUnder(alwaysRoot, ALWAYS);
  const outcome = siteTwo({
    from: helper,
    sessions: [alwaysRoot, helper],
    deskAccess: ALWAYS,
    ask: { folder: "off", message: "need to write the fix" },
  });
  assert.equal(outcome.prompted, false, "the seat is a clamp, not a setting the person made");
  assert.deepEqual(outcome.reply, {
    ok: false,
    reason: "Helpers are read-only by design; the parent owns writes.",
  });
  // Asking with nothing named lands in the same place.
  assert.equal(siteTwo({ from: helper, sessions: [alwaysRoot, helper], deskAccess: ALWAYS, ask: {} }).prompted, false);
});

test("a path-owned worker asking for always-approve is told it already has it", () => {
  const worker = pathWorkerUnder(alwaysRoot, ALWAYS);
  const outcome = siteTwo({
    from: worker,
    sessions: [alwaysRoot, worker],
    deskAccess: ALWAYS,
    ask: { name: "always-approve" },
  });
  assert.equal(outcome.prompted, false);
  assert.deepEqual(outcome.reply, {
    ok: true,
    alreadyGranted: true,
    howToUse: "Your writes are answered from the grant this chat carries; keep going.",
  });
});

test("beyond the lineage grant the worker still reaches the person", () => {
  const worker = pathWorkerUnder(planRoot, PLAN);
  const outcome = siteTwo({
    from: worker,
    sessions: [planRoot, worker],
    deskAccess: ALWAYS,
    ask: { name: "always-approve", folder: "off" },
  });
  assert.equal(outcome.prompted, true, "the person set the root to Plan; only they can move it");
  assert.deepEqual(outcome.reply, { need: { mode: "always-approve", sandbox: "off" } });
});

// ---------------------------------------------------------------------------
// Site 3 — a delegation is not a write (src/lib/permissions.ts).
// ---------------------------------------------------------------------------

test("a Task-variant detail is a delegation, not a write", () => {
  // The live receipt: request id "0" for a worker in a plan/read-only chat,
  // elevate { mode: ask, sandbox: off } for a delegation whose only "write" was
  // the word inside its own brief.
  const brief = JSON.stringify({
    variant: "Task",
    prompt: "IOpenER tail math check. Do not write files. Create nothing; edit nothing.",
  });
  assert.equal(looksLikeDelegationTool("IOpenER tail math check", brief), true);
  assert.equal(looksLikeWriteTool("IOpenER tail math check", brief), false);
  assert.equal(
    elevationForBlock({ mode: "plan", sandbox: "read-only", tool: "IOpenER tail math check", detail: brief }),
    null,
    "no sandbox is demanded on a delegation's account",
  );
  // Under the person's plan/read-only chat it is still an ordinary ask.
  assert.equal(
    permissionPolicyAnswer({ mode: "plan", sandbox: "read-only", tool: "IOpenER tail math check", detail: brief }),
    null,
  );
  // Agent reads the same way, and case does not matter.
  assert.equal(looksLikeWriteTool("helper", JSON.stringify({ variant: "agent", prompt: "edit src/app.ts" })), false);
  // The desk's own delegation tools go by name.
  assert.equal(looksLikeDelegationTool("workhorse_spawn_agent", "another agent"), true);
  assert.equal(looksLikeDelegationTool("workhorse_delegate", "build the thing"), true);
  // A brief clipped before its closing brace still reads as a delegation.
  assert.equal(looksLikeDelegationTool("Task", '{"variant":"Task","prompt":"write the file and then'), true);

  // A real write is untouched, and so is a JSON detail that is not a launch.
  assert.equal(looksLikeWriteTool("Write", "src/app.ts", "src/app.ts"), true);
  assert.equal(looksLikeDelegationTool("Write", JSON.stringify({ variant: "patch", path: "src/app.ts" })), false);
  assert.equal(looksLikeWriteTool("Write", JSON.stringify({ variant: "patch", path: "src/app.ts" })), true);
  assert.equal(looksLikeDelegationTool("Write", "src/app.ts"), false);
});

// ---------------------------------------------------------------------------
// Both store sites, pinned. The functions above are only right if the store
// actually calls them, and in this order.
// ---------------------------------------------------------------------------

test("store.tsx routes both permission sites through the lineage grant", () => {
  const store = source("src", "lib", "store.tsx");

  // Site 1 — the vendor permission event.
  assert.match(
    store,
    /const deskClamp =\n\s*blocked && owner && promptOwner\(blocked, lineage\) === "desk" \? deskClampNote\(owner\.agentRun\) : null;\n\s*const need = deskClamp \? null : blocked;/,
    "a desk-owned block must never become a prompt",
  );
  // A custom host asking to elevate (electron/custom-host.ts) lands on the same
  // `blocked`, so it is classified the same way and cannot drift off on its own.
  assert.match(
    store,
    /const blocked =\n\s*eventElevate && owner\n\s*\? parseElevationInput\(eventElevate as Record<string, unknown>, owner\)\n\s*: owner && forced === "deny" && !security\.boundary\n\s*\? elevationForBlock\(\{/,
    "the custom host's elevate goes through the same classification",
  );
  assert.match(
    source("electron", "custom-host.ts"),
    /elevate: blocked,/,
    "and that is the event it sends",
  );
  assert.match(
    store,
    /const lineage = lineageGrant\(\{\n\s*session: owner,\n\s*sessions: stateRef\.current\.sessions,\n\s*deskAccess: stateRef\.current\.settings\.access,\n\s*\}\);/,
    "the grant is read from the lineage and the desk default, not the seat",
  );
  assert.match(
    store,
    /\$\{event\.detail\}\$\{deskClamp \? ` · \$\{deskClamp\}` : ""\}/,
    "the denial has to name the clamp or the person cannot tell who stopped them",
  );

  // Site 2 — workhorse_request_permission.
  assert.match(
    store,
    /const lineage = lineageGrant\(\{\n\s*session: from,\n\s*sessions: latest\.sessions,\n\s*deskAccess: latest\.settings\.access,\n\s*\}\);/,
  );
  assert.match(
    store,
    /classifyElevationInput\(\n\s*\{\n\s*permission: payload\.name,\n\s*mode: payload\.name,\n\s*sandbox: payload\.folder,\n\s*reason: payload\.message,\n\s*\},\n\s*lineage,\n\s*\)/,
    "the ask is measured against the lineage, never the clamped seat",
  );
  assert.doesNotMatch(
    store,
    /reason: payload\.message,\n\s*\},\n\s*from,\n\s*\)/,
    "the seat must not come back as the comparison",
  );
  assert.match(store, /Helpers are read-only by design; the parent owns writes\./);
  assert.match(store, /Your writes are answered from the grant this chat carries; keep going\./);
});

test("the desk's read-only clamp on a nested helper is still the desk's alone", () => {
  // If nestedWorkerPolicy ever stopped clamping, this lane would be answering a
  // block nobody applied. The clamp and the answer have to stay a matched pair.
  const subagents = source("src", "lib", "subagents.ts");
  assert.match(subagents, /role: "helper",\n\s*readOnly: true,/);
  // And the desk still records the unclamped grant at spawn, which is what the
  // lineage reads first.
  assert.match(source("src", "lib", "store.tsx"), /grantedAccess: workerGrant\(\{ inherited: inheritedAccess, prior: priorWorker \}\)/);
  // The seat itself is unchanged by this lane.
  assert.match(source("src", "lib", "permissions.ts"), /sandbox: input\.readOnly \? "read-only" : input\.inherited\.sandbox,/);
});

test("the permission inbox promise is written down where a person can read it", () => {
  const features = source("docs", "FEATURES.md");
  assert.match(features, /A prompt reaches you only when a\n\s*setting you made is what blocks the work/);
  assert.match(features, /read-only helpers, path-owned launches/);
});

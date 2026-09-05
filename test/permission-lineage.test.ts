import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  autoAllowPermission,
  describeElevation,
  deskClampNote,
  elevationForBlock,
  enqueuePermission,
  grantedPolicyAnswer,
  lineageGrant,
  looksLikeDelegationTool,
  looksLikeSearchOnly,
  looksLikeWriteTool,
  parseElevationInput,
  permissionPolicyAnswer,
  permissionSourceNote,
  promptOwner,
  sandboxSourceNote,
  securityPolicyAnswer,
  standingGrant,
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

type EventInput = {
  requestId: string;
  tool: string;
  detail: string;
  path?: string;
  /** What a custom host sends when it asks the desk to elevate. */
  elevate?: Record<string, unknown>;
};

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
  const blocked = event.elevate
    ? parseElevationInput(event.elevate, { mode: owner.mode, sandbox: owner.sandbox })
    : forced === "deny" && !security.boundary
      ? elevationForBlock({
          mode: owner.mode,
          sandbox: owner.sandbox,
          tool: event.tool,
          detail: event.detail,
          path: event.path,
        })
      : null;
  const lineage = lineageGrant({ session: owner, sessions: input.sessions, deskAccess: input.deskAccess });
  // The desk default is the standing permission for work the system started:
  // a hidden worker's need within it is granted here, no card and no note.
  const standing = blocked ? standingGrant({ session: owner, need: blocked, deskAccess: input.deskAccess }) : null;
  // Past it, a hidden worker never reaches the person; the desk answers and
  // names the source of the sandbox. Only a visible chat's own block still asks.
  const deskClamp = blocked && !standing
    ? owner.hidden
      ? sandboxSourceNote({ session: owner, sessions: input.sessions, deskAccess: input.deskAccess })
      : promptOwner(blocked, lineage) === "desk"
        ? deskClampNote(owner.agentRun)
        : null
    : null;
  const need = deskClamp || standing ? null : blocked;
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
  const answered =
    (standing ? ("once" as const) : null) ??
    forced ??
    granted ??
    autoAllowPermission({ tool: event.tool, detail: event.detail, path: event.path }) ??
    (deskClamp ? ("deny" as const) : null);
  // The ordinary prompt is the other door a subagent used to reach the person.
  const hiddenDeny = !answered && owner.hidden === true;
  const allowed = answered ?? (hiddenDeny ? ("deny" as const) : null);
  const deskNote =
    deskClamp ??
    (hiddenDeny
      ? permissionSourceNote({ session: owner, sessions: input.sessions, deskAccess: input.deskAccess })
      : null);
  const deniedBy =
    security.boundary ??
    (forced === "deny" ? (owner.sandbox === "read-only" || owner.sandbox === "strict" ? "sandbox" : "plan") : "the desk");
  if (allowed) {
    return {
      answer: allowed,
      pending: pending.filter((item) => item.id !== event.requestId),
      ...(allowed === "deny"
        ? { line: `Denied by ${deniedBy}: ${event.tool} — ${event.detail}${deskNote ? ` · ${deskNote}` : ""}` }
        : standing
          ? { line: `Granted from the desk default: ${describeElevation(owner, standing)}. ${event.tool} — ${event.detail}` }
          : {}),
    };
  }
  return { answer: null, pending: enqueuePermission(pending, request) };
}

const WRITE: EventInput = { requestId: "0", tool: "Write", detail: "src/app.ts", path: "src/app.ts" };

test("a read-only helper under an always-approve root is granted the seat by the desk", () => {
  // The live complaint, twice over: five nested helpers held read-only by the
  // desk, under a root the person set to Always, each one asking the person for
  // "elevated permissions" the person had already granted; then, once the card
  // was gone, each one denied and told to "fix the call". The desk default is
  // the standing permission for work the system started, so the desk hands the
  // seat over and the helper writes.
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
  assert.equal(outcome.answer, "once", "the vendor gets its answer here, not the person, and the answer is yes");
  assert.deepEqual(outcome.pending, standing, "the pending queue is untouched — nothing was enqueued");
  assert.match(outcome.line ?? "", /^Granted from the desk default: .*Write — src\/app\.ts$/, "and the transcript says the desk granted it");
});

test("the same helper under a plan/read-only root is granted too: the desk default is the standing permission", () => {
  // Lane 4 raised this one to the person, because the root IS a setting they
  // made. Lane 5 denied it and named the root. Lane 13: the helper is hidden,
  // the system seated it, and the desk default covers the write. Nothing is
  // raised past what the person set on the desk, so the desk grants it.
  const helper = helperUnder(planRoot, PLAN);
  const outcome = siteOne({ owner: helper, sessions: [planRoot, helper], deskAccess: ALWAYS, event: WRITE });
  assert.deepEqual(outcome.pending, [], "a subagent never asks the person");
  assert.equal(outcome.answer, "once");
  assert.match(outcome.line ?? "", /^Granted from the desk default: /);
});

test("past the desk default the same helper is denied and told where the sandbox came from", () => {
  // The desk itself is read-only. That is the ceiling; the desk cannot hand
  // over what the person did not grant anywhere, so it names the source.
  const helper = helperUnder(planRoot, PLAN);
  const outcome = siteOne({
    owner: helper,
    sessions: [planRoot, helper],
    deskAccess: { mode: "always-approve", sandbox: "read-only" },
    event: WRITE,
  });
  assert.deepEqual(outcome.pending, [], "still never a card");
  assert.equal(outcome.answer, "deny");
  assert.match(outcome.line ?? "", /Sandbox Read-only comes from chat “root”/);
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

test("a desk-wide read-only sandbox still stops a path-owned worker", () => {
  // It still stops the write. What changed is who hears about it: the worker
  // is hidden, so the desk denies and names the root, instead of putting a
  // card in front of someone who is not in that chat.
  const worker = pathWorkerUnder(planRoot, PLAN);
  const outcome = siteOne({
    owner: worker,
    sessions: [planRoot, worker],
    deskAccess: { mode: "always-approve", sandbox: "read-only" },
    event: WRITE,
  });
  assert.deepEqual(outcome.pending, []);
  assert.equal(outcome.answer, "deny", "the write is refused all the same");
  assert.match(outcome.line ?? "", /Sandbox Read-only comes from chat “root”/);
});

test("a person's own chat set to plan/read-only keeps its prompt", () => {
  const outcome = siteOne({ owner: planRoot, sessions: [planRoot], deskAccess: ALWAYS, event: WRITE });
  assert.equal(outcome.pending[0]?.kind, "elevate", "nothing here was clamped by the desk");
  assert.deepEqual(outcome.pending[0]?.elevate, { mode: "ask", sandbox: "off" });
});

test("the clamp note says which clamp, and says nothing false when there is none", () => {
  assert.equal(deskClampNote({ role: "helper" }), "This helper was asked to run read-only; hand this write to your parent, or spawn it with a sandbox that can write.");
  assert.match(deskClampNote({ paths: ["src/app.ts"] }), /path-owned/);
  assert.match(deskClampNote(undefined), /The desk narrowed this launch itself/);
  assert.match(deskClampNote({ paths: [] }), /The desk narrowed this launch itself/);
});

test("a desk-owned elevate is granted here, never handed on as a plain prompt", () => {
  // A custom host asks the desk to elevate. The desk default already grants
  // it, so the desk owns the block — but nothing in the policy forced a deny,
  // so the request used to fall past the elevate branch and land in the queue
  // as an ordinary tool prompt. Now the desk answers yes and raises the seat.
  const helper: LineageChat = {
    id: "helper",
    parentId: "root",
    hidden: true,
    mode: "ask",
    sandbox: "read-only",
    agentRun: { role: "helper" },
  };
  const event: EventInput = {
    requestId: "0",
    tool: "Read",
    detail: "notes.md",
    elevate: { permission: "always-approve" },
  };
  const outcome = siteOne({ owner: helper, sessions: [alwaysRoot, helper], deskAccess: ALWAYS, event });
  assert.deepEqual(outcome.pending, [], "nothing reaches the person by either door");
  assert.equal(outcome.answer, "once", "and the answer is the grant, not a denial to fix later");
  assert.match(outcome.line ?? "", /^Granted from the desk default: .*Read — notes\.md$/);
});

test("a real policy deny still names the sandbox, not the desk", () => {
  // The clamp note is an addition to the reason, never a replacement for it.
  // A desk that is itself read-only cannot grant the write, so this one denies.
  const helper = helperUnder(alwaysRoot, ALWAYS);
  const outcome = siteOne({
    owner: helper,
    sessions: [alwaysRoot, helper],
    deskAccess: { mode: "always-approve", sandbox: "read-only" },
    event: WRITE,
  });
  assert.match(outcome.line ?? "", /^Denied by sandbox: /);
  const boundary = siteOne({
    owner: planRoot,
    sessions: [planRoot],
    deskAccess: ALWAYS,
    event: { requestId: "0", tool: "Write", detail: "src/app.ts", path: "src/app.ts" },
  });
  assert.match(boundary.line ?? "", /^Denied by plan: |^Denied by sandbox: |^$/);
});

// ---------------------------------------------------------------------------
// The write heuristic reads the tool's name, never the words it was handed.
// ---------------------------------------------------------------------------

test("a shell is judged by the program it invokes, not by words in the command", () => {
  // The hole: the read exemption matched "search" anywhere in tool+detail+path
  // and excluded only write/edit/replace/delete, so a destructive shell command
  // whose argument happened to contain the word walked straight through a
  // read-only sandbox.
  assert.equal(looksLikeWriteTool("shell", "rm -rf ~/search"), true);
  assert.equal(
    permissionPolicyAnswer({ mode: "ask", sandbox: "read-only", tool: "shell", detail: "rm -rf ~/search" }),
    "deny",
    "a read-only sandbox has to stop it",
  );
  assert.equal(looksLikeWriteTool("shell", "mv build dist && ./deploy.sh # search"), true);
  assert.equal(looksLikeWriteTool("bash", "cp -r src ~/list_dir"), true);

  // A search program in a shell is still a search.
  assert.equal(looksLikeWriteTool("shell", "grep -rn foo src"), false);
  assert.equal(looksLikeWriteTool("shell", "rg --files"), false);
  assert.equal(looksLikeWriteTool("shell", "rg foo && rm notes.md"), true, "chained onto a delete it is not");
});

test("a read tool is a read whatever its path or query says", () => {
  // The other half of the same hole: a read whose path carried a write word was
  // denied as a write.
  assert.equal(looksLikeWriteTool("read_file", "src/delete-me.ts", "src/delete-me.ts"), false);
  assert.equal(
    permissionPolicyAnswer({
      mode: "ask",
      sandbox: "read-only",
      tool: "read_file",
      detail: "src/delete-me.ts",
      path: "src/delete-me.ts",
    }),
    null,
    "reading a file is not blocked by what the file is called",
  );
  assert.equal(looksLikeWriteTool("grep", "grep -rn 'write' src"), false);
  assert.equal(looksLikeWriteTool("mcp__fs__read_file", "notes.md"), false, "a vendor namespace still reads");
  // And a write tool is still a write, however it is named.
  assert.equal(looksLikeWriteTool("search_replace", "src/app.ts", "src/app.ts"), true);
  assert.equal(looksLikeWriteTool("str_replace", "src/app.ts"), true);
  assert.equal(looksLikeWriteTool("Write", "notes.md", "notes.md"), true);
});

test("search-only means the program is a search, not that the word appears", () => {
  // A brief that mentions grep is a brief, and it was auto-allowed as a search.
  assert.equal(looksLikeSearchOnly("Task", "run a grep over the tree and report"), false);
  assert.equal(
    permissionPolicyAnswer({ mode: "ask", sandbox: "read-only", tool: "Task", detail: "run a grep over the tree" }),
    null,
    "no free pass from a word in the payload",
  );
  assert.equal(looksLikeSearchOnly("grep", "foo src"), true);
  assert.equal(looksLikeSearchOnly("rg", "rg -n leftover src"), true);
  assert.equal(looksLikeSearchOnly("shell", "rg pattern"), true);
  assert.equal(looksLikeSearchOnly("shell", "rg pattern && rm -rf x"), false);
  assert.equal(looksLikeSearchOnly("Read", "notes.md"), false, "a read still answers to the chat's own setting");
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
      return { reply: { ok: false, reason: "This helper was asked to run read-only; the parent owns its writes." }, prompted: false };
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
  if (from.hidden) {
    const standing = standingGrant({ session: from, need: classified.need, deskAccess: input.deskAccess });
    if (standing) return { reply: { ok: true, elevated: true, granted: standing }, prompted: false };
    return {
      reply: {
        ok: false,
        reason: sandboxSourceNote({ session: from, sessions: input.sessions, deskAccess: input.deskAccess }),
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
    reason: "This helper was asked to run read-only; the parent owns its writes.",
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

test("within the desk default a hidden worker is granted the seat, with no card and no note", () => {
  // The person set the desk to always-approve/off. A worker the system seated
  // lower asks for what the desk already allows: that is not a raise past
  // anything the person set, so the desk hands it over and the worker goes on.
  const worker = pathWorkerUnder(planRoot, PLAN);
  const outcome = siteTwo({
    from: worker,
    sessions: [planRoot, worker],
    deskAccess: ALWAYS,
    ask: { name: "always-approve", folder: "off" },
  });
  assert.equal(outcome.prompted, false, "a subagent's ask is never a card");
  assert.deepEqual(outcome.reply, { ok: true, elevated: true, granted: { mode: "always-approve", sandbox: "off" } });
});

test("past the desk default a hidden worker is told where to ask instead", () => {
  const worker = pathWorkerUnder(planRoot, PLAN);
  const outcome = siteTwo({
    from: worker,
    sessions: [planRoot, worker],
    deskAccess: { mode: "ask", sandbox: "read-only" },
    ask: { name: "always-approve", folder: "off" },
  });
  assert.equal(outcome.prompted, false, "a subagent's ask is never a card");
  assert.deepEqual(outcome.reply, {
    ok: false,
    reason: "Sandbox Read-only comes from chat “root”; ask for sandbox: off in the call, or raise that chat's Sandbox.",
  });
});

test("a visible chat's own ask still reaches the person", () => {
  // The one card that survives: the person's own chat asking to lift the
  // Permission or Sandbox they set on it, seen where they set it.
  const outcome = siteTwo({
    from: planRoot,
    sessions: [planRoot],
    deskAccess: ALWAYS,
    ask: { name: "always-approve", folder: "off" },
  });
  assert.equal(outcome.prompted, true);
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
    /promptOwner\(blocked, lineage\) === "desk"\n\s*\? deskClampNote\(owner\.agentRun\)\n\s*: null\n\s*: null;\n\s*const need = deskClamp \|\| standing \? null : blocked;/,
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
    /\$\{event\.detail\}\$\{deskNote \? ` · \$\{deskNote\}` : ""\}/,
    "the denial has to name the clamp or the person cannot tell who stopped them",
  );
  assert.match(
    store,
    /\}\) \?\?\n\s*\(deskClamp \? \("deny" as const\) : null\);/,
    "a block the desk owns is answered here; it must never reach the plain enqueue",
  );
  // And neither must an ordinary request from a chat the person is not in.
  assert.match(
    store,
    /const hiddenDeny = !answered && owner\?\.hidden === true;\n\s*const allowed = answered \?\? \(hiddenDeny \? \("deny" as const\) : null\);/,
    "the ordinary prompt is the second door, and a subagent must not walk through it",
  );
  assert.match(
    store,
    /const deniedBy =\n\s*security\.boundary \?\?\n\s*\(forced === "deny"\n(.|\n)*?: "the desk"\);/,
    "and the reason has to be the one that actually applied",
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
  // The guard has to reach the reply. Pinning the sentence alone let a mutation
  // dead-code the branch — the words stayed in the file and the pin held.
  assert.match(
    store,
    /if \(!downgrade && from\.agentRun\?\.role === "helper"\) \{[\s\S]{0,260}?reason: "This helper was asked to run read-only; the parent owns its writes\.",/,
    "a helper's ask is answered from its own branch",
  );
  assert.match(
    store,
    /if \(!downgrade && \(from\.agentRun\?\.paths\?\.length \?\? 0\) > 0\) \{[\s\S]{0,320}?howToUse: "Your writes are answered from the grant this chat carries; keep going\.",/,
    "and a path-owned worker from its own",
  );
});

test("the desk's read-only clamp on a nested helper is still the desk's alone", () => {
  // If nestedWorkerPolicy ever stopped clamping, this lane would be answering a
  // block nobody applied. The clamp and the answer have to stay a matched pair.
  const subagents = source("src", "lib", "subagents.ts");
  assert.match(subagents, /role: "helper",\n\s*readOnly: true,/);
  // And the desk still records the unclamped grant at spawn, which is what the
  // lineage reads first.
  assert.match(
    source("src", "lib", "store.tsx"),
    /grantedAccess: \{ \.\.\.workerGrant\(\{ inherited: callAccess\.granted, prior: priorWorker \}\), source: callAccess\.source \}/,
  );
  // The seat itself is unchanged by this lane.
  assert.match(source("src", "lib", "permissions.ts"), /sandbox: input\.readOnly \? "read-only" : input\.inherited\.sandbox,/);
});

test("the permission inbox promise is written down where a person can read it", () => {
  const features = source("docs", "FEATURES.md");
  assert.match(features, /A delegation's access is decided at\n\s*the call/);
  assert.match(features, /A subagent never asks\n\s*you/);
});

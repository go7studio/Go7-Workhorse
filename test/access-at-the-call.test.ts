import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  autoAllowPermission,
  grantedAccessLine,
  grantedPolicyAnswer,
  inboundAccess,
  permissionGrantKey,
  permissionPolicyAnswer,
  permissionSourceNote,
  parseCallPermission,
  parseSandboxValue,
  releasedHelper,
  requestedWorkerAccess,
  sandboxSourceNote,
  spawnAccessLogDetail,
  workerAccess,
  workerGrant,
  workerTightening,
  type LineageChat,
  type PermissionAnswer,
} from "../src/lib/permissions";
import type { DeskAccess, PermissionGrant } from "../src/lib/types";

/**
 * Permission and Sandbox are the person's settings. A coordinator may pick
 * who works, not what they are allowed to do.
 *
 * The live complaint: Wren · Playthrough UX review sat at Ask under a parent
 * the person had set to Always allow, because the spawn call passed
 * permission: ask. The composer chip then looked like the desk had fallen
 * back to Ask. The call must not move the seat.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Windows CI checks out with autocrlf, so a source pin that reads raw bytes fails there. */
function source(...parts: string[]): string {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
}

/**
 * The text between two markers. A pin written as `name: "X"[\s\S]*?field:`
 * passes when the field is deleted from X and still present in the NEXT tool
 * down the file — which is exactly how a dropped `sandbox` on delegate went
 * unnoticed. Slicing the block first makes the pin mean what it says.
 */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing ${end} after ${start}`);
  return text.slice(from, to);
}

const DESK_DEFAULT: DeskAccess = { mode: "always-approve", sandbox: "off" };
const READ_ONLY_REVIEW: DeskAccess = { mode: "always-approve", sandbox: "read-only" };

// ---------------------------------------------------------------------------
// requestedWorkerAccess — the parent seat, and the call cannot move it.
// ---------------------------------------------------------------------------

test("a requested seat is ignored: the child copies the parent", () => {
  // The live row: parent is Always / Full access. The spawn call passed
  // permission: ask. The child used to land at Ask. It must stay Always.
  const dropped = requestedWorkerAccess({
    requested: { mode: "ask", sandbox: "workspace" },
    inherited: DESK_DEFAULT,
    ceiling: DESK_DEFAULT,
  });
  assert.deepEqual(dropped.granted, DESK_DEFAULT);
  assert.equal(dropped.source, "inherited");
  assert.equal(dropped.refused, undefined);

  // A call asking to raise a read-only parent also cannot move the seat.
  const raised = requestedWorkerAccess({
    requested: { sandbox: "off" },
    inherited: READ_ONLY_REVIEW,
    ceiling: DESK_DEFAULT,
  });
  assert.deepEqual(raised.granted, READ_ONLY_REVIEW);
  assert.equal(raised.source, "inherited");
});

test("a silent call copies the parent, including a parent the person tightened", () => {
  const silent = requestedWorkerAccess({ inherited: READ_ONLY_REVIEW, ceiling: DESK_DEFAULT });
  assert.deepEqual(silent.granted, READ_ONLY_REVIEW);
  assert.equal(silent.source, "inherited");
  assert.equal(silent.refused, undefined);
  assert.equal(requestedWorkerAccess({ requested: {}, inherited: READ_ONLY_REVIEW }).source, "inherited");
  assert.deepEqual(
    requestedWorkerAccess({ inherited: { mode: "ask", sandbox: "read-only" }, ceiling: DESK_DEFAULT }).granted,
    { mode: "ask", sandbox: "read-only" },
  );
});

test("plan is not a seat a call may hand a child", () => {
  // A worker parked in Plan cannot write and cannot report; it would sit there
  // until it timed out. The parser drops it, so the child inherits instead.
  assert.equal(parseCallPermission("plan"), undefined);
  assert.equal(parseCallPermission("ask"), "ask");
  assert.equal(parseCallPermission("always"), "always-approve");
  assert.equal(parseCallPermission("accept-edits"), "accept-edits");
  assert.equal(parseCallPermission(undefined), undefined);
  assert.equal(parseCallPermission("nonsense"), undefined);
});

// ---------------------------------------------------------------------------
// The whole spawn seat, the way store.tsx assembles it.
// ---------------------------------------------------------------------------

/** The order store.tsx runs at the spawn site, so a drift there fails here. */
function spawnSeat(input: {
  caller: DeskAccess;
  desk: DeskAccess;
  call?: { permission?: string; sandbox?: string };
  nested?: boolean;
  owned?: boolean;
}): { seat: DeskAccess; granted: DeskAccess & { source: string }; role?: string; log: string; line: string } {
  const requested = {
    ...(parseCallPermission(input.call?.permission) ? { mode: parseCallPermission(input.call?.permission)! } : {}),
    ...(parseSandboxValue(input.call?.sandbox) ? { sandbox: parseSandboxValue(input.call?.sandbox)! } : {}),
  };
  const callAccess = requestedWorkerAccess({ requested, inherited: input.caller, ceiling: input.desk });
  const nestedRole = input.nested ? "helper" : undefined;
  return {
    seat: workerAccess({
      inherited: callAccess.granted,
      owned: Boolean(input.owned),
    }),
    granted: { ...workerGrant({ inherited: callAccess.granted }), source: callAccess.source },
    role: nestedRole,
    log: spawnAccessLogDetail({
      child: "sess_child",
      parent: "sess_pj3m99rpahx5",
      requested,
      granted: callAccess.granted,
      ceiling: input.desk,
      source: callAccess.source,
    }),
    line: grantedAccessLine(callAccess),
  };
}

test("a delegate call with sandbox off under a read-only caller still yields read-only", () => {
  // The person set the parent to read-only. The spawn call asking for off
  // cannot raise that. The child copies the parent.
  const spawned = spawnSeat({ caller: READ_ONLY_REVIEW, desk: DESK_DEFAULT, call: { sandbox: "off" } });
  assert.deepEqual(spawned.seat, READ_ONLY_REVIEW, "the call cannot raise the parent seat");
  assert.equal(spawned.granted.source, "inherited");
  assert.equal(
    spawned.log,
    "child=sess_child parent=sess_pj3m99rpahx5 requested=-/off granted=always-approve/read-only cap=always-approve/off source=inherited",
  );
  assert.equal(spawned.line, "Permission Always approve, Sandbox Read-only (inherited from the caller).");
});

test("a silent call under the same caller yields read-only, source inherited", () => {
  const spawned = spawnSeat({ caller: READ_ONLY_REVIEW, desk: DESK_DEFAULT });
  assert.deepEqual(spawned.seat, READ_ONLY_REVIEW, "silence is still the caller's seat");
  assert.equal(spawned.granted.source, "inherited");
  assert.match(
    spawned.log,
    /requested=none granted=always-approve\/read-only cap=always-approve\/off source=inherited$/,
  );
  assert.equal(spawned.line, "Permission Always approve, Sandbox Read-only (inherited from the caller).");
});

test("a nested helper copies the parent seat; the call cannot clamp it", () => {
  const silent = spawnSeat({ caller: DESK_DEFAULT, desk: DESK_DEFAULT, nested: true });
  assert.equal(silent.seat.sandbox, DESK_DEFAULT.sandbox);
  assert.equal(silent.role, "helper");

  const asked = spawnSeat({ caller: DESK_DEFAULT, desk: DESK_DEFAULT, nested: true, call: { sandbox: "read-only" } });
  assert.equal(asked.seat.sandbox, DESK_DEFAULT.sandbox, "the call cannot clamp a helper");
  assert.equal(asked.role, "helper");
  assert.equal(releasedHelper({ role: "helper", requestedSandbox: "read-only" }), true);
  assert.equal(releasedHelper({ role: "worker" }), false);
});

test("a path-owned worker still launches at Ask so ownership can be preflighted", () => {
  const spawned = spawnSeat({
    caller: DESK_DEFAULT,
    desk: DESK_DEFAULT,
    call: { permission: "always-approve", sandbox: "off" },
    owned: true,
  });
  assert.equal(spawned.seat.mode, "ask", "the preflight still gets to read the writes");
  assert.equal(spawned.seat.sandbox, "off");
  assert.equal(spawned.granted.mode, "always-approve", "and the desk answers those writes from this");
});

// ---------------------------------------------------------------------------
// The denial a subagent gets instead of a card.
// ---------------------------------------------------------------------------

const reviewChat: LineageChat = {
  id: "sess_pj3m99rpahx5",
  title: "Adversarial product and eval review only",
  mode: "always-approve",
  sandbox: "read-only",
};

const nadia: LineageChat = {
  id: "sess_mtjzcdi8o6qj08",
  parentId: reviewChat.id,
  hidden: true,
  title: "Nadia 2 · AMA read as agent operator",
  mode: "always-approve",
  sandbox: "read-only",
  agentRun: { grantedAccess: { mode: "always-approve", sandbox: "read-only", source: "inherited" } },
};

test("the denial names the chat the sandbox came from, and both ways to change it", () => {
  // A read-only seat leads with what it can still run, because the worker
  // reading this line was usually refused for a call it could have made in
  // another form. Then it names the chat and both ways to change it.
  assert.equal(
    sandboxSourceNote({ session: nadia, sessions: [reviewChat, nadia], deskAccess: DESK_DEFAULT }),
    "Read-only sandbox: gh, git and search reads are allowed; interpreters and writes are not. " +
      "Sandbox Read-only comes from chat “Adversarial product and eval review only”; " +
      "raise that chat's Sandbox.",
  );
  // Any depth: a helper under Nadia climbs past every hidden row to the chat
  // the person can actually see and open.
  const deeper: LineageChat = { ...nadia, id: "sess_deep", parentId: nadia.id, title: "helper" };
  assert.match(
    sandboxSourceNote({ session: deeper, sessions: [reviewChat, nadia, deeper] }),
    /chat “Adversarial product and eval review only”/,
  );
  // A seat the call itself set is not blamed on a chat nobody touched.
  const byCall: LineageChat = {
    ...nadia,
    agentRun: { grantedAccess: { mode: "ask", sandbox: "read-only", source: "call" } },
  };
  assert.match(sandboxSourceNote({ session: byCall, sessions: [reviewChat, byCall] }), /this delegation's own call/);
  // Nothing visible above, and no session at all, both fall to the desk.
  const orphan: LineageChat = { id: "orphan", parentId: "gone", hidden: true, mode: "ask", sandbox: "strict" };
  assert.equal(
    sandboxSourceNote({ session: orphan, sessions: [orphan] }),
    "Read-only sandbox: gh, git and search reads are allowed; interpreters and writes are not. " +
      "Sandbox Strict comes from the desk default; raise that chat's Sandbox.",
  );
  assert.match(sandboxSourceNote({ deskAccess: { mode: "ask", sandbox: "workspace" } }), /Sandbox Workspace comes from the desk default/);
});

// ---------------------------------------------------------------------------
// A new chat starts at the desk default, not at the last chat of that vendor.
// ---------------------------------------------------------------------------

test("a new chat after a read-only chat of the same vendor starts at the desk default", () => {
  const afterReadOnly = inboundAccess({ desk: DESK_DEFAULT, vendor: undefined });
  assert.deepEqual(afterReadOnly, DESK_DEFAULT, "memory of a seat is not a setting on the new chat");
  // A vendor app's own config is not a Workhorse setting.
  assert.deepEqual(inboundAccess({ desk: DESK_DEFAULT, vendor: { mode: "ask", sandbox: "read-only" } }), DESK_DEFAULT);
  assert.deepEqual(inboundAccess({ desk: { mode: "ask", sandbox: "workspace" } }), {
    mode: "ask",
    sandbox: "workspace",
  });
});

test("startSession no longer seeds a new chat's seat from the last chat", () => {
  const store = source("src", "lib", "store.tsx");
  assert.match(
    store,
    /const seat = inboundAccess\(\{\n\s*desk: current\.settings\.access,\n\s*\}\);/,
    "a new chat takes the desk default, not a vendor app's config",
  );
  assert.doesNotMatch(store, /rememberedAccess/, "the seat memory is gone, not merely unused");
  assert.match(store, /const picked = provider \?\? remembered!\.provider;/);
  assert.match(store, /effort: withEffort\(picked, model, remembered\?\.effort \?\? null\)/);
  assert.match(store, /function rememberLastModel\(/);
  assert.match(store, /if \(!session \|\| session\.hidden\) return lastModel;/);
});

// ---------------------------------------------------------------------------
// The schemas, the payload, and the CLI — pinned where a caller reads them.
// ---------------------------------------------------------------------------

test("both spawn tool declarations tell coordinators permission and sandbox are ignored", () => {
  const mcp = source("electron", "workhorse-mcp.ts");
  const ignored = /permission: \{ type: "string", description: "Ignored\. This chat's Permission is the person's setting/;
  const ignoredBox = /sandbox: \{ type: "string", description: "Ignored\. This chat's Sandbox is the person's setting/;
  const delegate = between(mcp, 'name: "workhorse_delegate",', 'name: "workhorse_continue_mission",');
  assert.match(delegate, ignored);
  assert.match(delegate, ignoredBox);

  const spawn = between(mcp, 'name: "workhorse_spawn_agent",', 'name: "workhorse_await_agents",');
  assert.match(spawn, ignored);
  assert.match(spawn, ignoredBox);

  const custom = between(source("electron", "custom-tools.ts"), 'name: "workhorse_spawn_agent",', 'name: "workhorse_await_agents",');
  assert.match(custom, ignored);
  assert.match(custom, ignoredBox);
});

test("the call's seat reaches the /spawn payload and comes back as a decision", () => {
  const mcp = source("electron", "workhorse-mcp.ts");
  // Both handlers read the fields off the tool arguments, each pinned inside
  // its own branch so one handler cannot answer for the other.
  const reads = /permission: typeof args\.permission === "string" \? args\.permission : undefined,\n\s*sandbox: typeof args\.sandbox === "string" \? args\.sandbox : undefined,/;
  assert.match(between(mcp, 'if (name === "workhorse_delegate") {', 'if (name === "workhorse_continue_mission") {'), reads);
  assert.match(between(mcp, 'if (name === "workhorse_spawn_agent") {', 'if (name === "workhorse_await_agents") {'), reads);
  // ...and both /spawn posts carry them, or the retry would silently drop the
  // seat and the second attempt would run at a different access.
  assert.equal(
    (mcp.match(/permission: spawnInput\.permission,\n\s*sandbox: spawnInput\.sandbox,/g) ?? []).length,
    2,
    "the first post and the retry both carry the requested seat",
  );
  // The wire type declares them, so the store's read is a typed read.
  assert.match(source("electron", "peer-inbox.ts"), /permission\?: string;\n\s*sandbox\?: string;/);
  // The spawn result states the seat on both replies — started and completed.
  const store = source("src", "lib", "store.tsx");
  assert.equal((store.match(/access: accessReceipt,/g) ?? []).length, 2);
  assert.match(store, /summary: grantedAccessLine\(callAccess\),/);
  // And the desk's own main log gets one line per delegation.
  assert.match(mcp, /openMainLog\(userData\)\.record\("spawn:access", detail\);/);
  assert.equal((mcp.match(/recordSpawnAccess\(/g) ?? []).length, 3, "declared once, called on both spawn replies");
});

test("the CLI can hand a delegation its seat", () => {
  const mcp = source("electron", "workhorse-mcp.ts");
  // Value flags, or --sandbox off parses as a switch and "off" becomes a positional.
  assert.match(mcp, /"--permission", "--sandbox",/);
  assert.match(
    mcp,
    /if \(sub === "delegate"\)[\s\S]*?\.\.\.\(flag\("permission"\) \? \{ permission: flag\("permission"\) \} : \{\}\),\n\s*\.\.\.\(flag\("sandbox"\) \? \{ sandbox: flag\("sandbox"\) \} : \{\}\),/,
  );
  // Usage says so in both places a person reads it.
  assert.equal(
    (mcp.match(/\[--permission <seat>\] \[--sandbox <profile>\]/g) ?? []).length,
    4,
    "delegate and follow-up, each in the doc comment and the runtime usage line",
  );
});

test("the store seats a worker from the parent, not from the call", () => {
  const store = source("src", "lib", "store.tsx");
  assert.match(
    store,
    /const callAccess = requestedWorkerAccess\(\{\n\s*inherited: callerAccess,\n\s*\}\);/,
    "the call cannot name a seat",
  );
  assert.match(store, /inherited: callAccess\.granted,\n\s*owned: assignedPaths\.length > 0,/);
  assert.doesNotMatch(store, /readOnly: nestedPolicy\.readOnly && !helperReleased/);
  assert.match(store, /grantedAccess: \{ \.\.\.workerGrant\(\{ inherited: callAccess\.granted, prior: priorWorker \}\), source: callAccess\.source \}/);
  // The guard, not the sentence: a hidden owner must reach sandboxSourceNote
  // and the note must reach `need`, so dead-coding the branch fails this.
  assert.match(
    store,
    /blocked && owner && !standing\n\s*\? owner\.hidden\n\s*\? sandboxSourceNote\(\{[\s\S]{0,200}?\}\)\n\s*: promptOwner\(blocked, lineage\) === "desk"/,
    "site 1: a subagent's block past the desk default is answered, a visible chat's is not",
  );
  assert.match(
    store,
    /if \(from\.hidden\) \{[\s\S]{0,2600}?reason: sandboxSourceNote\(\{/,
    "site 2: the same rule on workhorse_request_permission, past the standing grant",
  );
  // The elevate enqueue still exists below that guard, for the visible chat.
  assert.match(store, /if \(from\.hidden\) \{[\s\S]{0,3400}?const need = classified\.need;[\s\S]{0,600}?kind: "elevate",/);
});

test("the rules text tells a coordinator not to pass permission or sandbox", async () => {
  const rules = source("src", "lib", "workhorse-rules.ts");
  assert.match(rules, /Do not pass permission or sandbox on a spawn/);
  assert.match(rules, /You cannot raise, lower, or retune a worker's access from the call/);
  // Since S11 there is one spawn law, and every coordinator surface reaches it
  // rather than keeping its own copy. Checked on the built text, not on how
  // many times the source concatenates the constant.
  const { DESK_SPAWN_LAW, SPAWN_TURN_HINT, withCrewModeHint, withSpawnHint } = await import(
    "../src/lib/workhorse-rules"
  );
  assert.match(DESK_SPAWN_LAW, /Do not pass permission or sandbox on a spawn/);
  for (const surface of [
    SPAWN_TURN_HINT,
    withSpawnHint("Spawn two agents to review this."),
    withCrewModeHint("Do the work.", "orchestrate"),
    withCrewModeHint("Do the work.", "mission"),
  ]) {
    assert.ok(surface.includes(DESK_SPAWN_LAW), "every coordinator surface carries it");
  }
  assert.match(rules, /Do not pass permission or sandbox on a helper spawn/);
  assert.equal((rules.match(/HELPER_ACCESS_LAW \+/g) ?? []).length, 2, "both worker surfaces carry the short form");
});

test("LINK.md states that spawn cannot set a worker's seat", () => {
  const link = source("docs", "LINK.md");
  assert.match(link, /Permission and Sandbox are the person's settings/);
  assert.match(link, /`permission` and `sandbox` on `workhorse_delegate`/);
  assert.match(link, /are ignored if sent/);
  assert.match(link, /The worker copies the parent chat's current seat/);
});

// ---------------------------------------------------------------------------
// The second door: the ordinary permission prompt.
// ---------------------------------------------------------------------------

/**
 * The elevate card was the door everyone looked at. The plain prompt is the
 * other one, and a seat on Ask walks straight through it: Ask does not refuse
 * a write, it declines to answer, so nothing upstream produces a deny and the
 * request lands in the queue as an ordinary question. For a chat the person
 * cannot see, that question has no one to answer it.
 *
 * This is site 1's tail, in the order store.tsx runs it.
 */
function ordinaryPath(input: {
  owner: LineageChat;
  sessions: readonly LineageChat[];
  deskAccess: DeskAccess;
  event: { tool: string; detail: string; path?: string };
  grants?: PermissionGrant[];
}): { answer: PermissionAnswer | null; enqueued: boolean; line?: string } {
  const { owner, event } = input;
  const forced = permissionPolicyAnswer({
    mode: owner.mode,
    sandbox: owner.sandbox,
    tool: event.tool,
    detail: event.detail,
    path: event.path,
  });
  const granted = grantedPolicyAnswer({
    granted: owner.agentRun?.grantedAccess?.mode,
    sandbox: owner.sandbox,
    tool: event.tool,
    detail: event.detail,
    path: event.path,
  });
  const answered =
    forced ??
    granted ??
    autoAllowPermission({ tool: event.tool, detail: event.detail, path: event.path, grants: input.grants }) ??
    null;
  const hiddenDeny = !answered && owner.hidden === true;
  const allowed = answered ?? (hiddenDeny ? ("deny" as const) : null);
  const note = hiddenDeny
    ? permissionSourceNote({ session: owner, sessions: input.sessions, deskAccess: input.deskAccess })
    : null;
  return {
    answer: allowed,
    enqueued: !allowed,
    ...(allowed === "deny" && note ? { line: `Denied by the desk: ${event.tool} — ${event.detail} · ${note}` } : {}),
  };
}

/** The person's own chat, set to Ask. Visible, so its prompts are theirs to answer. */
const askChat: LineageChat = { id: "sess_ask", title: "Nightly cleanup", mode: "ask", sandbox: "off" };

/** A subagent under it, inheriting Ask because the call named no seat. */
const askWorker: LineageChat = {
  id: "sess_worker",
  parentId: askChat.id,
  hidden: true,
  title: "Wren · tidy the fixtures",
  mode: "ask",
  sandbox: "off",
  agentRun: { grantedAccess: { mode: "ask", sandbox: "off", source: "inherited" } },
};

const WRITE = { tool: "Write", detail: "src/app.ts", path: "src/app.ts" };

test("an Ask-mode subagent's write is answered by the desk, never queued", () => {
  // Nothing above this refuses: the sandbox is off and Ask is not a deny. The
  // request used to reach the plain enqueue and card the person from a chat
  // they are not in — the same surprise the elevate path already stopped.
  const outcome = ordinaryPath({
    owner: askWorker,
    sessions: [askChat, askWorker],
    deskAccess: DESK_DEFAULT,
    event: WRITE,
  });
  assert.equal(outcome.enqueued, false, "a subagent never asks the person, by either door");
  assert.equal(outcome.answer, "deny");
  assert.equal(
    outcome.line,
    "Denied by the desk: Write — src/app.ts · Permission Ask comes from chat “Nightly cleanup”; " +
      "raise that chat's Permission.",
    "and the denial names the seat that stopped it and the two ways to change it",
  );
});

test("the same chat's own write still reaches the person", () => {
  // The one prompt that survives: the person's own visible chat, set to Ask by
  // them, asking them. Deny that and the desk answers for someone who is right
  // there — which is the opposite mistake.
  const outcome = ordinaryPath({
    owner: askChat,
    sessions: [askChat],
    deskAccess: DESK_DEFAULT,
    event: WRITE,
  });
  assert.equal(outcome.enqueued, true, "a visible chat's Ask is a question for the person");
  assert.equal(outcome.answer, null);
});

test("the desk answers a subagent from its own seat before it ever denies", () => {
  // Deny is the last resort, not the rule. Anything the worker's grant, its
  // session grants, or a quiet desk tool already allows is allowed.
  const always: LineageChat = {
    ...askWorker,
    agentRun: { grantedAccess: { mode: "always-approve", sandbox: "off", source: "call" } },
  };
  assert.equal(
    ordinaryPath({ owner: always, sessions: [askChat, always], deskAccess: DESK_DEFAULT, event: WRITE }).answer,
    "session",
    "a call that asked for always-approve gets its writes answered, not refused",
  );
  // A search runs under Ask on its own merits, hidden or not.
  const search = { tool: "grep", detail: "grep -rn leftover src" };
  assert.equal(
    ordinaryPath({ owner: askWorker, sessions: [askChat, askWorker], deskAccess: DESK_DEFAULT, event: search }).answer,
    "once",
  );
  // A quiet desk tool is answered the same way it always was.
  assert.equal(
    ordinaryPath({
      owner: askWorker,
      sessions: [askChat, askWorker],
      deskAccess: DESK_DEFAULT,
      event: { tool: "workhorse_list_chats", detail: "" },
    }).answer,
    "once",
  );
  // And a live session grant still covers the exact tool and target.
  const grants: PermissionGrant[] = [
    {
      id: "g1",
      key: permissionGrantKey(WRITE.tool, WRITE.detail, WRITE.path),
      tool: WRITE.tool,
      detail: WRITE.detail,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    },
  ];
  assert.equal(
    ordinaryPath({ owner: askWorker, sessions: [askChat, askWorker], deskAccess: DESK_DEFAULT, event: WRITE, grants })
      .answer,
    "session",
  );
});

test("permissionSourceNote names the Permission dial, not the sandbox", () => {
  // Only Permission can carry a request as far as the ordinary prompt: a
  // sandbox refusal already came out as a deny and took the elevate path. A
  // note about the sandbox here would send the coordinator to the wrong dial.
  const note = permissionSourceNote({ session: askWorker, sessions: [askChat, askWorker], deskAccess: DESK_DEFAULT });
  assert.match(note, /^Permission Ask comes from chat “Nightly cleanup”;/);
  assert.match(note, /raise that chat's Permission\.$/);
  assert.doesNotMatch(note, /Sandbox/);
  // Same walk as the sandbox note: past every hidden row, to the chat the
  // person can open — and to the call when the call is what set the seat.
  const deeper: LineageChat = { ...askWorker, id: "deep", parentId: askWorker.id, title: "helper" };
  assert.match(
    permissionSourceNote({ session: deeper, sessions: [askChat, askWorker, deeper] }),
    /chat “Nightly cleanup”/,
  );
  const byCall: LineageChat = {
    ...askWorker,
    agentRun: { grantedAccess: { mode: "ask", sandbox: "off", source: "call" } },
  };
  assert.match(permissionSourceNote({ session: byCall, sessions: [askChat, byCall] }), /this delegation's own call/);
  assert.match(permissionSourceNote({ deskAccess: { mode: "ask", sandbox: "off" } }), /^Permission Ask comes from the desk default;/);
});

test("store.tsx shuts the ordinary door on a hidden worker", () => {
  const store = source("src", "lib", "store.tsx");
  // The guard, not the sentence: `if (false)` around the branch, or dropping
  // the `owner?.hidden` term, has to fail here rather than leave the words in.
  assert.match(
    store,
    /const hiddenDeny = !answered && owner\?\.hidden === true;\n\s*const allowed = answered \?\? \(hiddenDeny \? \("deny" as const\) : null\);/,
    "a subagent's ordinary request is answered, never enqueued",
  );
  // The note has to reach the transcript, or the worker learns nothing.
  assert.match(
    store,
    /const deskNote =\n\s*deskClamp \?\?\n\s*\(hiddenDeny\n\s*\? permissionSourceNote\(\{/,
    "and the denial carries the seat that stopped it",
  );
  assert.match(store, /\$\{event\.detail\}\$\{deskNote \? ` · \$\{deskNote\}` : ""\}/);
  // The plain enqueue must still exist below, for the visible chat that owns it.
  assert.match(
    store,
    /pending: enqueuePermission\(current\.pending, \{\n\s*id: event\.requestId,\n\s*sessionId: event\.sessionId,\n\s*provider,\n\s*tool: event\.tool,\n\s*detail: event\.detail,\n\s*path: event\.path,\n\s*\}\),/,
    "a visible chat's own Ask is still a question for the person",
  );
});

// ---------------------------------------------------------------------------
// A call-set clamp is not a person's tightening.
// ---------------------------------------------------------------------------

test("a spawn call cannot leave a read-only clamp on the worker", () => {
  const call = requestedWorkerAccess({ requested: { sandbox: "read-only" }, inherited: DESK_DEFAULT, ceiling: DESK_DEFAULT });
  const seat = workerAccess({ inherited: call.granted, owned: false });
  assert.deepEqual(seat, DESK_DEFAULT);
  assert.equal(call.source, "inherited");
});

test("a narrowing the person made by hand still survives the next slice", () => {
  // The other half, and the reason a blanket "a call-set grant never clamps"
  // rule would be wrong: it would drop this too, and hand back access the
  // person took away.
  const call = requestedWorkerAccess({ requested: { sandbox: "read-only" }, inherited: DESK_DEFAULT, ceiling: DESK_DEFAULT });
  const grant = { ...workerGrant({ inherited: call.granted }), source: call.source };
  // The person then set this worker's chat to Strict themselves.
  const prior = { mode: "always-approve" as const, sandbox: "strict" as const, agentRun: { grantedAccess: grant } };
  assert.deepEqual(workerTightening(prior), { sandbox: "strict" });
  const reuse = requestedWorkerAccess({ inherited: DESK_DEFAULT, ceiling: DESK_DEFAULT });
  assert.deepEqual(workerAccess({ inherited: reuse.granted, owned: false, prior }), {
    mode: "always-approve",
    sandbox: "strict",
  });
});

test("a nested helper is not reused, and it inherits the parent seat", () => {
  const helperSeat = workerAccess({ inherited: DESK_DEFAULT, owned: false });
  assert.deepEqual(helperSeat, DESK_DEFAULT);
  assert.match(source("src", "lib", "subagents.ts"), /readOnly: false,\n\s*mayReuse: false,/);
  assert.match(source("src", "lib", "store.tsx"), /const reusedWorker = nestedPolicy\.mayReuse \?/);
});

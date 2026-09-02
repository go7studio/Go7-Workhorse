import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  grantedAccessLine,
  inboundAccess,
  parseCallPermission,
  parseSandboxValue,
  releasedHelper,
  requestedWorkerAccess,
  sandboxSourceNote,
  spawnAccessLogDetail,
  workerAccess,
  workerGrant,
  type LineageChat,
} from "../src/lib/permissions";
import type { DeskAccess } from "../src/lib/types";

/**
 * A delegation's access is decided at the call, never by a card mid-run.
 *
 * The live complaint: a Claude subagent asked the person to move "Sandbox
 * Read-only → Off" for a write to /tmp. The read-only had been set months
 * earlier on a Grok review chat two rows up, which someone then used as a
 * parent for working delegations. The card named a setting on a chat the
 * person was not looking at, and the call that made the worker had no way to
 * ask for the access it needed. Both halves are fixed here.
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
// requestedWorkerAccess — the call, the ceiling, and silence.
// ---------------------------------------------------------------------------

test("a requested seat is honoured exactly, under a caller that cannot give it", () => {
  // The live row: parent "Adversarial product and eval review only" is
  // always-approve / read-only, because the person set it so for reviews. The
  // call asks for a writable child. The caller's own seat is NOT the ceiling —
  // the desk default is — so the child gets what the call asked for.
  const decided = requestedWorkerAccess({
    requested: { sandbox: "off" },
    inherited: READ_ONLY_REVIEW,
    ceiling: DESK_DEFAULT,
  });
  assert.deepEqual(decided.granted, { mode: "always-approve", sandbox: "off" });
  assert.equal(decided.source, "call");
  assert.equal(decided.refused, undefined, "nothing was refused, so nothing is claimed to be");

  // A call may also tighten a child below the caller. Same path, no refusal.
  const tightened = requestedWorkerAccess({
    requested: { mode: "ask", sandbox: "workspace" },
    inherited: DESK_DEFAULT,
    ceiling: DESK_DEFAULT,
  });
  assert.deepEqual(tightened.granted, { mode: "ask", sandbox: "workspace" });
  assert.equal(tightened.source, "call");

  // One dial named, the other inherited.
  const half = requestedWorkerAccess({
    requested: { mode: "accept-edits" },
    inherited: READ_ONLY_REVIEW,
    ceiling: DESK_DEFAULT,
  });
  assert.deepEqual(half.granted, { mode: "accept-edits", sandbox: "read-only" });
});

test("the ceiling is the desk default, and passing it returns the cap plus a reason", () => {
  // The person narrowed Settings › LLMs to Ask / Workspace. No call gets past
  // that, and the caller is told what it got instead of finding out from a
  // failed write ten minutes later.
  const tightDesk: DeskAccess = { mode: "ask", sandbox: "workspace" };
  const capped = requestedWorkerAccess({
    requested: { mode: "always-approve", sandbox: "off" },
    inherited: { mode: "ask", sandbox: "read-only" },
    ceiling: tightDesk,
  });
  assert.deepEqual(capped.granted, tightDesk, "capped, not refused outright");
  assert.equal(capped.source, "desk", "the desk decided this seat, so the call is not named as its author");
  assert.match(capped.refused ?? "", /Permission Always approve is above the desk default, so this worker runs at Ask/);
  assert.match(capped.refused ?? "", /Sandbox Off is above the desk default, so this worker runs at Workspace/);
  assert.equal(capped.refused?.includes("\n"), false, "one line, so a caller can print it");

  // One dial capped, one honoured: the call still authored the seat.
  const mixed = requestedWorkerAccess({
    requested: { mode: "ask", sandbox: "off" },
    inherited: DESK_DEFAULT,
    ceiling: { mode: "always-approve", sandbox: "workspace" },
  });
  assert.deepEqual(mixed.granted, { mode: "ask", sandbox: "workspace" });
  assert.equal(mixed.source, "call");
  assert.match(mixed.refused ?? "", /Sandbox Off is above the desk default/);
  assert.doesNotMatch(mixed.refused ?? "", /Permission/);

  // The shipped default when Settings has never been touched.
  const shipped = requestedWorkerAccess({ requested: { sandbox: "off" }, inherited: READ_ONLY_REVIEW });
  assert.deepEqual(shipped.granted, { mode: "always-approve", sandbox: "off" });
});

test("a silent call changes nothing: the child inherits the caller", () => {
  const silent = requestedWorkerAccess({ inherited: READ_ONLY_REVIEW, ceiling: DESK_DEFAULT });
  assert.deepEqual(silent.granted, READ_ONLY_REVIEW, "this is what every call did before the fields existed");
  assert.equal(silent.source, "inherited");
  assert.equal(silent.refused, undefined);
  // An empty object is silence too — a caller that built the field and left it unset.
  assert.equal(requestedWorkerAccess({ requested: {}, inherited: READ_ONLY_REVIEW }).source, "inherited");
  // Silence never reaches for the desk default: a caller the person tightened
  // stays tight for its children unless the call says otherwise.
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
  const helperReleased = releasedHelper({ role: nestedRole, requestedSandbox: requested.sandbox });
  return {
    seat: workerAccess({
      inherited: callAccess.granted,
      owned: Boolean(input.owned),
      readOnly: Boolean(input.nested) && !helperReleased,
    }),
    granted: { ...workerGrant({ inherited: callAccess.granted }), source: callAccess.source },
    role: (helperReleased ? undefined : nestedRole) ?? (helperReleased ? "worker" : undefined),
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

test("a delegate call with sandbox off under a read-only caller yields a child at off", () => {
  // The whole point of the lane, end to end: the visible Grok chat is
  // always-approve / read-only, and the call asks for a writable worker.
  const spawned = spawnSeat({ caller: READ_ONLY_REVIEW, desk: DESK_DEFAULT, call: { sandbox: "off" } });
  assert.deepEqual(spawned.seat, { mode: "always-approve", sandbox: "off" }, "the child can write");
  assert.equal(spawned.granted.source, "call");
  assert.deepEqual(
    { mode: spawned.granted.mode, sandbox: spawned.granted.sandbox },
    { mode: "always-approve", sandbox: "off" },
  );
  // One line the Link helper records: identifiers and seats, never the brief.
  assert.equal(
    spawned.log,
    "child=sess_child parent=sess_pj3m99rpahx5 requested=-/off granted=always-approve/off cap=always-approve/off source=call",
  );
  // And one line the caller reads in the spawn result, so it needs no card.
  assert.equal(spawned.line, "Permission Always approve, Sandbox Off (from the call).");
});

test("a silent call under the same caller yields read-only, source inherited", () => {
  const spawned = spawnSeat({ caller: READ_ONLY_REVIEW, desk: DESK_DEFAULT });
  assert.deepEqual(spawned.seat, READ_ONLY_REVIEW, "silence is still the caller's seat");
  assert.equal(spawned.granted.source, "inherited");
  assert.match(
    spawned.log,
    /requested=none granted=always-approve\/read-only cap=always-approve\/off source=inherited$/,
  );
  assert.equal(spawned.line, "Permission Always approve, Sandbox Read-only (from the inherited).");
});

test("a nested helper keeps its read-only clamp until the call asks for a sandbox", () => {
  // The policy this lane picked: a helper the call made writable is no longer
  // a helper, so the desk records it as a worker. Keeping the label would make
  // the denial say "helpers are read-only" about a chat that is writing files.
  const clamped = spawnSeat({ caller: DESK_DEFAULT, desk: DESK_DEFAULT, nested: true });
  assert.equal(clamped.seat.sandbox, "read-only", "silence leaves the clamp exactly where it was");
  assert.equal(clamped.role, "helper");

  const released = spawnSeat({ caller: DESK_DEFAULT, desk: DESK_DEFAULT, nested: true, call: { sandbox: "off" } });
  assert.equal(released.seat.sandbox, "off", "the call lifted it on purpose");
  assert.equal(released.role, "worker", "and the role went with the access");

  // Asking only for a permission is not asking for a sandbox: the clamp holds.
  const modeOnly = spawnSeat({
    caller: DESK_DEFAULT,
    desk: DESK_DEFAULT,
    nested: true,
    call: { permission: "always-approve" },
  });
  assert.equal(modeOnly.seat.sandbox, "read-only");
  assert.equal(modeOnly.role, "helper");
  assert.equal(releasedHelper({ role: "worker", requestedSandbox: "off" }), false, "only a helper is released");
  assert.equal(releasedHelper({ role: "helper" }), false);
});

test("the desk ceiling still holds over a delegation to a path-owned worker", () => {
  // A path allowlist clamps the vendor session to Ask so ownership can still
  // be checked per write. That is the desk's clamp, and it survives a call
  // asking for always-approve — but the recorded grant keeps what was granted.
  const spawned = spawnSeat({
    caller: READ_ONLY_REVIEW,
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
  assert.equal(
    sandboxSourceNote({ session: nadia, sessions: [reviewChat, nadia], deskAccess: DESK_DEFAULT }),
    "Sandbox Read-only comes from chat “Adversarial product and eval review only”; " +
      "ask for sandbox: off in the call, or raise that chat's Sandbox.",
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
    "Sandbox Strict comes from the desk default; ask for sandbox: off in the call, or raise that chat's Sandbox.",
  );
  assert.match(sandboxSourceNote({ deskAccess: { mode: "ask", sandbox: "workspace" } }), /Sandbox Workspace comes from the desk default/);
});

// ---------------------------------------------------------------------------
// A new chat starts at the desk default, not at the last chat of that vendor.
// ---------------------------------------------------------------------------

test("a new chat after a read-only chat of the same vendor starts at the desk default", () => {
  // The quiet third fact behind the complaint: one review chat set to
  // read-only made every next Grok chat read-only, and nobody chose that.
  const afterReadOnly = inboundAccess({ desk: DESK_DEFAULT, vendor: undefined });
  assert.deepEqual(afterReadOnly, DESK_DEFAULT, "memory of a seat is not a setting on the new chat");
  // A vendor app the person configured narrower is still honoured — that is a
  // setting they made, on that vendor.
  assert.deepEqual(inboundAccess({ desk: DESK_DEFAULT, vendor: { mode: "ask" } }), {
    mode: "ask",
    sandbox: "off",
  });
  // And a desk default the person narrowed is what a new chat starts at.
  assert.deepEqual(inboundAccess({ desk: { mode: "ask", sandbox: "workspace" } }), {
    mode: "ask",
    sandbox: "workspace",
  });
});

test("startSession no longer seeds a new chat's seat from the last chat", () => {
  const store = source("src", "lib", "store.tsx");
  // The pin is the guard, not the words: the call must not carry a parent, and
  // the remembered row must not be read for a mode or a sandbox anywhere near
  // it. `if (false) {}` around the old block would leave this failing.
  assert.match(
    store,
    /const seat = inboundAccess\(\{\n\s*desk: current\.settings\.access,\n\s*vendor: nativeAccess,\n\s*\}\);/,
    "a new chat takes the desk default and that vendor's own config, nothing else",
  );
  assert.doesNotMatch(store, /rememberedAccess/, "the seat memory is gone, not merely unused");
  // Vendor, model and effort memory stay: this lane took the seat, not the brain.
  assert.match(store, /const picked = provider \?\? remembered!\.provider;/);
  assert.match(store, /effort: withEffort\(picked, model, remembered\?\.effort \?\? null\)/);
});

// ---------------------------------------------------------------------------
// The schemas, the payload, and the CLI — pinned where a caller reads them.
// ---------------------------------------------------------------------------

test("both spawn tool declarations expose permission and sandbox", () => {
  const mcp = source("electron", "workhorse-mcp.ts");
  // Each schema is sliced to its own tool first: a pin that may run on to the
  // next declaration passes while the field it names is gone from this one.
  const delegate = between(mcp, 'name: "workhorse_delegate",', 'name: "workhorse_continue_mission",');
  assert.match(delegate, /permission: \{ type: "string", description: "Seat this worker runs under: ask, accept-edits, or always-approve\./);
  assert.match(delegate, /sandbox: \{ type: "string", description: "Sandbox this worker runs under: off, workspace, read-only, or strict\./);
  assert.match(delegate, /Capped at the desk default \(Settings › LLMs\), not at your own seat/);

  const spawn = between(mcp, 'name: "workhorse_spawn_agent",', 'name: "workhorse_await_agents",');
  assert.match(spawn, /permission: \{ type: "string", description: "Seat this worker runs under/);
  assert.match(spawn, /sandbox: \{ type: "string", description: "Sandbox this worker runs under/);
  assert.match(spawn, /Capped at the desk default \(Settings › LLMs\), not at your own seat/);

  // The in-desk tool a custom bot sees carries the same pair.
  const custom = between(source("electron", "custom-tools.ts"), 'name: "workhorse_spawn_agent",', 'name: "workhorse_await_agents",');
  assert.match(custom, /permission: \{ type: "string", description: "Seat this worker runs under/);
  assert.match(custom, /sandbox: \{ type: "string", description: "Sandbox this worker runs under/);
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
    2,
    "the doc comment and the runtime usage line",
  );
});

test("the store decides the seat at the call and records who decided it", () => {
  const store = source("src", "lib", "store.tsx");
  assert.match(
    store,
    /const callAccess = requestedWorkerAccess\(\{\n\s*requested: requestedAccess,\n\s*inherited: inheritedAccess,\n\s*ceiling: latest\.settings\.access,\n\s*\}\);/,
    "the ceiling is the desk default, never the caller's seat",
  );
  // The seat and the recorded grant both come off the decision, or the child
  // would launch at one access and have its writes answered from another.
  assert.match(store, /inherited: callAccess\.granted,\n\s*owned: assignedPaths\.length > 0,\n\s*readOnly: nestedPolicy\.readOnly && !helperReleased,/);
  assert.match(store, /grantedAccess: \{ \.\.\.workerGrant\(\{ inherited: callAccess\.granted, prior: priorWorker \}\), source: callAccess\.source \}/);
  // The guard, not the sentence: a hidden owner must reach sandboxSourceNote
  // and the note must reach `need`, so dead-coding the branch fails this.
  assert.match(
    store,
    /blocked && owner\n\s*\? owner\.hidden\n\s*\? sandboxSourceNote\(\{[\s\S]{0,200}?\}\)\n\s*: promptOwner\(blocked, lineage\) === "desk"/,
    "site 1: a subagent's block is answered, a visible chat's is not",
  );
  assert.match(
    store,
    /if \(from\.hidden\) \{[\s\S]{0,320}?reason: sandboxSourceNote\(\{/,
    "site 2: the same rule on workhorse_request_permission",
  );
  // The elevate enqueue still exists below that guard, for the visible chat.
  assert.match(store, /if \(from\.hidden\) \{[\s\S]{0,600}?const need = classified\.need;[\s\S]{0,600}?kind: "elevate",/);
});

test("the rules text tells a coordinator to ask for the sandbox in the call", () => {
  const rules = source("src", "lib", "workhorse-rules.ts");
  assert.match(
    rules,
    /A worker's Permission and Sandbox are decided by your spawn call, so pass sandbox \(off, workspace, read-only, strict\) and permission/,
  );
  assert.match(rules, /the worker cannot ask the user for more later/);
  // It has to be on the surfaces the desk actually injects, not just declared.
  assert.equal((rules.match(/SPAWN_ACCESS_LAW \+/g) ?? []).length, 3, "every coordinator surface carries it");
  // A worker may still make one bounded helper, so it gets the short form —
  // worker rules are held to a tenth of the bible's length, and the long
  // sentence broke that ceiling by four characters when it was shared.
  assert.match(rules, /Your spawn call decides that helper's Permission and Sandbox: pass sandbox when it must write/);
  assert.equal((rules.match(/HELPER_ACCESS_LAW \+/g) ?? []).length, 2, "both worker surfaces carry the short form");
});

test("LINK.md states the two fields and the ceiling rule", () => {
  const link = source("docs", "LINK.md");
  assert.match(link, /\| `permission` \| `ask`, `accept-edits`, `always-approve` \|/);
  assert.match(link, /\| `sandbox` \| `off`, `workspace`, `read-only`, `strict` \|/);
  assert.match(link, /capped by the \*\*desk default\*\* in Settings › LLMs — the app's own\nceiling, not your seat/);
  assert.match(link, /Send neither field\nand the worker inherits your own seat/);
});

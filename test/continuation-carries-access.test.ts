import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  continuedInheritedAccess,
  grantedAccessLine,
  parseCallPermission,
  parseContinuedAccess,
  parseSandboxValue,
  passGrantedAccess,
  requestedWorkerAccess,
  spawnAccessLogDetail,
  workerAccess,
  workerGrant,
} from "../src/lib/permissions";
import type { DeskAccess } from "../src/lib/types";

/**
 * A mission's access is decided once, at the call that started it — and it has
 * to survive the mission.
 *
 * Lane 5 let a delegation ask for its seat, and pass 1 got it. Pass 2 did not:
 * workhorse_continue_mission carried no seat, so the desk fell back to the
 * chat the continuation was called from. Delegate with sandbox: off out of the
 * read-only review chat and the job writes, reports, continues — and then
 * stops writing, for no reason anybody in the transcript can see. "Worked,
 * then stopped working" is the worst shape a permission bug can take.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Windows CI checks out with autocrlf, so a source pin that reads raw bytes fails there. */
function source(...parts: string[]): string {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
}

/** The text between two markers, so a pin cannot drift into the next block. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing ${end} after ${start}`);
  return text.slice(from, to);
}

const DESK_DEFAULT: DeskAccess = { mode: "always-approve", sandbox: "off" };
/** The live parent: "Adversarial product and eval review only", set read-only by hand. */
const REVIEW_CHAT: DeskAccess = { mode: "always-approve", sandbox: "read-only" };

/**
 * One pass of a mission, the way the desk assembles it: the call decides the
 * seat, the worker launches on it, and the desk records what it granted.
 */
function runPass(input: {
  caller: DeskAccess;
  desk: DeskAccess;
  call?: { permission?: string; sandbox?: string };
  continued?: { mode?: string; sandbox?: string; pass?: number };
}): { seat: DeskAccess; granted: DeskAccess & { source: string }; summary: string; log: string } {
  const requested = {
    ...(parseCallPermission(input.call?.permission) ? { mode: parseCallPermission(input.call?.permission)! } : {}),
    ...(parseSandboxValue(input.call?.sandbox) ? { sandbox: parseSandboxValue(input.call?.sandbox)! } : {}),
  };
  const continued = parseContinuedAccess(input.continued);
  const callerAccess = continuedInheritedAccess({ continued, caller: input.caller, ceiling: input.desk });
  const decided = requestedWorkerAccess({ requested, inherited: callerAccess, ceiling: input.desk });
  return {
    seat: workerAccess({ inherited: decided.granted, owned: false }),
    granted: { ...workerGrant({ inherited: decided.granted }), source: decided.source },
    summary: grantedAccessLine(decided),
    log: spawnAccessLogDetail({
      child: "sess_pass2",
      parent: "sess_pj3m99rpahx5",
      requested,
      granted: decided.granted,
      ceiling: input.desk,
      source: decided.source,
      ...(continued?.pass ? { pass: continued.pass } : {}),
    }),
  };
}

// ---------------------------------------------------------------------------
// The hole itself.
// ---------------------------------------------------------------------------

test("a continuation copies the parent chat, not the previous pass's grant", () => {
  const pass1 = runPass({ caller: REVIEW_CHAT, desk: DESK_DEFAULT, call: { sandbox: "off" } });
  assert.deepEqual(pass1.seat, REVIEW_CHAT, "the call cannot raise the parent");
  assert.equal(pass1.granted.source, "inherited");

  const carried = passGrantedAccess([pass1.granted]);
  const pass2 = runPass({
    caller: REVIEW_CHAT,
    desk: DESK_DEFAULT,
    continued: { ...carried!, pass: 1 },
  });
  assert.deepEqual(pass2.seat, REVIEW_CHAT, "pass 2 still copies the parent");
  assert.equal(pass2.granted.source, "inherited");
  assert.equal(pass2.summary, "Permission Always approve, Sandbox Read-only (inherited from the caller).");
});

test("an explicit seat on the continuation is ignored", () => {
  const raised = runPass({
    caller: REVIEW_CHAT,
    desk: DESK_DEFAULT,
    call: { sandbox: "off" },
    continued: { mode: "always-approve", sandbox: "read-only", pass: 2 },
  });
  assert.deepEqual(raised.seat, REVIEW_CHAT);
  assert.equal(raised.granted.source, "inherited");
  assert.equal(raised.summary, "Permission Always approve, Sandbox Read-only (inherited from the caller).");

  const tightened = runPass({
    caller: DESK_DEFAULT,
    desk: DESK_DEFAULT,
    call: { sandbox: "workspace" },
    continued: { mode: "always-approve", sandbox: "off", pass: 3 },
  });
  assert.equal(tightened.seat.sandbox, "off");
  assert.equal(tightened.granted.source, "inherited");
});

// ---------------------------------------------------------------------------
// Reading the wave, and reading the wire.
// ---------------------------------------------------------------------------

test("where a wave's workers disagree the tightest seat carries forward", () => {
  const off: DeskAccess = { mode: "always-approve", sandbox: "off" };
  const workspace: DeskAccess = { mode: "ask", sandbox: "workspace" };
  // Agreement is the easy half.
  assert.deepEqual(passGrantedAccess([off, off]), off);
  // Disagreement is not: handing the next worker the widest seat anyone held
  // would raise access nobody granted for this slice.
  assert.deepEqual(passGrantedAccess([off, workspace]), { mode: "ask", sandbox: "workspace" });
  assert.deepEqual(passGrantedAccess([workspace, off]), { mode: "ask", sandbox: "workspace" });
  assert.deepEqual(
    passGrantedAccess([{ mode: "always-approve", sandbox: "workspace" }, { mode: "ask", sandbox: "off" }]),
    { mode: "ask", sandbox: "workspace" },
    "tightest per dial, not the tightest row wholesale",
  );
  // A worker with no record contributes nothing rather than a guess, and a
  // wave with no records at all leaves the caller's seat alone.
  assert.deepEqual(passGrantedAccess([undefined, off]), off);
  assert.equal(passGrantedAccess([]), undefined);
  assert.equal(passGrantedAccess([undefined, undefined]), undefined);
  assert.equal(passGrantedAccess([{ mode: "ask" } as DeskAccess]), undefined, "half a seat is not a seat");
});

test("the carried seat is read off the wire, never trusted", () => {
  assert.deepEqual(parseContinuedAccess({ mode: "ask", sandbox: "off", pass: 2 }), {
    mode: "ask",
    sandbox: "off",
    pass: 2,
  });
  // plan is refused here for the same reason it is refused on a delegation:
  // a worker that cannot write cannot finish the pass.
  assert.deepEqual(parseContinuedAccess({ mode: "plan", sandbox: "off" }), { sandbox: "off" });
  assert.equal(parseContinuedAccess({ mode: "plan" }), undefined);
  assert.equal(parseContinuedAccess({ mode: "nonsense", sandbox: "nonsense" }), undefined);
  assert.equal(parseContinuedAccess(undefined), undefined);
  assert.equal(parseContinuedAccess(null), undefined);
  assert.equal(parseContinuedAccess("off"), undefined);
  assert.equal(parseContinuedAccess([{ sandbox: "off" }]), undefined);
  // A nonsense pass number is dropped without dropping the seat with it.
  assert.deepEqual(parseContinuedAccess({ sandbox: "off", pass: 0 }), { sandbox: "off" });
  assert.deepEqual(parseContinuedAccess({ sandbox: "off", pass: -3 }), { sandbox: "off" });
  assert.deepEqual(parseContinuedAccess({ sandbox: "off", pass: Number.NaN }), { sandbox: "off" });
  assert.deepEqual(parseContinuedAccess({ sandbox: "off", pass: 2.7 }), { sandbox: "off", pass: 2 });
});

test("continuedInheritedAccess always returns the caller", () => {
  assert.deepEqual(
    continuedInheritedAccess({ caller: REVIEW_CHAT, ceiling: DESK_DEFAULT }),
    REVIEW_CHAT,
  );
  assert.deepEqual(
    continuedInheritedAccess({ continued: { sandbox: "off" }, caller: { mode: "ask", sandbox: "read-only" }, ceiling: DESK_DEFAULT }),
    { mode: "ask", sandbox: "read-only" },
  );
  assert.deepEqual(
    continuedInheritedAccess({ continued: { mode: "always-approve", sandbox: "off" }, caller: REVIEW_CHAT }),
    REVIEW_CHAT,
  );
});

// ---------------------------------------------------------------------------
// The wiring, pinned where a caller reads it.
// ---------------------------------------------------------------------------

test("workhorse_continue_mission tells coordinators permission and sandbox are ignored", () => {
  const mcp = source("electron", "workhorse-mcp.ts");
  const schema = between(mcp, 'name: "workhorse_continue_mission",', 'name: "workhorse_list_chats",');
  assert.match(schema, /permission: \{ type: "string", description: "Ignored\. This chat's Permission is the person's setting/);
  assert.match(schema, /sandbox: \{ type: "string", description: "Ignored\. This chat's Sandbox is the person's setting/);
});

test("continueMission reads the wave's grants and hands them to the next pass", () => {
  const mcp = source("electron", "workhorse-mcp.ts");
  const fn = between(mcp, "async function continueMission(", "function currentMcpProfile()");
  // The seat comes from the wave's recorded grants, not from the coordinator.
  assert.match(
    fn,
    /const passSeat = passGrantedAccess\(source\.map\(\(session\) => session\.agentRun\?\.grantedAccess\)\);/,
    "the pass answers, not the chat the continuation was called from",
  );
  // The guard, not the words: drop the spread and a wave with no grants would
  // still send an empty object, which reads as a seat.
  assert.match(
    fn,
    /\.\.\.\(passSeat \? \{ continuedAccess: \{ \.\.\.passSeat, pass: previousPass \} \} : \{\}\),/,
    "no record means no carry, rather than a guessed seat",
  );
  assert.match(fn, /permission: typeof args\.permission === "string" \? args\.permission : undefined,/);
  assert.match(fn, /sandbox: typeof args\.sandbox === "string" \? args\.sandbox : undefined,/);
  // Both /spawn posts carry it, or a retry after a vendor grant runs the pass
  // at a different seat from the one the first attempt was given.
  assert.equal(
    (mcp.match(/continuedAccess: spawnInput\.continuedAccess,/g) ?? []).length,
    2,
    "the first post and the granted retry",
  );
  assert.match(source("electron", "peer-inbox.ts"), /continuedAccess\?: \{ mode\?: string; sandbox\?: string; pass\?: number \};/);
});

test("the store seats a continuation from the parent chat", () => {
  const store = source("src", "lib", "store.tsx");
  assert.match(
    store,
    /const continuedAccess = parseContinuedAccess\(payload\.continuedAccess\);\n\s*const callerAccess = continuedInheritedAccess\(\{\n\s*continued: continuedAccess,\n\s*caller: inheritedAccess,\n\s*ceiling: latest\.settings\.access,\n\s*\}\);/,
  );
  assert.match(
    store,
    /const callAccess = requestedWorkerAccess\(\{\n\s*inherited: callerAccess,\n\s*\}\);/,
    "the call cannot name a seat",
  );
  assert.match(store, /summary: grantedAccessLine\(callAccess\),/);
  assert.match(store, /\.\.\.\(continuedAccess\?\.pass \? \{ pass: continuedAccess\.pass \} : \{\}\),/);
});

test("the CLI can hand a continuation its seat", () => {
  const mcp = source("electron", "workhorse-mcp.ts");
  const followUp = between(mcp, 'if (sub === "follow-up") {', 'if (sub === "local-hosts")');
  assert.match(followUp, /\.\.\.\(flag\("permission"\) \? \{ permission: flag\("permission"\) \} : \{\}\),/);
  assert.match(followUp, /\.\.\.\(flag\("sandbox"\) \? \{ sandbox: flag\("sandbox"\) \} : \{\}\),/);
  // Value flags were already declared for delegate; follow-up shares them.
  assert.match(mcp, /"--permission", "--sandbox",/);
});

test("the docs say a worker copies the parent chat's seat", () => {
  const link = source("docs", "LINK.md");
  assert.match(link, /Permission and Sandbox are the person's settings/);
  assert.match(link, /The worker copies the parent chat's current seat/);
  assert.match(source("docs", "FEATURES.md"), /A\n\s*worker copies the parent chat's current seat/);
});

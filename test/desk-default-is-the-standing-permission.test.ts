import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { deskClampNote, releasedHelper, standingGrant } from "../src/lib/permissions";
import { applyStandingGrant } from "../src/lib/session";
import type { Session } from "../src/lib/types";
import { assertSharedWrite, claimSharedFiles, workerMayWrite } from "../src/lib/subagents";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

test("a nested helper is released unless the call asked for it to be read-only", () => {
  assert.equal(releasedHelper({ role: "helper" }), true, "nothing asked: the helper inherits its seat");
  assert.equal(releasedHelper({ role: "helper", requestedSandbox: "off" }), true);
  assert.equal(releasedHelper({ role: "helper", requestedSandbox: "workspace" }), true);
  assert.equal(releasedHelper({ role: "helper", requestedSandbox: "read-only" }), false, "the call said read-only, so read-only it is");
  assert.equal(releasedHelper({ role: "helper", requestedSandbox: "strict" }), false);
  assert.equal(releasedHelper({ role: "auditor" }), false, "only helpers are subject to release; other roles never had the clamp");
});

test("the seat decides who may write, not the label on the role", () => {
  for (const role of [undefined, "worker", "helper", "auditor"] as const) {
    assert.equal(workerMayWrite(role, "off"), true, `${role ?? "no role"} at sandbox off writes`);
    assert.equal(workerMayWrite(role, "workspace"), true);
    assert.equal(workerMayWrite(role, "read-only"), false, `${role ?? "no role"} at read-only does not`);
    assert.equal(workerMayWrite(role, "strict"), false);
  }
});

test("a lease refusal names the sandbox, because that is what refused it", () => {
  const files = [{ path: "src/a.ts", fingerprint: "x" }];
  const held = claimSharedFiles({ leases: [], sessionId: "w", role: "auditor", sandbox: "read-only", files });
  assert.equal(held.ok, false);
  if (!held.ok) assert.match(held.error, /sandbox is read-only/);
  const free = claimSharedFiles({ leases: [], sessionId: "w", role: "auditor", sandbox: "off", files });
  assert.equal(free.ok, true, "an auditor at sandbox off writes its own report");
  // A shared write needs the claim first; the seat is checked on the write too.
  const claimed = claimSharedFiles({ leases: [], sessionId: "w", role: "helper", sandbox: "off", files });
  assert.equal(claimed.ok, true, "a released helper at sandbox off claims its files");
  const leases = claimed.ok ? claimed.leases : [];
  const write = assertSharedWrite({ leases, sessionId: "w", role: "helper", sandbox: "off", path: "src/a.ts", currentFingerprint: "x" });
  assert.equal(write.ok, true, "and writes what it claimed");
  const clamped = assertSharedWrite({ leases, sessionId: "w", role: "helper", sandbox: "read-only", path: "src/a.ts", currentFingerprint: "x" });
  assert.equal(clamped.ok, false, "the same claim at a read-only seat does not write");
});

test("the copy no longer claims helpers are read-only by design", () => {
  assert.doesNotMatch(deskClampNote({ role: "helper" }), /by design/);
  assert.match(deskClampNote({ role: "helper" }), /asked to run read-only/);
  for (const rel of ["src/lib/store.tsx", "src/lib/permissions.ts", "electron/workhorse-mcp.ts", "src/lib/workhorse-rules.ts"]) {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(src, /read-only by design/, `${rel} still tells someone the old rule`);
  }
});

test("both write gates receive the seat that will actually apply", () => {
  const store = read("src/lib/store.tsx");
  assert.match(store, /sandbox: nestedPolicy\.readOnly && !helperReleased \? "read-only" : callAccess\.granted\.sandbox,/, "the lease claim sees the seat the worker will run under");
  assert.match(store, /role: owner\.agentRun\?\.role,\s*sandbox: owner\.sandbox,/, "the path write sees the worker's own sandbox");
  const sub = read("src/lib/subagents.ts");
  assert.match(sub, /sandbox: input\.sandbox,\s*path,/, "the allowlist gate passes it on");
});

test("a hidden worker's need within the desk default is granted, not carded", () => {
  const desk = { mode: "always-approve", sandbox: "off" } as const;
  const worker = { hidden: true, mode: "plan", sandbox: "read-only" } as const;
  assert.deepEqual(
    standingGrant({ session: worker, need: { mode: "ask", sandbox: "off" }, deskAccess: desk }),
    { mode: "ask", sandbox: "off" },
    "the desk hands over exactly what the seat is missing",
  );
  assert.deepEqual(
    standingGrant({ session: { ...worker, sandbox: "off" }, need: { sandbox: "off" }, deskAccess: desk }),
    null,
    "nothing missing, nothing to grant",
  );
  assert.equal(
    standingGrant({ session: worker, need: { sandbox: "off" }, deskAccess: { mode: "always-approve", sandbox: "read-only" } }),
    null,
    "past the desk default is past the ceiling; the desk cannot grant it",
  );
  assert.equal(
    standingGrant({ session: { ...worker, hidden: false }, need: { sandbox: "off" }, deskAccess: desk }),
    null,
    "a visible chat is the person's own seat; that raise is theirs to answer",
  );
  assert.deepEqual(
    standingGrant({ session: worker, need: { mode: "ask", sandbox: "off" } }),
    { mode: "ask", sandbox: "off" },
    "no desk access recorded reads as the fallback default",
  );
});

test("both elevate sites consult the standing grant before a card or a denial", () => {
  const store = readFileSync(new URL("../src/lib/store.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  // The vendor block: standing decides before the clamp note and before the card.
  assert.match(store, /const standing =\n\s*blocked && owner && !security\.boundary && security\.answer !== "deny"\n\s*\? standingGrant\(\{ session: owner, need: blocked, deskAccess: stateRef\.current\.settings\.access \}\)/, "a security boundary is never granted past");
  assert.match(store, /blocked && owner && !standing\n\s*\? owner\.hidden/, "a granted need is not a desk clamp");
  assert.match(store, /const need = deskClamp \|\| standing \? null : blocked;/, "a granted need raises no card");
  assert.match(store, /\(standing \? \("once" as const\) : null\) \?\?\n\s*forced \?\?/, "the grant answers the vendor before any seat-derived denial");
  assert.match(store, /\.\.\.\(standing \? applyStandingGrant\(session, standing\) : \{\}\)/, "and the seat and its lineage record are raised together");
  assert.match(store, /Granted from the desk default: \$\{describeElevation\(session, standing\)\}/);
  // The Link ask from a hidden chat: granted within the default, told the source past it.
  assert.match(store, /if \(from\.hidden\) \{[\s\S]{0,900}?const standing = standingGrant\(\{ session: from, need: classified\.need, deskAccess: latest\.settings\.access \}\);[\s\S]{0,1400}?ok: true,\n\s*elevated: true,/);
  assert.match(store, /if \(!elevationStillNeeded\(\{ mode: from\.mode, sandbox: from\.sandbox \}, classified\.need\)\) \{[\s\S]{0,400}?alreadyElevated: true,/, "a seat that already covers the need is not denied for a stale record");
  assert.match(store, /howToUse: "Granted from the desk default\. Continue the work\.",/);
});

test("a seat the call asked for holds; the desk hands over only what nobody chose", () => {
  const desk = { mode: "always-approve", sandbox: "off" } as const;
  const byCall = { hidden: true, mode: "always-approve", sandbox: "read-only", agentRun: { grantedAccess: { source: "call" as const } } } as const;
  assert.equal(standingGrant({ session: byCall, need: { sandbox: "off" }, deskAccess: desk }), null, "the coordinator said read-only and meant it");
  const inherited = { ...byCall, agentRun: { grantedAccess: { source: "inherited" as const } } };
  assert.deepEqual(standingGrant({ session: inherited, need: { sandbox: "off" }, deskAccess: desk }), { sandbox: "off" }, "an inherited clamp is the desk's to lift");
});

test("a standing grant raises the lineage record with the seat", () => {
  const session = {
    id: "w",
    hidden: true,
    mode: "plan",
    sandbox: "read-only",
    messages: [],
    agentRun: { status: "running", grantedAccess: { mode: "plan", sandbox: "read-only", source: "inherited" } },
  } as unknown as Session;
  const raised = applyStandingGrant(session, { mode: "ask", sandbox: "off" });
  assert.equal(raised.mode, "ask");
  assert.equal(raised.sandbox, "off");
  assert.deepEqual(raised.agentRun?.grantedAccess, { mode: "ask", sandbox: "off", source: "inherited" }, "the next ask classifies against the raised grant");
  const bare = { ...session, agentRun: undefined } as unknown as Session;
  assert.equal(applyStandingGrant(bare, { sandbox: "off" }).sandbox, "off", "a chat with no run record still gets its seat");
});

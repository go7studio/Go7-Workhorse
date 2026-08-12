import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, filterCommands } from "../src/lib/commands";
import { applyPermissionAnswer, permissionAnswerLabel } from "../src/lib/permissions";
import { selectSurface, titlebarLabel } from "../src/lib/surface";
import type { PermissionRequest, Session } from "../src/lib/types";

test("filterCommands returns the shipped command list and filters it", () => {
  const all = filterCommands("/");
  assert.equal(all, COMMANDS);
  assert.ok(COMMANDS.length > 0);

  const asked = filterCommands("/ask");
  assert.ok(asked.length > 0);
  assert.ok(asked.every((command) => COMMANDS.includes(command)));
  assert.ok(asked.some((command) => command.run === "mode:ask"));

  const byHint = filterCommands("token usage");
  assert.ok(byHint.every((command) => COMMANDS.includes(command)));
  assert.ok(byHint.some((command) => command.run === "usage"));

  assert.deepEqual(filterCommands("/no-such-command"), []);
});

test("applyPermissionAnswer updates the real pending queue and session", () => {
  const session: Session = {
    id: "sess_1",
    projectId: "proj_1",
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "New chat",
    mode: "ask",
    status: "needs-input",
    messages: [{ id: "m1", role: "system", text: "preview", createdAt: 1 }],
  };
  const request: PermissionRequest = {
    id: "perm_1",
    sessionId: session.id,
    provider: "grok",
    tool: "run command",
    detail: "git status",
  };
  const start = { pending: [request], sessions: [session] };

  assert.equal(applyPermissionAnswer(start, "missing", "deny"), null);

  const denied = applyPermissionAnswer(start, request.id, "deny");
  assert.ok(denied);
  assert.equal(denied.pending.length, 0);
  assert.equal(denied.sessions[0].status, "idle");
  assert.equal(denied.sessions[0].messages.length, session.messages.length + 1);
  assert.equal(
    denied.sessions[0].messages.at(-1)?.text,
    `${permissionAnswerLabel("deny")}: ${request.tool} — ${request.detail}`,
  );

  const once = applyPermissionAnswer(start, request.id, "once");
  const sessionGrant = applyPermissionAnswer(start, request.id, "session");
  assert.ok(once && sessionGrant);
  assert.notEqual(once.sessions[0].messages.at(-1)?.text, sessionGrant.sessions[0].messages.at(-1)?.text);
  assert.ok(once.sessions[0].messages.at(-1)?.text.startsWith(permissionAnswerLabel("once")));
  assert.ok(sessionGrant.sessions[0].messages.at(-1)?.text.startsWith(permissionAnswerLabel("session")));
});

test("selectSurface and titlebarLabel follow the draft chrome rules", () => {
  assert.equal(selectSurface({ panel: "settings", hasProject: true, hasSession: true }), "settings");
  assert.equal(selectSurface({ panel: null, hasProject: false, hasSession: false }), "welcome");
  assert.equal(selectSurface({ panel: null, hasProject: true, hasSession: false }), "project-home");
  assert.equal(selectSurface({ panel: null, hasProject: true, hasSession: true }), "session");

  assert.equal(titlebarLabel(null, null), "");
  assert.equal(titlebarLabel("Alpha"), "Alpha");
  const titled = titlebarLabel("Alpha", "New chat");
  assert.ok(titled.includes("Alpha"));
  assert.ok(titled.includes("New chat"));
  assert.ok(!titled.includes("Go7 Workhorse"));
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseGrokUsage, pickPermissionOptionId } from "../electron/grok-agent";
import { GrokSessionHost } from "../electron/grok-host";
import {
  GROK_EFFORT_GATES,
  GROK_MODELS,
  buildGrokLaunchSpec,
  grokSpawnArgs,
} from "../electron/grok-launch";
import { COMMANDS, filterCommands } from "../src/lib/commands";
import { applyPermissionAnswer, permissionAnswerLabel } from "../src/lib/permissions";
import { archiveChat, deleteChat, moveChat, renameChat } from "../src/lib/chats";
import { selectSurface, titlebarLabel } from "../src/lib/surface";
import type { PermissionMode, PermissionRequest, Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    contextUsed: 0,
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

test("chat rename, move, archive, and delete", () => {
  const one: Session = {
    id: "sess_1",
    projectId: "proj_1",
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "New chat",
    mode: "ask",
    status: "idle",
    messages: [],
    contextUsed: 0,
  };
  const two = { ...one, id: "sess_2", title: "Other" };
  const sessions = [one, two];

  const renamed = renameChat(sessions, "sess_1", "Login fix");
  assert.equal(renamed?.[0].title, "Login fix");
  assert.equal(renameChat(sessions, "sess_1", "  "), null);

  const moved = moveChat(sessions, "sess_1", "proj_2");
  assert.equal(moved?.[0].projectId, "proj_2");
  assert.equal(moveChat(sessions, "sess_1", "proj_1"), null);

  const archived = archiveChat(sessions, "sess_1", true, 99);
  assert.equal(archived?.[0].archivedAt, 99);
  const open = archiveChat(archived!, "sess_1", false);
  assert.equal(open?.[0].archivedAt, null);

  const deleted = deleteChat(sessions, "sess_2");
  assert.equal(deleted?.length, 1);
  assert.equal(deleted?.[0].id, "sess_1");
  assert.equal(deleteChat(sessions, "missing"), null);
});

const MODES: PermissionMode[] = ["ask", "accept-edits", "always-approve"];

for (const model of GROK_MODELS) {
  for (const effort of GROK_EFFORT_GATES) {
    for (const mode of MODES) {
      test(`grok launch ${model} ${effort} ${mode} uses grok agent stdio`, () => {
        const spec = buildGrokLaunchSpec({
          model,
          effort,
          cwd: ROOT,
          mode,
        });
        const spawned = grokSpawnArgs(spec);
        assert.equal(spec.command, "grok");
        assert.equal(spawned.command, "grok");
        assert.deepEqual(spawned.args, spec.argv);
        assert.equal(spawned.cwd, ROOT);
        assert.ok(spec.argv.includes("agent"));
        assert.equal(spec.argv.at(-1), "stdio");
        assert.equal(spec.argv[spec.argv.indexOf("--model") + 1], model);
        assert.equal(spec.argv[spec.argv.indexOf("--reasoning-effort") + 1], effort);
        assert.equal(spec.model, model);
        assert.equal(spec.effort, effort);
        assert.equal(spec.sessionParams.cwd, ROOT);
        assert.deepEqual(spec.sessionParams.mcpServers, []);
        assert.ok(!/claude|codex|custom/i.test([spec.command, ...spec.argv].join(" ")));
        if (mode === "always-approve") {
          assert.equal(spec.alwaysApprove, true);
          assert.ok(spec.argv.includes("--always-approve"));
          assert.equal(spec.sessionParams._meta?.yoloMode, true);
        } else {
          assert.equal(spec.alwaysApprove, false);
          assert.ok(!spec.argv.includes("--always-approve"));
          assert.ok(!spec.sessionParams._meta?.yoloMode);
        }
        if (mode === "accept-edits") {
          assert.equal(spec.sessionParams._meta?.autoMode, true);
        }
      });
    }
  }
}

test("GrokSessionHost is the Electron spawn owner and does not call other vendors", () => {
  const host = new GrokSessionHost();
  assert.equal(typeof host.prompt, "function");
  assert.equal(typeof host.answerPermission, "function");
  host.disposeAll();
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const agent = readFileSync(path.join(ROOT, "electron", "grok-agent.ts"), "utf8");
  assert.match(main, /new GrokSessionHost/);
  assert.match(main, /ipcMain\.handle\("grok:prompt"/);
  assert.match(main, /spawnGrok|GrokSessionHost|grokHost\.prompt/);
  assert.doesNotMatch(main, /spawn\(["']claude|spawn\(["']codex/);
  assert.match(preload, /ipcRenderer\.invoke\("grok:prompt"/);
  assert.doesNotMatch(preload, /spawn\(/);
  assert.match(store, /session\.provider === "grok"/);
  assert.match(store, /grokPrompt/);
  assert.match(store, /Preview only/);
  const grokBranch = store.slice(store.indexOf('session.provider === "grok"'));
  assert.doesNotMatch(grokBranch.slice(0, grokBranch.indexOf("Preview only")), /Preview only/);
  assert.match(agent, /spawnGrokProcess/);
  assert.match(agent, /buildGrokLaunchSpec/);
});

test("pickPermissionOptionId maps Workhorse answers onto ACP option kinds", () => {
  const options = [
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "allow-always", kind: "allow_always" },
    { optionId: "reject-once", kind: "reject_once" },
  ];
  assert.equal(pickPermissionOptionId(options, "once"), "allow-once");
  assert.equal(pickPermissionOptionId(options, "session"), "allow-always");
  assert.equal(pickPermissionOptionId(options, "deny"), "reject-once");
});

test("parseGrokUsage reads ACP usage_update and token fields", () => {
  const usage = parseGrokUsage({
    input_tokens: 12,
    output_tokens: 4,
    cache_read_input_tokens: 8,
    cache_creation_input_tokens: 1,
    cost: { amount: 0.02, currency: "USD" },
  });
  assert.deepEqual(usage, {
    inputTokens: 12,
    outputTokens: 4,
    cacheReadTokens: 8,
    cacheWriteTokens: 1,
    costUsd: 0.02,
  });
  const fromUsed = parseGrokUsage({ used: 53000, cost: { amount: 0.045, currency: "USD" } });
  assert.equal(fromUsed?.inputTokens, 53000);
  assert.equal(fromUsed?.costUsd, 0.045);
});

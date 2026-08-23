import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleWorkhorseRpc, linkCliCall } from "../electron/workhorse-mcp";
import { isMcpToolAllowed } from "../electron/mcp-exposure";
import { applyCreateWorkhorseChat, isDraftChat, listedChats } from "../src/lib/chats";
import {
  applyCreateWorkhorseProject,
  applyLinkProjectFolder,
  emptyProject,
  resolveExistingFolder,
} from "../src/lib/project";
import type { Session } from "../src/lib/types";

test("create-project is a desk name, never a new directory", () => {
  const missing = path.join(os.tmpdir(), `wh-no-dir-${Date.now()}`);
  assert.throws(
    () =>
      resolveExistingFolder(missing, {
        resolve: (folder) => folder,
        existsSync: () => false,
        isDirectory: () => false,
        realpathSync: (folder) => folder,
      }),
    /not an existing directory/,
  );
  const created = applyCreateWorkhorseProject([], [], { name: "Cargo Pop", description: "parity board" });
  assert.equal(created.result.ok, true);
  assert.equal(created.result.name, "Cargo Pop");
  assert.equal(created.result.description, "parity board");
  assert.deepEqual(created.result.folders, []);
  assert.equal(created.result.movedThisChat, false);
});

test("link-folder appends an existing path and is idempotent", () => {
  const project = emptyProject("Cargo Pop");
  const first = applyLinkProjectFolder([project], project.id, "/abs/repo");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.path, "/abs/repo");
  assert.equal(first.alreadyLinked, false);
  const again = applyLinkProjectFolder(first.projects, project.id, "/abs/repo");
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.alreadyLinked, true);
  assert.equal(again.project.folders.length, 1);
});

test("create-chat persists a parent without a vendor prompt", () => {
  const project = emptyProject("Cargo Pop");
  const opened = applyCreateWorkhorseChat([], {
    projectId: project.id,
    title: "Parity parent",
    provider: "grok",
    model: "grok-4.6",
    effort: "high",
  });
  assert.equal(opened.session.messages.length, 0);
  assert.equal(opened.session.titleLocked, true);
  assert.equal(isDraftChat(opened.session), false);
  assert.deepEqual(listedChats(opened.sessions).map((item) => item.id), [opened.session.id]);
});

test("Link advertises project lifecycle and refuses delete", () => {
  assert.equal(isMcpToolAllowed("external-runtime", "workhorse_create_project"), true);
  assert.equal(isMcpToolAllowed("external-runtime", "workhorse_link_project_folder"), true);
  assert.equal(isMcpToolAllowed("external-runtime", "workhorse_create_chat"), true);
  assert.equal(isMcpToolAllowed("external-runtime", "workhorse_read_project"), true);
  assert.equal(isMcpToolAllowed("external-runtime", "workhorse_delete_project"), false);
  assert.deepEqual(linkCliCall(["projects"]), { name: "workhorse_list_projects", args: {} });
});

test("Link create-project does not move an ambient chat", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "wh-link-proj-"));
  const stateFile = path.join(scratch, "workhorse-state.json");
  const folder = path.join(scratch, "repo");
  mkdirSync(folder);
  writeFileSync(
    stateFile,
    JSON.stringify({
      projects: [],
      sessions: [{ id: "sess_other", title: "Other", provider: "grok", projectId: null, messages: [{ id: "u", role: "user", text: "hi", createdAt: 1 }] }],
    }),
  );
  const previous = {
    profile: process.env.WORKHORSE_MCP_PROFILE,
    state: process.env.WORKHORSE_STATE_PATH,
    url: process.env.WORKHORSE_BRIDGE_URL,
  };
  try {
    process.env.WORKHORSE_MCP_PROFILE = "external-runtime";
    process.env.WORKHORSE_STATE_PATH = stateFile;
    delete process.env.WORKHORSE_BRIDGE_URL;
    const created = await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "workhorse_create_project", arguments: { name: "Link Demo", folder, idempotencyKey: "k1" } },
    });
    const text =
      (created as { result?: { content?: Array<{ text?: string }> } })?.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
    const parsed = JSON.parse(text) as { ok?: boolean; projectId?: string; name?: string; folder?: string };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.name, "Link Demo");
    assert.equal(parsed.folder, realpathSync(folder));
    const chat = await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "workhorse_create_chat", arguments: { projectId: parsed.projectId, title: "Parent", idempotencyKey: "k2" } },
    });
    const chatText =
      (chat as { result?: { content?: Array<{ text?: string }> } })?.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
    const opened = JSON.parse(chatText) as { ok?: boolean; sessionId?: string; messages?: number };
    assert.equal(opened.ok, true);
    assert.ok(opened.sessionId?.startsWith("sess_"));
    assert.equal(opened.messages, 0);
    const saved = JSON.parse(readFileSync(stateFile, "utf8")) as {
      sessions: Session[];
    };
    assert.equal(saved.sessions.find((item) => item.id === "sess_other")?.projectId, null);
  } finally {
    if (previous.profile === undefined) delete process.env.WORKHORSE_MCP_PROFILE;
    else process.env.WORKHORSE_MCP_PROFILE = previous.profile;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    if (previous.url === undefined) delete process.env.WORKHORSE_BRIDGE_URL;
    else process.env.WORKHORSE_BRIDGE_URL = previous.url;
    rmSync(scratch, { recursive: true, force: true });
  }
});

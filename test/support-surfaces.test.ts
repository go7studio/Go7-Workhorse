import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchChats } from "../src/lib/search";
import { buildSupportReport } from "../electron/diagnostics";
import type { Session } from "../src/lib/types";

const session = {
  id: "chat-1",
  projectId: "project-1",
  provider: "claude",
  model: "claude-sonnet",
  effort: "medium",
  title: "Release notes",
  mode: "ask",
  sandbox: "workspace",
  status: "idle",
  contextUsed: 0,
  messages: [{ id: "message-1", role: "assistant", text: "The deployment checklist is ready", createdAt: 20 }],
} as Session;

test("global search finds titles and transcript text across projects", () => {
  const projects = [{ id: "project-1", name: "Workhorse", folders: [], references: [] }];
  assert.equal(searchChats([session], projects, "deployment")[0]?.messageId, "message-1");
  assert.equal(searchChats([session], projects, "Workhorse")[0]?.sessionId, "chat-1");
});

test("support report contains capabilities but never credential values or prompts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-support-"));
  fs.writeFileSync(path.join(dir, "workhorse-state.json"), "{}", "utf8");
  const report = buildSupportReport({
    state: {
      sessions: [{ ...session, messages: [{ id: "secret-prompt", role: "user", text: "do not export me" }] }],
      projects: [],
      settings: { customBots: [{ name: "Bot", model: "model", api: "openai-completions", apiKey: "sk-secret" }] },
    },
    version: "test",
    userData: dir,
    detections: { grok: { connected: true }, codex: {}, claude: {} },
    encryptionAvailable: true,
  });
  const serialized = JSON.stringify(report);
  assert.match(serialized, /capabilities/);
  assert.doesNotMatch(serialized, /sk-secret|do not export me|secret-prompt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

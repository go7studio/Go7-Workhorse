import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchChats, searchDisplayTitle } from "../src/lib/search";
import { leftoverUnknownMark } from "../src/ui/FuelRing";
import { buildSupportReport } from "../electron/diagnostics";
import type { DeskLineup, Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const crateLineup: DeskLineup = {
  id: "lineup_1",
  folder: path.posix.join("/opt", "fixture-desk"),
  startedAt: 1,
  joinOwner: "external-runtime",
  rows: [
    {
      childId: "child_1",
      title: "Audit tactile crate pass",
      slice: "Audit tactile crate pass",
      folder: path.posix.join("/opt", "fixture-desk"),
      vendor: "claude",
      status: "completed",
      startedAt: 1,
    },
  ],
};

test("global search finds titles and transcript text across projects", () => {
  const projects = [{ id: "project-1", name: "Workhorse", folders: [], references: [], createdAt: 1, openedAt: 1 }];
  assert.equal(searchChats([session], projects, "deployment")[0]?.messageId, "message-1");
  assert.equal(searchChats([session], projects, "Workhorse")[0]?.sessionId, "chat-1");
});

test("search uses the sidebar mission title and still skips hidden chats", () => {
  const projects = [{ id: "project-1", name: "Workhorse", folders: [], references: [], createdAt: 1, openedAt: 1 }];
  const crate = { ...session, title: "Opus ping", lineup: crateLineup } as Session;
  assert.equal(searchDisplayTitle(crate), "Audit tactile crate pass");
  const hit = searchChats([crate], projects, "crate");
  assert.equal(hit[0]?.sessionId, "chat-1");
  assert.equal(hit[0]?.title, "Audit tactile crate pass");
  assert.equal(searchChats([{ ...crate, hidden: true }], projects, "crate").length, 0);
  assert.equal(searchChats([crate], projects, "Opus")[0]?.sessionId, "chat-1");
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
    detections: { grok: { connected: true }, codex: {}, claude: {}, cursor: { connected: true }, openclaw: { connected: true, binary: "/bin/openclaw" }, hermes: {} },
    encryptionAvailable: true,
  });
  const serialized = JSON.stringify(report);
  assert.match(serialized, /capabilities/);
  assert.equal((report.providers.cursor as { connected: boolean }).connected, true);
  assert.equal((report.harnesses.openclaw as { available: boolean }).available, true);
  assert.doesNotMatch(serialized, /sk-secret|do not export me|secret-prompt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("settings blurbs wrap and skill paths keep the folder name from a fixture", () => {
  const css = fs.readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  const mcp = css.match(/\.mcp-settings \.link-head p,\s*\.mcp-settings > \.row-meta,\s*\.skills-heading \.row-meta\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(mcp, /white-space:\s*normal/);
  assert.match(mcp, /overflow:\s*visible/);
  const skillMeta = css.match(/\.skill-row \.row-meta\s*\{[^}]+\}/)?.[0] ?? "";
  assert.match(skillMeta, /white-space:\s*normal/);
  assert.match(skillMeta, /overflow:\s*visible/);
  const sidebarMeta = css.match(/^\.row-meta \{[^}]+\}/m)?.[0] ?? "";
  assert.match(sidebarMeta, /white-space:\s*nowrap/);
  assert.match(sidebarMeta, /text-overflow:\s*ellipsis/);
  const fixtureDir = path.posix.join("/opt", "fixture-home", ".codex", "skills", "asset-audition");
  assert.equal(path.posix.basename(fixtureDir), "asset-audition");
  assert.match(fixtureDir, /^\/opt\/fixture-home\//);
  assert.notEqual(fixtureDir, os.homedir());
});

test("Add a bot Back sits on the full pane, and New project Escape closes from the document", () => {
  const css = fs.readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  const addBotCss = css.match(/\.add-bot \{[^}]+\}/)?.[0] ?? "";
  assert.match(addBotCss, /max-width:\s*none/);
  assert.match(css, /\.add-bot \.project-hero \{[^}]*width:\s*100%/);
  assert.match(css, /\.add-bot \.project-hero \.link-head \{[^}]*width:\s*100%/);
  const sheet = fs.readFileSync(path.join(ROOT, "src", "ui", "NewProjectSheet.tsx"), "utf8");
  assert.match(sheet, /document\.addEventListener\("keydown"/);
  assert.match(sheet, /event\.key !== "Escape"/);
  assert.match(sheet, /closeSheet\(\)/);
  assert.doesNotMatch(sheet, /if \(event\.key === "Escape"\) submit/);
});

test("unknown leftover stays an ellipsis with an Unknown title, never 0 or 100", () => {
  assert.deepEqual(leftoverUnknownMark(true), { label: "…", unknown: true, title: "Unknown" });
  assert.deepEqual(leftoverUnknownMark(false), { label: "…", unknown: false, title: "Loading leftover" });
  const ring = fs.readFileSync(path.join(ROOT, "src", "ui", "FuelRing.tsx"), "utf8");
  assert.match(ring, /title=\{hint\}/);
  assert.match(ring, /aria-label=\{unknown \? "Unknown" : hint\}/);
  assert.doesNotMatch(ring, /label: "0"/);
  const usage = fs.readFileSync(path.join(ROOT, "src", "ui", "UsagePane.tsx"), "utf8");
  assert.match(usage, /leftoverUnknownMark/);
  assert.doesNotMatch(usage, /value=\{ring \? ring\.value : 0\}/);
  assert.doesNotMatch(usage, /value=\{ring \? ring\.value : 1\}/);
});

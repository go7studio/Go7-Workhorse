import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { crewActivity, crewIsLive, crewWorkers } from "../src/lib/crew-tray";
import type { Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(ROOT, "src", "styles", "crew-tray.css"), "utf8");
const tray = readFileSync(path.join(ROOT, "src", "ui", "CrewTray.tsx"), "utf8");

const worker = (id: string, patch: Partial<Session> = {}) => ({
  id, parentId: "parent", status: "idle", messages: [], ...patch,
}) as Session;

test("crew stays scoped to its parent and excludes archived workers", () => {
  const first = worker("first");
  assert.deepEqual(crewWorkers([first, worker("other", { parentId: "elsewhere" }),
    worker("archived", { archivedAt: 1 }), worker("grandchild", { parentId: "first" })], "parent"), [first]);
});

test("working count includes a worker waiting for input and a running agent lifecycle", () => {
  assert.equal(crewIsLive(worker("waiting", { status: "needs-input" })), true);
  assert.equal(crewIsLive(worker("running", { status: "running" })), true);
  assert.equal(crewIsLive(worker("agent", { agentRun: { status: "running", startedAt: 1, isolation: "shared" } })), true);
  assert.equal(crewIsLive(worker("done")), false);
  assert.equal(crewIsLive(worker("think", {
    status: "idle",
    messages: [{ id: "th", role: "assistant", kind: "thought", text: "planning", createdAt: 1 }],
  })), true);
  assert.equal(crewActivity(worker("think", {
    status: "idle",
    messages: [{ id: "th", role: "assistant", kind: "thought", text: "planning", createdAt: 1 }],
  })), "Thinking");
});

test("latest activity uses worker output, never a queued user follow-up", () => {
  assert.equal(crewActivity(worker("one", { messages: [
    { id: "tool", role: "assistant", kind: "tool", text: "Reading\n source files", createdAt: 1 },
    { id: "followup", role: "user", text: "Do something else", createdAt: 2 },
  ] })), "Reading source files");
  assert.equal(crewActivity(worker("one", { status: "needs-input" })), "Needs you");
  assert.equal(crewActivity(worker("one", { agentRun: { status: "failed", error: "Connection lost", startedAt: 1, isolation: "shared" } })), "Connection lost");
});

test("crew tray chip sits left of the composer and does not span the chat", () => {
  assert.match(css, /\.crew-tray\s*\{[^}]*width:\s*max-content/);
  assert.match(css, /\.crew-tray-toggle\s*\{[^}]*flex:\s*0 1 auto/);
  assert.match(css, /\.crew-tray-caret/);
  assert.doesNotMatch(css, /margin-left:\s*auto/);
  assert.match(tray, /crew-tray-caret/);
  assert.match(tray, /View workers/);
  assert.match(tray, /setOpen\(!open\)/);
});

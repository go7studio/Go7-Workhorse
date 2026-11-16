import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { moveChat } from "../src/lib/chats";
import { normalizeSession } from "../src/lib/session";
import { callerExecutionFolder, spawnChildFolder } from "../src/lib/subagents";
import type { Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PARENT = "D:\\GitHub\\Go7-Workhorse";
const PRACTICE = "D:\\GitHub\\orchestration-practice";

function chat(id: string, projectId: string, over: Partial<Session> = {}): Session {
  return {
    id,
    projectId,
    provider: "grok",
    model: "grok-4.7",
    effort: "medium",
    title: id,
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [],
    contextUsed: 0,
    ...over,
  };
}

test("a spawn folder different from the parent workspace is the child cwd", () => {
  const plan = spawnChildFolder({
    admittedCwd: PRACTICE,
    requestedFolder: PRACTICE,
    parentEnvironment: { kind: "local" },
    parentCwd: PARENT,
    projectFolder: PARENT,
    isolation: "shared",
  });
  assert.equal(plan.outsideParent, true);
  assert.equal(plan.cwd, PRACTICE);
  assert.equal(plan.boundFolder, PRACTICE);
  assert.equal(plan.environment.kind, "local");
  assert.notEqual(plan.cwd, PARENT);

  const child = { environment: plan.environment, boundFolder: plan.boundFolder };
  assert.equal(callerExecutionFolder(child, PARENT), PRACTICE);
  assert.equal(normalizeSession({ id: "child", provider: "grok", model: "grok-4.7", boundFolder: PRACTICE })?.boundFolder, PRACTICE);

  const inherited = callerExecutionFolder(child, PARENT);
  const grandchild = spawnChildFolder({
    admittedCwd: inherited,
    parentEnvironment: child.environment,
    parentCwd: inherited,
    projectFolder: PARENT,
    isolation: "shared",
  });
  assert.equal(grandchild.cwd, PRACTICE);
  assert.equal(grandchild.boundFolder, PRACTICE);
  assert.notEqual(grandchild.cwd, PARENT);
});

test("omitting the folder keeps the parent workspace", () => {
  const plan = spawnChildFolder({
    admittedCwd: PARENT,
    parentEnvironment: { kind: "local" },
    parentCwd: PARENT,
    projectFolder: PARENT,
    isolation: "shared",
  });
  assert.equal(plan.outsideParent, false);
  assert.equal(plan.cwd, PARENT);
  assert.equal(plan.boundFolder, undefined);
});

test("moving a chat onto another project folder is what the next spawn uses", () => {
  const nextProject = "D:\\GitHub\\other-project";
  const before = [chat("sess_root", "proj_a", { boundFolder: PRACTICE, environment: { kind: "local" } })];
  assert.equal(callerExecutionFolder(before[0], PARENT), PRACTICE);
  const moved = moveChat(before, "sess_root", "proj_b")![0]!;
  assert.equal(moved.projectId, "proj_b");
  assert.equal(moved.boundFolder, undefined);
  assert.equal(callerExecutionFolder(moved, nextProject), nextProject);
  const plan = spawnChildFolder({
    admittedCwd: nextProject,
    parentEnvironment: moved.environment,
    parentCwd: callerExecutionFolder(moved, nextProject),
    projectFolder: nextProject,
    isolation: "shared",
  });
  assert.equal(plan.cwd, nextProject);
  assert.notEqual(plan.cwd, PRACTICE);
});

test("the vendor process and the lineup both keep that spawn folder", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const promptAt = store.indexOf("const promptVendor = async");
  assert.ok(promptAt > 0, "promptVendor starts the vendor process");
  const promptHead = store.slice(promptAt, promptAt + 2500);
  assert.match(
    promptHead,
    /const cwd = callerExecutionFolder\(session, primaryFolder\(project, folderExists\)\?\.path \?\? ""\);/,
  );
  assert.doesNotMatch(promptHead, /sessionExecutionCwd\(session\.environment/);
  assert.match(store, /folder: childCwd,/);
  assert.match(store, /boundFolder: childBound/);
  assert.match(store, /: folderPlan\.cwd;/);

  const mcp = readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8");
  assert.match(mcp, /const parentCwd = callerExecutionFolder\(caller, projectFolder\);/);
  assert.match(mcp, /projectFolder: isNested \? parentCwd : projectFolder,/);
  assert.equal(
    (mcp.match(/folder: spawnInput\.folder\?\.trim\(\) \? admitted\.cwd : undefined,/g) ?? []).length,
    2,
    "a fallback project folder must not be posted as an explicit spawn folder",
  );
});

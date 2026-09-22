import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { continueWorkerRun, normalizeAgentRun, workerStatusSnapshot } from "../src/lib/subagents";
import type { Session } from "../src/lib/types";
import { foldersToCount, leftInFolderNote, workerFoldersLine, workerLabel } from "../src/lib/worker-folders";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8");

function worker(id: string, environment: Session["environment"], run: Partial<NonNullable<Session["agentRun"]>> = {}): Session {
  return {
    id,
    title: `Hazel · slice ${id}`,
    parentId: "sess_parent",
    environment,
    agentRun: { status: "completed", startedAt: 1_000, isolation: "worktree", ...run },
  } as unknown as Session;
}

test("only a worker that ran in a folder of its own is counted", () => {
  const own = worker("sess_own", { kind: "worktree", path: "/managed/sess_own", gitRoot: "/repo", head: "abc" }, { runId: "run_1" });
  const shared = worker("sess_shared", { kind: "local", path: "/Users/steve/project" } as Session["environment"]);
  const other = worker("sess_other", { kind: "worktree", path: "/managed/sess_other", gitRoot: "/repo", head: "abc" });
  const settled = [
    { workerId: "sess_own", status: "completed" },
    { workerId: "sess_shared", status: "completed" },
  ];
  assert.deepEqual(foldersToCount(settled, [own, shared, other]), [{ id: "sess_own", runKey: "sess_own:run_1" }]);
  assert.deepEqual(foldersToCount([], [own]), []);
});

test("the note names the worker and the count, and the Settings line says what the sweep kept", () => {
  assert.equal(leftInFolderNote("Hazel", 4), "Hazel's folder holds 4 uncommitted files.");
  assert.equal(leftInFolderNote("Hazel", 1), "Hazel's folder holds 1 uncommitted file.");
  assert.equal(workerLabel({ workerName: "Nadia 7", title: "Nadia 7 · gate" }), "Nadia 7");
  assert.equal(workerLabel({ title: "Wren 2 · Platform and packaging hygiene" }), "Wren 2");

  const titles: Record<string, string> = { sess_a: "Wanda 2", sess_b: "Wren 3" };
  const titleOf = (id: string) => titles[id];
  assert.equal(workerFoldersLine(null, titleOf), "The desk counts them shortly after it opens.");
  const base = { at: 1, trees: 2, maxTrees: 24, overTrees: false, removed: 0, held: [] };
  assert.equal(workerFoldersLine(base, titleOf), "2 folders. None stay.");
  const held = [
    { name: "sess_a", reason: "it holds untracked files (art/x.blend)" },
    { name: "sess_b", reason: "it holds untracked files (art/y.blend)" },
  ];
  assert.equal(
    workerFoldersLine({ ...base, trees: 25, overTrees: true, held }, titleOf),
    "25 folders, over the limit of 24. 2 stay: Wanda 2, Wren 3.",
  );
  const many = [...held, { name: "sess_c", reason: "r" }, { name: "sess_d", reason: "r" }, { name: "sess_e", reason: "r" }];
  assert.equal(workerFoldersLine({ ...base, trees: 5, held: many }, titleOf), "5 folders. 5 stay: Wanda 2, Wren 3, sess_c and 2 more.");
  assert.equal(workerFoldersLine({ ...base, trees: 1, held: held.slice(0, 1) }, titleOf), "1 folder. One stays: Wanda 2.");
});

test("the count survives a save, and a worker's status carries it", () => {
  const raw = { status: "completed", startedAt: 1, isolation: "worktree", leftInFolder: { files: 4, at: 2 } };
  assert.deepEqual(normalizeAgentRun(raw)?.leftInFolder, { files: 4, at: 2 });
  for (const junk of [{ files: 0, at: 2 }, { files: -1, at: 2 }, { files: 1.5, at: 2 }, { files: 3 }, "4"]) {
    assert.equal(normalizeAgentRun({ ...raw, leftInFolder: junk })?.leftInFolder, undefined, JSON.stringify(junk));
  }
  const done = {
    ...worker("sess_left", { kind: "worktree", path: "/managed/sess_left", gitRoot: "/repo", head: "abc" }, { finishedAt: 5, leftInFolder: { files: 4, at: 6 } }),
    status: "idle",
    messages: [],
  } as unknown as Parameters<typeof workerStatusSnapshot>[0];
  assert.equal(workerStatusSnapshot(done).leftInFolder, 4);
  // A reused worker starts its next slice with no count from the last one.
  const next = continueWorkerRun({ status: "completed", startedAt: 1, finishedAt: 5, isolation: "worktree", leftInFolder: { files: 4, at: 6 } }, { now: 10 });
  assert.equal(next.leftInFolder, undefined);
});

test("main hands the sweep the chats it last saved, and the store counts on settle, once per run", () => {
  const main = source("electron", "main.ts");
  // Only a save that was written becomes the sweep's list; a refused empty save never does.
  assert.match(main, /if \(result\?\.written && Array\.isArray\(saved\)\) latestSavedSessions = saved;/);
  assert.doesNotMatch(main, /if \(Array\.isArray\(saved\)\) latestSavedSessions = saved;/);
  assert.match(main, /runHousekeeping\(latestSavedSessions \?\? sessions\)/);
  assert.match(main, /ipcMain\.handle\("project:folder-left"/);
  const store = source("src", "lib", "store.tsx");
  assert.match(store, /noteFoldersLeft\(foldersToCount\(settledWorkers\(previous\?\.sessions, state\.sessions\), state\.sessions\)\)/);
  // The answer lands only on the run that ended: a worker resumed meanwhile is left alone.
  assert.match(store, /`\$\{id\}:\$\{run\.runId \?\? run\.startedAt \?\? ""\}` !== runKey\) return current;/);
});

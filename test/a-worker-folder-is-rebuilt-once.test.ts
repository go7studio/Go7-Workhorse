/*
 * Asking for a worker's folder: once at a time, and only ever its own.
 *
 * Resume and a mission reusing the same worker both ask main for the folder,
 * and nothing kept the two apart. The second ask found the folder the first
 * was still rebuilding and handed it back half made, or failed to add it and
 * force-removed the first one's folder on its way out.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { ensureManagedWorktree, pruneOrphanWorktrees, type EnsureWorktreeResult } from "../electron/worktree-host";
import { durable, repoWithWorktree } from "./worktree-fixtures";

const GENERATED = 60;

function releasedWorker(label: string) {
  const made = repoWithWorktree(label);
  for (let index = 0; index < GENERATED; index += 1) {
    fs.writeFileSync(path.join(made.wt, `gen${index}.txt`), `generated ${index}\n`);
  }
  const pruned = pruneOrphanWorktrees(made.managed, [], { ...durable(made.root), resumable: new Set(["sess_gone"]) });
  assert.deepEqual(pruned.removed, ["sess_gone"], "the folder must be let go at a rescue ref first");
  return made;
}

/** The result, and how much of the folder was there when it came back. */
async function asked(repo: string, managed: string, wt: string): Promise<{ result: EnsureWorktreeResult; generated: number }> {
  const result = await ensureManagedWorktree({ sessionId: "sess_gone", root: repo }, managed);
  const generated = fs.existsSync(wt) ? fs.readdirSync(wt).filter((name) => name.startsWith("gen")).length : -1;
  return { result, generated };
}

test("two asks at once rebuild a released folder once, and both get it whole", async () => {
  const { root, repo, managed, wt } = releasedWorker("twice-at-once");

  const [first, second] = await Promise.all([asked(repo, managed, wt), asked(repo, managed, wt)]);

  assert.equal(first.result.ok, true, JSON.stringify(first.result));
  assert.equal(second.result.ok, true, JSON.stringify(second.result));
  assert.equal(first.generated, GENERATED);
  assert.equal(second.generated, GENERATED);
  assert.equal(first.result.ok && first.result.restored !== undefined, true, "the first rebuilds it");
  assert.equal(second.result.ok && second.result.reused, true, "the second finds it made");
  fs.rmSync(root, { recursive: true, force: true });
});

test("an ask that arrives mid-rebuild waits for the folder rather than taking half of it", async () => {
  const { root, repo, managed, wt } = releasedWorker("mid-rebuild");

  const first = asked(repo, managed, wt);
  // The moment the rebuild's checkout makes the folder, ask again.
  const until = Date.now() + 30_000;
  while (!fs.existsSync(wt) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 1));
  const second = await asked(repo, managed, wt);
  const done = await first;

  assert.equal(done.result.ok, true, JSON.stringify(done.result));
  assert.equal(second.result.ok, true, JSON.stringify(second.result));
  assert.equal(second.generated, GENERATED, "the second ask came back to a folder still being rebuilt");
  fs.rmSync(root, { recursive: true, force: true });
});

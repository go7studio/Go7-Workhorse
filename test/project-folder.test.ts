/**
 * A project linked two folders. The repo behind the first one moved, the dead
 * link stayed first, and every agent in that project died with `spawn ~/.grok/bin/grok ENOENT` — a message naming a
 * binary that was present, resolvable and executable the whole time. Node
 * reports a working directory that does not exist by naming the command.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { spawnCwd } from "../electron/spawn-cwd";
import { primaryFolder } from "../src/lib/project";
import { volatileFolderPath } from "../src/lib/store";
import type { Project } from "../src/lib/types";

const project = (...paths: string[]): Project =>
  ({
    id: "proj_example",
    name: "Example",
    folders: paths.map((folder, index) => ({ id: `fold_${index}`, path: folder, label: path.basename(folder) })),
  }) as Project;

const DEAD = "/nowhere/workspace/repos/moved-away";
const LIVE = "/nowhere/workspace/current/moved-away";
const exists = (folder: string) => folder !== DEAD;

test("a folder that moved is skipped when a live one is linked beside it", () => {
  assert.equal(primaryFolder(project(DEAD, LIVE), exists)?.path, LIVE);
  // Order must not matter, and a healthy project keeps answering its first.
  assert.equal(primaryFolder(project(LIVE, DEAD), exists)?.path, LIVE);
  assert.equal(primaryFolder(project(LIVE, "/tmp/other"), exists)?.path, LIVE);
});

test("with nothing to fall back to, it still names a folder the person linked", () => {
  // Answering "" here would spawn in the desk's own directory and quietly do
  // work in the wrong tree. The caller needs a real path to complain about.
  assert.equal(primaryFolder(project(DEAD), exists)?.path, DEAD);
  assert.equal(primaryFolder(project(), exists), null);
  assert.equal(primaryFolder(undefined, exists), null);
});

test("without a probe the old choice stands, so a slow answer changes nothing", () => {
  assert.equal(primaryFolder(project(DEAD, LIVE))?.path, DEAD);
});

test("a missing folder says so, instead of blaming the vendor's binary", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workhorse-cwd."));
  try {
    assert.equal(spawnCwd(root), root);
    assert.equal(spawnCwd(undefined), undefined, "no folder at all is not an error — the desk has chats with none");
    assert.equal(spawnCwd("   "), undefined);
    assert.throws(
      () => spawnCwd(DEAD),
      (error: Error) => {
        assert.match(error.message, /project folder is missing/);
        assert.match(error.message, /moved-away/, "it must name the folder that is gone");
        assert.doesNotMatch(error.message, /ENOENT/, "the old message sent people hunting for a CLI");
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every vendor host runs its agent through the guard", () => {
  // One host left unguarded is one vendor that still reports the wrong cause.
  for (const host of ["grok-agent", "cursor-host", "codex-host", "claude-host"]) {
    const source = readFileSync(new URL(`../electron/${host}.ts`, import.meta.url), "utf8");
    assert.match(source, /cwd: spawnCwd\(cwd\)/, `${host} must check the folder before spawning`);
  }
});

test("nothing that decides a directory picks a folder without asking", () => {
  // Not just the store. The terminal, the worktree button and the Codex probe
  // all resolve a project root too, and a UI that names the dead folder while
  // the agent runs in the live one is its own bug.
  const surfaces = ["src/lib/store.tsx", "src/ui/SessionPane.tsx", "src/ui/SessionSetup.tsx", "src/ui/Settings.tsx"];
  for (const file of surfaces) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const bare = [...source.matchAll(/\??\.folders\[0\]\?\.path/g)];
    assert.equal(bare.length, 0, `${file} chose a folder that may be gone`);
  }
});

test("the store never picks a folder without asking whether it is there", () => {
  // Each of these decides where an agent runs. A bare folders[0] here is the
  // bug returning.
  const store = readFileSync(new URL("../src/lib/store.tsx", import.meta.url), "utf8");
  const picks = [...store.matchAll(/sessionExecutionCwd\(/g)].length;
  assert.ok(picks >= 4, `expected the execution-cwd sites, found ${picks}`);
  const bare = [...store.matchAll(/\?\.folders\[0\]\?\.path/g)];
  assert.equal(bare.length, 0, "a folder that may be gone was chosen without a check");
});

test("Node really does blame the command for a missing directory", async () => {
  // The claim the whole fix rests on, rather than a comment asserting it.
  const code = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ["--version"], { cwd: DEAD });
    child.on("error", (error: NodeJS.ErrnoException) => resolve(`${error.code}:${error.message}`));
    child.on("spawn", () => { child.kill(); resolve("spawned"); });
  });
  assert.match(code, /^ENOENT/);
  assert.match(code, /spawn .*node/i, "the message names the binary, never the directory");
});

/**
 * The second half of the same failure. A linked folder can be gone because it
 * moved — or because the operating system took it. `/private/tmp` is swept by a
 * daily launchd job on this platform (`com.apple.tmp_cleaner`, midnight) and
 * `/var/folders` is per-boot scratch, so a project pointed at either is a
 * project on a timer nobody set.
 */
test("a folder the system empties is recognised, and an ordinary one is not", () => {
  for (const volatile of [
    "/tmp",
    "/tmp/scratch",
    "/private/tmp",
    "/private/tmp/build-42",
    "/var/folders/kf/abc123/T/render",
    "/private/var/folders/kf/abc123/T",
    "/private/tmp/",
  ]) {
    assert.equal(volatileFolderPath(volatile), true, `${volatile} is cleared by the system`);
  }
  for (const durable of [
    "/nowhere/workspace/repos/game",
    "/Volumes/work/tmp-notes",
    "/nowhere/tmpfiles",
    "/private/tmpfoo",
    "/var/foldersomething",
    "",
    "   ",
  ]) {
    assert.equal(volatileFolderPath(durable), false, `${durable} is an ordinary folder`);
  }
});

test("linking a temporary folder warns instead of refusing", () => {
  // A project is a name and its folders are optional links, so someone pointing
  // a throwaway project at scratch space means it. They are told, not stopped.
  const store = readFileSync(new URL("../src/lib/store.tsx", import.meta.url), "utf8");
  const linkFolder = store.slice(store.indexOf("const linkFolder = useCallback"));
  const body = linkFolder.slice(0, linkFolder.indexOf("const unlinkFolder"));
  assert.match(body, /if \(volatileFolderPath\(folderPath\)\)/, "the warning has to be at the moment of choosing");
  assert.match(body, /notifyDesktop/, "and it has to reach the person, not the console");
  assert.doesNotMatch(body, /volatileFolderPath\(folderPath\)\)\s*return/, "linking must never be refused");
  assert.match(body, /folders: \[\.\.\.project\.folders, folderFromPath\(folderPath/, "the folder is still linked");
});

test("the missing-folder answer is something React can redraw on", () => {
  // It was a ref mutated inside a promise. Nothing re-rendered, so Project Home
  // drew a deleted folder as a live one until something unrelated forced a pass.
  const store = readFileSync(new URL("../src/lib/store.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(store, /const \[missingFolderPaths, setMissingFolderPaths\] = useState<ReadonlySet<string>>/);
  assert.match(store, /missingFolders\.current = next;\s*\n\s*setMissingFolderPaths\(next\);/, "the ref and the state must move together");
  assert.match(store, /if \(live\) applyMissingFolders\(new Set\(gone\)\)/, "the probe's answer must go through it");
  // And the memo has to depend on it, or the new value never leaves the provider.
  const deps = store.slice(store.indexOf("    }),\n    [\n      state,"));
  assert.match(deps.slice(0, 600), /\n      missingFolderPaths,\n/);
});

test("Project Home shows a linked folder that is not there", () => {
  const home = readFileSync(new URL("../src/ui/ProjectHome.tsx", import.meta.url), "utf8");
  assert.match(home, /const gone = store\.missingFolderPaths\.has\(folder\.path\)/);
  assert.match(home, /Not on disk\./, "a person cannot fix what they are not shown");
  assert.match(home, /const temporary = !gone && volatileFolderPath\(folder\.path\)/);
  assert.match(home, /Temporary folder\./);
});

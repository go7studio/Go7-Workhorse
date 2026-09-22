/**
 * Git repositories with one managed worker folder, shared by the suites that
 * drive the worktree sweep and the rescue. Each suite is its own file so no
 * one file outgrows the per-file ceiling on the Windows runner.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A managed worktree is where a worker's generated output lives, and that output is
 * untracked: it belongs to no commit, and no diff would carry it. Sweeping the
 * directory with `fs.rmSync` destroyed it. These pin the refusal instead.
 */

export function repoWithWorktree(
  label: string,
  /** Committed in the repository before the worktree exists, so HEAD stays reachable. */
  tracked: Record<string, string> = {},
): { root: string; repo: string; managed: string; wt: string; remote: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `workhorse-prune-${label}-`));
  const repo = path.join(root, "repo");
  const managed = path.join(root, "worktrees");
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(repo);
  fs.mkdirSync(managed);
  const git = (args: string[], cwd = repo) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git(["init", "-q", "--bare", remote], root);
  git(["init", "-q", "."]);
  // Windows runners convert line endings on checkout. These tests compare
  // bytes, so the repositories they build say plainly that nothing converts.
  git(["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "original\n");
  for (const [name, body] of Object.entries(tracked)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), body);
  }
  git(["add", "-A"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"]);
  // The base commit goes to a remote, so a tree sitting on it is saved
  // somewhere other than this disk. Without that, every tree here would be
  // held as unpushed and none of these tests would reach what it aims at.
  git(["remote", "add", "origin", remote]);
  git(["push", "-q", "origin", "HEAD:refs/heads/main"]);
  git(["fetch", "-q", "origin"]);
  const wt = path.join(managed, "sess_gone");
  git(["worktree", "add", "--quiet", "--detach", wt]);
  // A folder made in the last hour is never swept; these trees stand in for
  // ones a finished worker left long ago.
  const earlier = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(wt, ".git"), earlier, earlier);
  return { root, repo, managed, wt, remote };
}

/*
 * The fixtures live under the system temporary folder, which is exactly where
 * the rescue refuses to keep anything. Tests that mean "a durable repository"
 * name a stand-in temporary folder that does not hold the fixture.
 */

export function durable(root: string) {
  return { tempRoot: path.join(root, "elsewhere-temp") };
}

export const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A clean filter that changes what it stores, run by the node running these tests. */

export function upperCaseFilter(root: string, repo: string): void {
  const script = path.join(root, "upper.js");
  fs.writeFileSync(script, "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()));\n");
  const quoted = (file: string) => `"${file.replace(/\\/g, "/")}"`;
  git(repo, ["config", "filter.upper.clean", `${quoted(process.execPath)} ${quoted(script)}`]);
}

/** What CPython 3.12 writes: version 3531, CR LF, flags 0, an eight-byte stamp, then a code object. */

export function pycBytes(): Buffer {
  return Buffer.concat([Buffer.from([0xcb, 0x0d, 0x0d, 0x0a]), Buffer.alloc(12), Buffer.from([0xe3]), Buffer.from("code object")]);
}

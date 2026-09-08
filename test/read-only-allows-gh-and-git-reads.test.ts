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
const LIVE_GH_VIEW =
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
  [LIVE_GH_VIEW, true, "the observed gh pr view --json line"],
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
  ["gh repo view go7studio/Go7-Workhorse", true, "repo view reads"],
  ["gh api repos/go7studio/Go7-Workhorse/pulls/293", true, "gh api defaults to GET"],
  ["gh api --method GET repos/go7studio/Go7-Workhorse", true, "an explicit GET reads"],
  ["gh api -X GET /rate_limit", true, "-X GET reads"],

  // gh writes.
  ["gh pr merge 293 --squash", false, "merge is a write"],
  ["gh pr close 293", false, "close is a write"],
  ["gh pr comment 293 --body hi", false, "comment is a write"],
  ["gh pr create --title x --body y", false, "create is a write"],
  ["gh pr edit 293 --add-label bug", false, "edit is a write"],
  ["gh pr review 293 --approve", false, "review is a write"],
  ["gh api -X POST repos/go7studio/Go7-Workhorse/issues", false, "-X POST is a write"],
  ["gh api --method PATCH /repos/x/y", false, "PATCH is a write"],
  ["gh api -X PUT /repos/x/y", false, "PUT is a write"],
  ["gh api -X DELETE /repos/x/y", false, "DELETE is a write"],
  ["gh api /repos/x/y/issues -f title=bug", false, "a -f field posts a body"],
  ["gh api /repos/x/y -F n=@file.json", false, "a -F field posts a body"],
  ["gh api /repos/x/y --input body.json", false, "--input posts a body"],
  ["gh api graphql -f query=x", false, "graphql posts"],
  ["gh repo delete go7studio/x", false, "repo delete is a write"],
  ["gh release create v1", false, "release is not on the read table"],
  ["gh auth token", false, "auth is not on the read table"],
  ["gh pr", false, "a group with no subcommand is a write"],

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

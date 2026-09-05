import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  autoAllowPermission,
  looksLikeDelegationTool,
  looksLikeSearchOnly,
  looksLikeShellTool,
  looksLikeWriteTool,
  permissionPolicyAnswer,
  securityPolicyAnswer,
  shellCommandIn,
  type PermissionAnswer,
} from "../src/lib/permissions";
import { WRITE_LIMIT_HINT } from "../src/lib/workhorse-rules";
import type { PermissionMode, SandboxProfile } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * The two calls a Claude worker was denied for on 5 September 2026, copied off
 * the wire. Both are reads. Both were refused "by the desk" on a read-only
 * seat, because the title the desk's own labeller gave them — "Run a command" —
 * was a name no classifier knew, so the JSON envelope was judged as if the
 * braces were the program.
 */
const LIVE_GREP_SED = String.raw`{"command":"grep -rn \"influence\" --include=*.dart lib | grep -v \"globalInfluence\" | sed 's/^\\(.\\{200\\}\\).*/\\1.../' ","description":"Grep all influence references in lib"}`;
const LIVE_GREP_HEAD = String.raw`{"command":"grep -rn \"25 Influence\\|5 Influence\\|refund 4\\|influence, \\|influence ==\\|influence,$\" --include='*.dart' test | head -40","description":"Find influence assertions in tests"}`;
const LIVE_DETAILS = [LIVE_GREP_SED, LIVE_GREP_HEAD] as const;

/** The title the desk's labeller puts on a pasted command (tool-labels.ts). */
const DESK_TITLE = "Run a command";
/** The ACP kind Claude sends for the same call, now carried alongside it. */
const RAW_KIND = "execute";

test("the title the desk puts on a shell call is read as a shell", () => {
  assert.equal(looksLikeShellTool(DESK_TITLE, LIVE_GREP_SED), true);
  assert.equal(looksLikeShellTool(`${DESK_TITLE} ${RAW_KIND}`, LIVE_GREP_HEAD), true);
  assert.equal(looksLikeShellTool("execute", ""), true, "the ACP kind on its own is a shell");
  assert.equal(looksLikeShellTool("run_terminal_cmd", ""), true);
  // The name is what says shell. A brief that talks about executing is a brief.
  assert.equal(
    looksLikeShellTool("Task", "execute the plan and report back"),
    false,
    "a word in the payload is not a shell",
  );
});

test("a JSON detail is judged by the command inside it, not by the envelope", () => {
  assert.equal(
    shellCommandIn(LIVE_GREP_SED),
    String.raw`grep -rn "influence" --include=*.dart lib | grep -v "globalInfluence" | sed 's/^\(.\{200\}\).*/\1.../'`,
  );
  assert.equal(
    shellCommandIn(LIVE_GREP_HEAD),
    String.raw`grep -rn "25 Influence\|5 Influence\|refund 4\|influence, \|influence ==\|influence,$" --include='*.dart' test | head -40`,
  );
  assert.equal(shellCommandIn(JSON.stringify({ cmd: "rg --files" })), "rg --files", "Codex sends cmd");
  assert.equal(shellCommandIn(JSON.stringify({ tool_input: { command: "ls docs" } })), "ls docs");
  assert.equal(shellCommandIn("rg --files"), undefined, "a bare command is not JSON");
  // A long call reaches the desk clipped. The command survives the cut.
  assert.equal(shellCommandIn(String.raw`{"command":"grep -rn foo lib","descri`), "grep -rn foo lib");
});

test("a pipeline of read-only programs is a search, and anything that writes is not", () => {
  for (const detail of LIVE_DETAILS) {
    assert.equal(looksLikeSearchOnly(DESK_TITLE, detail), true, `live detail is a search: ${detail.slice(0, 40)}`);
    assert.equal(looksLikeWriteTool(DESK_TITLE, detail), false, "and so it is not a write");
  }
  const searches: string[] = [
    "git log --oneline | head",
    "rg --files",
    "grep -rn write src | wc -l",
    "ls docs",
    "find . -name '*.ts' | sort | uniq",
    "cat notes.md | sed -n '1,20p'",
    "git status --short",
    "git diff | head -100",
  ];
  for (const command of searches) {
    assert.equal(looksLikeSearchOnly("shell", command), true, `${command} only reads`);
  }
  const writes: string[] = [
    "grep x | tee out.txt",
    "sed -i 's/a/b/' src/app.ts",
    "find . -delete",
    "find . -name '*.log' -exec rm {} ;",
    "cat a > b",
    "echo hi >> notes.md",
    "awk '{print > \"out.txt\"}' f",
    "sort a -o b",
    "uniq in out",
    "env FOO=1 rm x",
    "git commit -m x",
    "git branch feature-x",
    "git branch -d old",
    "rg foo && rm notes.md",
    "grep foo lib; rm -rf build",
    "grep foo `whoami`",
    "grep foo $(cat list.txt)",
  ];
  for (const command of writes) {
    assert.equal(looksLikeSearchOnly("shell", command), false, `${command} is not a search`);
  }
  // The word check no longer decides a shell. The program does.
  assert.equal(looksLikeSearchOnly("shell", "grep -rn 'remove the file' src"), true);
});

test("sed and awk are searches only for a program that cannot break out of itself", () => {
  // Both take a program of their own, and both can run a command from inside
  // it. Read as searches, they answered "once" on a read-only seat.
  const escapes: string[] = [
    String.raw`awk 'BEGIN{system("rm x")}'`,
    String.raw`sed 'e rm x'`,
    String.raw`awk 'BEGIN{print "x" > "/tmp/f"}'`,
    String.raw`awk 'BEGIN{"rm x" | getline}'`,
    String.raw`sed 's/a/b/w out.txt'`,
    String.raw`sed -i 's/a/b/' f`,
    String.raw`sed -f script.sed f`,
    String.raw`awk -f script.awk f`,
  ];
  for (const command of escapes) {
    assert.equal(looksLikeSearchOnly("shell", command), false, `${command} can run a program`);
    assert.equal(
      permissionPolicyAnswer({ mode: "plan", sandbox: "read-only", tool: "shell", detail: command }),
      "deny",
      `${command} is refused on a read-only seat`,
    );
  }
  const plain: string[] = [
    String.raw`awk '{print $1}'`,
    String.raw`awk -F: '{print $1}' /etc/passwd`,
    String.raw`sed 's/a/b/'`,
    String.raw`sed -n '1,20p'`,
    String.raw`sed '1,20d'`,
    String.raw`cat notes.md | sed -n '1,20p'`,
  ];
  for (const command of plain) {
    assert.equal(looksLikeSearchOnly("shell", command), true, `${command} only reads`);
  }
  // The live call's own sed script is a plain substitution and stays a search.
  for (const detail of LIVE_DETAILS) {
    assert.equal(looksLikeSearchOnly(DESK_TITLE, detail), true);
  }
});

test("a shell command is held to the root boundary by the paths inside it", () => {
  const roots = ["/repo"];
  const ask = (command: string, root: "blocked" | "ask" | "allowed", where = roots) =>
    securityPolicyAnswer({
      policy: { network: "allowed", root },
      tool: DESK_TITLE,
      detail: JSON.stringify({ command }),
      roots: where,
    });
  // A shell call carries no path of its own, so the root check had nothing to
  // look at and a read outside the workspace went through.
  assert.deepEqual(ask("cat /etc/passwd", "blocked"), { answer: "deny", boundary: "outside-workspace" });
  assert.deepEqual(ask("cat /etc/passwd", "ask"), { answer: null, boundary: "outside-workspace" });
  assert.deepEqual(ask("grep x /repo/src/a.ts", "blocked"), { answer: null }, "inside the root still reads");
  assert.deepEqual(ask("grep -rn foo lib", "blocked"), { answer: null }, "a relative path is not judged here");
  assert.deepEqual(ask("cat /etc/passwd", "blocked", []), { answer: null }, "no roots, no boundary");
  for (const detail of LIVE_DETAILS) {
    assert.deepEqual(
      securityPolicyAnswer({ policy: { network: "allowed", root: "blocked" }, tool: DESK_TITLE, detail, roots }),
      { answer: null },
      "the live calls name no absolute path",
    );
  }
  // A sub-agent launch keeps the exemption it always had: its detail is the
  // brief it hands the helper, so a folder named in there is not the target.
  const brief = JSON.stringify({ variant: "Task", prompt: "run bash checks over /elsewhere/repo and report" });
  assert.deepEqual(
    securityPolicyAnswer({ policy: { network: "allowed", root: "blocked" }, tool: "Task", detail: brief, roots }),
    { answer: null },
  );
});

test("a quoted path is still a path", () => {
  const roots = ["/repo"];
  const ask = (command: string) =>
    securityPolicyAnswer({
      policy: { network: "allowed", root: "blocked" },
      tool: DESK_TITLE,
      detail: JSON.stringify({ command }),
      roots,
    });
  // The walk kept the opening quote and dropped the closing one, so a quoted
  // token never started with a slash and walked past the root check.
  const outside: string[] = [
    String.raw`cat "/etc/passwd"`,
    String.raw`cat '/etc/passwd'`,
    String.raw`cat "/etc/my secrets"`,
    String.raw`cat --file="/etc/x"`,
  ];
  for (const command of outside) {
    assert.deepEqual(ask(command), { answer: "deny", boundary: "outside-workspace" }, command);
  }
  assert.deepEqual(ask(String.raw`cat "/repo/src/a.ts"`), { answer: null }, "quoted and inside the root still reads");
  // A quoted script is still not a path, which is why the quotes are kept in
  // the token and only a matching pair comes off.
  assert.deepEqual(ask(String.raw`sed 's|^/x|y|' f`), { answer: null });
});

test("a shell is never excused by a delegation envelope it wrote itself", () => {
  const roots = ["/repo"];
  const forgedRead = String.raw`{"variant":"Task","command":"cat /etc/passwd"}`;
  const forgedWrite = String.raw`{"variant":"Task","command":"rm -rf src"}`;
  // The variant is a field inside vendor text. On a shell-named tool it bought
  // an exemption from both the root scan and the write check.
  assert.equal(looksLikeDelegationTool(DESK_TITLE, forgedRead), false);
  assert.deepEqual(
    securityPolicyAnswer({ policy: { network: "allowed", root: "blocked" }, tool: DESK_TITLE, detail: forgedRead, roots }),
    { answer: "deny", boundary: "outside-workspace" },
  );
  assert.equal(looksLikeWriteTool(DESK_TITLE, forgedWrite), true);
  assert.equal(
    permissionPolicyAnswer({ mode: "ask", sandbox: "read-only", tool: DESK_TITLE, detail: forgedWrite }),
    "deny",
  );
  // A real launch is still a launch, including one whose brief says "bash".
  const brief = JSON.stringify({ variant: "Task", prompt: "tail math check. Do not write files." });
  assert.equal(looksLikeDelegationTool("IOpenER tail math check", brief), true);
  assert.equal(looksLikeWriteTool("IOpenER tail math check", brief), false);
  const bashBrief = JSON.stringify({ variant: "Task", prompt: "run bash checks over /elsewhere/repo and report" });
  assert.equal(looksLikeDelegationTool("IOpenER tail math check", bashBrief), true);
});

test("a path that climbs out of the folder is measured where it lands", () => {
  const ask = (command: string, roots: string[], cwd?: string) =>
    securityPolicyAnswer({
      policy: { network: "allowed", root: "blocked" },
      tool: DESK_TITLE,
      detail: JSON.stringify({ command }),
      roots,
      cwd,
    });
  const denied = { answer: "deny", boundary: "outside-workspace" };
  assert.deepEqual(ask("cat ../../etc/passwd", ["/repo/app"], "/repo/app"), denied);
  assert.deepEqual(ask(String.raw`cat "../../etc/passwd"`, ["/repo/app"], "/repo/app"), denied);
  assert.deepEqual(ask("cat ../../etc/passwd", ["/repo/app"]), denied, "with no cwd the first root stands in");
  assert.deepEqual(ask("cat ../src/a.ts", ["/repo"], "/repo/app"), { answer: null }, "still inside the root");
  assert.deepEqual(ask("cat ./src/a.ts", ["/repo/app"], "/repo/app"), { answer: null });
  assert.deepEqual(ask("cat ../../etc/passwd", []), { answer: null }, "no roots, no boundary");
});

test("a vendor's read-sounding tool name does not make a write a read", () => {
  // The raw name now rides with the title, and it is the vendor's to choose.
  assert.equal(looksLikeWriteTool("Read file read", "rm -rf src"), true);
  assert.equal(
    permissionPolicyAnswer({ mode: "ask", sandbox: "read-only", tool: "Read file read", detail: "rm -rf src" }),
    "deny",
  );
  assert.equal(looksLikeWriteTool("Read", JSON.stringify({ command: "rm -rf src" })), true);
  // The exemption still holds for what it was written for: the name decides,
  // and a read's own payload is not a target.
  assert.equal(looksLikeWriteTool("read_file", "src/delete-me.ts", "src/delete-me.ts"), false);
  assert.equal(looksLikeWriteTool("read_file", "notes.md", "notes.md"), false);
  assert.equal(looksLikeWriteTool("mcp__fs__read_file", "notes.md"), false);
  assert.equal(looksLikeWriteTool("rg", "rg -n leftover src"), false);
  assert.equal(looksLikeWriteTool("web_fetch", "https://example.com/rm"), false, "a URL is not the program rm");
  assert.equal(looksLikeWriteTool("web_search", "how to rm -rf safely"), false, "a query is not a command");
});

test("the write-limit hint no longer tells a read-only chat that every command is blocked", () => {
  assert.doesNotMatch(WRITE_LIMIT_HINT, /or run shell commands/);
  assert.match(WRITE_LIMIT_HINT, /cannot write, edit, create, or delete/);
  assert.match(WRITE_LIMIT_HINT, /only reads, such as grep, rg, cat, ls or git log, still runs/);
});

test("a search-only command answers once on a read-only seat, and a write still does not", () => {
  const seats: Array<[PermissionMode, SandboxProfile]> = [
    ["accept-edits", "read-only"],
    ["plan", "read-only"],
    ["accept-edits", "strict"],
    ["ask", "read-only"],
  ];
  for (const detail of LIVE_DETAILS) {
    for (const [mode, sandbox] of seats) {
      assert.equal(
        permissionPolicyAnswer({ mode, sandbox, tool: DESK_TITLE, detail }),
        "once",
        `a read at ${mode}/${sandbox} is allowed: a read-only seat blocks writes, never reads`,
      );
    }
    assert.equal(
      permissionPolicyAnswer({ mode: "always-approve", sandbox: "off", tool: DESK_TITLE, detail }),
      "session",
      "and the person's own chat is unchanged",
    );
  }
  // The seat still stops a write, which is the whole point of the seat.
  for (const command of ["rm -rf src", "cat a > b", "sed -i 's/x/y/' src/app.ts"]) {
    assert.equal(
      permissionPolicyAnswer({
        mode: "accept-edits",
        sandbox: "read-only",
        tool: DESK_TITLE,
        detail: JSON.stringify({ command, description: "housekeeping" }),
      }),
      "deny",
      `${command} is still denied on a read-only seat`,
    );
  }
});

/**
 * The store's own chain for a worker nobody can card: the security boundary,
 * then the seat policy, then the grants, and a hidden worker left with no
 * answer is denied. Mirrored here so the reads and the write are judged by the
 * same order the desk uses (src/lib/store.tsx).
 */
function deskAnswer(input: {
  tool: string;
  rawTool?: string;
  detail: string;
  mode: PermissionMode;
  sandbox: SandboxProfile;
  hidden: boolean;
}): PermissionAnswer | null {
  const classifyTool = input.rawTool ? `${input.tool} ${input.rawTool}` : input.tool;
  const security = securityPolicyAnswer({ tool: classifyTool, detail: input.detail });
  const forced = security.answer ?? permissionPolicyAnswer({
    mode: input.mode,
    sandbox: input.sandbox,
    tool: classifyTool,
    detail: input.detail,
  });
  const answered = forced ?? autoAllowPermission({ tool: input.tool, detail: input.detail });
  return answered ?? (input.hidden ? "deny" : null);
}

test("a hidden worker's read is answered, and its write is still denied", () => {
  for (const detail of LIVE_DETAILS) {
    assert.equal(
      deskAnswer({ tool: DESK_TITLE, rawTool: RAW_KIND, detail, mode: "accept-edits", sandbox: "read-only", hidden: true }),
      "once",
      "the call that was denied twice on 5 September 2026 now runs",
    );
    assert.equal(
      deskAnswer({ tool: DESK_TITLE, detail, mode: "accept-edits", sandbox: "read-only", hidden: true }),
      "once",
      "and it runs even when the vendor sends no raw name",
    );
  }
  assert.equal(
    deskAnswer({
      tool: DESK_TITLE,
      rawTool: RAW_KIND,
      detail: JSON.stringify({ command: "rm -rf src", description: "clean up" }),
      mode: "accept-edits",
      sandbox: "read-only",
      hidden: true,
    }),
    "deny",
    "the hidden-deny path still refuses a real write on a read-only seat",
  );
});

test("every vendor host hands the classifiers the vendor's own tool name", () => {
  const agent = read("electron/grok-agent.ts");
  assert.match(agent, /rawTool: rawToolName\(params\)/, "the ACP agent reads the tool kind off the call");
  assert.match(agent, /typeof toolCall\.kind === "string"/);
  for (const rel of ["electron/claude-host.ts", "electron/codex-host.ts", "electron/cursor-host.ts", "electron/grok-host.ts"]) {
    assert.match(read(rel), /rawTool: ask\.rawTool,/, `${rel} forwards the raw name`);
  }
  assert.match(read("electron/custom-host.ts"), /rawTool: use\.name,/, "the custom host sends its own tool name");
  for (const rel of ["electron/grok-host.ts", "src/vite-env.d.ts"]) {
    assert.match(read(rel), /rawTool\?: string;/, `${rel} carries the field`);
  }
  const store = read("src/lib/store.tsx");
  assert.match(store, /const classifyTool =/, "the store composes the name the classifiers judge");
  assert.match(store, /tool: classifyTool,\n\s+detail: event\.detail,/, "and passes it to the policy");
  assert.match(store, /tool: event\.tool,\n\s+detail:/, "while the card still shows the title");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  autoAllowPermission,
  looksLikeSearchOnly,
  looksLikeShellTool,
  looksLikeWriteTool,
  permissionPolicyAnswer,
  securityPolicyAnswer,
  shellCommandIn,
  type PermissionAnswer,
} from "../src/lib/permissions";
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

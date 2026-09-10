import { modeLabel, sandboxLabel } from "./commands";
import { uid } from "./id";
import { applySessionElevation } from "./session";
import { canonicalToolKey, isAcpToolKind, toolNameKey } from "./tool-labels";
import type { BotAccessDefaults, DeskAccess, PermissionGrant, PermissionMode, PermissionRequest, SandboxProfile, Session } from "./types";

export type PermissionAnswer = "once" | "session" | "deny";

const DELEGATION_TOOLS = /^(?:task|agent|launch_agent|spawn_agent|spawn_subagent|delegate)$/;

/**
 * A sub-agent launch carries the whole assignment as its detail, so the words
 * inside it — "write the test", "create the file" — are the helper's brief,
 * not this call's target. Reading them as a target turned every launch into a
 * write and asked the person to drop the sandbox for it. A delegation is
 * judged at spawn admission; the write heuristic stays out of it.
 */
export function looksLikeDelegationTool(tool: string, detail: string): boolean {
  if (DELEGATION_TOOLS.test(canonicalToolKey(tool))) return true;
  // Past this line the evidence is a field inside vendor-supplied text, and a
  // shell must never be excused by its own envelope: a call named "Run a
  // command" carrying {"variant":"Task","command":"rm -rf src"} is a command.
  // The name is judged on its own, so a brief that merely mentions bash is
  // still a brief.
  if (shellByName(tool)) return false;
  const text = detail.trim();
  if (!text.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(text) as { variant?: unknown };
    return typeof parsed.variant === "string" && /^(?:task|agent)$/i.test(parsed.variant.trim());
  } catch {
    // A long brief can reach the desk clipped. The variant is the first key
    // the vendors send, so it survives a cut that the closing brace does not.
    return /^\{\s*"variant"\s*:\s*"(?:task|agent)"/i.test(text);
  }
}

/**
 * Tool names that only ever read. The exemption keys on the NAME, never on the
 * detail or the path: a query, a filename, or a brief is the payload a tool was
 * handed, not the thing the tool does. Matching words instead let
 * `rm -rf ~/search` out through the read exemption, and denied a plain read of
 * `src/delete-me.ts` as if it were a write.
 */
const READ_TOOL_KEYS: ReadonlySet<string> = new Set([
  "read",
  "read_file",
  "readfile",
  "view",
  "list",
  "list_dir",
  "listdir",
  "glob",
  "grep",
  "ripgrep",
  "rg",
  "rg_exe",
  "search",
  "codebase_search",
  "file_search",
  "web_search",
  "web_fetch",
  "todo_write",
]);

/** The search programs, by name. Narrower than a read: this one auto-allows. */
const SEARCH_TOOL_KEYS: ReadonlySet<string> = new Set([
  "grep",
  "ripgrep",
  "rg",
  "rg_exe",
  "search",
  "codebase_search",
  "file_search",
]);

/** A vendor namespace rides in front of the name: mcp__fs__read_file -> fs_read_file. */
function toolKeyIn(tool: string, names: ReadonlySet<string>): boolean {
  const key = toolNameKey(tool);
  if (names.has(key)) return true;
  const parts = key.split("_");
  for (let index = 1; index < parts.length; index += 1) {
    if (names.has(parts.slice(index).join("_"))) return true;
  }
  return false;
}

const WRITE_WORDS =
  /\b(write|write_file|edit|search_replace|str_replace|create|delete|unlink|rm |remove|move|rename|bash|shell|powershell|cmd\.exe|run a command|run command|run_command)\b/;

export function looksLikeWriteTool(tool: string, detail: string, filePath?: string): boolean {
  if (isQuietDeskTool(tool)) return false;
  if (looksLikeDelegationTool(tool, detail)) return false;
  const shell = looksLikeShellTool(tool, detail);
  // A tool that is not a shell is what its name says it is. The name is the
  // vendor's, though, so it does not get to make `rm -rf src` a read: a
  // read-named tool whose detail runs a program that writes is still a write.
  if (!shell && toolKeyIn(tool, READ_TOOL_KEYS)) return detailRunsAWrite(detail, filePath);
  // A shell's name says nothing about what it runs, so it is judged by the
  // program it invokes. Everything else a shell does counts as a write.
  if (shell && looksLikeSearchOnly(tool, detail, filePath)) return false;
  if (shell) return true;
  return WRITE_WORDS.test(`${tool} ${detail} ${filePath ?? ""}`.toLowerCase());
}

/**
 * Shell names that never say "bash". The desk's own labeller turns a pasted
 * command into the title "Run a command", and the ACP kind for that same call
 * is "execute" — so a Claude worker's grep arrived named something no
 * classifier knew, was judged not-a-shell, and fell through to a deny. These
 * are matched on the NAME alone: a brief that merely says "execute the plan"
 * is still a brief.
 */
const SHELL_TOOL_NAMES = /\b(run a command|execute|terminal|run_terminal_cmd|local_shell|shell_command)\b/i;
const SHELL_WORDS = /\b(bash|shell|powershell|cmd\.exe|run command|run_command)\b/i;

/** The NAME says shell, whatever the detail holds. */
function shellByName(tool: string): boolean {
  return SHELL_TOOL_NAMES.test(tool) || SHELL_WORDS.test(tool);
}

export function looksLikeShellTool(tool: string, detail: string): boolean {
  if (isQuietDeskTool(tool)) return false;
  if (shellByName(tool)) return true;
  return SHELL_WORDS.test(`${tool} ${detail}`);
}

/**
 * Name the classifiers judge. ACP `kind` (execute, other, …) is not a tool
 * name: concatenating it onto "Wait for agents" made every MCP call a shell.
 */
export function classifyPermissionTool(tool: string, rawTool?: string): string {
  const kind = rawTool?.trim() ?? "";
  if (!kind || isAcpToolKind(kind)) return tool;
  return `${tool} ${kind}`;
}

export function looksLikeNetworkTool(tool: string, detail: string): boolean {
  const hay = `${tool} ${detail}`.toLowerCase();
  return /\b(web_search|web_fetch|browser|http|https|curl|wget|invoke-webrequest|npm\s+(?:install|view|info)|pnpm\s+(?:install|add)|yarn\s+add|pip\s+install|git\s+(?:clone|fetch|pull|push)|ssh|scp)\b/.test(hay);
}

function comparable(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function absolutePath(value: string): boolean {
  return /^(?:[a-z]:[\\/]|\/)/i.test(value.trim());
}

function inside(root: string, candidate: string): boolean {
  const base = comparable(root);
  const file = comparable(candidate);
  return file === base || file.startsWith(`${base}/`);
}

/** Provider-independent boundary applied before vendor-specific approval rules. */
export function securityPolicyAnswer(input: {
  policy?: import("./types").SessionSecurityPolicy;
  tool: string;
  detail: string;
  path?: string;
  roots?: string[];
  /** Where the command runs, so a `..` inside it is measured from the right place. */
  cwd?: string;
}): { answer: PermissionAnswer | null; boundary?: "network" | "outside-workspace" } {
  const policy = input.policy ?? { network: "allowed", root: "allowed" };
  if (policy.network === "blocked" && looksLikeNetworkTool(input.tool, input.detail)) {
    return { answer: "deny", boundary: "network" };
  }
  const candidate = input.path?.trim();
  const roots = (input.roots ?? []).filter((root) => root.trim());
  const outside = (value: string) => absolutePath(value) && !roots.some((root) => inside(root, value));
  if (candidate && roots.length > 0 && outside(candidate)) {
    if (policy.root === "blocked") return { answer: "deny", boundary: "outside-workspace" };
    if (policy.root === "ask") return { answer: null, boundary: "outside-workspace" };
  }
  // A shell call carries no path of its own: the paths it touches are inside
  // the command. `cat /etc/passwd` reached here with nothing to check, and now
  // that a read runs on a clamped seat it would have run. The same root test
  // is applied to every absolute path the command names. A sub-agent launch is
  // exempt for the reason it always was: its detail is the brief, and a folder
  // named in a brief is not this call's target.
  if (
    roots.length > 0 &&
    looksLikeShellTool(input.tool, input.detail) &&
    !looksLikeDelegationTool(input.tool, input.detail)
  ) {
    const command = shellCommandIn(input.detail) ?? input.detail;
    const cwd = (input.cwd ?? "").trim() || (roots[0] ?? "");
    const targets = commandTargets(command, cwd);
    if (targets.unjudgeable || targets.paths.some(outside)) {
      if (policy.root === "blocked") return { answer: "deny", boundary: "outside-workspace" };
      if (policy.root === "ask") return { answer: null, boundary: "outside-workspace" };
    }
  }
  return { answer: null };
}

const WRITE_HINT_WORDS =
  /\b(write|edit|replace|delete|unlink|rm\b|remove|move|rename|mkdir|out-file|set-content|new-item)\b/;

/**
 * Claude hands the desk a shell call as JSON — {"command":"grep …",
 * "description":"…"} — and Codex sends `cmd`. Judging that envelope as if it
 * were the command read the braces and the description instead of the program,
 * so a plain grep counted as neither a search nor a write. The command string
 * is what the shell runs; everything beside it is a label.
 */
export function shellCommandIn(detail: string): string | undefined {
  const text = detail.trim();
  if (!text.startsWith("{")) return undefined;
  const fromRecord = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    for (const key of ["command", "cmd"]) {
      const found = record[key];
      if (typeof found === "string" && found.trim()) return found.trim();
    }
    return undefined;
  };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return fromRecord(parsed) ?? fromRecord(parsed.tool_input) ?? fromRecord(parsed.input);
  } catch {
    // A long call can reach the desk clipped. The command survives a cut that
    // the closing brace does not, so it is read back out of the raw text.
    const match = /"(?:command|cmd)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
    if (!match?.[1]) return undefined;
    try {
      const value = JSON.parse(match[1]) as unknown;
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Programs that only ever read. Every stage of a pipeline has to start with one
 * of these before the command counts as a search.
 */
const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set([
  "grep",
  "rg",
  "ripgrep",
  "egrep",
  "fgrep",
  "sed",
  "awk",
  "gawk",
  "mawk",
  "head",
  "tail",
  "cat",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "ls",
  "find",
  "echo",
  "printf",
  "git",
  "which",
  "type",
  "file",
  "stat",
  "du",
  "df",
  "pwd",
  "env",
  "printenv",
]);

/** The read forms of git. Everything else it can do puts something on disk. */
const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "log",
  "status",
  "diff",
  "show",
  "blame",
  "rev-parse",
  "ls-files",
  "branch",
]);

type CommandStage = { program: string; args: string[] };
type CommandWalk = {
  stages: CommandStage[];
  /** Anything that stops the programs at the front speaking for the command. */
  unsafe: boolean;
  /** Text this side cannot see the value of: a substitution, or an open quote. */
  hidden: boolean;
};

/** Characters a backslash is escaping. Anywhere else it is part of the word. */
const SHELL_ESCAPABLE = /[ \t"'$`\\|&;<>\n]/;

/**
 * Split a command into pipeline stages, honouring quotes. Splitting the raw
 * text tore `grep "a\|b" test | head -40` apart at the pipe inside the pattern
 * and left a stage that started with nothing. Redirection and command
 * substitution mark the walk unsafe: neither can be judged by the program at
 * the front. The walk still finishes, because the paths a command names are
 * read out of it whether or not it is allowed to run.
 */
function shellWalk(command: string): CommandWalk {
  const stages: CommandStage[] = [];
  let unsafe = false;
  let hidden = false;
  let tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  const endToken = () => {
    if (token) tokens.push(token);
    token = "";
  };
  const endStage = () => {
    endToken();
    if (tokens.length > 0) stages.push({ program: tokens[0] ?? "", args: tokens.slice(1) });
    tokens = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    if (quote) {
      if (char === "\\" && quote === '"' && index + 1 < command.length) {
        token += char + (command[index + 1] as string);
        index += 1;
        continue;
      }
      // The closing quote is kept as well as the opening one, so a quoted
      // token carries a matching pair. Keeping only the opening quote meant
      // `cat "/etc/passwd"` never looked like a path and walked past the root
      // check.
      token += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      token += char;
      continue;
    }
    if (char === "\\") {
      // A backslash escapes only what a shell escapes. Swallowing it wholesale
      // turned `C:\repo\..\etc` into `C:repo..etc`, which is not an absolute
      // path, so no Windows drive path was ever held to the root boundary.
      const next = command[index + 1];
      if (next !== undefined && SHELL_ESCAPABLE.test(next)) {
        token += next;
        index += 1;
      } else {
        token += char;
      }
      continue;
    }
    if (char === ">" || char === "<") {
      unsafe = true;
      endToken();
      continue;
    }
    if (char === "`" || (char === "$" && command[index + 1] === "(")) {
      unsafe = true;
      hidden = true;
      endToken();
      continue;
    }
    if (char === "|" || char === ";" || char === "&" || char === "\n" || char === "\r") {
      endStage();
      continue;
    }
    if (char === " " || char === "\t") {
      endToken();
      continue;
    }
    token += char;
  }
  if (quote) {
    unsafe = true;
    hidden = true;
  }
  endStage();
  return { stages, unsafe, hidden };
}

/** Inside double quotes a backslash escapes only these; elsewhere it is a character. */
const DQ_ESCAPABLE = /["$`\\\n]/;

/**
 * The word the shell builds out of a token, with its quoting taken off. Only a
 * pair wrapping the whole token used to come off, which meant a quote broken
 * across the middle hid a path in plain sight: `"/etc/pass"wd` is one word and
 * the shell reads it as /etc/passwd, but the leading quote survived and the
 * absolute-path test never fired. So did `""/etc/passwd` and `/e"t"c/passwd`.
 * Spans are joined the way the shell joins them, which closes the shape rather
 * than the two examples of it, and leaves an ordinary `--include='*.dart'`
 * alone.
 */
function dequote(raw: string): string {
  let out = "";
  let single = false;
  let double = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (char === "\\") {
      const next = raw[index + 1];
      if (!escapesNext(next, single, double)) {
        out += char;
        continue;
      }
      out += next as string;
      index += 1;
      continue;
    }
    if (char === "'" && !double) {
      single = !single;
      continue;
    }
    if (char === '"' && !single) {
      double = !double;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Whether a backslash is escaping what follows it. A backslash escapes nothing
 * inside single quotes, a short list inside double quotes, and only the shell's
 * own characters outside both. Swallowing it everywhere turned `C:\repo\..\etc`
 * into `C:repo..etc`, which is not a path, so the boundary never saw it.
 */
function escapesNext(next: string | undefined, single: boolean, double: boolean): boolean {
  if (next === undefined || single) return false;
  return double ? DQ_ESCAPABLE.test(next) : SHELL_ESCAPABLE.test(next);
}

/** A token that walks out of its own folder. Nothing else can leave the cwd. */
function climbsOut(value: string): boolean {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value);
}

/**
 * A token the shell rewrites before the program ever sees it. `$HOME/../etc`
 * and `~/../etc` read here as folders named `$HOME` and `~` sitting under the
 * working folder, so both resolved to somewhere inside the root and were
 * allowed; the shell lands them on /etc. Where the token goes is unknowable
 * from this side, so it is judged as outside rather than guessed at.
 *
 * The whole token is walked, not just its front. Testing the front alone let
 * `cat "$HOME"/../etc/passwd` through: the quotes around the variable are not
 * a matching pair wrapping the token, so nothing came off and the token simply
 * did not begin with a `$`. Single quotes are the only thing that stops the
 * shell expanding, so `'$HOME'` really is a name; double quotes do not.
 *
 * A `$` only expands when something can follow it as a name, so the trailing
 * `$` anchoring a grep pattern stays a pattern.
 */
function expandsAtRuntime(raw: string): boolean {
  let single = false;
  let double = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (char === "\\") {
      if (escapesNext(raw[index + 1], single, double)) index += 1;
      continue;
    }
    if (char === "'" && !double) {
      single = !single;
      continue;
    }
    if (char === '"' && !single) {
      double = !double;
      continue;
    }
    if (single) continue;
    if (char === "`") return true;
    if (char === "$") {
      const next = raw[index + 1] ?? "";
      // $'…' decodes its escapes and $"…" is translated, so both can become a
      // path this side never saw: `cat $'\x2fetc/passwd'` is /etc/passwd. They
      // only do that outside a quote, so a `$` sitting inside double quotes is
      // not one of them.
      if (!double && (next === "'" || next === '"')) return true;
      // A `$` expands only when something can follow it as a name, so the
      // trailing `$` anchoring a grep pattern stays a pattern.
      if (/[A-Za-z_{(?#@*!$0-9-]/.test(next)) return true;
      continue;
    }
    // Tilde expansion only happens at the front of a word, or straight after
    // the `=` or `:` of an assignment. A trailing `backup~` is a file name.
    if (char === "~" && (index === 0 || raw[index - 1] === "=" || raw[index - 1] === ":")) return true;
  }
  return false;
}

/**
 * Resolve a path against the folder the command runs in and flatten every `..`
 * in it, so the path is measured where it actually lands. `cat ../../etc/passwd`
 * named no absolute path, so the root check had nothing to test; and
 * `/repo/../etc/passwd` was absolute but unflattened, so a prefix test read it
 * as sitting inside /repo. Both land on /etc/passwd.
 */
function resolveFrom(base: string, value: string): string {
  const combined = absolutePath(value) ? value : `${base}/${value}`;
  const parts = comparable(combined).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/") || "/";
}

/**
 * The paths a command names, so a root boundary can be applied to them. Every
 * path carrying a `..` is flattened first, absolute or not, because a prefix
 * test cannot see through one. A token the shell rewrites is reported as
 * unjudgeable rather than guessed at.
 *
 * One thing this walk cannot see: a symlink inside the root pointing out of
 * it. Following that needs realpath on the machine, which is not available
 * here, so it stays a known gap rather than a silent claim.
 */
function commandTargets(command: string, cwd: string): { paths: string[]; unjudgeable: boolean } {
  const paths: string[] = [];
  const walk = shellWalk(command);
  // A substitution or an unclosed quote hides the target outright. A plain
  // redirect does not: its file is the next token along, and that is checked.
  let unjudgeable = walk.hidden;
  for (const stage of walk.stages) {
    for (const token of [stage.program, ...stage.args]) {
      // The whole token is tested for expansion, so both walks agree; only the
      // path test looks past a flag's `=`.
      if (expandsAtRuntime(token)) {
        unjudgeable = true;
        continue;
      }
      const word = dequote(token);
      if (word.includes("://")) continue;
      // A flag's value is a path as readily as a bare word is, and the word is
      // judged too, so `--file=/etc/x` and `/etc/x` are both seen.
      for (const value of word.includes("=") ? [word, word.slice(word.indexOf("=") + 1)] : [word]) {
        if (!value) continue;
        if (climbsOut(value)) {
          if (absolutePath(value) || cwd) paths.push(resolveFrom(cwd, value));
        } else if (absolutePath(value)) {
          paths.push(value);
        }
      }
    }
  }
  return { paths, unjudgeable };
}

/** A command holding a token only the shell can resolve is not a search. */
function expandsSomewhere(command: string): boolean {
  return shellWalk(command).stages.some((stage) =>
    [stage.program, ...stage.args].some((token) => expandsAtRuntime(token)),
  );
}

function programName(raw: string): string {
  // Quoting is taken off the way the shell takes it off, so `r"m"` is rm.
  return dequote(raw)
    .replace(/^.*[\\/]/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

function positionals(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith("-"));
}

/**
 * A sed substitution with no `w` and no `e` flag: `s/a/b/`, `1,20s|x|y|g`. The
 * delimiter is whatever follows the `s`, so it is captured and matched back.
 */
const SED_SUBSTITUTION = /^\d*(?:,\d*)?s(.)(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[gpiImM0-9]*$/;
/** An addressed print or delete: `p`, `1,20p`, `$d`, `/foo/p`. */
const SED_PRINT = /^(?:\d+(?:,\d+)?|\$|\/(?:\\.|[^/\\])*\/)?[pdq=lnN]$/;

/**
 * sed and awk are the two programs on the read-only list that take a program
 * of their own, and both can break out of it: awk through `system()`, a pipe
 * to a command, or `print > "file"`; sed through the `e` command, a `w` write,
 * and `-i` on either. `awk 'BEGIN{system("rm x")}'` and `sed 'e rm x'` were
 * both read as searches and answered "once" on a read-only seat. Every other
 * interpreter — perl, python, node, sh — is not on the list at all, so it
 * never reaches here.
 */
function interpreterScriptReads(program: string, args: string[]): boolean {
  if (args.some((arg) => /^-i/.test(arg) || arg === "--in-place")) return false;
  const scripts = args.filter((arg) => !arg.startsWith("-"));
  if (program === "sed") {
    // -e and -f take the script as their own argument; -f names a file this
    // side cannot read, so it is never a search.
    if (args.some((arg) => /^(?:-f|--file)/.test(arg))) return false;
    if (scripts.length === 0) return false;
    const script = dequote(scripts[0] ?? "");
    return script
      .split(/[;\n]/)
      .every((piece) => {
        const text = piece.trim();
        return text.length > 0 && (SED_SUBSTITUTION.test(text) || SED_PRINT.test(text));
      });
  }
  if (args.some((arg) => /^(?:-f|--file|--source|-v)/.test(arg))) return false;
  const program_text = scripts[0] ?? "";
  return !/system|exec|ENVIRON|getline|close\s*\(|[|>]/.test(program_text);
}

/** Programs on the list that still hold a way to write, and the flag that does it. */
function stageWrites(program: string, args: string[]): boolean {
  if (program === "sed" || program === "awk" || program === "gawk" || program === "mawk") {
    return !interpreterScriptReads(program === "sed" ? "sed" : "awk", args);
  }
  if (program === "find") {
    return args.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(arg));
  }
  if (program === "sort") return args.some((arg) => arg === "-o" || arg.startsWith("--output"));
  // `uniq in out` writes its second file.
  if (program === "uniq") return positionals(args).length > 1;
  // `env FOO=1 rm x` runs rm, so env only reads when it names no program.
  if (program === "env") return positionals(args).length > 0;
  if (program === "git") {
    const sub = positionals(args)[0];
    if (!sub || !GIT_READ_SUBCOMMANDS.has(sub.toLowerCase())) return true;
    // `git branch` reads; `git branch <name>` and `git branch -d` do not.
    if (sub.toLowerCase() === "branch") {
      if (positionals(args).length > 1) return true;
      return args.some((arg) => /^-(?:[dDmMcCf]|-delete|-move|-copy|-force|-set-upstream.*|-unset-upstream|-edit-description)$/.test(arg));
    }
    return false;
  }
  return false;
}

const POWERSHELL_WRAPPER = /^[^\n]*powershell(?:\.exe)?[^\n]*?(?:-command|-c)\s+/i;

/** Programs that put something on disk, or run something that can. */
const WRITE_PROGRAMS: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "unlink",
  "mv",
  "cp",
  "touch",
  "mkdir",
  "dd",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "truncate",
  "shred",
  "install",
  "tee",
  "rsync",
  "sh",
  "bash",
  "zsh",
  "ksh",
  "fish",
  "powershell",
  "pwsh",
  "cmd",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "make",
  "xargs",
  "eval",
  "sudo",
]);

/**
 * The detail names a program that writes, or redirects into a file. Only the
 * program at the front of each stage is read: a search whose query happens to
 * contain the word "delete" is still a search, which is why the read exemption
 * keys on the name in the first place.
 */
function detailRunsAWrite(detail: string, filePath?: string): boolean {
  const command = shellCommandIn(detail) ?? `${detail} ${filePath ?? ""}`.trim();
  if (!command) return false;
  const { stages, unsafe } = shellWalk(command);
  if (unsafe) return true;
  return stages.some((stage) => {
    if (stage.program.includes("://")) return false;
    return WRITE_PROGRAMS.has(programName(stage.program));
  });
}

/** Every stage starts with a program that only reads, and nothing redirects. */
function readOnlyPipeline(command: string): boolean {
  const { stages, unsafe } = shellWalk(command);
  if (unsafe || stages.length === 0) return false;
  // A token the shell rewrites could name anything, so the command cannot be
  // called a search on the strength of the programs alone.
  if (expandsSomewhere(command)) return false;
  return stages.every((stage) => {
    const program = programName(stage.program);
    if (!READ_ONLY_PROGRAMS.has(program)) return false;
    return !stageWrites(program, stage.args);
  });
}

/** rg / grep as the invoked program — allow through Ask / Plan / Always. */
export function looksLikeSearchOnly(tool: string, detail: string, filePath?: string): boolean {
  const command = `${detail} ${filePath ?? ""}`.trim();
  // A tool that is not a shell is judged by its name. "run a grep over the
  // tree" sitting inside a brief is the brief talking, not the program.
  if (!looksLikeShellTool(tool, detail)) {
    if (WRITE_HINT_WORDS.test(`${tool} ${command}`.toLowerCase())) return false;
    return toolKeyIn(tool, SEARCH_TOOL_KEYS);
  }
  // A shell is judged by the programs it invokes, never by the words in its
  // text: a grep whose pattern held "remove" read as a write, and a search
  // that piped into head read as neither.
  const json = shellCommandIn(detail);
  if (json !== undefined) return readOnlyPipeline(json);
  // A PowerShell interpreter is not one of the programs below and its cmdlets
  // are not those either, so its payload keeps the older, narrower rule: the
  // search it was unwrapped for, and nothing else.
  if (POWERSHELL_WRAPPER.test(command)) {
    const inner = command
      .replace(POWERSHELL_WRAPPER, "")
      .replace(/^try\s*\{[\s\S]*?\}\s*catch\s*\{\s*\}\s*/i, "")
      .trim();
    return /^(rg(?:\.exe)?|ripgrep|grep)\b/im.test(inner);
  }
  // Only a quote pair that wraps the WHOLE command comes off. Stripping either
  // end on its own took the closing quote off `sed -n '1,20p'` and left the
  // walk inside a quote that never ended.
  const wrapped = command.length > 1 && /^(["'])[\s\S]*\1$/.test(command);
  return readOnlyPipeline(wrapped ? command.slice(1, -1).trim() : command);
}

const QUIET_DESK_TOOLS = new Set([
  "list_chats",
  "list_bots",
  "query_capacity",
  "list_tools",
  "list_references",
  "read_chat",
  "ask_chat",
  "spawn_agent",
  "await_agents",
  "request_vendor",
  "detect_custom",
  "list_skills",
  "read_skill",
  "list_projects",
  "create_project",
  "move_chat",
  "rename_chat",
  "rename_project",
  "delete_chat",
  "delete_project",
]);

export function isQuietDeskTool(tool: string): boolean {
  return QUIET_DESK_TOOLS.has(canonicalToolKey(tool));
}

function grantText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function permissionGrantKey(tool: string, detail?: string, filePath?: string): string {
  const key = canonicalToolKey(tool);
  if (
    QUIET_DESK_TOOLS.has(key) ||
    /^(ask_chat|spawn_agent|await_agents|add_reference|delete_reference|setup_custom_bot|delete_bot|create_project|list_projects|move_chat|rename_chat|rename_project|delete_chat|delete_project)$/.test(
      key,
    )
  ) {
    return "workhorse";
  }
  if (/^(?:bash|shell|powershell|run_command|cd|ls|pwd|cat|sed|rg|grep|find|git|wc|head|tail|echo|mkdir|cp|mv|rm|touch|npm|npx|node|python|godot)(?:_|$)/.test(key)) {
    return `shell:${grantText(detail) || key}`;
  }
  const target = grantText(filePath) || grantText(detail);
  if (/^(?:read|read_file|list|list_dir)(?:_|$)/.test(key)) return `read:${target || key}`;
  if (/^(?:write|write_file|edit|str_replace|search_replace)(?:_|$)/.test(key)) return `write:${target || key}`;
  return `${key || grantText(tool)}:${target || key}`;
}

export function grantCovers(
  grants: PermissionGrant[] | undefined,
  tool: string,
  detail?: string,
  filePath?: string,
  now = Date.now(),
): boolean {
  if (!grants?.length) return false;
  const key = permissionGrantKey(tool, detail, filePath);
  return grants.some((grant) => grant.expiresAt > now && grant.key === key);
}

export function enqueuePermission(
  pending: PermissionRequest[],
  request: PermissionRequest,
): PermissionRequest[] {
  return [...pending.filter((item) => item.id !== request.id), request];
}

/** A late vendor permission result cannot make a finished worker look active again. */
export function permissionResumeStatus(input: {
  hasOtherPending: boolean;
  agentRun?: Session["agentRun"];
}): Session["status"] {
  if (input.hasOtherPending) return "needs-input";
  if (input.agentRun && input.agentRun.status !== "running") return "idle";
  return "running";
}

/** Software fallback when the vendor kernel sandbox is a no-op (Windows). */
export type ElevationNeed = {
  mode?: PermissionMode;
  sandbox?: SandboxProfile;
};

const MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  ask: 1,
  "accept-edits": 2,
  "always-approve": 3,
};

const SANDBOX_RANK: Record<SandboxProfile, number> = {
  strict: 0,
  "read-only": 1,
  workspace: 2,
  off: 3,
};

export function parsePermissionModeValue(raw: string | undefined): PermissionMode | undefined {
  const value = raw?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (value === "ask" || value === "default") return "ask";
  if (value === "accept-edits" || value === "accept" || value === "auto") return "accept-edits";
  if (value === "always-approve" || value === "always" || value === "yolo") return "always-approve";
  if (value === "plan") return "plan";
  return undefined;
}

export function parseSandboxValue(raw: string | undefined): SandboxProfile | undefined {
  const value = raw?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (value === "off" || value === "full" || value === "machine") return "off";
  if (value === "workspace" || value === "project") return "workspace";
  if (value === "read-only" || value === "readonly") return "read-only";
  if (value === "strict") return "strict";
  return undefined;
}

/** Only keep raises (never a downgrade). */
export function elevationStillNeeded(
  current: { mode: PermissionMode; sandbox: SandboxProfile },
  want: ElevationNeed,
): ElevationNeed | null {
  const need: ElevationNeed = {};
  if (want.mode && MODE_RANK[want.mode] > MODE_RANK[current.mode]) need.mode = want.mode;
  if (want.sandbox && SANDBOX_RANK[want.sandbox] > SANDBOX_RANK[current.sandbox]) need.sandbox = want.sandbox;
  return need.mode || need.sandbox ? need : null;
}

export type ElevationClass = "raise" | "noop" | "downgrade";

export function classifyElevation(
  current: { mode: PermissionMode; sandbox: SandboxProfile },
  want: ElevationNeed,
): { kind: ElevationClass; need?: ElevationNeed } {
  const raise = elevationStillNeeded(current, want);
  if (raise) return { kind: "raise", need: raise };
  const askedLower =
    (want.mode != null && MODE_RANK[want.mode] < MODE_RANK[current.mode]) ||
    (want.sandbox != null && SANDBOX_RANK[want.sandbox] < SANDBOX_RANK[current.sandbox]);
  return { kind: askedLower ? "downgrade" : "noop" };
}

export function elevationForBlock(input: {
  mode: PermissionMode;
  sandbox: SandboxProfile;
  tool: string;
  detail: string;
  path?: string;
}): ElevationNeed | null {
  const write = looksLikeWriteTool(input.tool, input.detail, input.path);
  const planFile = /plan\.md/i.test(`${input.path ?? ""} ${input.detail}`);
  const want: ElevationNeed = {};
  if ((input.sandbox === "read-only" || input.sandbox === "strict") && write) want.sandbox = "off";
  if (input.mode === "plan" && write && !planFile) want.mode = "ask";
  return elevationStillNeeded({ mode: input.mode, sandbox: input.sandbox }, want);
}

export function parseElevationInput(
  input: Record<string, unknown> | undefined,
  current: { mode: PermissionMode; sandbox: SandboxProfile },
): ElevationNeed | null {
  const record = input ?? {};
  const modeRaw =
    (typeof record.permission === "string" && record.permission) ||
    (typeof record.mode === "string" && record.mode) ||
    "";
  const sandboxRaw = typeof record.sandbox === "string" ? record.sandbox : "";
  const mode = parsePermissionModeValue(modeRaw);
  const sandbox = parseSandboxValue(sandboxRaw);
  const want: ElevationNeed = {};
  if (mode && mode !== "plan") want.mode = mode;
  if (sandbox === "off" || sandbox === "workspace") want.sandbox = sandbox;
  if (!want.mode && !want.sandbox) {
    if (current.mode === "plan") want.mode = "ask";
    if (current.sandbox === "read-only" || current.sandbox === "strict") want.sandbox = "off";
  }
  return classifyElevation(current, want).need ?? null;
}

export function classifyElevationInput(
  input: Record<string, unknown> | undefined,
  current: { mode: PermissionMode; sandbox: SandboxProfile },
): { kind: ElevationClass; need?: ElevationNeed } {
  const record = input ?? {};
  const modeRaw =
    (typeof record.permission === "string" && record.permission) ||
    (typeof record.mode === "string" && record.mode) ||
    "";
  const sandboxRaw = typeof record.sandbox === "string" ? record.sandbox : "";
  const mode = parsePermissionModeValue(modeRaw);
  const sandbox = parseSandboxValue(sandboxRaw);
  const want: ElevationNeed = {};
  if (mode && mode !== "plan") want.mode = mode;
  if (sandbox === "off" || sandbox === "workspace") want.sandbox = sandbox;
  if (!want.mode && !want.sandbox) {
    if (current.mode === "plan") want.mode = "ask";
    if (current.sandbox === "read-only" || current.sandbox === "strict") want.sandbox = "off";
    if (!want.mode && !want.sandbox) return { kind: "noop" };
  }
  return classifyElevation(current, want);
}

export function describeElevation(
  from: { mode: PermissionMode; sandbox: SandboxProfile },
  to: ElevationNeed,
): string {
  const bits: string[] = [];
  if (to.mode) bits.push(`Permission ${modeLabel(from.mode)} → ${modeLabel(to.mode)}`);
  if (to.sandbox) bits.push(`Sandbox ${sandboxLabel(from.sandbox)} → ${sandboxLabel(to.sandbox)}`);
  return bits.join(" and ");
}

/** The narrower of a desk answer and a vendor app's own recorded defaults. */
export function tighterAccess(left: DeskAccess, right: BotAccessDefaults | undefined): DeskAccess {
  if (!right) return left;
  return {
    mode: right.mode && MODE_RANK[right.mode] < MODE_RANK[left.mode] ? right.mode : left.mode,
    sandbox: right.sandbox && SANDBOX_RANK[right.sandbox] < SANDBOX_RANK[left.sandbox] ? right.sandbox : left.sandbox,
  };
}

export const DESK_ACCESS_FALLBACK: DeskAccess = { mode: "always-approve", sandbox: "off" };

/**
 * Access an inbound CLI / MCP / tool call runs under.
 *
 * An explicit parent chat is the path: the call takes that chat's Permission
 * and Sandbox, so a chat the person tightened stays tight and a chat they set
 * to Always stays Always. With no parent the desk's own stored default answers
 * — Always / Off as shipped, and only the person may narrow it. The vendor
 * app's recorded defaults are folded in as a second thing the person set, so
 * the narrower of the two wins: a Codex on approval_policy="never" keeps the
 * desk's Always, and a Codex on "on-request" pulls it back to Ask.
 *
 * Nothing here reads the caller's live permission state, and nothing asks for
 * it. A desk cannot see what another vendor's app is allowing right now, so
 * that handshake is not attempted. Every input is the desk's own record.
 */
export function inboundAccess(input: {
  parent?: BotAccessDefaults;
  desk?: DeskAccess;
  vendor?: BotAccessDefaults;
}): DeskAccess {
  const seat = tighterAccess(input.desk ?? DESK_ACCESS_FALLBACK, input.vendor);
  return {
    mode: input.parent?.mode ?? seat.mode,
    sandbox: input.parent?.sandbox ?? seat.sandbox,
  };
}

/**
 * The vendor session a path-owned worker launches under, never looser than
 * Ask. Always maps to approval_policy="never" / bypassPermissions at the
 * vendor launch (electron/codex-launch.ts:86, electron/claude-launch.ts:120),
 * and those stop the write events the path preflight reads — a worker that
 * cannot be preflighted cannot be held to its allowlist. The person still sees
 * no modal for in-path work: the desk answers those events itself from the
 * grant the worker carries. The prompt is suppressed at the desk, not at the
 * vendor. Plan and Ask are already tight enough and pass through unchanged.
 */
export function pathOwnerMode(mode: PermissionMode): PermissionMode {
  return MODE_RANK[mode] > MODE_RANK.ask ? "ask" : mode;
}

export type WorkerAccessPrior = {
  mode: PermissionMode;
  sandbox: SandboxProfile;
  agentRun?: { paths?: string[]; grantedAccess?: DeskAccess };
};

/**
 * A narrowing the person put on a worker chat themselves, told apart from the
 * desk's own path clamp. The desk records what it granted, so anything tighter
 * than what it last set is the person's doing and survives the next slice.
 * Without the record every reuse would read last slice's clamp as a wish.
 */
export function workerTightening(prior: WorkerAccessPrior | undefined): BotAccessDefaults | undefined {
  if (!prior) return undefined;
  const granted = prior.agentRun?.grantedAccess;
  if (!granted) return { mode: prior.mode, sandbox: prior.sandbox };
  const owned = (prior.agentRun?.paths?.length ?? 0) > 0;
  const deskSet: DeskAccess = { mode: owned ? pathOwnerMode(granted.mode) : granted.mode, sandbox: granted.sandbox };
  const mode = MODE_RANK[prior.mode] < MODE_RANK[deskSet.mode] ? prior.mode : undefined;
  const sandbox = SANDBOX_RANK[prior.sandbox] < SANDBOX_RANK[deskSet.sandbox] ? prior.sandbox : undefined;
  if (!mode && !sandbox) return undefined;
  return { ...(mode ? { mode } : {}), ...(sandbox ? { sandbox } : {}) };
}

/**
 * The seat a spawned worker launches under. It inherits the parent path; a
 * path allowlist clamps the vendor session to Ask so ownership can still be
 * checked before each write; and a narrowing the person set on this worker
 * chat outranks both, because reuse must not hand back access they took away.
 */
export function workerAccess(input: {
  inherited: DeskAccess;
  owned: boolean;
  readOnly?: boolean;
  prior?: WorkerAccessPrior;
}): DeskAccess {
  const seat: DeskAccess = {
    mode: input.owned ? pathOwnerMode(input.inherited.mode) : input.inherited.mode,
    sandbox: input.readOnly ? "read-only" : input.inherited.sandbox,
  };
  return tighterAccess(seat, workerTightening(input.prior));
}

/** What the desk records as granted, so the next reuse can read the clamp apart from a tightening. */
export function workerGrant(input: { inherited: DeskAccess; prior?: WorkerAccessPrior }): DeskAccess {
  return tighterAccess(input.inherited, workerTightening(input.prior));
}

/**
 * Where a delegated child's seat came from. "call" is the delegating call
 * naming it, "inherited" is silence keeping the caller's seat, and "desk" is
 * the app's own default answering because the call asked for more than the
 * desk allows. It is recorded so a denial can say what to change.
 */
export type AccessSource = "call" | "inherited" | "desk";

export type RequestedAccess = { mode?: PermissionMode; sandbox?: SandboxProfile };

export type GrantedWorkerAccess = {
  granted: DeskAccess;
  source: AccessSource;
  /** One line, present only when the call asked for more than the ceiling. */
  refused?: string;
};

/** `plan` is not a seat a call may hand a child: it cannot finish the work. */
export function parseCallPermission(raw: string | undefined): PermissionMode | undefined {
  const mode = parsePermissionModeValue(raw);
  return mode === "plan" ? undefined : mode;
}

/**
 * The seat a delegation's child launches under.
 *
 * A delegation's access is decided at the CALL. A call that names `permission`
 * or `sandbox` is honoured exactly, capped by `ceiling` — which is the desk
 * default (Settings › LLMs), never the caller's own seat. That is the point: a
 * chat the person tightened for reviews may still hand a working child the
 * access the app allows, so a read-only review chat stops being a trap for
 * every delegation made from it. A silent call changes nothing and the child
 * inherits the caller's seat, which is what every call did before.
 *
 * When a request passes the ceiling the capped seat is returned WITH a reason,
 * so the caller reads what it got instead of guessing from a failure later.
 */
export function requestedWorkerAccess(input: {
  requested?: RequestedAccess;
  inherited: DeskAccess;
  ceiling?: DeskAccess;
}): GrantedWorkerAccess {
  const ceiling = input.ceiling ?? DESK_ACCESS_FALLBACK;
  const wantMode = input.requested?.mode;
  const wantSandbox = input.requested?.sandbox;
  if (!wantMode && !wantSandbox) return { granted: { ...input.inherited }, source: "inherited" };
  const refusals: string[] = [];
  let honoured = 0;
  let mode = input.inherited.mode;
  if (wantMode) {
    if (MODE_RANK[wantMode] > MODE_RANK[ceiling.mode]) {
      mode = ceiling.mode;
      refusals.push(`Permission ${modeLabel(wantMode)} is above the desk default, so this worker runs at ${modeLabel(ceiling.mode)}`);
    } else {
      mode = wantMode;
      honoured += 1;
    }
  }
  let sandbox = input.inherited.sandbox;
  if (wantSandbox) {
    if (SANDBOX_RANK[wantSandbox] > SANDBOX_RANK[ceiling.sandbox]) {
      sandbox = ceiling.sandbox;
      refusals.push(`Sandbox ${sandboxLabel(wantSandbox)} is above the desk default, so this worker runs at ${sandboxLabel(ceiling.sandbox)}`);
    } else {
      sandbox = wantSandbox;
      honoured += 1;
    }
  }
  return {
    granted: { mode, sandbox },
    // Nothing the call asked for survived, so the desk default decided this
    // seat — not the call. Saying "call" there would name the wrong author.
    source: honoured > 0 ? "call" : "desk",
    ...(refusals.length > 0 ? { refused: `${refusals.join("; ")}. Raise the desk default in Settings › LLMs to go higher.` } : {}),
  };
}

/** Who decided this seat, said the way a caller reads it. */
function sourcePhrase(source: AccessSource, pass?: number): string {
  if (source !== "inherited") return `from the ${source}`;
  // A continuation inherits the wave it continues, not the chat it was called
  // from, so saying "the caller" there would name the wrong thing entirely.
  return pass ? `inherited from pass ${pass}` : "inherited from the caller";
}

/** The granted seat and any refusal, in the one line a spawn result carries. */
export function grantedAccessLine(result: GrantedWorkerAccess, pass?: number): string {
  const seat = `Permission ${modeLabel(result.granted.mode)}, Sandbox ${sandboxLabel(result.granted.sandbox)} (${sourcePhrase(result.source, pass)}).`;
  return result.refused ? `${seat} ${result.refused}` : seat;
}

/** One main-log line. Identifiers and seats only — never a word of the brief. */
export function spawnAccessLogDetail(input: {
  child: string;
  parent: string;
  requested?: RequestedAccess;
  granted: DeskAccess;
  ceiling: DeskAccess;
  source: AccessSource;
  /** The pass this seat was handed forward from, when this is a continuation. */
  pass?: number;
}): string {
  const seat = (access: { mode?: string; sandbox?: string } | undefined) =>
    access?.mode || access?.sandbox ? `${access.mode ?? "-"}/${access.sandbox ?? "-"}` : "none";
  return [
    `child=${input.child}`,
    `parent=${input.parent}`,
    `requested=${seat(input.requested)}`,
    `granted=${seat(input.granted)}`,
    `cap=${seat(input.ceiling)}`,
    `source=${input.source}`,
    ...(input.pass ? [`pass=${input.pass}`] : []),
  ].join(" ");
}

/**
 * The seat the wave being continued actually ran under.
 *
 * A mission's second pass used to seat its workers from the chat it was called
 * from, which is the parent chat — so a mission delegated with sandbox: off out
 * of a chat the person had tightened wrote happily in pass 1 and was refused in
 * pass 2. Nothing about the work changed; only which seat the desk read.
 *
 * The pass answers instead. Where its workers disagree the tightest one wins:
 * handing a new worker the widest seat anyone in the wave held would quietly
 * raise access nobody granted for this slice.
 */
export function passGrantedAccess(grants: readonly (DeskAccess | undefined)[]): DeskAccess | undefined {
  const seats = grants.filter((seat): seat is DeskAccess => Boolean(seat?.mode && seat?.sandbox));
  if (seats.length === 0) return undefined;
  return seats.reduce<DeskAccess>((narrowest, seat) => tighterAccess(narrowest, seat), seats[0]!);
}

/** The seat a continuation hands forward, plus the pass it came from. */
export type ContinuedAccess = { mode?: PermissionMode; sandbox?: SandboxProfile; pass?: number };

/** Read off the wire, so anything malformed is simply absent rather than trusted. */
export function parseContinuedAccess(raw: unknown): ContinuedAccess | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const mode = parseCallPermission(typeof record.mode === "string" ? record.mode : undefined);
  const sandbox = parseSandboxValue(typeof record.sandbox === "string" ? record.sandbox : undefined);
  const pass =
    typeof record.pass === "number" && Number.isFinite(record.pass) && record.pass >= 1
      ? Math.floor(record.pass)
      : undefined;
  if (!mode && !sandbox) return undefined;
  return { ...(mode ? { mode } : {}), ...(sandbox ? { sandbox } : {}), ...(pass ? { pass } : {}) };
}

/**
 * What a continuation's new worker inherits when the call named no seat: the
 * pass it continues, still held to the desk default. The pass's own grant was
 * capped when it was made, so this only bites when the person narrowed Settings
 * between passes — and then their latest decision is the one that should win.
 */
export function continuedInheritedAccess(input: {
  continued?: ContinuedAccess;
  caller: DeskAccess;
  ceiling?: DeskAccess;
}): DeskAccess {
  if (!input.continued) return input.caller;
  const seat: DeskAccess = {
    mode: input.continued.mode ?? input.caller.mode,
    sandbox: input.continued.sandbox ?? input.caller.sandbox,
  };
  return tighterAccess(seat, input.ceiling ?? DESK_ACCESS_FALLBACK);
}

export type LineageChat = {
  id: string;
  parentId?: string;
  hidden?: boolean;
  title?: string;
  mode: PermissionMode;
  sandbox: SandboxProfile;
  agentRun?: { role?: string; paths?: string[]; grantedAccess?: DeskAccess & { source?: AccessSource } };
};

/**
 * What this chat's lineage actually grants, told apart from the seat it runs
 * under. A seat can be tighter for reasons the person never chose: a nested
 * helper is read-only by design, a path-owned worker launches at Ask so its
 * writes still reach the ownership preflight. Those are the desk's own clamps.
 *
 * The worker's recorded grant answers first — the desk wrote it at spawn from
 * the parent path, before any clamp. With no record the walk climbs parentId
 * to the first chat the person can see and takes its Permission and Sandbox; a
 * parent calling through Link sits on that walk. Above that there is only the
 * desk's Settings default, which is the last thing the person set.
 */
export function lineageGrant(input: {
  session?: LineageChat;
  sessions?: readonly LineageChat[];
  deskAccess?: DeskAccess;
}): DeskAccess {
  const desk = input.deskAccess ?? DESK_ACCESS_FALLBACK;
  if (!input.session) return desk;
  const granted = input.session.agentRun?.grantedAccess;
  if (granted) return { mode: granted.mode, sandbox: granted.sandbox };
  const rows = input.sessions ?? [];
  const seen = new Set<string>();
  let chat: LineageChat | undefined = input.session;
  while (chat && !seen.has(chat.id)) {
    seen.add(chat.id);
    if (!chat.hidden) return { mode: chat.mode, sandbox: chat.sandbox };
    const parentId: string | undefined = chat.parentId;
    chat = parentId ? rows.find((item) => item.id === parentId) : undefined;
  }
  return desk;
}

/**
 * Who owns a block. "person" only when the need climbs past what the lineage
 * already grants — someone tightened the root chat, the parent, or this chat.
 * Otherwise the seat that refused is a clamp the desk applied, and the desk
 * answers it from the access the person did grant.
 */
export function promptOwner(need: ElevationNeed, lineage: DeskAccess): "person" | "desk" {
  return elevationStillNeeded(lineage, need) ? "person" : "desk";
}

/**
 * The desk default is the standing permission for work the system starts.
 *
 * A hidden worker was seated by a call, not by a person: a subagent, a mission
 * pass, a Link delegate, a CLI hand-off. When it hits a block that the desk
 * default already covers, nothing is being raised past what the person set;
 * the desk is only handing the worker the seat it could have been given at
 * spawn. So the desk grants it silently: no card, no denial note, no second
 * call to "fix". The answer is the part of the need still missing from the
 * worker's own seat, or null when there is nothing the desk may hand over.
 *
 * Two cases stay as they were. A visible chat is the person's own seat, so a
 * raise there is theirs to answer and still gets its card. A need that climbs
 * past the desk default is past the ceiling; the desk cannot grant it and the
 * caller reads why in its transcript.
 */
export function standingGrant(input: {
  session: {
    hidden?: boolean;
    mode: PermissionMode;
    sandbox: SandboxProfile;
    agentRun?: { grantedAccess?: { source?: AccessSource } };
  };
  need: ElevationNeed;
  deskAccess?: DeskAccess;
}): ElevationNeed | null {
  if (!input.session.hidden) return null;
  // A seat the call asked for is the caller's own clamp: a coordinator that
  // said read-only meant it. The desk hands over only what nobody chose.
  if (input.session.agentRun?.grantedAccess?.source === "call") return null;
  const desk = input.deskAccess ?? DESK_ACCESS_FALLBACK;
  if (elevationStillNeeded(desk, input.need)) return null;
  return elevationStillNeeded({ mode: input.session.mode, sandbox: input.session.sandbox }, input.need);
}

/**
 * A subagent never asks the person. It is not in front of them, its chat is
 * hidden, and the card it raised named a setting on some other chat entirely —
 * the live complaint was a Claude helper asking to drop "Sandbox Read-only"
 * that a Grok review chat two rows up had been set to months earlier.
 *
 * So the desk answers, and the answer has to name the SOURCE: which chat that
 * sandbox came from, and the two ways to change it. A coordinator reading this
 * in its transcript can fix the next call without anyone touching the desk.
 */
export function sandboxSourceNote(input: {
  session?: LineageChat;
  sessions?: readonly LineageChat[];
  deskAccess?: DeskAccess;
}): string {
  const desk = input.deskAccess ?? DESK_ACCESS_FALLBACK;
  const sandbox = input.session?.sandbox ?? desk.sandbox;
  return `Sandbox ${sandboxLabel(sandbox)} comes from ${accessOrigin(input)}; ask for sandbox: off in the call, or raise that chat's Sandbox.`;
}

/**
 * The other dial, for the other door.
 *
 * A sandbox block arrives as a refusal, so it comes out of the policy as a
 * deny and takes the elevate path. Permission does not: a seat on Ask simply
 * declines to answer, and the request falls through to the ordinary prompt.
 * For a subagent that prompt is nobody's — so the desk answers, and this is
 * the line it answers with. It names Permission, because Permission is the
 * only dial that can bring a request that far.
 */
export function permissionSourceNote(input: {
  session?: LineageChat;
  sessions?: readonly LineageChat[];
  deskAccess?: DeskAccess;
}): string {
  const desk = input.deskAccess ?? DESK_ACCESS_FALLBACK;
  const mode = input.session?.mode ?? desk.mode;
  return `Permission ${modeLabel(mode)} comes from ${accessOrigin(input)}; ask for permission: always-approve in the call, or raise that chat's Permission.`;
}

/** The thing that decided this worker's seat, named the way a person reads it. */
function accessOrigin(input: { session?: LineageChat; sessions?: readonly LineageChat[] }): string {
  if (!input.session) return "the desk default";
  if (input.session.agentRun?.grantedAccess?.source === "call") return "this delegation's own call";
  const rows = input.sessions ?? [];
  const seen = new Set<string>();
  let chat: LineageChat | undefined = input.session;
  while (chat && !seen.has(chat.id)) {
    seen.add(chat.id);
    if (!chat.hidden) return `chat “${chat.title?.trim() || chat.id}”`;
    const parentId: string | undefined = chat.parentId;
    chat = parentId ? rows.find((item) => item.id === parentId) : undefined;
  }
  return "the desk default";
}

/**
 * A nested helper is read-only by design, and that clamp holds — unless the
 * call asked for a sandbox on purpose. A child the call made writable is not a
 * helper any more, so it stops being recorded as one: keeping the label would
 * make deskClampNote tell the person "helpers are read-only" about a chat that
 * is writing files. The access and the role move together or neither moves.
 */
/**
 * Whether a nested helper runs at the seat it inherited rather than read-only.
 *
 * It used to take an explicit sandbox on the call to release one, so a plain
 * nested spawn under a desk whose default was always-approve / off was seated
 * read-only anyway, blocked on its first write, and asked the person to
 * elevate — for work another part of the system had asked for. The desk
 * default is the person's standing decision. The desk must not add a clamp the
 * call did not ask for: a helper is read-only only when the call says so.
 */
export function releasedHelper(input: { role?: string; requestedSandbox?: SandboxProfile }): boolean {
  if (input.role !== "helper") return false;
  return input.requestedSandbox !== "read-only" && input.requestedSandbox !== "strict";
}

/** The clamp, named, so a denial says what actually stopped the work. */
export function deskClampNote(run: { role?: string; paths?: string[] } | undefined): string {
  if (run?.role === "helper") return "This helper was asked to run read-only; hand this write to your parent, or spawn it with a sandbox that can write.";
  if ((run?.paths?.length ?? 0) > 0) {
    return "This launch is path-owned; the desk answers its in-path writes from the access you granted.";
  }
  return "The desk narrowed this launch itself; the access you granted still stands.";
}

/**
 * What the desk answers on a worker's behalf from the grant it inherited.
 * A grant only ever allows: it can silence a prompt the desk already decided
 * to allow, and it never turns into a fresh denial, so every real block still
 * comes from the chat's own Permission and Sandbox.
 */
export function grantedPolicyAnswer(input: {
  granted?: PermissionMode;
  sandbox: SandboxProfile;
  tool: string;
  detail: string;
  path?: string;
}): PermissionAnswer | null {
  if (!input.granted) return null;
  const answer = permissionPolicyAnswer({
    mode: input.granted,
    sandbox: input.sandbox,
    tool: input.tool,
    detail: input.detail,
    path: input.path,
  });
  return answer === "deny" ? null : answer;
}

export function permissionPolicyAnswer(input: {
  mode: PermissionMode;
  sandbox: SandboxProfile;
  tool: string;
  detail: string;
  path?: string;
}): PermissionAnswer | null {
  if (isQuietDeskTool(input.tool)) return input.mode === "always-approve" ? "session" : "once";
  const searchOnly = looksLikeSearchOnly(input.tool, input.detail, input.path);
  // A read-only seat blocks writes, never reads. A search-only command is a
  // read whatever the seat is, so it is answered above the sandbox clamp and
  // above the plan clamp rather than leaning on the write check to spare it.
  // Security boundaries still win: securityPolicyAnswer runs before this.
  if (searchOnly) return input.mode === "always-approve" ? "session" : "once";
  const write = looksLikeWriteTool(input.tool, input.detail, input.path);
  const planFile = /plan\.md/i.test(`${input.path ?? ""} ${input.detail}`);
  if ((input.sandbox === "read-only" || input.sandbox === "strict") && write) return "deny";
  if (input.mode === "plan" && write && !planFile) return "deny";
  if (input.mode === "always-approve") return "session";
  if (input.mode === "accept-edits" && write && !looksLikeShellTool(input.tool, input.detail)) return "once";
  return null;
}

export function autoAllowPermission(input: {
  tool: string;
  detail?: string;
  path?: string;
  grants?: PermissionGrant[];
  now?: number;
}): PermissionAnswer | null {
  if (isQuietDeskTool(input.tool)) return "once";
  if (grantCovers(input.grants, input.tool, input.detail, input.path, input.now)) return "session";
  return null;
}

export function permissionAnswerLabel(answer: PermissionAnswer): string {
  if (answer === "deny") return "Denied";
  if (answer === "session") return "Allowed for this session";
  return "Allowed once";
}

export function applyPermissionAnswer(
  state: { pending: PermissionRequest[]; sessions: Session[] },
  id: string,
  answer: PermissionAnswer,
): { pending: PermissionRequest[]; sessions: Session[] } | null {
  const request = state.pending.find((item) => item.id === id);
  if (!request) return null;
  const remaining = state.pending.filter((item) => item.id !== id);
  const stillWaiting = remaining.some((item) => item.sessionId === request.sessionId);
  const elevate = request.kind === "elevate" && request.elevate && answer !== "deny";
  const vendor = request.kind === "vendor" && request.vendor && answer !== "deny";
  const label = elevate
    ? `Elevated ${describeElevation(
        state.sessions.find((item) => item.id === request.sessionId) ?? {
          mode: request.elevate?.mode ?? "ask",
          sandbox: request.elevate?.sandbox ?? "off",
        },
        request.elevate ?? {},
      )}`
    : vendor
      ? `Allowed ${request.vendor?.name ?? "that vendor"} for this chat`
      : `${permissionAnswerLabel(answer)}: ${request.tool} — ${request.detail}`;
  return {
    pending: remaining,
    sessions: state.sessions.map((session) => {
      if (session.id !== request.sessionId) return session;
      const next = elevate ? applySessionElevation(session, request.elevate ?? {}) : session;
      const now = Date.now();
      const grant = answer === "session" && request.kind !== "elevate" && request.kind !== "vendor"
        ? {
            id: uid("grant"),
            key: permissionGrantKey(request.tool, request.detail, request.path),
            tool: request.tool,
            detail: request.detail,
            ...(request.path ? { path: request.path } : {}),
            createdAt: now,
            expiresAt: now + 24 * 60 * 60 * 1_000,
          } satisfies PermissionGrant
        : undefined;
      const grants = grant
        ? [...(next.permissionGrants ?? []).filter((item) => item.key !== grant.key), grant]
        : next.permissionGrants;
      return {
        ...next,
        status: answer === "deny" ? "idle" : stillWaiting ? "needs-input" : "running",
        permissionGrants: grants,
        messages: [
          ...next.messages,
          {
            id: uid("msg"),
            role: "system",
            kind: "tool",
            toolStatus: answer === "deny" ? "failed" : "completed",
            text: `${label} · ${answer === "deny" ? "denied" : "completed"}`,
            createdAt: Date.now(),
          },
        ],
      };
    }),
  };
}

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { groupSpawnOptions, stopProcessGroup, trackProcessGroup } from "./process-registry";
import { permissionPolicyAnswer, looksLikeWriteTool, autoAllowPermission, type PermissionAnswer } from "../src/lib/permissions";
import {
  deskRoleOf,
  isWorkerOmittedTool,
  toolsForDeskRole,
  workerOmittedToolError,
  type DeskRole,
} from "../src/lib/subagents";
import type { PermissionGrant, PermissionMode, SandboxProfile } from "../src/lib/types";
import type { CustomHttpTool } from "./custom-http";
import { handleWorkhorseRpc } from "./workhorse-mcp";

export type CustomToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type CustomToolResult = {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
};

export const MAX_CUSTOM_TOOL_RESULT_CHARS = 64_000;

export function limitCustomToolResult(
  result: CustomToolResult,
  maxChars = MAX_CUSTOM_TOOL_RESULT_CHARS,
): CustomToolResult {
  if (result.content.length <= maxChars) return result;
  const marker = `\n\n[Workhorse truncated ${result.content.length - maxChars} characters. Narrow the search or request a smaller range.]\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available * 0.75);
  const tail = available - head;
  return {
    ...result,
    content: `${result.content.slice(0, head)}${marker}${tail > 0 ? result.content.slice(-tail) : ""}`,
  };
}

/** What `run_command` keeps and how long it may run. Both were `exec` defaults. */
const RUN_COMMAND_MAX_OUTPUT = 1024 * 1024;
const RUN_COMMAND_TIMEOUT_MS = 30_000;

export type CustomToolPolicy = {
  mode?: PermissionMode;
  sandbox?: SandboxProfile;
  grants?: PermissionGrant[];
  cwd?: string;
  folders?: string[];
  sessionId?: string;
  parentId?: string;
  hidden?: boolean;
  role?: DeskRole;
  signal?: AbortSignal;
};

const WORKSPACE_TOOLS: { name: string; description: string; input_schema: Record<string, unknown> }[] = [
  {
    name: "list_dir",
    description:
      "List files and folders. Omit path to list this chat’s Working directory. Relative paths are from that cwd. Absolute paths work when Sandbox is Off (machine-wide) or the path is inside a linked folder.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to list. Omit for cwd. Relative to cwd, or absolute when Sandbox allows.",
        },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a text file from the linked workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        limit: { type: "number", description: "Optional max characters" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file in the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "Full file contents" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the linked working directory and return stdout/stderr.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command" },
        cwd: { type: "string", description: "Optional working directory" },
      },
      required: ["command"],
    },
  },
];

const DESK_TOOLS: { name: string; description: string; input_schema: Record<string, unknown> }[] = [
  {
    name: "workhorse_list_tools",
    description:
      "List every tool this Workhorse chat can call (workspace + desk). Call this first if you are unsure what is available.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "workhorse_list_chats",
    description: "List live sidebar chats with session IDs, titles, models, and previews.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "workhorse_read_chat",
    description: "Read another sidebar chat by session ID or title.",
    input_schema: {
      type: "object",
      properties: { chat: { type: "string" }, limit: { type: "number" } },
      required: ["chat"],
    },
  },
  {
    name: "workhorse_ask_chat",
    description: "Ask another live chat by session ID or title and return its real reply.",
    input_schema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Session ID or visible title" },
        message: { type: "string", description: "Question or request for that chat" },
      },
      required: ["chat", "message"],
    },
  },
  {
    name: "workhorse_spawn_agent",
    description:
      "Spawn Grok, Codex, Claude, or another desk bot as an in-chat subagent. To run several at once, call this once per slice with wait=false, then stop. The desk joins reports later. wait=true blocks until that one worker finishes. Sol and Terra are Codex models. Never invent a reply.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Full task for the subagent" },
        description: { type: "string", description: "Short 3–5 word label" },
        provider: { type: "string", description: "grok, codex, claude, or custom" },
        model: { type: "string", description: "Optional model id" },
        route: { type: "string", description: "auto, quick, balanced, or deep" },
        planStepId: { type: "string", description: "Optional executable plan step id" },
        rationale: { type: "string", description: "Why this agent fits this step" },
        skills: { type: "array", items: { type: "string" }, description: "Exact installed skill names from workhorse_list_skills" },
        capabilities: { type: "array", items: { type: "string" }, description: "Desired expertise; free-form" },
        tools: { type: "array", items: { type: "string" }, description: "Required tools" },
        constraints: { type: "array", items: { type: "string" }, description: "Assignment boundaries" },
        files: { type: "array", items: { type: "string" }, description: "Files to attach to the worker" },
        chat: { type: "string", description: "Optional existing chat or vendor name to copy" },
        effort: { type: "string", description: "Optional override. Omit to keep a reused worker's thinking level; otherwise derived from quick, balanced, or deep" },
        timeoutSeconds: { type: "number", description: "Optional 30-3600 second runtime limit. The desk stops the worker when it passes this; the run ends timed-out." },
        tokenBudget: {
          type: "number",
          description:
            "Optional ceiling on this slice’s new work (output plus input growth after the first meter). Not leftover, occupancy, or inherited context. Omit unless stopping a runaway.",
        },
        isolation: { type: "string", description: "worktree (default) or shared" },
        seed: {
          type: "string",
          description: "inherit (default) may reuse an idle worker. fresh starts cold with only a handoff — no parent conversation.",
        },
        handoff: {
          type: "object",
          description: "Bounded report for seed=fresh: status, summary, evidence, nextSteps, blocker.",
        },
        folder: { type: "string", description: "Optional absolute folder the worker must use as cwd" },
        wait: {
          type: "boolean",
          description: "true (default) wait for this worker’s report. false start it and return immediately so you can spawn more.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "workhorse_await_agents",
    description:
      "Status of this chat’s worker lineup. Default returns immediately (who is running, finished reports). Pass wait=true only if the user asked you to sit until they finish. Never treat a timeout as a bot-setup failure. Do not ask the user to pick 1/2/3.",
    input_schema: {
      type: "object",
      properties: {
        wait: { type: "boolean", description: "false (default) status now. true wait until terminal or timeoutSeconds." },
        timeoutSeconds: { type: "number", description: "Only with wait=true. 30-3600 seconds. Default 600." },
      },
    },
  },
  {
    name: "workhorse_list_bots",
    description:
      "List built-in vendors and custom desk slots with leftover/Watch status. leftoverPercent is that vendor’s plan remaining overall, not this prompt. Do not spawn or ask a row whose canCall is false.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "workhorse_probe_runtime",
    description: "Probe local Godot, Android, iOS, and configured MCP capability before assigning device work.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "workhorse_plan",
    description: "Import, inspect, approve, run, or update this chat's executable plan.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "import, view, approve, start, pause, resume, revise, reopen, status, evidence, complete, block, or cancel" },
        path: { type: "string", description: "Markdown path for import" },
        stepId: { type: "string", description: "Plan step id" },
        title: { type: "string", description: "Revised step title" },
        details: { type: "string", description: "Revised step details" },
        dependsOn: { type: "array", items: { type: "string" }, description: "Revised prerequisite step ids" },
        evidenceRequired: { type: "boolean", description: "Require evidence before completion" },
        status: { type: "string", description: "ready, running, completed, failed, blocked, or cancelled" },
        kind: { type: "string", description: "note, file, test, screenshot, or runtime" },
        label: { type: "string", description: "Short evidence label" },
        value: { type: "string", description: "Evidence value or block reason" },
      },
      required: ["action"],
    },
  },
  {
    name: "workhorse_list_projects",
    description: "List Workhorse projects (name + linked folders). Use before and after creating a project. Do not tell the user a project exists unless it appears here.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "workhorse_create_project",
    description:
      "Create a Workhorse project (a named desk entry under Projects, not a file). Pass the exact name. Folder is optional at create time. If you found a folder, pass that absolute path — if the project already exists, this links the folder onto it and moves this chat there. Then call workhorse_list_projects and only report success if that name appears. Never invent a created project.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
        folder: { type: "string", description: "Optional folder to link" },
      },
      required: ["name"],
    },
  },
  {
    name: "workhorse_move_chat",
    description:
      "Move a chat into a project. Omit chat to move this chat. Pass the visible project name.",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name or id" },
        chat: { type: "string", description: "Optional chat title. Defaults to this chat." },
      },
      required: ["project"],
    },
  },
  {
    name: "workhorse_rename_chat",
    description: "Rename a live chat. Omit chat to rename this chat. Pass the new title in name. Do not delete and recreate.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "New chat title" },
        chat: { type: "string", description: "Optional exact title or id. Defaults to this chat." },
      },
      required: ["name"],
    },
  },
  {
    name: "workhorse_rename_project",
    description:
      "Rename a Workhorse project in place. Omit project to rename this chat’s project. Pass the new name. Do not delete and recreate. Then call workhorse_list_projects. Only say the new name if Visible sidebar names include it.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "New project name" },
        project: { type: "string", description: "Optional project name or id. Defaults to this chat’s project." },
      },
      required: ["name"],
    },
  },
  {
    name: "workhorse_delete_chat",
    description:
      "Delete another live chat by exact title or id, or delete every loose chat (not in a project) with scope=loose. Never omit chat to delete yourself. A bulk list that includes this title or “this one” must not delete this chat. scope=loose never deletes this chat. onlyThis=true only when the user asked to delete this chat alone.",
    input_schema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Exact chat title or id of another chat." },
        scope: {
          type: "string",
          description: "loose — delete every chat that is not in a project, except this chat. Do not ask which ones.",
        },
        onlyThis: {
          type: "boolean",
          description: "true only if the user asked to delete this chat alone.",
        },
      },
    },
  },
  {
    name: "workhorse_delete_project",
    description:
      "Delete a Workhorse project. chats=keep leaves its chats loose; chats=remove deletes those chats too.",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name or id" },
        chats: { type: "string", description: "keep (default) or remove" },
      },
      required: ["project"],
    },
  },
  {
    name: "workhorse_request_vendor",
    description:
      "Do not use this to unlock a spawn. If the daily bank is spent or canCall is false, that vendor is a no-go — skip it. Never ask the user to Allow a spawn.",
    input_schema: {
      type: "object",
      properties: {
        vendor: { type: "string", description: "grok, codex, claude, or cursor" },
        reason: { type: "string", description: "Why you need that vendor" },
      },
      required: ["vendor"],
    },
  },
  {
    name: "workhorse_request_permission",
    description:
      "Raise this chat’s Permission and/or Sandbox only when Plan or Read-only/Strict is blocking a write you must do now. Never use this to lower limits. A card appears above the composer. Wait for Elevate or Deny.",
    input_schema: {
      type: "object",
      properties: {
        permission: {
          type: "string",
          description: "ask, accept-edits, or always-approve",
        },
        sandbox: { type: "string", description: "off or workspace" },
        reason: { type: "string", description: "Why you need the extra access" },
      },
    },
  },
  {
    name: "workhorse_list_skills",
    description: "List desk skills from Grok, Codex, Claude, Cursor, and Workhorse. Call proactively when the request or Workhorse skill radar resembles an installed workflow, even if the user did not name it.",
    input_schema: { type: "object", properties: { origin: { type: "string", description: "Optional filter: grok, codex, claude, cursor, or workhorse" } } },
  },
  {
    name: "workhorse_read_skill",
    description: "Read one matching SKILL.md by name or origin:name before acting.",
    input_schema: { type: "object", properties: { skill: { type: "string" } }, required: ["skill"] },
  },
];

export function isFanOutDeskTool(name: string): boolean {
  const key = normalizeCustomToolName(name);
  return key === "workhorse_spawn_agent";
}

/** Consecutive spawn_agent calls in one model turn run as one parallel group. */
export function groupFanOutToolUses<T extends { name: string }>(uses: T[]): T[][] {
  const groups: T[][] = [];
  for (const use of uses) {
    const last = groups[groups.length - 1];
    if (isFanOutDeskTool(use.name) && last && last.every((item) => isFanOutDeskTool(item.name))) {
      last.push(use);
    } else {
      groups.push([use]);
    }
  }
  return groups;
}

export function customHttpTools(extra: CustomHttpTool[] = [], opts?: { role?: DeskRole }): CustomHttpTool[] {
  const base = [...WORKSPACE_TOOLS, ...DESK_TOOLS];
  const names = new Set(base.map((tool) => tool.name));
  const merged = [...base, ...extra.filter((tool) => !names.has(tool.name))];
  return toolsForDeskRole(merged, opts?.role ?? "orchestrator");
}

export function customHttpToolsOpenAi(extra: CustomHttpTool[] = [], opts?: { role?: DeskRole }): Record<string, unknown>[] {
  return customHttpTools(extra, opts).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }));
}

export function normalizeCustomToolName(name: string): string {
  const raw = name.trim();
  const key = raw.replace(/[\s-]+/g, "_");
  const lower = key.toLowerCase();
  if (lower === "workhorselistbots" || lower === "workhorse_listbots") return "workhorse_list_bots";
  if (lower === "workhorselistchats" || lower === "workhorse_listchats") return "workhorse_list_chats";
  if (lower === "workhorselistskills" || lower === "workhorse_listskills") return "workhorse_list_skills";
  if (lower === "workhorsereadskill" || lower === "workhorse_readskill") return "workhorse_read_skill";
  if (lower === "workhorselisttools" || lower === "workhorse_listtools") return "workhorse_list_tools";
  if (lower === "workhorseaskchat" || lower === "workhorse_askchat") return "workhorse_ask_chat";
  if (lower === "workhorsespawnagent" || lower === "workhorse_spawnagent") return "workhorse_spawn_agent";
  if (lower === "workhorseawaitagents" || lower === "workhorse_awaitagents") return "workhorse_await_agents";
  if (lower === "workhorsereadchat" || lower === "workhorse_readchat") return "workhorse_read_chat";
  if (lower === "workhorsecreateproject" || lower === "workhorse_createproject") return "workhorse_create_project";
  if (lower === "workhorsemovechat" || lower === "workhorse_movechat") return "workhorse_move_chat";
  if (lower === "workhorserenamechat" || lower === "workhorse_renamechat") return "workhorse_rename_chat";
  if (lower === "workhorserenameproject" || lower === "workhorse_renameproject") return "workhorse_rename_project";
  if (lower === "workhorsedeletechat" || lower === "workhorse_deletechat") return "workhorse_delete_chat";
  if (lower === "workhorsedeleteproject" || lower === "workhorse_deleteproject") return "workhorse_delete_project";
  if (
    lower === "workhorserequestpermission" ||
    lower === "workhorse_requestpermission" ||
    lower === "request_permission" ||
    lower === "requestpermission"
  ) {
    return "workhorse_request_permission";
  }
  if (
    lower === "workhorserequestvendor" ||
    lower === "workhorse_requestvendor" ||
    lower === "request_vendor" ||
    lower === "requestvendor"
  ) {
    return "workhorse_request_vendor";
  }
  if (lower === "workhorselistprojects" || lower === "workhorse_listprojects") return "workhorse_list_projects";
  if (lower === "listdir" || lower === "list_directory") return "list_dir";
  if (lower === "readfile" || lower === "read") return "read_file";
  if (lower === "writefile" || lower === "write") return "write_file";
  if (lower === "runcommand" || lower === "bash" || lower === "shell") return "run_command";
  return key;
}

export function toolDetail(use: CustomToolUse): { detail: string; path?: string } {
  const name = normalizeCustomToolName(use.name);
  const input = use.input ?? {};
  if (name === "run_command") {
    const command = typeof input.command === "string" ? input.command : "";
    return { detail: command || "run command", path: typeof input.cwd === "string" ? input.cwd : undefined };
  }
  if (name === "workhorse_spawn_agent") {
    const provider = typeof input.provider === "string" ? input.provider.trim() : "";
    const chat = typeof input.chat === "string" ? input.chat.trim() : "";
    const description = typeof input.description === "string" ? input.description.trim() : "";
    return { detail: provider || chat || description || "another agent" };
  }
  if (name === "workhorse_ask_chat") {
    const chat = typeof input.chat === "string" ? input.chat.trim() : "";
    return { detail: chat || "another chat" };
  }
  const filePath = typeof input.path === "string" ? input.path : undefined;
  return { detail: filePath || name, path: filePath };
}

/** Policy used for custom HTTP tools. Reads auto-run; writes follow Permission/Sandbox. */
export function customToolPolicy(
  use: CustomToolUse,
  policy: CustomToolPolicy,
): PermissionAnswer | "ask" {
  const name = normalizeCustomToolName(use.name);
  const { detail, path: filePath } = toolDetail({ ...use, name });
  const forced = permissionPolicyAnswer({
    mode: policy.mode ?? "ask",
    sandbox: policy.sandbox ?? "off",
    tool: name,
    detail,
    path: filePath,
  });
  if (forced) return forced;
  if ((policy.mode ?? "ask") === "always-approve") return "once";
  if (!looksLikeWriteTool(name, detail, filePath)) return "once";
  return autoAllowPermission({ tool: name, detail, path: filePath, grants: policy.grants }) ?? "ask";
}

export function parseLeftoverToolCalls(text: string): CustomToolUse[] {
  const found: CustomToolUse[] = [];
  const re = /<tool[_-]?call\b[^>]*>([\s\S]*?)<\/tool[_-]?call>/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = re.exec(text))) {
    const body = match[1]?.trim() ?? "";
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      const nameMatch = body.match(/"name"\s*:\s*"([^"]+)"/);
      const argsMatch = body.match(/"arguments"\s*:\s*(\{[\s\S]*\})/);
      if (nameMatch) {
        let args: Record<string, unknown> = {};
        if (argsMatch) {
          try {
            args = JSON.parse(argsMatch[1]) as Record<string, unknown>;
          } catch {
            args = {};
          }
        }
        parsed = { name: nameMatch[1], arguments: args };
      }
    }
    if (!parsed) continue;
    const name = typeof parsed.name === "string" ? parsed.name : "";
    if (!name) continue;
    const args =
      parsed.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments)
        ? (parsed.arguments as Record<string, unknown>)
        : parsed.input && typeof parsed.input === "object" && !Array.isArray(parsed.input)
          ? (parsed.input as Record<string, unknown>)
          : {};
    found.push({ id: `xml_${index++}`, name: normalizeCustomToolName(name), input: args });
  }
  return found;
}

export function parseAnthropicToolUseBlock(block: unknown): CustomToolUse | null {
  if (!block || typeof block !== "object") return null;
  const record = block as Record<string, unknown>;
  if (record.type !== "tool_use") return null;
  const name = typeof record.name === "string" ? record.name : "";
  if (!name) return null;
  const input =
    record.input && typeof record.input === "object" && !Array.isArray(record.input)
      ? (record.input as Record<string, unknown>)
      : {};
  const id = typeof record.id === "string" && record.id ? record.id : `tool_${name}`;
  return { id, name: normalizeCustomToolName(name), input };
}

export function parseOpenAiToolCall(raw: unknown): CustomToolUse | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : record;
  const name = typeof fn.name === "string" ? fn.name : typeof record.name === "string" ? record.name : "";
  if (!name) return null;
  let input: Record<string, unknown> = {};
  const args = fn.arguments ?? record.arguments ?? record.input;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
    } catch {
      input = {};
    }
  } else if (args && typeof args === "object" && !Array.isArray(args)) {
    input = args as Record<string, unknown>;
  }
  const id = typeof record.id === "string" && record.id ? record.id : `call_${name}`;
  return { id, name: normalizeCustomToolName(name), input };
}

/**
 * The real path, not the spelling of it. A symlink on POSIX or a junction on
 * Windows sits inside the workspace and points anywhere; comparing normalized
 * strings says it is contained when it is not. A worker that reads a file
 * carrying hostile instructions can then write outside the sandbox without any
 * other foothold, which is the shortest real attack on this app.
 *
 * A write target usually does not exist yet, so resolve the nearest ancestor
 * that does and keep the remainder: a new file cannot be contained by a
 * directory that is itself a link out.
 */
function realPathOrNearest(target: string, realpath: (value: string) => string): string {
  const tail: string[] = [];
  let current = path.normalize(target);
  for (;;) {
    try {
      return tail.length === 0 ? realpath(current) : path.join(realpath(current), ...tail.slice().reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.normalize(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** Windows and macOS treat these as one path, so containment has to as well. */
function samePathCase(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

export function resolveWorkspacePath(
  requested: string | undefined,
  cwd: string,
  folders: string[],
  sandbox: SandboxProfile,
  options?: { realpath?: (value: string) => string; platform?: NodeJS.Platform },
): string {
  const base = cwd.trim() || process.cwd();
  const raw = (requested ?? "").trim() || base;
  const abs = path.normalize(path.isAbsolute(raw) ? raw : path.join(base, raw));
  if (sandbox === "off") return abs;
  const realpath = options?.realpath ?? ((value: string) => fs.realpathSync(value));
  const platform = options?.platform ?? process.platform;
  const real = samePathCase(realPathOrNearest(abs, realpath), platform);
  const roots = [base, ...folders.map((item) => item.trim()).filter(Boolean)]
    .map((item) => samePathCase(realPathOrNearest(path.normalize(item), realpath), platform));
  const allowed = roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`));
  if (!allowed) throw new Error(`Path is outside the workspace: ${abs}`);
  return abs;
}

export async function executeCustomTool(
  use: CustomToolUse,
  policy: CustomToolPolicy,
): Promise<CustomToolResult> {
  const name = normalizeCustomToolName(use.name);
  const cwd = policy.cwd?.trim() || process.cwd();
  const folders = policy.folders ?? [];
  const sandbox = policy.sandbox ?? "off";
  const role = policy.role ?? deskRoleOf({ parentId: policy.parentId, hidden: policy.hidden });
  try {
    if (role === "worker" && isWorkerOmittedTool(name)) {
      return { id: use.id, name, content: workerOmittedToolError(name), isError: true };
    }
    if (name === "workhorse_list_tools") {
      return {
        id: use.id,
        name,
        content: JSON.stringify(
          customHttpTools([], { role }).map((tool) => ({ name: tool.name, description: tool.description })),
          null,
          2,
        ),
      };
    }
    if (name.startsWith("workhorse_")) {
      const rpc = await handleWorkhorseRpc(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: use.input ?? {} },
        },
        { fromSessionId: policy.sessionId },
      );
      const result = rpc && typeof rpc === "object" ? (rpc as { result?: { content?: { text?: string }[] }; error?: { message?: string } }) : {};
      if (result.error?.message) throw new Error(result.error.message);
      const text = result.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
      return { id: use.id, name, content: text || "(empty)" };
    }
    if (name === "list_dir") {
      const dir = resolveWorkspacePath(typeof use.input.path === "string" ? use.input.path : cwd, cwd, folders, sandbox);
      const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200);
      const lines = entries.map((entry) => `${entry.isDirectory() ? "dir" : "file"} ${entry.name}`);
      return { id: use.id, name, content: lines.join("\n") || "(empty directory)" };
    }
    if (name === "read_file") {
      const filePath = resolveWorkspacePath(typeof use.input.path === "string" ? use.input.path : "", cwd, folders, sandbox);
      const limit = typeof use.input.limit === "number" && use.input.limit > 0 ? Math.round(use.input.limit) : 80_000;
      const text = fs.readFileSync(filePath, "utf8");
      return { id: use.id, name, content: text.length > limit ? `${text.slice(0, limit)}\n…` : text };
    }
    if (name === "write_file") {
      const filePath = resolveWorkspacePath(typeof use.input.path === "string" ? use.input.path : "", cwd, folders, sandbox);
      const content = typeof use.input.content === "string" ? use.input.content : "";
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf8");
      return { id: use.id, name, content: `Wrote ${filePath} (${content.length} chars)` };
    }
    if (name === "run_command") {
      const command = typeof use.input.command === "string" ? use.input.command : "";
      if (!command.trim()) throw new Error("command is required");
      const runCwd = resolveWorkspacePath(typeof use.input.cwd === "string" ? use.input.cwd : cwd, cwd, folders, sandbox);
      return await new Promise<CustomToolResult>((resolve) => {
        /*
         * `exec` used to run this, and its `timeout` and `signal` both stop the
         * shell by pid — the one process a runaway command is not. The shell
         * exits, the loop it started is reparented to init, and it runs on.
         * `exec` also drops `detached` on the floor (execFile forwards only a
         * fixed set of options), so the shell could never lead a group. `spawn`
         * with a shell does honour it: cancel and timeout take the group.
         */
        let timer: NodeJS.Timeout | undefined;
        let stopped = false;
        let out = "";
        const child = spawn(command, {
          cwd: runCwd,
          shell: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          ...groupSpawnOptions(),
        });
        const collect = (chunk: Buffer | string) => {
          if (out.length >= RUN_COMMAND_MAX_OUTPUT) return;
          out += String(chunk);
          if (out.length > RUN_COMMAND_MAX_OUTPUT) out = out.slice(0, RUN_COMMAND_MAX_OUTPUT);
        };
        child.stdout?.on("data", collect);
        child.stderr?.on("data", collect);
        function stop() {
          stopped = true;
          stopProcessGroup(child);
        }
        function finish(code: number | null, signal: NodeJS.Signals | null, error?: Error) {
          if (timer) clearTimeout(timer);
          policy.signal?.removeEventListener("abort", stop);
          const cancelled = Boolean(policy.signal?.aborted) || stopped;
          const text = out.trim();
          const failed = Boolean(error) || cancelled || (code ?? 0) !== 0;
          const why = error
            ? error.message.slice(0, 1_000)
            : cancelled
              ? "Command cancelled"
              : `(exit ${code ?? signal ?? 0})`;
          resolve({ id: use.id, name, content: text || why, ...(failed ? { isError: true } : {}) });
        }
        child.on("error", (error) => finish(null, null, error));
        child.on("close", (code, signal) => finish(code, signal));
        trackProcessGroup(child, policy.sessionId ?? "");
        if (policy.signal?.aborted) stop();
        else policy.signal?.addEventListener("abort", stop, { once: true });
        timer = setTimeout(stop, RUN_COMMAND_TIMEOUT_MS);
      });
    }
    throw new Error(`Unknown tool ${name}`);
  } catch (error) {
    return {
      id: use.id,
      name,
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

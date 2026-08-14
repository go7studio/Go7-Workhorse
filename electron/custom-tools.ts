import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { permissionPolicyAnswer, looksLikeWriteTool, autoAllowPermission, type PermissionAnswer } from "../src/lib/permissions";
import type { PermissionMode, SandboxProfile } from "../src/lib/types";
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

export type CustomToolPolicy = {
  mode?: PermissionMode;
  sandbox?: SandboxProfile;
  grants?: string[];
  cwd?: string;
  folders?: string[];
  sessionId?: string;
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
    description: "List live sidebar chats in this Workhorse window (title, model, preview).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "workhorse_read_chat",
    description: "Read another sidebar chat’s transcript by title.",
    input_schema: {
      type: "object",
      properties: { chat: { type: "string" }, limit: { type: "number" } },
      required: ["chat"],
    },
  },
  {
    name: "workhorse_ask_chat",
    description:
      "Ask an existing sidebar chat a question and return its reply. Talking to another live chat is always allowed and is not limited by this chat’s Permission or Sandbox. Pass the visible title.",
    input_schema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Visible chat title" },
        message: { type: "string", description: "Question or request for that chat" },
      },
      required: ["chat", "message"],
    },
  },
  {
    name: "workhorse_spawn_agent",
    description:
      "Spawn Grok, Codex, Claude, or another desk bot as an in-chat subagent and return its real reply. Sol and Terra are Codex models — pass provider codex and chat or model Sol/Terra. Never invent a reply; only return what this tool outputs.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Full task for the subagent" },
        description: { type: "string", description: "Short 3–5 word label" },
        provider: { type: "string", description: "grok, codex, claude, or custom" },
        model: { type: "string", description: "Optional model id" },
        chat: { type: "string", description: "Optional existing chat or vendor name to copy" },
        effort: { type: "string", description: "Optional reasoning effort" },
        timeoutSeconds: { type: "number", description: "Optional 30-3600 second runtime limit" },
        tokenBudget: { type: "number", description: "Optional total token ceiling" },
        isolation: { type: "string", description: "worktree (default) or shared" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "workhorse_list_bots",
    description:
      "List built-in vendors and custom desk slots with leftover/Watch status. leftoverPercent is that vendor’s weekly plan remaining overall, not this prompt. Do not spawn or ask a row whose canCall is false.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "workhorse_list_projects",
    description: "List Workhorse sidebar projects. Use before creating a project.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "workhorse_create_project",
    description:
      "Create a Workhorse sidebar project with this exact name. The optional folder is linked under that project only, never under a different existing name. Returns immediately — do not wait on another chat.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Sidebar project name" },
        folder: { type: "string", description: "Optional folder to link" },
      },
      required: ["name"],
    },
  },
  {
    name: "workhorse_request_vendor",
    description:
      "Ask the user to allow Grok, Codex, or Claude for THIS chat only when that vendor used its daily bank (today's share is spent; leftover remains for later days). Wait for Allow or Deny. A USER DECLINED result means they said no — tell them that and stop.",
    input_schema: {
      type: "object",
      properties: {
        vendor: { type: "string", description: "grok, codex, or claude" },
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
    description: "List desk skills from Grok, Codex, Claude, and Workhorse.",
    input_schema: { type: "object", properties: { origin: { type: "string" } } },
  },
  {
    name: "workhorse_read_skill",
    description: "Read one SKILL.md by name or origin:name.",
    input_schema: { type: "object", properties: { skill: { type: "string" } }, required: ["skill"] },
  },
];

export function customHttpTools(extra: CustomHttpTool[] = []): CustomHttpTool[] {
  const base = [...WORKSPACE_TOOLS, ...DESK_TOOLS];
  const names = new Set(base.map((tool) => tool.name));
  return [...base, ...extra.filter((tool) => !names.has(tool.name))];
}

export function customHttpToolsOpenAi(extra: CustomHttpTool[] = []): Record<string, unknown>[] {
  return customHttpTools(extra).map((tool) => ({
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
  if (lower === "workhorsereadchat" || lower === "workhorse_readchat") return "workhorse_read_chat";
  if (lower === "workhorsecreateproject" || lower === "workhorse_createproject") return "workhorse_create_project";
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
  return autoAllowPermission({ tool: name, grants: policy.grants }) ?? "ask";
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

export function resolveWorkspacePath(
  requested: string | undefined,
  cwd: string,
  folders: string[],
  sandbox: SandboxProfile,
): string {
  const base = cwd.trim() || process.cwd();
  const raw = (requested ?? "").trim() || base;
  const abs = path.normalize(path.isAbsolute(raw) ? raw : path.join(base, raw));
  if (sandbox === "off") return abs;
  const roots = [base, ...folders.map((item) => item.trim()).filter(Boolean)].map((item) => path.normalize(item));
  const allowed = roots.some((root) => abs === root || abs.startsWith(`${root}${path.sep}`));
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
  try {
    if (name === "workhorse_list_tools") {
      return {
        id: use.id,
        name,
        content: JSON.stringify(
          customHttpTools().map((tool) => ({ name: tool.name, description: tool.description })),
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
      const result = spawnSync(command, {
        cwd: runCwd,
        shell: true,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      if (result.error) throw result.error;
      return {
        id: use.id,
        name,
        content: out || `(exit ${result.status ?? 0})`,
        isError: typeof result.status === "number" && result.status !== 0,
      };
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

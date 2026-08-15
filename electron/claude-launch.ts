import type { EffortLevel, McpServerConfig, PermissionMode, SandboxProfile } from "../src/lib/types";
import {
  WORKHORSE_CLIENT_CAPABILITIES,
  WORKHORSE_SESSION_RULES,
  mergeMcpServers,
  workhorseMcpServer,
  type GrokLaunchSpec,
  type GrokMcpServer,
  type GrokSessionMeta,
} from "./grok-launch";
import { readClaudeDesktopOauth } from "./claude-desktop-auth";
import {
  CLAUDE_ACP_NOT_INSTALLED,
  isElectronAcpCommand,
  resolveClaudeAcpLaunch,
  resolveClaudeCliBinary,
  type ClaudeLoginDetectInput,
} from "./claude-login";
import { withDeskToolEnv } from "./desk-path";

export type ClaudeLaunchInput = {
  sessionId?: string;
  model: string;
  effort: EffortLevel | string | null;
  cwd: string;
  mode: PermissionMode;
  sandbox?: SandboxProfile;
  mcpServers?: McpServerConfig[];
  detect?: ClaudeLoginDetectInput;
};

export type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export type ClaudeSessionMeta = GrokSessionMeta & {
  model?: string;
  effort?: string;
  permissionMode?: ClaudePermissionMode;
  sandbox?: SandboxProfile;
  claudeCode?: {
    options?: {
      thinking?: { type: "adaptive" | "enabled" | "disabled"; display?: "summarized" | "omitted"; budgetTokens?: number };
      effort?: string;
    };
  };
};

export type ClaudeLaunchSpec = GrokLaunchSpec & {
  env?: Record<string, string>;
  permissionMode: ClaudePermissionMode;
};

const DEFAULT_MODEL = "claude-sonnet-5";

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-5",
  "opus 5": "claude-opus-5",
  "opus-5": "claude-opus-5",
  sonnet: "claude-sonnet-5",
  "sonnet 5": "claude-sonnet-5",
  "sonnet-5": "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  "haiku 4.5": "claude-haiku-4-5",
  "haiku-4-5": "claude-haiku-4-5",
  fable: "claude-fable-5",
  "fable 5": "claude-fable-5",
  "fable-5": "claude-fable-5",
  "claude-opus": "claude-opus-5",
  "claude-sonnet": "claude-sonnet-5",
  "claude-haiku": "claude-haiku-4-5",
  "claude-fable": "claude-fable-5",
};
const DEFAULT_EFFORT = "medium";

export function resolveClaudeModel(model: string | null | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed) return DEFAULT_MODEL;
  const stripped = trimmed.replace(/\[[^\]]+\]$/g, "").trim();
  const key = stripped.toLowerCase().replace(/_/g, "-");
  return CLAUDE_MODEL_ALIASES[key] ?? stripped;
}

export function resolveClaudeEffort(effort: EffortLevel | string | null | undefined): string {
  if (effort === "extra") return "xhigh";
  if (
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max" ||
    effort === "ultra"
  ) {
    return effort === "ultra" ? "max" : effort;
  }
  if (typeof effort === "string" && effort.trim()) return effort.trim();
  return DEFAULT_EFFORT;
}

export function resolveClaudeSandbox(sandbox: SandboxProfile | string | null | undefined): SandboxProfile {
  if (sandbox === "workspace" || sandbox === "read-only" || sandbox === "strict" || sandbox === "off") return sandbox;
  return "off";
}

export function resolveClaudePermissionMode(
  mode: PermissionMode,
  sandbox?: SandboxProfile | string | null,
): ClaudePermissionMode {
  if (mode === "plan") return "plan";
  if (sandbox === "read-only" || sandbox === "strict") return "default";
  if (mode === "always-approve") return "bypassPermissions";
  if (mode === "accept-edits") return "acceptEdits";
  return "default";
}

export function buildClaudeLaunchSpec(input: ClaudeLaunchInput): ClaudeLaunchSpec {
  const model = resolveClaudeModel(input.model);
  const effort = resolveClaudeEffort(input.effort);
  const sandbox = resolveClaudeSandbox(input.sandbox);
  const permissionMode = resolveClaudePermissionMode(input.mode, sandbox);
  const boxed = sandbox === "read-only" || sandbox === "strict";
  const alwaysApprove = input.mode === "always-approve" && !boxed;
  const launch = resolveClaudeAcpLaunch(input.detect);
  if (!launch) throw new Error(CLAUDE_ACP_NOT_INSTALLED);
  const command = launch.command;
  if (command.toLowerCase() === "grok" || /(^|[\\/])grok(\.exe)?$/i.test(command)) {
    throw new Error("Claude launch refused to spawn grok");
  }

  const meta: ClaudeSessionMeta = {
    model,
    effort,
    permissionMode,
    sandbox,
    rules: WORKHORSE_SESSION_RULES,
    claudeCode: {
      options: {
        thinking: { type: "adaptive", display: "summarized" },
        effort,
      },
    },
  };
  if (alwaysApprove) meta.yoloMode = true;
  else if (input.mode === "accept-edits" && !boxed) meta.autoMode = true;
  else if (input.mode === "plan") meta.planMode = true;

  const builtIn = workhorseMcpServer(input.sessionId);
  const mcpServers: GrokMcpServer[] = mergeMcpServers(input.mcpServers, builtIn);
  const cli = resolveClaudeCliBinary(input.detect);
  const env: Record<string, string> = {
    NO_BROWSER: "1",
    ANTHROPIC_MODEL: model,
  };
  if (cli) env.CLAUDE_CODE_EXECUTABLE = cli;
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    const desktop = readClaudeDesktopOauth(input.detect);
    if (desktop?.accessToken) env.CLAUDE_CODE_OAUTH_TOKEN = desktop.accessToken;
  }
  if (isElectronAcpCommand(command)) env.ELECTRON_RUN_AS_NODE = "1";

  return {
    agentLabel: "Claude",
    command,
    argv: launch.argv,
    cwd: input.cwd,
    model,
    effort,
    alwaysApprove,
    sandbox,
    permissionMode,
    env,
    initializeParams: {
      protocolVersion: 1,
      clientInfo: {
        name: "go7-workhorse",
        title: "Workhorse",
        version: "0.1.1",
      },
      clientCapabilities: { ...WORKHORSE_CLIENT_CAPABILITIES },
    },
    sessionParams: {
      cwd: input.cwd,
      mcpServers,
      _meta: meta,
    },
  };
}

export function claudeSpawnArgs(spec: ClaudeLaunchSpec): {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  return {
    command: spec.command,
    args: spec.argv,
    cwd: spec.cwd,
    env: withDeskToolEnv({ ...process.env, ...spec.env }),
  };
}

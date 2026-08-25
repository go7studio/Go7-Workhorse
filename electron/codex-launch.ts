import type { EffortLevel, McpServerConfig, PermissionMode, SandboxProfile, SessionSecurityPolicy } from "../src/lib/types";
import { sessionRulesFor, type DeskRole } from "../src/lib/workhorse-rules";
import {
  WORKHORSE_CLIENT_CAPABILITIES,
  mergeMcpServers,
  workhorseMcpServer,
  type GrokLaunchSpec,
  type GrokMcpServer,
  type GrokSessionMeta,
} from "./grok-launch";
import {
  CODEX_ACP_NOT_INSTALLED,
  isElectronAcpCommand,
  resolveCodexAcpLaunch,
  CODEX_CLI_NOT_INSTALLED,
  resolveCodexCliBinary,
  type CodexLoginDetectInput,
} from "./codex-login";
import { isInsideAsar, withDeskToolEnv, withoutWorkhorsePrivateEnv } from "./desk-path";
import { APP_VERSION } from "../src/lib/app-info";

export type CodexLaunchInput = {
  sessionId?: string;
  model: string;
  effort: EffortLevel | string | null;
  cwd: string;
  mode: PermissionMode;
  sandbox?: SandboxProfile;
  securityPolicy?: SessionSecurityPolicy;
  mcpServers?: McpServerConfig[];
  detect?: CodexLoginDetectInput;
  /** Which rules the CLI is launched with. A worker gets worker rules. */
  role?: DeskRole;
};

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexAgentMode = "read-only" | "agent" | "agent-full-access";

export type CodexSessionMeta = GrokSessionMeta & {
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
};

export type CodexLaunchSpec = GrokLaunchSpec & {
  env?: Record<string, string>;
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  agentMode: CodexAgentMode;
};

const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_EFFORT = "medium";

/** Composer slug → Codex `model` (CODEX_CONFIG.model / session _meta.model). Pass through live slugs. */
export function resolveCodexModel(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_MODEL;
}

/** Codex config key `model_reasoning_effort`. No `--reasoning-effort` argv — Codex ACP does not take that Grok flag. */
export function resolveCodexEffort(effort: EffortLevel | string | null | undefined): string {
  if (effort === "extra") return "xhigh";
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max" || effort === "ultra") {
    return effort;
  }
  if (typeof effort === "string" && effort.trim()) return effort.trim();
  return DEFAULT_EFFORT;
}

/** Workhorse off|workspace|read-only|strict → Codex sandbox_mode. */
export function resolveCodexSandboxMode(
  sandbox: SandboxProfile | string | null | undefined,
  root?: SessionSecurityPolicy["root"],
): CodexSandboxMode {
  if (sandbox === "read-only" || sandbox === "strict") return "read-only";
  if (sandbox === "workspace") return "workspace-write";
  if (root === "blocked") return "workspace-write";
  return "danger-full-access";
}

export function resolveCodexApprovalPolicy(mode: PermissionMode, root?: SessionSecurityPolicy["root"]): CodexApprovalPolicy {
  if (root === "ask") return "on-request";
  if (mode === "always-approve") return "never";
  if (mode === "plan") return "untrusted";
  return "on-request";
}

export function resolveCodexAgentMode(mode: PermissionMode, sandbox: SandboxProfile | string | null | undefined): CodexAgentMode {
  if (mode === "plan" || sandbox === "read-only" || sandbox === "strict") return "read-only";
  if (mode === "always-approve" || sandbox === "off" || !sandbox) return "agent-full-access";
  return "agent";
}

export function buildCodexLaunchSpec(input: CodexLaunchInput): CodexLaunchSpec {
  const model = resolveCodexModel(input.model);
  const effort = resolveCodexEffort(input.effort);
  const sandbox = input.sandbox === "workspace" || input.sandbox === "read-only" || input.sandbox === "strict" || input.sandbox === "off"
    ? input.sandbox
    : "off";
  const sandboxMode = resolveCodexSandboxMode(sandbox, input.securityPolicy?.root);
  const approvalPolicy = resolveCodexApprovalPolicy(input.mode, input.securityPolicy?.root);
  const agentMode = resolveCodexAgentMode(input.mode, sandbox);
  const alwaysApprove = input.mode === "always-approve";
  const launch = resolveCodexAcpLaunch(input.detect);
  if (!launch) throw new Error(CODEX_ACP_NOT_INSTALLED);
  const command = launch.command;
  if (command.toLowerCase() === "grok" || command.toLowerCase().endsWith("\\grok") || command.toLowerCase().endsWith("/grok") || command.toLowerCase().endsWith("grok.exe")) {
    throw new Error("Codex launch refused to spawn grok");
  }

  const meta: CodexSessionMeta = {
    model,
    reasoningEffort: effort,
    sandboxMode,
    approvalPolicy,
    rules: sessionRulesFor(input.role, "codex"),
  };
  if (alwaysApprove) meta.yoloMode = true;
  else if (input.mode === "accept-edits") meta.autoMode = true;
  else if (input.mode === "plan") meta.planMode = true;

  const builtIn = workhorseMcpServer(input.sessionId);
  const mcpServers: GrokMcpServer[] = mergeMcpServers(input.mcpServers, builtIn);

  const cli = resolveCodexCliBinary(input.detect);
  const env: Record<string, string> = {
    INITIAL_AGENT_MODE: agentMode,
    NO_BROWSER: "1",
    CODEX_CONFIG: JSON.stringify({
      model,
      model_reasoning_effort: effort,
      sandbox_mode: sandboxMode,
      approval_policy: approvalPolicy,
      sandbox_workspace_write: { network_access: input.securityPolicy?.network === "allowed" },
    }),
  };
  if (cli) env.CODEX_PATH = cli;
  // See the Claude adapter: a packaged fallback lands inside app.asar and
  // surfaces as "spawn ENOTDIR" instead of naming the missing CLI.
  else if (isInsideAsar(launch.acpFile)) throw new Error(CODEX_CLI_NOT_INSTALLED);
  if (isElectronAcpCommand(command)) env.ELECTRON_RUN_AS_NODE = "1";

  return {
    agentLabel: "Codex",
    command,
    argv: launch.argv,
    cwd: input.cwd,
    model,
    effort,
    alwaysApprove,
    sandbox,
    sandboxMode,
    approvalPolicy,
    agentMode,
    env,
    initializeParams: {
      protocolVersion: 1,
      clientInfo: {
        name: "go7-workhorse",
        title: "Workhorse",
        version: APP_VERSION,
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

export function codexSpawnArgs(spec: CodexLaunchSpec): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  return {
    command: spec.command,
    args: spec.argv,
    cwd: spec.cwd,
    env: withDeskToolEnv({ ...withoutWorkhorsePrivateEnv(process.env), ...spec.env }),
  };
}

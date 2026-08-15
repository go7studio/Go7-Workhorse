import fs from "node:fs";
import path from "node:path";
import { WORKHORSE_SESSION_RULES } from "../src/lib/workhorse-rules";
import type { EffortLevel, McpServerConfig, PermissionMode, SandboxProfile } from "../src/lib/types";
import { APP_VERSION } from "../src/lib/app-info";

export { WORKHORSE_SESSION_RULES };

export const GROK_MODELS = ["grok-4.6", "grok-4.5", "grok-build"] as const;
export const GROK_EFFORT_GATES = ["low", "medium", "high", "xhigh"] as const;
export const GROK_EFFORT_INPUTS = ["low", "medium", "high", "extra", "xhigh"] as const;

export type GrokModelId = (typeof GROK_MODELS)[number];
export type GrokEffortGate = (typeof GROK_EFFORT_GATES)[number];
export type GrokEffortInput = (typeof GROK_EFFORT_INPUTS)[number];

export type GrokLaunchInput = {
  sessionId?: string;
  model: string;
  effort: EffortLevel | string | null;
  cwd: string;
  mode: PermissionMode;
  sandbox?: SandboxProfile;
  mcpServers?: McpServerConfig[];
};

export type GrokMcpEnvVar = { name: string; value: string };

export type GrokMcpServer = {
  type?: "stdio";
  name: string;
  command: string;
  args: string[];
  env?: GrokMcpEnvVar[];
};

export function toAcpMcpEnv(env: Record<string, string> | undefined): GrokMcpEnvVar[] | undefined {
  if (!env) return undefined;
  const rows = Object.entries(env)
    .filter(([name]) => name.trim())
    .map(([name, value]) => ({ name, value: String(value) }));
  return rows.length > 0 ? rows : undefined;
}

export type GrokSessionMeta = {
  yoloMode?: boolean;
  autoMode?: boolean;
  // ACP session/new documents yoloMode/autoMode only. Plan is Grok permission-mode
  // `plan` / plan-mode; we pass the same shape plus --permission-mode plan.
  planMode?: boolean;
  rules?: string;
};

export const WORKHORSE_CLIENT_CAPABILITIES = {
  sessionLoad: true,
  permissionPrompts: true,
} as const;

function binaryName(command: string): string {
  return path.basename(command).toLowerCase();
}

export function isNodeBinary(command: string): boolean {
  const name = binaryName(command);
  return name === "node" || name === "node.exe";
}

export function isElectronBinary(command: string): boolean {
  const name = binaryName(command);
  return name === "electron" || name === "electron.exe";
}

/** Packaged builds rename Electron to the product name. Spawning that
 *  without ELECTRON_RUN_AS_NODE opens another desk window. */
export function isElectronAppCommand(command: string, execPath = process.execPath): boolean {
  if (isElectronBinary(command)) return true;
  const name = binaryName(command);
  if (name === "workhorse" || name === "workhorse.exe") return true;
  return Boolean(process.versions.electron) && command === execPath;
}

function findNodeOnPath(): string | null {
  const name = process.platform === "win32" ? "node.exe" : "node";
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const raw of dirs) {
    const dir = raw.replace(/^"+|"+$/g, "").trim();
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveNodeExecutable(): { command: string; runAsNode: boolean } {
  if (!process.versions.electron && isNodeBinary(process.execPath)) {
    return { command: process.execPath, runAsNode: false };
  }
  const npmNode = process.env.npm_node_execpath?.trim();
  const found =
    findNodeOnPath() ?? (npmNode && !isElectronBinary(npmNode) && fs.existsSync(npmNode) ? npmNode : null);
  if (found && !isElectronBinary(found)) {
    return { command: found, runAsNode: false };
  }
  if (process.versions.electron) {
    return { command: process.execPath, runAsNode: true };
  }
  return { command: "node", runAsNode: false };
}

export function workhorseMcpScript(script: string): string {
  const base = path.basename(script).toLowerCase();
  if (base === "main.js" || base === "main.ts") {
    return path.join(path.dirname(script), "workhorse-mcp.js");
  }
  return script;
}

export function workhorseMcpServer(fromSessionId?: string): GrokMcpServer | null {
  const scriptEnv = process.env.WORKHORSE_MCP_SCRIPT?.trim();
  const url = process.env.WORKHORSE_BRIDGE_URL?.trim();
  const token = process.env.WORKHORSE_BRIDGE_TOKEN?.trim();
  const statePath = process.env.WORKHORSE_STATE_PATH?.trim();
  if (!scriptEnv || !url || !token || !statePath) return null;
  const script = workhorseMcpScript(scriptEnv);
  // A missing helper exits at once and Grok reports "pipe is being closed" (os 232).
  if (!fs.existsSync(script)) return null;
  const override = process.env.WORKHORSE_MCP_COMMAND?.trim();
  const resolved = override
    ? { command: override, runAsNode: isElectronAppCommand(override) }
    : resolveNodeExecutable();
  const env: Record<string, string> = {
    WORKHORSE_BRIDGE_URL: url,
    WORKHORSE_BRIDGE_TOKEN: token,
    WORKHORSE_STATE_PATH: statePath,
  };
  if (fromSessionId?.trim()) env.WORKHORSE_FROM_SESSION = fromSessionId.trim();
  if (resolved.runAsNode || isElectronAppCommand(resolved.command)) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  return {
    type: "stdio",
    name: "workhorse",
    command: resolved.command,
    args: [script],
    env: toAcpMcpEnv(env),
  };
}

export type GrokLaunchSpec = {
  /** Vendor name for messages. The ACP agent is shared, so Claude and Codex
   *  failures would otherwise all report themselves as grok. */
  agentLabel?: string;
  command: string;
  argv: string[];
  cwd: string;
  model: string;
  effort: string;
  /** Claude Code Fast mode, sent as a session config option after session/new. */
  fastMode?: boolean;
  /** Claude Code agent persona, sent the same way. */
  agentName?: string | null;
  alwaysApprove: boolean;
  sandbox: SandboxProfile;
  initializeParams: {
    protocolVersion: 1;
    clientInfo: { name: string; title: string; version: string };
    clientCapabilities: { sessionLoad: true; permissionPrompts: true };
  };
  sessionParams: {
    cwd: string;
    mcpServers: GrokMcpServer[];
    _meta?: GrokSessionMeta;
  };
};

const DEFAULT_MODEL = "grok-4.6";
const DEFAULT_EFFORT = "medium";

export function resolveGrokModel(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_MODEL;
}

export function resolveGrokEffort(effort: EffortLevel | string | null | undefined): string {
  if (effort === "extra" || effort === "max" || effort === "ultra") return "xhigh";
  if (typeof effort === "string" && effort.trim()) return effort.trim();
  return DEFAULT_EFFORT;
}

export function resolveGrokSandbox(sandbox: SandboxProfile | string | null | undefined): SandboxProfile {
  if (sandbox === "workspace" || sandbox === "read-only" || sandbox === "strict" || sandbox === "off") return sandbox;
  return "off";
}

/** Grok `--permission-mode` values. accept-edits is acceptEdits, not autoMode. */
export type GrokPermissionMode = "default" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | "plan";

export function resolveGrokPermissionMode(
  mode: PermissionMode,
  sandbox?: SandboxProfile | string | null,
): GrokPermissionMode {
  const boxed = sandbox === "read-only" || sandbox === "strict";
  if (mode === "plan") return "plan";
  if (boxed) return "dontAsk";
  if (mode === "always-approve") return "bypassPermissions";
  if (mode === "accept-edits") return "acceptEdits";
  return "default";
}

export function mergeMcpServers(user: McpServerConfig[] | undefined, extra: GrokMcpServer | null): GrokMcpServer[] {
  const servers: GrokMcpServer[] = [];
  for (const item of user ?? []) {
    const name = item.name?.trim();
    const command = item.command?.trim();
    if (!name || !command) continue;
    servers.push({
      type: "stdio",
      name,
      command,
      args: Array.isArray(item.args) ? item.args.map(String) : [],
      ...(toAcpMcpEnv(item.env) ? { env: toAcpMcpEnv(item.env) } : {}),
    });
  }
  if (extra && !servers.some((item) => item.name === extra.name)) servers.push(extra);
  return servers;
}

export function buildGrokLaunchSpec(input: GrokLaunchInput): GrokLaunchSpec {
  const model = resolveGrokModel(input.model);
  const effort = resolveGrokEffort(input.effort);
  const sandbox = resolveGrokSandbox(input.sandbox);
  const permissionMode = resolveGrokPermissionMode(input.mode, sandbox);
  const alwaysApprove = input.mode === "always-approve" && sandbox !== "read-only" && sandbox !== "strict";
  // `--sandbox` and `--permission-mode` are top-level `grok` flags.
  // Current grok agent rejects them after `agent` (`unexpected argument '--sandbox'`).
  // Always pass both so ~/.grok/config.toml and GROK_SANDBOX cannot override This chat.
  const argv: string[] = ["--sandbox", sandbox, "--permission-mode", permissionMode];
  if (permissionMode === "acceptEdits") argv.push("--allow", "Edit", "--allow", "Write");
  argv.push("agent", "--no-leader");
  if (alwaysApprove) argv.push("--always-approve");
  argv.push("--model", model, "--reasoning-effort", effort, "stdio");

  const meta: GrokSessionMeta = { rules: WORKHORSE_SESSION_RULES };
  if (alwaysApprove) meta.yoloMode = true;
  else if (input.mode === "plan") meta.planMode = true;
  const builtIn = workhorseMcpServer(input.sessionId);
  const mcpServers = mergeMcpServers(input.mcpServers, builtIn);

  return {
    command: "grok",
    argv,
    cwd: input.cwd,
    model,
    effort,
    alwaysApprove,
    sandbox,
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
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    },
  };
}

export function grokSpawnArgs(spec: GrokLaunchSpec): { command: string; args: string[]; cwd: string } {
  return { command: spec.command, args: spec.argv, cwd: spec.cwd };
}

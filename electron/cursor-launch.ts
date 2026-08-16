import type { EffortLevel, McpServerConfig, PermissionMode, SandboxProfile } from "../src/lib/types";
import { APP_VERSION } from "../src/lib/app-info";
import {
  WORKHORSE_CLIENT_CAPABILITIES,
  WORKHORSE_SESSION_RULES,
  mergeMcpServers,
  workhorseMcpServer,
  type GrokLaunchSpec,
} from "./grok-launch";
import {
  detectCursorLogin,
  isCursorAppCommand,
  isGrokCommand,
  type CursorLoginDetectInput,
} from "./cursor-login";

export type CursorLaunchInput = {
  sessionId?: string;
  model: string;
  effort: EffortLevel | string | null;
  cwd: string;
  mode: PermissionMode;
  sandbox?: SandboxProfile;
  mcpServers?: McpServerConfig[];
  detect?: CursorLoginDetectInput;
};

const DEFAULT_MODEL = "composer-2.5";

export function resolveCursorModel(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_MODEL;
}

export function resolveCursorEffort(effort: EffortLevel | string | null | undefined): string {
  if (effort === "extra") return "xhigh";
  if (
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max" ||
    effort === "ultra"
  ) {
    return effort;
  }
  if (typeof effort === "string" && effort.trim()) return effort.trim();
  return "medium";
}

export function resolveCursorPermissionMode(mode: PermissionMode): "ask" | "agent" | "plan" {
  if (mode === "plan") return "plan";
  if (mode === "always-approve" || mode === "accept-edits") return "agent";
  return "ask";
}

export function buildCursorLaunchSpec(input: CursorLaunchInput): GrokLaunchSpec {
  const detected = detectCursorLogin(input.detect);
  let command = detected.binary ?? "";
  if (command && (isCursorAppCommand(command) || isGrokCommand(command))) command = "";
  const model = resolveCursorModel(input.model);
  const effort = resolveCursorEffort(input.effort);
  const permissionMode = resolveCursorPermissionMode(input.mode);
  const argv = ["acp"];
  const builtIn = workhorseMcpServer(input.sessionId);
  const mcpServers = mergeMcpServers(input.mcpServers, builtIn);
  const env: Record<string, string> = {};
  const key = (input.detect?.env ?? process.env).CURSOR_API_KEY?.trim();
  const token = (input.detect?.env ?? process.env).CURSOR_AUTH_TOKEN?.trim();
  if (key) env.CURSOR_API_KEY = key;
  if (token) env.CURSOR_AUTH_TOKEN = token;
  return {
    agentLabel: "Cursor",
    command,
    argv,
    cwd: input.cwd,
    model,
    effort,
    alwaysApprove: input.mode === "always-approve",
    sandbox: input.sandbox ?? "off",
    initializeParams: {
      protocolVersion: 1,
      clientInfo: { name: "go7-workhorse", title: "Workhorse", version: APP_VERSION },
      clientCapabilities: { ...WORKHORSE_CLIENT_CAPABILITIES },
    },
    sessionParams: {
      cwd: input.cwd,
      mcpServers,
      _meta: {
        rules: WORKHORSE_SESSION_RULES,
        model,
        effort,
        permissionMode,
      } as GrokLaunchSpec["sessionParams"]["_meta"] & { model: string; effort: string; permissionMode: string },
    },
    ...(Object.keys(env).length > 0 ? { env } : {}),
  } as GrokLaunchSpec & { env?: Record<string, string> };
}

export function cursorSpawnArgs(spec: GrokLaunchSpec & { env?: Record<string, string> }): {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  return {
    command: spec.command,
    args: spec.argv,
    cwd: spec.cwd,
    env: { ...process.env, ...(spec as { env?: Record<string, string> }).env },
  };
}

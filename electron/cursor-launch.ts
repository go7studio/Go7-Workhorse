import type { EffortLevel, McpServerConfig, PermissionMode, SandboxProfile } from "../src/lib/types";
import { APP_VERSION } from "../src/lib/app-info";
import {
  WORKHORSE_CLIENT_CAPABILITIES,
  mergeMcpServers,
  workhorseMcpServer,
  type GrokLaunchSpec,
} from "./grok-launch";
import { sessionRulesFor, type DeskRole } from "../src/lib/workhorse-rules";
import { normalizeModelId } from "../src/lib/models";
import {
  detectCursorLogin,
  isCursorAppCommand,
  isGrokCommand,
  type CursorLoginDetectInput,
} from "./cursor-login";
import { withDeskToolEnv } from "./desk-path";

export type CursorLaunchInput = {
  sessionId?: string;
  model: string;
  effort: EffortLevel | string | null;
  cwd: string;
  mode: PermissionMode;
  sandbox?: SandboxProfile;
  mcpServers?: McpServerConfig[];
  detect?: CursorLoginDetectInput;
  /** Which rules the CLI is launched with. A worker gets worker rules. */
  role?: DeskRole;
};

const DEFAULT_MODEL = "composer-2.5";

export function resolveCursorModel(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return normalizeModelId("cursor", trimmed || DEFAULT_MODEL);
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
  const argv = [...detected.prefixArgs, "--model", model, "acp"];
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
        rules: sessionRulesFor(input.role, "cursor"),
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
    // Same desk environment the other three vendors get. Without it a
    // Finder-launched app hands Cursor a bare PATH, so its tools cannot find
    // git, node, ripgrep or a command-named MCP server.
    env: withDeskToolEnv({ ...process.env, ...(spec as { env?: Record<string, string> }).env }),
  };
}

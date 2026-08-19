import type { McpServerConfig } from "../src/lib/types";

export const WORKHORSE_MCP_NAME = "workhorse";

export type ExternalMcpLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export function workhorseExternalMcpLaunch(input: {
  command: string;
  script: string;
  statePath: string;
}): ExternalMcpLaunch {
  return {
    command: input.command,
    args: [input.script],
    env: {
      WORKHORSE_MCP_PROFILE: "external-runtime",
      WORKHORSE_STATE_PATH: input.statePath,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

export function workhorseExternalMcpServer(input: {
  command: string;
  script: string;
  statePath: string;
}): McpServerConfig {
  const launch = workhorseExternalMcpLaunch(input);
  return { name: WORKHORSE_MCP_NAME, command: launch.command, args: launch.args, env: launch.env };
}

export function mcpConfigContainsBearer(config: unknown): boolean {
  const text = JSON.stringify(config ?? {});
  return /bearer|WORKHORSE_BRIDGE_TOKEN|authorization/i.test(text);
}

export function mergeExternalMcpServer(existing: unknown, entry: McpServerConfig): Record<string, unknown> {
  const base = existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
  const servers =
    base.mcpServers && typeof base.mcpServers === "object" && !Array.isArray(base.mcpServers)
      ? { ...(base.mcpServers as Record<string, unknown>) }
      : {};
  servers[entry.name] = {
    command: entry.command,
    args: entry.args,
    ...(entry.env ? { env: entry.env } : {}),
  };
  return { ...base, mcpServers: servers };
}

export function mergeOpenClawMcpConfig(existing: unknown, launch: ExternalMcpLaunch): Record<string, unknown> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  const mcp = base.mcp && typeof base.mcp === "object" && !Array.isArray(base.mcp) ? { ...(base.mcp as Record<string, unknown>) } : {};
  const servers =
    mcp.servers && typeof mcp.servers === "object" && !Array.isArray(mcp.servers)
      ? { ...(mcp.servers as Record<string, unknown>) }
      : {};
  servers[WORKHORSE_MCP_NAME] = {
    command: launch.command,
    args: launch.args,
    env: launch.env,
  };
  return { ...base, mcp: { ...mcp, servers } };
}

export function openClawMcpSetJson(launch: ExternalMcpLaunch): string {
  return JSON.stringify({ command: launch.command, args: launch.args, env: launch.env });
}

function yamlQuote(value: string): string {
  // MCP environment values are strings. Plain YAML scalars such as `1`,
  // `true`, and `null` are typed by strict readers (Hermes uses Pydantic),
  // so always quote them instead of relying on a reader's coercion.
  return JSON.stringify(value);
}

export function hermesWorkhorseYamlBlock(launch: ExternalMcpLaunch, indent = "  "): string {
  const lines = [
    `${indent}${WORKHORSE_MCP_NAME}:`,
    `${indent}  command: ${yamlQuote(launch.command)}`,
    `${indent}  args:`,
    ...launch.args.map((arg) => `${indent}    - ${yamlQuote(arg)}`),
    `${indent}  env:`,
    ...Object.entries(launch.env).map(([key, value]) => `${indent}    ${key}: ${yamlQuote(value)}`),
    `${indent}  enabled: true`,
  ];
  return `${lines.join("\n")}\n`;
}

export function upsertHermesMcpServers(yamlText: string, launch: ExternalMcpLaunch): string {
  const block = hermesWorkhorseYamlBlock(launch, "  ");
  const text = yamlText.replace(/\r\n/g, "\n");
  if (!text.trim()) {
    return `mcp_servers:\n${block}`;
  }
  if (!/^mcp_servers:\s*$/m.test(text) && !/^mcp_servers:\s*\n/m.test(text)) {
    const trimmed = text.replace(/\s*$/, "");
    return `${trimmed}\n\nmcp_servers:\n${block}`;
  }
  const workhorse = /^([ \t]*)workhorse:\s*$/m.exec(text);
  if (workhorse && workhorse.index !== undefined) {
    const indent = workhorse[1] ?? "";
    const start = workhorse.index;
    const after = text.slice(start + workhorse[0].length);
    const next = after.search(new RegExp(`\\n(?=${indent}\\S|\\S)`));
    const end = next < 0 ? text.length : start + workhorse[0].length + next + 1;
    return `${text.slice(0, start)}${hermesWorkhorseYamlBlock(launch, indent || "  ")}${text.slice(end).replace(/^\n/, "")}`;
  }
  return text.replace(/^mcp_servers:\s*$/m, `mcp_servers:\n${block.replace(/\n$/, "")}`);
}

export function openClawConfigPath(home: string, platform: "darwin" | "win32" | "linux"): string {
  const slash = platform === "win32" || home.includes("\\") ? "\\" : "/";
  return `${home.replace(/[\\/]+$/, "")}${slash}.openclaw${slash}openclaw.json`;
}

export function hermesConfigPath(home: string, platform: "darwin" | "win32" | "linux"): string {
  const slash = platform === "win32" || home.includes("\\") ? "\\" : "/";
  return `${home.replace(/[\\/]+$/, "")}${slash}.hermes${slash}config.yaml`;
}

export type InstallIo = {
  existsSync: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, text: string) => void;
  mkdirp: (path: string) => void;
  exec?: (file: string, args: string[]) => { status: number; stdout: string; stderr: string };
};

export type InstallReport = {
  ok: boolean;
  written: Array<{ target: "openclaw" | "hermes"; path: string; how: "file" | "cli" }>;
  skipped: Array<{ target: "openclaw" | "hermes"; reason: string }>;
};

function dirnameOf(file: string): string {
  const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return cut <= 0 ? file : file.slice(0, cut);
}

export function installWorkhorseExternalMcp(input: {
  home: string;
  platform: "darwin" | "win32" | "linux";
  command: string;
  script: string;
  statePath: string;
  io: InstallIo;
}): InstallReport {
  const launch = workhorseExternalMcpLaunch(input);
  const written: InstallReport["written"] = [];
  const skipped: InstallReport["skipped"] = [];

  const openclawPath = openClawConfigPath(input.home, input.platform);
  let openclawDone = false;
  if (input.io.exec) {
    const result = input.io.exec("openclaw", ["mcp", "set", WORKHORSE_MCP_NAME, openClawMcpSetJson(launch)]);
    if (result.status === 0) {
      written.push({ target: "openclaw", path: openclawPath, how: "cli" });
      openclawDone = true;
    }
  }
  if (!openclawDone) {
    try {
      let existing: unknown = {};
      if (input.io.existsSync(openclawPath)) {
        existing = JSON.parse(input.io.readFile(openclawPath));
      }
      const next = mergeOpenClawMcpConfig(existing, launch);
      if (mcpConfigContainsBearer(next)) {
        skipped.push({ target: "openclaw", reason: "refused to write a bearer token" });
      } else {
        input.io.mkdirp(dirnameOf(openclawPath));
        input.io.writeFile(openclawPath, `${JSON.stringify(next, null, 2)}\n`);
        written.push({ target: "openclaw", path: openclawPath, how: "file" });
      }
    } catch (error) {
      skipped.push({
        target: "openclaw",
        reason: error instanceof Error ? error.message : "could not write openclaw.json",
      });
    }
  }

  const hermesPath = hermesConfigPath(input.home, input.platform);
  const hermesHome = dirnameOf(hermesPath);
  if (!input.io.existsSync(hermesPath) && !input.io.existsSync(hermesHome)) {
    skipped.push({ target: "hermes", reason: "Hermes is not installed (no ~/.hermes)" });
  } else try {
    const current = input.io.existsSync(hermesPath) ? input.io.readFile(hermesPath) : "";
    const next = upsertHermesMcpServers(current, launch);
    if (/bearer|WORKHORSE_BRIDGE_TOKEN|authorization/i.test(next)) {
      skipped.push({ target: "hermes", reason: "refused to write a bearer token" });
    } else {
      input.io.mkdirp(dirnameOf(hermesPath));
      input.io.writeFile(hermesPath, next.endsWith("\n") ? next : `${next}\n`);
      written.push({ target: "hermes", path: hermesPath, how: "file" });
    }
  } catch (error) {
    skipped.push({
      target: "hermes",
      reason: error instanceof Error ? error.message : "could not write config.yaml",
    });
  }

  return { ok: written.length > 0, written, skipped };
}

export function installReportMessage(report: InstallReport): string {
  if (report.written.length === 0) {
    return report.skipped[0]?.reason || "Could not write OpenClaw or Hermes config.";
  }
  const names = report.written.map((item) => (item.target === "openclaw" ? "OpenClaw" : "Hermes")).join(" and ");
  return `Wrote the Workhorse MCP into ${names}. They launch this app’s helper. No token stored.`;
}

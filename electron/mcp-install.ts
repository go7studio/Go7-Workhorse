import type { McpServerConfig } from "../src/lib/types";
import { LINK_HOSTS, LINK_HOST_LABEL, linkGenericMcpConfig, linkHostCliArgs, type LinkHost } from "../src/lib/workhorse-link";

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
  /**
   * Which harness this config is for, when the desk can name it. It lets a
   * wave row say OpenClaw instead of the generic word. Hosts with no name of
   * their own carry none rather than a guess.
   */
  origin?: "openclaw" | "hermes";
}): ExternalMcpLaunch {
  return {
    command: input.command,
    args: [input.script],
    env: {
      WORKHORSE_MCP_PROFILE: "external-runtime",
      ...(input.origin ? { WORKHORSE_MCP_ORIGIN: input.origin } : {}),
      WORKHORSE_STATE_PATH: input.statePath,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

export function workhorseExternalMcpServer(input: {
  command: string;
  script: string;
  statePath: string;
  origin?: "openclaw" | "hermes";
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
  written: Array<{ target: LinkHost; path: string; how: "file" | "cli" }>;
  skipped: Array<{ target: LinkHost; reason: string }>;
};

function dirnameOf(file: string): string {
  const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return cut <= 0 ? file : file.slice(0, cut);
}

export type InstallLinkInput = {
  home: string;
  platform: "darwin" | "win32" | "linux";
  command: string;
  script: string;
  statePath: string;
  io: InstallIo;
  /** Which hosts to connect. Default: every host Link knows. */
  hosts?: LinkHost[];
};

/**
 * The generic configuration, for any MCP client Link has no writer for.
 * Same launch as every host gets; a new harness connects from this without
 * a Workhorse release.
 */
export function workhorseLinkGenericConfig(input: { command: string; script: string; statePath: string }): string {
  return linkGenericMcpConfig(workhorseExternalMcpServer(input));
}

/**
 * Connect a host that has its own `mcp add`. Its file format stays its
 * business; we only hand it the same launch. Exact flags are in
 * linkHostCliArgs, verified against each CLI's help.
 */
function connectViaHostCli(
  host: Exclude<LinkHost, "openclaw" | "hermes">,
  server: McpServerConfig,
  io: InstallIo,
  written: InstallReport["written"],
  skipped: InstallReport["skipped"],
): void {
  if (!io.exec) {
    skipped.push({ target: host, reason: `${host} needs its CLI to write the config, and none is available here` });
    return;
  }
  const { command, args } = linkHostCliArgs(host, server);
  const result = io.exec(command, args);
  if (result.status === 0) {
    written.push({ target: host, path: `${command} mcp`, how: "cli" });
    return;
  }
  const detail = `${result.stderr || result.stdout}`.trim().split("\n")[0] ?? "";
  skipped.push({
    target: host,
    reason: result.status === 127 || /not found|ENOENT/i.test(detail) ? `${host} is not installed (no \`${command}\` on PATH)` : `\`${command} mcp add\` failed: ${detail || `exit ${result.status}`}`,
  });
}

/** The original call: OpenClaw and Hermes, as it always did. Other hosts go through installWorkhorseLink. */
export function installWorkhorseExternalMcp(input: Omit<InstallLinkInput, "hosts">): InstallReport {
  return installWorkhorseLink({ ...input, hosts: ["openclaw", "hermes"] });
}

export function installWorkhorseLink(input: InstallLinkInput): InstallReport {
  const launch = workhorseExternalMcpLaunch({ ...input, origin: "openclaw" });
  const hermesLaunch = workhorseExternalMcpLaunch({ ...input, origin: "hermes" });
  const server = workhorseExternalMcpServer(input);
  const hosts = new Set<LinkHost>(input.hosts?.length ? input.hosts : LINK_HOSTS);
  const written: InstallReport["written"] = [];
  const skipped: InstallReport["skipped"] = [];

  for (const host of ["codex", "claude", "grok"] as const) {
    if (hosts.has(host)) connectViaHostCli(host, server, input.io, written, skipped);
  }
  if (!hosts.has("openclaw") && !hosts.has("hermes")) return { ok: written.length > 0, written, skipped };

  const openclawPath = openClawConfigPath(input.home, input.platform);
  let openclawDone = !hosts.has("openclaw");
  if (hosts.has("openclaw") && input.io.exec) {
    const result = input.io.exec("openclaw", ["mcp", "set", WORKHORSE_MCP_NAME, openClawMcpSetJson(launch)]);
    if (result.status === 0) {
      written.push({ target: "openclaw", path: openclawPath, how: "cli" });
      openclawDone = true;
    }
  }
  if (!openclawDone && hosts.has("openclaw")) {
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
  if (!hosts.has("hermes")) {
    /* not asked */
  } else if (!input.io.existsSync(hermesPath) && !input.io.existsSync(hermesHome)) {
    skipped.push({ target: "hermes", reason: "Hermes is not installed (no ~/.hermes)" });
  } else try {
    const current = input.io.existsSync(hermesPath) ? input.io.readFile(hermesPath) : "";
    const next = upsertHermesMcpServers(current, hermesLaunch);
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
  const name = (target: LinkHost) => LINK_HOST_LABEL[target];
  if (report.written.length === 0) {
    return report.skipped[0]?.reason || "Could not connect any host.";
  }
  const names = report.written.map((item) => name(item.target));
  const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const missed = report.skipped.length ? ` ${report.skipped.map((item) => `${name(item.target)}: ${item.reason}`).join(" · ")}` : "";
  return `Connected ${list} to Workhorse Link. ${names.length === 1 ? "It launches" : "They launch"} this app’s helper. No token stored.${missed}`;
}

/**
 * The `workhorse` command: a launcher that runs the packaged helper's Link CLI
 * with the same three variables every host config carries. Written into the
 * app's own data folder with the exact paths baked in, so it is right for
 * this install and regenerated on every Install.
 */
export function linkCliLauncherScript(platform: "darwin" | "win32" | "linux", launch: ExternalMcpLaunch): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  if (platform === "win32") {
    const sets = Object.entries(launch.env).map(([key, value]) => `set "${key}=${value}"`).join("\r\n");
    return `@echo off\r\n${sets}\r\n"${launch.command}" ${launch.args.map((arg) => `"${arg}"`).join(" ")} link %*\r\n`;
  }
  const exports = Object.entries(launch.env).map(([key, value]) => `export ${key}=${q(value)}`).join("\n");
  return `#!/bin/sh\n# Go7 Workhorse Link CLI. Written by the app; re-install from Settings after an update.\n${exports}\nexec ${q(launch.command)} ${launch.args.map(q).join(" ")} link "$@"\n`;
}

export type InstallCommandReport = {
  ok: boolean;
  launcher: string;
  /** Where the short name landed, when it did. */
  linked?: string;
  message: string;
};

/**
 * Put `workhorse` on PATH. macOS and Linux: a symlink into the first of the
 * usual bin folders that this user can write — no privilege prompt from the
 * app; when none is writable the report carries the one `ln -s` to run.
 * Windows: the launcher is written and its folder named; PATH is the user's
 * to change, and the report says so rather than editing it.
 */
export function installLinkCommand(input: {
  platform: "darwin" | "win32" | "linux";
  dataDir: string;
  launch: ExternalMcpLaunch;
  io: InstallIo & { symlink?: (target: string, linkPath: string) => void; writable?: (dir: string) => boolean; unlink?: (path: string) => void };
}): InstallCommandReport {
  const name = input.platform === "win32" ? "workhorse.cmd" : "workhorse";
  const binDir = `${input.dataDir.replace(/[\\/]+$/, "")}${input.platform === "win32" ? "\\" : "/"}bin`;
  const launcher = `${binDir}${input.platform === "win32" ? "\\" : "/"}${name}`;
  input.io.mkdirp(binDir);
  input.io.writeFile(launcher, linkCliLauncherScript(input.platform, input.launch));
  if (input.platform === "win32") {
    return { ok: true, launcher, message: `Wrote ${launcher}. Add ${binDir} to your PATH to run \`workhorse\` from any shell.` };
  }
  const candidates = ["/usr/local/bin", "/opt/homebrew/bin"];
  for (const dir of candidates) {
    if (!input.io.existsSync(dir) || !(input.io.writable?.(dir) ?? false)) continue;
    const linkPath = `${dir}/workhorse`;
    try {
      if (input.io.existsSync(linkPath)) input.io.unlink?.(linkPath);
      input.io.symlink?.(launcher, linkPath);
      return { ok: true, launcher, linked: linkPath, message: `\`workhorse\` is on your PATH at ${linkPath}. Try \`workhorse capabilities\`.` };
    } catch {
      /* try the next folder */
    }
  }
  return {
    ok: true,
    launcher,
    message: `Wrote ${launcher}. No bin folder here is writable without sudo; to put it on PATH run: sudo ln -sf ${q(launcher)} /usr/local/bin/workhorse`,
  };
}

function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

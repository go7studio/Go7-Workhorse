import type { McpServerConfig } from "./types";

/**
 * Cursor writes `${env:NAME}` into mcp.json and expands it itself.
 * Grok's Cursor import passes that text through, and a relative leftover is
 * joined to the chat folder, so Python never opens the script. Workhorse
 * expands the same tokens before it hands the server to an agent.
 */
export type McpPlaceholderContext = {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  cwd?: string;
  platform: "win32" | "darwin" | "linux";
};

export type ForeignMcpSkip = { name: string; reason: string };

export type MaterializedCursorMcp = {
  servers: McpServerConfig[];
  skipped: ForeignMcpSkip[];
  /** True when every entry is a local process Workhorse can launch itself. */
  ownsImport: boolean;
};

const TOKEN = /\$\{([^}]+)\}/g;
const WINDOWS_ENV = /%([A-Za-z_][A-Za-z0-9_]*)%/g;

function separator(platform: McpPlaceholderContext["platform"]): string {
  return platform === "win32" ? "\\" : "/";
}

function envValue(env: McpPlaceholderContext["env"], name: string, platform: McpPlaceholderContext["platform"]): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, name) && typeof env[name] === "string") return env[name];
  if (platform !== "win32") return undefined;
  const hit = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return hit && typeof env[hit] === "string" ? env[hit] : undefined;
}

function homeOf(context: McpPlaceholderContext): string | undefined {
  return envValue(context.env, "USERPROFILE", context.platform)
    ?? envValue(context.env, "HOME", context.platform)
    ?? (context.home.trim() || undefined);
}

/** Replace one Cursor/Grok placeholder. Unknown tokens stay so the caller can refuse the launch. */
function replaceToken(body: string, context: McpPlaceholderContext): { text?: string; unresolved?: string } {
  const token = body.trim();
  if (token === "userHome") {
    const home = homeOf(context);
    return home ? { text: home } : { unresolved: token };
  }
  if (token === "workspaceFolder") {
    const cwd = context.cwd?.trim();
    return cwd ? { text: cwd } : { unresolved: token };
  }
  if (token === "workspaceFolderBasename") {
    const cwd = context.cwd?.trim();
    if (!cwd) return { unresolved: token };
    const cut = Math.max(cwd.lastIndexOf("/"), cwd.lastIndexOf("\\"));
    return { text: cut >= 0 ? cwd.slice(cut + 1) : cwd };
  }
  if (token === "pathSeparator" || token === "/") return { text: separator(context.platform) };
  const envName = token.startsWith("env:") ? token.slice(4).trim() : token;
  if (!envName || /[^\w.-]/.test(envName)) return { unresolved: token };
  const value = envValue(context.env, envName, context.platform);
  return value !== undefined ? { text: value } : { unresolved: token };
}

export function expandMcpText(value: string, context: McpPlaceholderContext): { text: string; unresolved: string[] } {
  let text = value;
  const unresolved: string[] = [];
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    text = text.replace(TOKEN, (whole, body: string) => {
      const replaced = replaceToken(body, context);
      if (replaced.unresolved) {
        unresolved.push(replaced.unresolved);
        return whole;
      }
      return replaced.text ?? whole;
    });
    if (context.platform === "win32") {
      text = text.replace(WINDOWS_ENV, (whole, name: string) => {
        const value = envValue(context.env, name, context.platform);
        return value !== undefined ? value : whole;
      });
    }
    if (text === before) break;
  }
  const home = homeOf(context);
  if (home && (text === "~" || text.startsWith("~/") || text.startsWith("~\\"))) {
    const rest = text.slice(1).replace(/^[\\/]+/, "");
    const root = home.replace(/[\\/]+$/, "");
    text = rest ? `${root}${separator(context.platform)}${rest}` : root;
  }
  return { text, unresolved: [...new Set(unresolved)] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function serverTable(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.mcpServers)) return raw.mcpServers;
  return raw;
}

function expandField(value: string, context: McpPlaceholderContext, unresolved: string[]): string {
  const expanded = expandMcpText(value, context);
  unresolved.push(...expanded.unresolved);
  return expanded.text;
}

/**
 * Turn one Cursor mcp.json document into launch rows with real paths.
 * A server that still contains a placeholder is omitted. A remote row means
 * Workhorse does not take over the file, because Grok would still need it.
 */
export function materializeCursorMcpDocument(raw: unknown, context: McpPlaceholderContext): MaterializedCursorMcp {
  const table = serverTable(raw);
  if (!table) return { servers: [], skipped: [], ownsImport: false };
  const servers: McpServerConfig[] = [];
  const skipped: ForeignMcpSkip[] = [];
  let remote = false;
  for (const [key, value] of Object.entries(table)) {
    const name = key.trim();
    if (!name || !isRecord(value)) continue;
    if (value.disabled === true || value.enabled === false) {
      skipped.push({ name, reason: "disabled" });
      continue;
    }
    if (typeof value.command !== "string" || !value.command.trim()) {
      if (typeof value.url === "string" || value.type === "sse" || value.type === "http") {
        remote = true;
        skipped.push({ name, reason: "remote" });
      } else {
        skipped.push({ name, reason: "no command" });
      }
      continue;
    }
    const unresolved: string[] = [];
    const command = expandField(value.command, context, unresolved).trim();
    const args = Array.isArray(value.args)
      ? value.args.map((item) => expandField(String(item), context, unresolved))
      : [];
    const env: Record<string, string> = {};
    if (isRecord(value.env)) {
      for (const [envName, envRaw] of Object.entries(value.env)) {
        if (!envName.trim() || typeof envRaw !== "string") continue;
        env[envName] = expandField(envRaw, context, unresolved);
      }
    }
    const missing = [...new Set(unresolved)];
    if (!command || missing.length > 0) {
      skipped.push({ name, reason: missing.length > 0 ? `unresolved ${missing.join(", ")}` : "no command" });
      continue;
    }
    servers.push({
      name,
      command,
      args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
  }
  return { servers: remote ? [] : servers, skipped, ownsImport: !remote };
}

/** Desk rows win, including a disabled row the chat list already dropped. */
export function mergeDeskAndForeignMcp(
  desk: readonly McpServerConfig[] | undefined,
  foreign: readonly McpServerConfig[],
  claimedNames?: readonly string[],
): McpServerConfig[] {
  const claimed = new Set<string>();
  for (const name of claimedNames ?? []) {
    const trimmed = name.trim();
    if (trimmed) claimed.add(trimmed);
  }
  const out = [...(desk ?? [])];
  for (const server of out) claimed.add(server.name);
  for (const server of foreign) {
    if (claimed.has(server.name)) continue;
    claimed.add(server.name);
    out.push(server);
  }
  return out;
}

/** Names Grok already launches from config.toml. Handing them again starts a second process. */
export function grokMcpServerNames(toml: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of toml.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)/gm)) {
    const name = match[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { mcpToolAllowed } from "../src/lib/mcp-servers";
import type { McpProbeResult, McpServerConfig } from "../src/lib/types";
import type { CustomToolResult, CustomToolUse } from "./custom-tools";
import type { CustomHttpTool } from "./custom-http";
import { APP_VERSION } from "../src/lib/app-info";
import { spawnCwd } from "./spawn-cwd";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type McpListedTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

const SAFE_AMBIENT_ENV = new Set([
  "path", "home", "userprofile", "appdata", "localappdata", "systemroot", "windir", "pathext",
  "tmp", "temp", "tmpdir", "lang", "lc_all", "lc_ctype", "shell", "comspec",
  "xdg_config_home", "xdg_cache_home", "xdg_data_home",
]);

export function mcpSpawnEnvironment(
  config: Pick<McpServerConfig, "env">,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(ambient)) {
    const lower = name.toLowerCase();
    if (typeof value === "string" && (SAFE_AMBIENT_ENV.has(lower) || lower.startsWith("lc_"))) safe[name] = value;
  }
  return { ...safe, ...(config.env ?? {}) };
}

/** Windows package shims such as npx.cmd require cmd.exe; native executables do not. */
export function mcpNeedsWindowsShell(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = fs.existsSync,
): boolean {
  if (platform !== "win32") return false;
  const extension = path.win32.extname(command).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") return true;
  if (extension === ".exe" || extension === ".com") return false;
  const pathValue = env.Path ?? env.PATH ?? "";
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const folder of pathValue.split(";").filter(Boolean)) {
    for (const suffix of extensions) {
      const candidate = path.win32.join(folder.replace(/^"|"$/g, ""), `${command}${suffix}`);
      if (!exists(candidate)) continue;
      return suffix.toLowerCase() === ".cmd" || suffix.toLowerCase() === ".bat";
    }
  }
  return false;
}

function safeName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "tool";
}

export function mcpExposedToolName(server: string, tool: string): string {
  return `mcp__${safeName(server)}__${safeName(tool)}`.slice(0, 120);
}

export function mcpToolDefinition(server: string, tool: McpListedTool): CustomHttpTool {
  return {
    name: mcpExposedToolName(server, tool.name),
    description: `[${server}] ${tool.description?.trim() || tool.name}`,
    input_schema: tool.inputSchema && typeof tool.inputSchema === "object"
      ? tool.inputSchema
      : { type: "object", properties: {} },
  };
}

class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();

  constructor(private readonly config: McpServerConfig, private readonly cwd?: string) {}

  async start(): Promise<void> {
    if (this.child) return;
    const env = mcpSpawnEnvironment(this.config);
    const child = spawn(this.config.command, this.config.args ?? [], {
      env,
      ...(this.cwd ? { cwd: spawnCwd(this.cwd) } : {}),
      shell: mcpNeedsWindowsShell(this.config.command, env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(line));
    child.stderr.on("data", () => undefined);
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code) => this.failAll(new Error(`${this.config.name} MCP exited${code == null ? "" : ` (${code})`}`)));
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "go7-workhorse", version: APP_VERSION },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpListedTool[]> {
    await this.start();
    const result = await this.request("tools/list", {}) as { tools?: unknown };
    if (!Array.isArray(result?.tools)) return [];
    return result.tools.flatMap((item): McpListedTool[] => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.name !== "string" || !row.name.trim()) return [];
      return [{
        name: row.name.trim(),
        ...(typeof row.description === "string" ? { description: row.description } : {}),
        ...(row.inputSchema && typeof row.inputSchema === "object"
          ? { inputSchema: row.inputSchema as Record<string, unknown> }
          : {}),
      }];
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.start();
    return this.request("tools/call", { name, arguments: args });
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.failAll(new Error(`${this.config.name} MCP closed`));
    if (child && !child.killed) child.kill();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.config.name} MCP timed out during ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error(`${this.config.name} MCP is not running`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || `${this.config.name} MCP request failed`));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

type ToolRoute = { client: McpStdioClient; server: string; tool: string };

export class McpToolBridge {
  private clients: McpStdioClient[] = [];
  private routes = new Map<string, ToolRoute>();

  constructor(private readonly configs: McpServerConfig[], private readonly options: { cwd?: string } = {}) {}

  async tools(): Promise<CustomHttpTool[]> {
    const definitions: CustomHttpTool[] = [];
    for (const config of this.configs) {
      if (config.enabled === false) continue;
      if (!config.name?.trim() || !config.command?.trim()) continue;
      const client = new McpStdioClient(config, this.options.cwd);
      this.clients.push(client);
      try {
        const listed = await client.listTools();
        for (const tool of listed) {
          if (!mcpToolAllowed(config, tool.name)) continue;
          const definition = mcpToolDefinition(config.name, tool);
          let exposed = definition.name;
          let suffix = 2;
          while (this.routes.has(exposed)) exposed = `${definition.name}_${suffix++}`;
          definitions.push({ ...definition, name: exposed });
          this.routes.set(exposed, { client, server: config.name, tool: tool.name });
        }
      } catch {
        client.dispose();
      }
    }
    return definitions;
  }

  has(name: string): boolean {
    return this.routes.has(name);
  }

  async call(use: CustomToolUse): Promise<CustomToolResult> {
    const route = this.routes.get(use.name);
    if (!route) return { id: use.id, name: use.name, content: `Unknown MCP tool ${use.name}`, isError: true };
    try {
      const result = await route.client.callTool(route.tool, use.input ?? {});
      const row = result && typeof result === "object" ? result as { content?: unknown[]; isError?: boolean } : {};
      const content = Array.isArray(row.content)
        ? row.content.map((item) => {
            if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
              return (item as { text: string }).text;
            }
            return JSON.stringify(item);
          }).join("\n")
        : JSON.stringify(result);
      return {
        id: use.id,
        name: use.name,
        content: content || "(empty MCP result)",
        ...(row.isError ? { isError: true } : {}),
      };
    } catch (error) {
      return { id: use.id, name: use.name, content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  dispose(): void {
    for (const client of this.clients) client.dispose();
    this.clients = [];
    this.routes.clear();
  }
}

function redactProbeMessage(message: string, config: McpServerConfig): string {
  let safe = message;
  for (const value of Object.values(config.env ?? {})) {
    if (value.length > 0) safe = safe.split(value).join("<redacted>");
  }
  return safe.slice(0, 500);
}

export async function probeMcpServer(config: McpServerConfig): Promise<McpProbeResult> {
  if (!config.name?.trim() || !config.command?.trim()) {
    return { ok: false, message: "Name and command are required.", tools: [] };
  }
  const client = new McpStdioClient(config);
  try {
    const listed = await client.listTools();
    const tools = listed.map((tool) => tool.name).sort((left, right) => left.localeCompare(right));
    return {
      ok: true,
      message: tools.length === 1 ? "1 tool found." : `${tools.length} tools found.`,
      tools,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: redactProbeMessage(message || "MCP server did not respond.", config), tools: [] };
  } finally {
    client.dispose();
  }
}

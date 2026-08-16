import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { McpServerConfig } from "../src/lib/types";
import type { CustomToolResult, CustomToolUse } from "./custom-tools";
import type { CustomHttpTool } from "./custom-http";
import { APP_VERSION } from "../src/lib/app-info";

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

  constructor(private readonly config: McpServerConfig) {}

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
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

  constructor(private readonly configs: McpServerConfig[]) {}

  async tools(): Promise<CustomHttpTool[]> {
    const definitions: CustomHttpTool[] = [];
    for (const config of this.configs) {
      if (!config.name?.trim() || !config.command?.trim()) continue;
      const client = new McpStdioClient(config);
      this.clients.push(client);
      try {
        const listed = await client.listTools();
        for (const tool of listed) {
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

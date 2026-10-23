import { serversForChatPresets } from "./environment-presets";
import { mcpRuntimeIdForSession, mcpServersForSession, mcpToolAllowed } from "./mcp-servers";
import type { McpServerConfig, Session } from "./types";

export type McpObservedTool = { name: string; inputSchema?: Record<string, unknown> };
export type McpObservation = {
  checkedAt: number;
  ok: boolean;
  tools: McpObservedTool[];
  /** Only a client owned by this exact chat proves its connection. */
  connectedSessionIds: string[];
};

export type McpInventory = {
  version: 1;
  asOf: string;
  desk: "online" | "offline";
  scope: { sessionId?: string; runtimeId?: string };
  servers: Array<{
    name: string;
    configured: true;
    enabled: boolean;
    runtimeIds: string[] | "all";
    authorized: boolean | null;
    connection: "connected" | "unknown" | "offline";
    availability: "available" | "unavailable" | "unknown";
    catalog: "observed" | "stale" | "unknown";
    observedAt?: string;
    diagnostics: string[];
    tools: Array<McpObservedTool & { authorized: boolean | null; available: boolean | null }>;
  }>;
};

export const MCP_CATALOG_MAX_AGE_MS = 5 * 60 * 1000;

/** Schema structure only. Descriptions, defaults, examples, refs and enums may hold credentials or URLs. */
export function publicMcpSchema(value: unknown, depth = 0, forbidden: readonly string[] = []): Record<string, unknown> | undefined {
  if (depth > 8 || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
  if (typeof raw.type === "string" && types.has(raw.type)) out.type = raw.type;
  if (Array.isArray(raw.type)) out.type = raw.type.filter(type => typeof type === "string" && types.has(type));
  if (raw.properties && typeof raw.properties === "object" && !Array.isArray(raw.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(raw.properties).slice(0, 100)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/.test(name) || !publicMcpName(name, forbidden)) continue;
      const clean = publicMcpSchema(schema, depth + 1, forbidden);
      if (clean) Object.defineProperty(properties, name, { value: clean, enumerable: true });
    }
    out.properties = properties;
    if (Array.isArray(raw.required)) out.required = raw.required.filter(name => typeof name === "string" && Object.hasOwn(properties, name));
  }
  const items = publicMcpSchema(raw.items, depth + 1, forbidden);
  if (items) out.items = items;
  if (typeof raw.additionalProperties === "boolean") out.additionalProperties = raw.additionalProperties;
  return out;
}

function publicMcpName(name: string, forbidden: readonly string[]): boolean {
  return !forbidden.some(value => value && (value.length < 8 ? value === name : name.includes(value)));
}

function sensitiveArguments(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => {
    if (/^--?(?:api[-_]?key|key|token|secret|password|authorization|bearer)$/i.test(args[index - 1] ?? "")) return [arg];
    const assigned = /^--?(?:api[-_]?key|key|token|secret|password|authorization|bearer)=(.+)$/i.exec(arg);
    if (assigned) return [assigned[1]!];
    return /^(?:sk-|ghp_|gho_|Bearer\s)/i.test(arg) ? [arg] : [];
  });
}

/** No commands, arguments, environment values, credential ids, URLs or raw errors cross this projection. */
export function projectMcpInventory(input: {
  servers: readonly McpServerConfig[];
  session?: Pick<Session, "id" | "provider" | "customBotId" | "presets">;
  deskOnline: boolean;
  now?: number;
  observation?: (server: McpServerConfig) => McpObservation | undefined;
}): McpInventory {
  const now = input.now ?? Date.now();
  const scoped = input.session ? serversForChatPresets(input.servers, input.session.presets) : [...input.servers];
  const allowed = input.session ? new Set(mcpServersForSession(input.servers, input.session).map(server => server.name)) : null;
  return {
    version: 1,
    asOf: new Date(now).toISOString(),
    desk: input.deskOnline ? "online" : "offline",
    scope: input.session ? { sessionId: input.session.id, runtimeId: mcpRuntimeIdForSession(input.session) } : {},
    servers: scoped.map(server => {
      const forbidden = [...Object.values(server.env ?? {}), ...Object.values(server.envCredentialIds ?? {}), ...sensitiveArguments(server.args)];
      const enabled = server.enabled !== false;
      const authorized = allowed ? allowed.has(server.name) : null;
      const observed = input.deskOnline ? input.observation?.(server) : undefined;
      const fresh = observed && now - observed.checkedAt <= MCP_CATALOG_MAX_AGE_MS;
      const connected = Boolean(input.session?.provider === "custom" && observed?.connectedSessionIds.includes(input.session.id));
      const noTools = server.includeTools?.length === 0 || observed?.ok === true && !observed.tools.some(tool => mcpToolAllowed(server, tool.name));
      const unavailable = !input.deskOnline || !enabled || authorized === false || noTools;
      const diagnostics = [
        ...(!input.deskOnline ? ["desk_offline"] : []),
        ...(!enabled ? ["disabled"] : []),
        ...(authorized === false ? ["not_authorized_for_chat"] : []),
        ...(noTools ? ["no_authorized_tools"] : []),
        ...(!input.session ? ["chat_scope_required"] : []),
        ...(!observed ? ["not_observed"] : !observed.ok ? ["last_catalog_failed"] : !fresh ? ["catalog_stale"] : []),
      ];
      const names = observed?.ok ? observed.tools : (server.includeTools ?? []).map(name => ({ name }));
      return {
        name: publicMcpName(server.name, forbidden) ? server.name : "[redacted server name]",
        configured: true,
        enabled,
        runtimeIds: server.runtimeIds ? [...server.runtimeIds] : "all",
        authorized,
        connection: input.deskOnline ? connected ? "connected" : "unknown" : "offline",
        availability: unavailable ? "unavailable" : connected && fresh && observed?.ok ? "available" : "unknown",
        catalog: observed?.ok ? fresh ? "observed" : "stale" : "unknown",
        ...(observed ? { observedAt: new Date(observed.checkedAt).toISOString() } : {}),
        diagnostics,
        tools: names.filter(tool => /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,127}$/.test(tool.name) && publicMcpName(tool.name, forbidden)).slice(0, 500).map(tool => {
          const toolAuthorized = authorized === null ? null : authorized && mcpToolAllowed(server, tool.name);
          const schema = "inputSchema" in tool ? publicMcpSchema(tool.inputSchema, 0, forbidden) : undefined;
          return {
            name: tool.name,
            ...(schema ? { inputSchema: schema } : {}),
            authorized: toolAuthorized,
            available: unavailable || toolAuthorized === false ? false : connected && fresh && observed?.ok ? true : null,
          };
        }),
      };
    }),
  };
}

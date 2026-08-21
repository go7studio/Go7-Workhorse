/**
 * Workhorse Link — one way in for every outside harness.
 *
 * Codex, Claude Code, Grok, OpenClaw, Hermes and anything that speaks MCP
 * launch the same packaged helper and get the same small toolset. Nothing
 * here knows which harness is calling; the harness learns what it has from
 * `workhorse_capabilities` and never guesses. The internal profile name
 * stays `external-runtime` for the configs already written.
 */
import type { McpServerConfig } from "./types";

export const LINK_PROTOCOL_VERSION = 1;

/**
 * The contract. A harness may rely on these names across Workhorse versions.
 * `workers.follow_up` is `workhorse_continue_mission`: delegate does not take a
 * worker name, because which worker runs a task is Workhorse's routing, not
 * the harness's; a follow-up names the finished wave it continues instead.
 */
export const LINK_TOOLS = [
  "workhorse_capabilities",
  "workhorse_list_chats",
  "workhorse_read_chat",
  "workhorse_query_capacity",
  "workhorse_delegate",
  "workhorse_continue_mission",
  "workhorse_agent_status",
  "workhorse_ask_chat",
] as const;

export type LinkTool = (typeof LINK_TOOLS)[number];

export const LINK_CAPABILITIES = [
  "capacity.read",
  "chats.read",
  "workers.delegate",
  "workers.follow_up",
] as const;

export type LinkCapability = (typeof LINK_CAPABILITIES)[number];

/** Calls that change the desk. They carry the execution envelope. */
export const LINK_MUTATING_TOOLS = ["workhorse_delegate", "workhorse_continue_mission", "workhorse_ask_chat"] as const;

export type LinkHandshake = {
  protocolVersion: number;
  desk: "online" | "offline";
  capabilities: LinkCapability[];
  /** The tools this helper will answer. Absent names are not there to try. */
  tools: LinkTool[];
};

/** The first thing a harness asks. The answer is the contract, not a guess. */
export function linkHandshake(input: { deskOnline: boolean }): LinkHandshake {
  return {
    protocolVersion: LINK_PROTOCOL_VERSION,
    desk: input.deskOnline ? "online" : "offline",
    capabilities: [...LINK_CAPABILITIES],
    tools: [...LINK_TOOLS],
  };
}

export type LinkEnvelope = {
  fromSessionId?: string;
  traceId: string;
  idempotencyKey: string;
  /** Which of the three the caller sent; the rest Workhorse filled in. */
  supplied: Array<"fromSessionId" | "traceId" | "idempotencyKey">;
};

/**
 * Read the execution envelope off a call. A harness is meant to send all
 * three; Workhorse fills what is missing so the reply can say what it ran
 * under, and so a retry without a key is still a retry and not a duplicate
 * of nothing. Making them required would break harnesses that already call
 * `workhorse_delegate` with a trace id alone, which the live smoke test does.
 */
export function linkEnvelope(
  args: Record<string, unknown>,
  newId: (prefix: string) => string,
  ctxFrom?: string,
): LinkEnvelope {
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const supplied: LinkEnvelope["supplied"] = [];
  const fromSessionId = str(args.fromSessionId) ?? (ctxFrom?.trim() || undefined);
  if (str(args.fromSessionId)) supplied.push("fromSessionId");
  let traceId = str(args.traceId);
  if (traceId) supplied.push("traceId");
  else traceId = newId("trace");
  let idempotencyKey = str(args.idempotencyKey);
  if (idempotencyKey) supplied.push("idempotencyKey");
  else idempotencyKey = newId("idem");
  return { fromSessionId, traceId, idempotencyKey, supplied };
}

/**
 * Replies to a repeated idempotency key. A harness that retries after a
 * dropped connection gets the first answer back instead of a second worker.
 * Held per helper process for a bounded time; a key older than that is a
 * new request, which is the right failure when the first answer is gone.
 */
export class LinkReplayCache {
  private readonly seen = new Map<string, { at: number; text: string }>();
  constructor(private readonly ttlMs = 10 * 60 * 1000, private readonly now: () => number = () => Date.now()) {}
  get(key: string): string | undefined {
    const hit = this.seen.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.seen.delete(key);
      return undefined;
    }
    return hit.text;
  }
  put(key: string, text: string): void {
    this.seen.set(key, { at: this.now(), text });
    if (this.seen.size > 500) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.seen.delete(oldest[0]);
    }
  }
}

/**
 * The generic MCP configuration — the same launch every host gets, in the
 * shape most MCP clients read. A future harness connects from this without
 * a Workhorse release.
 */
export function linkGenericMcpConfig(server: McpServerConfig): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        [server.name]: {
          command: server.command,
          args: server.args,
          ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
        },
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * The chat a harness pointed at, as the land rule reads it. Only these four
 * facts decide where an objective goes.
 */
export type LinkMissionChat = {
  id: string;
  /** Set on a worker, and on any chat nested under another. */
  parentId?: string;
  projectId?: string | null;
  /** `external-runtime` marks a chat this rule already landed a mission on. */
  joinOwner?: "desk" | "external-runtime";
};

export type LinkMissionLanding =
  | { kind: "reuse"; sessionId: string; projectId: string | null }
  | { kind: "new"; projectId: string | null; liftedFrom?: string };

/**
 * Where an inbound objective lands.
 *
 * A harness sends a whole objective, not a line into a chat someone is sitting
 * in. So it gets its own top-level chat, named from the work, and its workers
 * nest under that one: project → mission chat → workers, and no deeper.
 *
 * Attaching to whatever chat the caller last held is what produced a chat
 * called "Workhorse Desk Bots…" hosting an unrelated analytics repair, and the
 * sidebar then took a worker's name off the person who chose that title.
 *
 * Only a chat this rule already landed on — top-level, harness-owned lineup —
 * is reused, and only for the same target project, so follow-up slices of one
 * objective stay together. Everything else lifts: an ordinary desk chat, a
 * worker, or a nested chat keeps its own name and gives up its project, which
 * is also the depth cap — a worker never ends up parented under a worker.
 */
export function linkMissionLanding(input: {
  from?: LinkMissionChat;
  /** Project the call named, already resolved to a live id. */
  namedProjectId?: string | null;
  /** Settings → LLMs inbound parent, when it is a project. */
  inboundProjectId?: string | null;
}): LinkMissionLanding {
  const named = input.namedProjectId?.trim() || "";
  const from = input.from;
  const fromProject = from?.projectId?.trim() || "";
  if (from && !from.parentId && from.joinOwner === "external-runtime" && (!named || named === fromProject)) {
    return { kind: "reuse", sessionId: from.id, projectId: fromProject || null };
  }
  const projectId = named || fromProject || input.inboundProjectId?.trim() || "";
  return { kind: "new", projectId: projectId || null, ...(from ? { liftedFrom: from.id } : {}) };
}

export type LinkHost = "codex" | "claude" | "grok" | "openclaw" | "hermes";

export const LINK_HOSTS: LinkHost[] = ["codex", "claude", "grok", "openclaw", "hermes"];

export const LINK_HOST_LABEL: Record<LinkHost, string> = {
  codex: "Codex",
  claude: "Claude",
  grok: "Grok",
  openclaw: "OpenClaw",
  hermes: "Hermes",
};

/**
 * The `mcp add` invocation for hosts that have one, each verified on a real
 * install on 2026-08-19. Writing through the host's own CLI keeps its file
 * format its business. `-s user` where the host scopes, so the link is
 * there in every project, not the one the desk happened to be in.
 */
export function linkHostCliArgs(host: Exclude<LinkHost, "openclaw" | "hermes">, server: McpServerConfig): { command: string; args: string[] } {
  const env = Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`);
  if (host === "claude") {
    // claude mcp add [options] <name> <commandOrUrl> [args...]  ·  -e KEY=value  ·  -s user
    return { command: "claude", args: ["mcp", "add", "-s", "user", ...env.flatMap((pair) => ["-e", pair]), server.name, "--", server.command, ...server.args] };
  }
  if (host === "codex") {
    // codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)  ·  --env KEY=VALUE
    return { command: "codex", args: ["mcp", "add", ...env.flatMap((pair) => ["--env", pair]), server.name, "--", server.command, ...server.args] };
  }
  // grok mcp add [OPTIONS] <NAME> [COMMAND_OR_URL] [ARGS]...  ·  -e KEY=value  ·  -s user (~/.grok/config.toml)
  return { command: "grok", args: ["mcp", "add", "-s", "user", ...env.flatMap((pair) => ["-e", pair]), server.name, server.command, ...server.args] };
}

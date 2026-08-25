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
import type {
  LocalCapabilityContinuationContract,
  LocalCapabilityInvocationContract,
} from "./local-capability-contract";

export const LINK_PROTOCOL_VERSION = 2;

/**
 * The contract. A harness may rely on these names across Workhorse versions.
 * `workers.follow_up` is `workhorse_continue_mission`: delegate does not take a
 * worker name, because which worker runs a task is Workhorse's routing, not
 * the harness's; a follow-up names the finished wave it continues instead.
 */
export const LINK_BASE_TOOLS = [
  "workhorse_capabilities",
  "workhorse_list_chats",
  "workhorse_read_chat",
  "workhorse_query_capacity",
  "workhorse_delegate",
  "workhorse_continue_mission",
  "workhorse_agent_status",
  "workhorse_ask_chat",
] as const;

/**
 * Local execution is an optional Link extension. These are stable protocol
 * names, not a promise that a particular helper will advertise them: the
 * live host registry and its grants decide that at tools/list time.
 */
export const LINK_LOCAL_TOOLS = [
  "workhorse_local_hosts",
  "workhorse_local_capabilities",
  "workhorse_local_upload",
  "workhorse_local_invoke",
  "workhorse_local_chat",
  "workhorse_local_generate_3d",
  "workhorse_local_job",
  "workhorse_local_cancel",
  "workhorse_local_artifact",
  "workhorse_local_materialize",
  "workhorse_local_continue",
] as const;

export const LINK_TOOLS = [...LINK_BASE_TOOLS, ...LINK_LOCAL_TOOLS] as const;

export type LinkTool = (typeof LINK_TOOLS)[number];

export const LINK_BASE_CAPABILITIES = [
  "capacity.read",
  "chats.read",
  "workers.delegate",
  "workers.follow_up",
] as const;

export const LINK_LOCAL_CAPABILITIES = [
  "local.hosts.read",
  "local.capabilities.read",
  "local.jobs.submit",
  "local.jobs.read",
  "local.jobs.cancel",
  "local.artifacts.transfer",
  "local.continuations.dispatch",
] as const;

export const LINK_CAPABILITIES = [...LINK_BASE_CAPABILITIES, ...LINK_LOCAL_CAPABILITIES] as const;

export type LinkCapability = (typeof LINK_CAPABILITIES)[number];

/** One discoverable tool proves each public Link capability is actually usable. */
export const LINK_CAPABILITY_TOOL_REQUIREMENT: Readonly<Record<LinkCapability, LinkTool>> = {
  "capacity.read": "workhorse_query_capacity",
  "chats.read": "workhorse_read_chat",
  "workers.delegate": "workhorse_delegate",
  "workers.follow_up": "workhorse_continue_mission",
  "local.hosts.read": "workhorse_local_hosts",
  "local.capabilities.read": "workhorse_local_capabilities",
  "local.jobs.submit": "workhorse_local_invoke",
  "local.jobs.read": "workhorse_local_job",
  "local.jobs.cancel": "workhorse_local_cancel",
  "local.artifacts.transfer": "workhorse_local_materialize",
  "local.continuations.dispatch": "workhorse_local_continue",
};

/** Calls that change the desk. They carry the execution envelope. */
export const LINK_MUTATING_TOOLS = [
  "workhorse_delegate",
  "workhorse_continue_mission",
  "workhorse_ask_chat",
  "workhorse_local_upload",
  "workhorse_local_invoke",
  "workhorse_local_chat",
  "workhorse_local_generate_3d",
  "workhorse_local_cancel",
  "workhorse_local_materialize",
  "workhorse_local_continue",
] as const;

export const LINK_FOLLOW_THROUGH = {
  newSlice: "workhorse_delegate",
  namedWorker: "workhorse_ask_chat",
  later: "workhorse_agent_status",
} as const;

export type LinkHandshake = {
  protocolVersion: number;
  desk: "online" | "offline";
  capabilities: LinkCapability[];
  /** The tools this helper will answer. Absent names are not there to try. */
  tools: LinkTool[];
  followThrough: typeof LINK_FOLLOW_THROUGH;
  local?: {
    /** Only healthy hosts authorized for this caller are present. */
    hosts: Array<{
      id: string;
      label: string;
      brokerId: string;
      brokerVersion: string;
      capabilities: Array<{
        id: string;
        profileId: string;
        description: string;
        inputKinds: string[];
        outputRoles: string[];
        invocation?: LocalCapabilityInvocationContract;
        continuations: LocalCapabilityContinuationContract[];
        estimatedMemoryGb: number;
        asynchronous: true;
      }>;
    }>;
  };
};

/** The first thing a harness asks. The answer is the contract, not a guess. */
export function linkHandshake(input: {
  deskOnline: boolean;
  local?: {
    tools: readonly (typeof LINK_LOCAL_TOOLS)[number][];
    hosts: NonNullable<LinkHandshake["local"]>["hosts"];
  };
}): LinkHandshake {
  const hasLocal = Boolean(input.local?.hosts.length);
  return {
    protocolVersion: LINK_PROTOCOL_VERSION,
    desk: input.deskOnline ? "online" : "offline",
    capabilities: [
      ...LINK_BASE_CAPABILITIES,
      ...(hasLocal ? LINK_LOCAL_CAPABILITIES : []),
    ],
    tools: [...LINK_BASE_TOOLS, ...(hasLocal ? input.local!.tools : [])],
    followThrough: { ...LINK_FOLLOW_THROUGH },
    ...(hasLocal ? { local: { hosts: input.local!.hosts } } : {}),
  };
}

/**
 * Default Link chat list: one compact object per row, no pretty-print, no
 * preview. Hosts clip tool output at 20–64 KB; 160-char previews blow that.
 * `full` restores the catalog row. `parents` drops workers (rows with a parent).
 */
export type LinkChatListRow = {
  id: string;
  title: string;
  worker?: string;
  parentId?: string;
  status: string;
  next?: string;
  project?: string | null;
};

export function formatLinkChatList(
  rows: Array<{
    id: string;
    title: string;
    worker?: string;
    parentId?: string;
    status: string;
    next?: string;
    projectName?: string | null;
  }>,
  opts?: { full?: boolean; parents?: boolean },
): string {
  const listed = opts?.parents ? rows.filter((row) => !row.parentId) : rows;
  if (opts?.full) return JSON.stringify(listed);
  const compact: LinkChatListRow[] = listed.map((row) => ({
    id: row.id,
    title: row.title,
    ...(row.worker ? { worker: row.worker } : {}),
    ...(row.parentId ? { parentId: row.parentId } : {}),
    status: row.status,
    ...(row.next ? { next: row.next } : {}),
    ...(row.projectName ? { project: row.projectName } : {}),
  }));
  return JSON.stringify(compact);
}

/** Worker session id from a delegate/spawn reply. Names are not ids. */
export function linkWorkerIdFromReply(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const id = parsed.childSessionId;
    if (typeof id === "string" && id.trim()) return id.trim();
  } catch {
    /* plain text */
  }
  return undefined;
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
  private readonly seen = new Map<string, { at: number; fingerprint: string; text: string }>();
  constructor(private readonly ttlMs = 10 * 60 * 1000, private readonly now: () => number = () => Date.now()) {}
  get(key: string, fingerprint = ""): string | undefined {
    const hit = this.seen.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.seen.delete(key);
      return undefined;
    }
    if (hit.fingerprint !== fingerprint) throw new Error("idempotency_key_conflict");
    return hit.text;
  }
  put(key: string, text: string, fingerprint = ""): void {
    const hit = this.seen.get(key);
    if (hit && this.now() - hit.at <= this.ttlMs && hit.fingerprint !== fingerprint) {
      throw new Error("idempotency_key_conflict");
    }
    this.seen.set(key, { at: this.now(), fingerprint, text });
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

export type LinkDeskPlatform = "darwin" | "win32" | "linux";

export type LinkGrokBotOneshotOptions = {
  cli?: string;
  platform?: LinkDeskPlatform;
  userData?: string;
};

function grokBotDeskLabel(platform: LinkDeskPlatform): string {
  if (platform === "win32") return "Windows PC";
  if (platform === "linux") return "Linux machine";
  return "Mac";
}

function grokBotUserData(platform: LinkDeskPlatform, userData?: string): string {
  if (userData?.trim()) return userData.replace(/[\\/]+$/, "");
  if (platform === "win32") return "%APPDATA%\\Go7 Workhorse";
  if (platform === "linux") return "~/.config/Go7 Workhorse";
  return "~/Library/Application Support/Go7 Workhorse";
}

function grokBotJoin(platform: LinkDeskPlatform, root: string, name: string): string {
  const sep = platform === "win32" ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${name}`;
}

/**
 * One-shot Grok Bot install. Paste into Grok Bot once. The charge is the same
 * Link launch every other host gets. Grok Bot must save it in permanent agent
 * memory (not the remote box scratch disk). Works on Mac and Windows. No bearer token.
 */
export function linkGrokBotOneshot(server: McpServerConfig, options: LinkGrokBotOneshotOptions | string = {}): string {
  const opts: LinkGrokBotOneshotOptions = typeof options === "string" ? { cli: options } : options;
  const platform = opts.platform ?? "darwin";
  const cli = opts.cli ?? (platform === "win32" ? "workhorse.cmd" : "workhorse");
  const desk = grokBotDeskLabel(platform);
  const userData = grokBotUserData(platform, opts.userData);
  const bridge = grokBotJoin(platform, userData, "workhorse-bridge.json");
  const wake = grokBotJoin(platform, userData, "grok-bot-wake.json");
  const leftover = grokBotJoin(platform, userData, "grok-bot-leftover.json");
  const tools = LINK_TOOLS.join(", ");
  const mcp = linkGenericMcpConfig(server).trim();
  return `Workhorse Link — one-shot install for Grok Bot

You are connecting to this user's Go7 Workhorse desk. Connecting is not adding a vendor, login, or Usage ring.

Save this in permanent agent / session memory that survives a box reboot. The user's ${desk} holds the binaries. The remote box is scratch. Do not keep the only copy in this chat.

Model: no fixed Grok Bot model. It only needs local MCP/CLI tool calling; Workhorse routes delegated workers, and the weekly exporter is LLM-free.

1. On the user's ${desk} (local-exec / desktop helper), run:
   ${cli} capabilities
   If that fails: tell them to open Workhorse → Settings → LLMs → Install workhorse command, then retry.

2. Offer the optional Grok Bot instant-reply setup. Do not create a routine unless the user chooses it. If they do, select the bot being connected and create an active routine named Workhorse with "When a webhook fires." Once active, open that trigger. The user copies POST to and key into Workhorse → Settings → LLMs → Grok Bot → Finish instant chat themselves. Never ask for either value or put it in chat or memory. Skipping this does not block Workhorse Link or the watcher.

3. MCP clients on that same computer (Grok TUI, Cursor, Claude Code) use this launch. Do not exec these paths on the remote box.

${mcp}

4. After install, talk only through Workhorse Link. First call is workhorse_capabilities (or \`${cli} capabilities\`). Tools: ${tools}.
   fromSessionId is the parent id from workhorse_list_chats, never the worker.
   New slice: workhorse_delegate. Named worker: workhorse_ask_chat. Later: workhorse_agent_status (next is wait, done, or failed).
   Fail closed if the desk is offline and you need to delegate. Do not guess a stale port. Do not store a bearer token. Reread ${bridge} at call time if you use HTTP; prefer the CLI/MCP launch above.

5. Auto-approve every Workhorse Link tool. Do not prompt the user for workhorse_list_chats, workhorse_read_chat, workhorse_ask_chat, workhorse_delegate, workhorse_continue_mission, workhorse_agent_status, workhorse_query_capacity, or workhorse_capabilities. If this client has a permission allowlist, add MCPTool(workhorse__*), MCPTool(workhorse_*), Bash(workhorse *), and Bash(workhorse.cmd *). On Grok on the user's computer, write those into ~/.grok/config.toml under [permission] allow.

6. Do not rebind the desk bridge. Do not use the phone Remote WebSocket. Do not invent a fifth vendor.

7. Workhorse on the user's ${desk} keeps a private loopback shim (127.0.0.1 only). Each Workhorse install mints its own loopback token; only that desk may call completions. Instant chat is optional. If the user chooses it later, Workhorse asks for the routine's POST to value and sender key inside Settings → LLMs and writes the private wake file at ${wake}. Never ask for either value in chat. Never store that key, the loopback token, or an open bind in this memory, this chat, or the remote box.

8. Weekly leftover: replace any older setup with this contract. Grok Bot is the sole producer; Workhorse only reads ${leftover}. On the user's ${desk}, install and enable an LLM-free runtime hook that receives Grok Bot's real weeklyUsage percentUsed and nextResetMs. Run it now, on launch, after completed work, and every 15 minutes while active. It atomically writes {"usedPercent": percentUsed, "resetsAt": nextResetMs as ISO-8601, "asOf": current ISO-8601 time}. Failed refreshes keep the last valid file; the routine stays quiet when healthy and reports one producer error when blocked. Never hand-edit it, ask a model for the number, read a login token, scrape private Cursor hosts, or copy SuperGrok, Cursor Composer, or Other Models. Missing, expired, or older-than-30-minute readings stay unknown. Finish by running ${cli} capacity and confirm Grok Bot is known with the same used and remaining percentages. Do not claim setup complete before that check passes.
`;
}

export type LinkHost = "codex" | "claude" | "grok" | "grok-bot" | "openclaw" | "hermes";

export const LINK_HOSTS: LinkHost[] = ["codex", "claude", "grok", "grok-bot", "openclaw", "hermes"];

export const LINK_HOST_LABEL: Record<LinkHost, string> = {
  codex: "Codex",
  claude: "Claude",
  grok: "Grok",
  "grok-bot": "Grok Bot",
  openclaw: "OpenClaw",
  hermes: "Hermes",
};

/** Grok Bot has no `mcp add`. Connect copies the charged one-shot instead. */
export function linkHostConnectsByOneshot(host: LinkHost): boolean {
  return host === "grok-bot";
}

/**
 * The `mcp add` invocation for hosts that have one, each verified on a real
 * install on 2026-08-19. Writing through the host's own CLI keeps its file
 * format its business. `-s user` where the host scopes, so the link is
 * there in every project, not the one the desk happened to be in.
 */
export function linkHostCliArgs(host: Exclude<LinkHost, "openclaw" | "hermes" | "grok-bot">, server: McpServerConfig): { command: string; args: string[] } {
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

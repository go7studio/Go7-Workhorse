import fs from "node:fs";
import path from "node:path";
import {
  publicBotsFromState,
  publicDetectCard,
  runCustomBotSetup,
  type BotSetupInput,
  type PublicBotCard,
} from "../src/lib/bot-setup";
import { applyCreateWorkhorseProject, normalizeProject } from "../src/lib/project";
import { normalizeSettings } from "../src/lib/settings";
import type { CustomLlm, UsageEvent, WatchDayMarks, WatchPermits } from "../src/lib/types";
import {
  deskCallCatalog,
  formatDeskRoster,
  type WatchPlans,
} from "../src/lib/watch";
import { isVendorDeclinedResult, vendorDeclinedForBot } from "../src/lib/vendor-decline";
import { catalogSessions, findSession, sessionTranscript } from "../src/lib/session-bridge";
import {
  admitSpawn,
  deskRoleOf,
  isSpawnOnlyPrompt,
  nestedSpawnError,
  NESTED_AGENT_MODEL,
  shouldSpawnInsteadOfAsk,
  toolsForDeskRole,
  SPAWN_ONLY_PROMPT_ERROR,
} from "../src/lib/subagents";
import { detectCustomLogin } from "./custom-login";
import { probeCustomHttp } from "./custom-http";
import {
  askViaInbox,
  interpretPeerAskHttp,
  isRetryablePeerAskTransport,
  readBridgeRecord,
  type PeerAsk,
} from "./peer-inbox";
import { publicDeskSkills, readDeskSkill } from "./desk-export-host";
import { APP_VERSION } from "../src/lib/app-info";

type JsonRpc = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
};

export type McpFraming = "content-length" | "ndjson";

export type McpFrame = {
  message: JsonRpc;
  framing: McpFraming;
};

function readState(): {
  sessions?: unknown[];
  projects?: unknown[];
  settings?: unknown;
  usage?: UsageEvent[];
  deskPlans?: WatchPlans;
  watchPermits?: WatchPermits;
  watchDayMarks?: WatchDayMarks;
} {
  const dest = process.env.WORKHORSE_STATE_PATH;
  if (!dest) return {};
  try {
    return JSON.parse(fs.readFileSync(dest, "utf8")) as ReturnType<typeof readState>;
  } catch {
    return {};
  }
}

export function encodeMcpFrame(message: object, framing: McpFraming = "content-length"): string {
  const body = JSON.stringify(message);
  if (framing === "ndjson") return `${body}\n`;
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

export function consumeMcpBuffers(input: Buffer): { frames: McpFrame[]; rest: Buffer } {
  const frames: McpFrame[] = [];
  let rest = input;
  while (rest.length > 0) {
    if (rest[0] === 0x0a) {
      rest = rest.subarray(1);
      continue;
    }
    if (rest[0] === 0x0d && rest[1] === 0x0a) {
      rest = rest.subarray(2);
      continue;
    }
    const asText = rest.toString("utf8");
    if (/^content-length:/i.test(asText)) {
      const header = asText.match(/^Content-Length:\s*(\d+)\r?\n(?:[A-Za-z0-9-]+:[^\n]*\n)*\r?\n/i);
      if (!header) break;
      const headerBytes = Buffer.byteLength(header[0], "utf8");
      const length = Number(header[1]);
      if (rest.length < headerBytes + length) break;
      const raw = rest.subarray(headerBytes, headerBytes + length).toString("utf8");
      rest = rest.subarray(headerBytes + length);
      try {
        frames.push({ message: JSON.parse(raw) as JsonRpc, framing: "content-length" });
      } catch {
        // ignore a broken frame
      }
      continue;
    }
    if (rest[0] === 0x7b) {
      const newline = rest.indexOf(0x0a);
      if (newline < 0) break;
      const line = rest.subarray(0, newline).toString("utf8").replace(/\r$/, "").trim();
      rest = rest.subarray(newline + 1);
      if (!line) continue;
      try {
        frames.push({ message: JSON.parse(line) as JsonRpc, framing: "ndjson" });
      } catch {
        // ignore a broken frame
      }
      continue;
    }
    const newline = rest.indexOf(0x0a);
    if (newline < 0) break;
    rest = rest.subarray(newline + 1);
  }
  return { frames, rest };
}

export function consumeMcpFrames(buffer: string): { frames: McpFrame[]; rest: string } {
  const parsed = consumeMcpBuffers(Buffer.from(buffer, "utf8"));
  return { frames: parsed.frames, rest: parsed.rest.toString("utf8") };
}

const TOOLS = [
  {
    name: "workhorse_list_chats",
    description:
      "List live sidebar chats in this window (id, title, project, sidebar, preview). Archived and deleted chats are omitted. sidebar is the visible subtitle (model · effort · mode). preview is the last user/assistant snippet — that is what “the preview” means. Use this before reading or asking another chat.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "workhorse_read_chat",
    description:
      "Read another sidebar chat’s transcript. The user will see that you are reading that chat. Pass the visible title.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Session id or title" },
        limit: { type: "number", description: "Max messages from the end (default 40)" },
      },
      required: ["chat"],
    },
  },
  {
    name: "workhorse_ask_chat",
    description:
      "Ask an existing sidebar chat a question and return its reply. Talking to another live chat is always allowed and is not limited by this chat’s Permission or Sandbox. Pass the visible title.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Session id or title to ask" },
        message: { type: "string", description: "Question or request for that chat" },
      },
      required: ["chat", "message"],
    },
  },
  {
    name: "workhorse_spawn_agent",
    description:
      "Spawn another vendor in this conversation. If workhorse_list_bots said that vendor is not callable (Watch hold, turned off, or not attached), do not call this — it fails immediately and will not start Grok/Codex/Claude.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Full task for the subagent" },
        description: { type: "string", description: "Short 3–5 word label" },
        provider: { type: "string", description: "grok, codex, claude, or custom" },
        model: { type: "string", description: "Optional model id such as gpt-5.6-terra" },
        chat: { type: "string", description: "Optional existing chat or vendor name to copy (Codex, Terra, Test)" },
        effort: { type: "string", description: "Optional reasoning effort" },
        timeoutSeconds: { type: "number", description: "Optional 30-3600 second runtime limit" },
        tokenBudget: { type: "number", description: "Optional total token ceiling" },
        isolation: { type: "string", description: "worktree (default) or shared" },
        folder: { type: "string", description: "Optional absolute folder the worker must use as cwd" },
        wait: {
          type: "boolean",
          description: "true (default) wait for this worker. false start it and return so you can spawn more, then workhorse_await_agents.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "workhorse_await_agents",
    description:
      "Status of this chat’s worker lineup. Default returns immediately. wait=true only if the user asked you to sit until they finish. Never treat a timeout as a bot-setup failure.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutSeconds: { type: "number", description: "Optional 30-3600 second wait. Default 600." },
      },
    },
  },
  {
    name: "workhorse_list_bots",
    description:
      "List every attached desk bot (Grok, Codex, Claude, and custom slots) with leftover/Watch status. leftoverPercent is that vendor’s weekly plan remaining overall, not this prompt. Name every attached bot. Only refuse to spawn or ask one if the summary says it is not callable.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "workhorse_detect_custom",
    description:
      "Optional inspection of a custom HTTP draft already stored on this machine. Returns URL, model, and a key hint — never the full key. Does not create a desk slot. Prefer workhorse_setup_custom_bot with the user’s URL, model, and key.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "workhorse_setup_custom_bot",
    description:
      "The backend for adding another LLM. Creates a live desk slot (This chat → Vendor). Do not read Workhorse source or write adapters. Pass name, baseUrl, model, and apiKey from the user. If the slot already exists it returns alreadyOnDesk=true and howToUse. Never invent an API key. Do not import MiniMax or OpenClaw automatically.",
    inputSchema: {
      type: "object",
      properties: {
        importFrom: {
          type: "string",
          description: "none (default). Do not auto-import a vendor.",
        },
        name: { type: "string", description: "Desk name" },
        color: { type: "string", description: "Color name or #rrggbb (green, blue, orange, pink, purple, cyan, gold)" },
        baseUrl: { type: "string", description: "API base URL" },
        model: { type: "string", description: "Model id" },
        apiKey: { type: "string", description: "API key from the user. Required." },
        api: { type: "string", description: "anthropic-messages or openai-completions" },
        contextWindow: { type: "number", description: "Optional context window override" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "workhorse_list_projects",
    description:
      "List Workhorse projects (name, linked folders, chat count). Use this before and after creating a project. Do not tell the user a project exists unless it appears here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "workhorse_request_vendor",
    description:
      "Do not use this to unlock a spawn. If the daily bank is spent or canCall is false, that vendor is a no-go — skip it. Never ask the user to Allow a spawn.",
    inputSchema: {
      type: "object",
      properties: {
        vendor: { type: "string", description: "grok, codex, or claude" },
        reason: { type: "string", description: "Why you need that vendor" },
      },
      required: ["vendor"],
      additionalProperties: false,
    },
  },
  {
    name: "workhorse_request_permission",
    description:
      "Raise this chat’s Permission and/or Sandbox only when Plan or Read-only/Strict is blocking a write you must do now. Never use this to lower limits. A card appears above the composer. Wait for Elevate or Deny.",
    inputSchema: {
      type: "object",
      properties: {
        permission: { type: "string", description: "ask, accept-edits, or always-approve" },
        sandbox: { type: "string", description: "off or workspace" },
        reason: { type: "string", description: "Why you need the extra access" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "workhorse_create_project",
    description:
      "Create a Workhorse project (a named desk entry under Projects, not a file on disk). Pass the exact name and an existing absolute folder. This chat is placed in the new project automatically. Then call workhorse_list_projects and only report success if that name appears. Never invent a created project.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
        folder: { type: "string", description: "Optional absolute folder to link" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "workhorse_move_chat",
    description:
      "Move a chat into a project. Omit chat to move this chat. Pass the visible project name. Use when the user asks to put a chat in a project, attach this chat, or throw a chat into a project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name or id" },
        chat: { type: "string", description: "Optional chat title or id. Defaults to this chat." },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "workhorse_rename_chat",
    description:
      "Rename a live chat. Omit chat to rename this chat. Pass the new title in name. Do not delete and recreate.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "New chat title" },
        chat: { type: "string", description: "Optional exact title or id. Defaults to this chat." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "workhorse_rename_project",
    description:
      "Rename a Workhorse project in place. Omit project to rename this chat’s project. Pass the new name. Do not delete and recreate. Then call workhorse_list_projects. Only say the new name if Visible sidebar names include it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "New project name" },
        project: { type: "string", description: "Optional project name or id. Defaults to this chat’s project." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "workhorse_delete_chat",
    description:
      "Delete another live chat by exact title or id, or delete every loose chat (not in a project) with scope=loose. Never omit chat to delete yourself. A bulk “kill these” list must not delete this chat even if it says “this one”. scope=loose never deletes this chat and never touches project chats. onlyThis=true only when the user asked to delete this chat alone. Ambiguous titles (two chats named test) fail — pass the id.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Exact chat title or id of another chat." },
        scope: {
          type: "string",
          description: "loose — delete every chat that is not in a project, except this chat. Do not ask which ones.",
        },
        onlyThis: {
          type: "boolean",
          description: "true only if the user asked to delete this chat alone. Required to delete the calling chat.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "workhorse_delete_project",
    description:
      "Delete a Workhorse project. chats=keep (default) leaves its chats as loose chats; chats=remove deletes those chats too.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name or id" },
        chats: { type: "string", description: "keep (default) or remove" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "workhorse_list_references",
    description:
      "List this project’s References (URL, note, or file). Call this before adding a duplicate. Use when the user asks what is pinned on the project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Optional project name. Defaults to this chat’s project." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "workhorse_add_reference",
    description:
      "Pin a URL, note, or file on this chat’s project (Project home → References). Desk action, not a source-code change. Infer kind from the value if omitted: http(s) → url, a path → file, otherwise note.",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string", description: "URL, file path, or note text" },
        kind: { type: "string", description: "url, note, or file" },
        label: { type: "string", description: "Optional short name shown on the project" },
        project: { type: "string", description: "Optional project name. Defaults to this chat’s project." },
      },
      required: ["value"],
      additionalProperties: false,
    },
  },
  {
    name: "workhorse_delete_reference",
    description: "Remove a project reference by id, label, or value.",
    inputSchema: {
      type: "object",
      properties: {
        reference: { type: "string", description: "Reference id, label, or value" },
        project: { type: "string", description: "Optional project name" },
      },
      required: ["reference"],
      additionalProperties: false,
    },
  },
  {
    name: "workhorse_list_skills",
    description:
      "List desk skills from Grok, Codex, Claude, and Workhorse (name, origin, description). Call this before reading a skill. Skills are instruction folders — reading one does not run its scripts.",
    inputSchema: {
      type: "object",
      properties: { origin: { type: "string", description: "Optional filter: grok, codex, claude, or workhorse" } },
      additionalProperties: false,
    },
  },
  {
    name: "workhorse_read_skill",
    description:
      "Read one SKILL.md by name (or origin:name). Returns instructions only. If the skill needs files or shell, say so — a custom HTTP bot cannot run those scripts.",
    inputSchema: {
      type: "object",
      properties: { skill: { type: "string", description: "Skill name, or grok:pdf" } },
      required: ["skill"],
    },
  },
  {
    name: "workhorse_delete_bot",
    description: "Delete a custom desk slot by id or name.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Bot id or name" },
      },
      required: ["bot"],
    },
  },
];

type DeskAsk = (ask: PeerAsk) => Promise<{ text?: string; error?: string }>;
let deskAsk: DeskAsk | null = null;

/** When MiniMax tools run inside Electron main, skip HTTP-to-self and hit the live desk. */
export function setWorkhorseDeskAsk(handler: DeskAsk | null): void {
  deskAsk = handler;
}

async function postBridge(
  pathName: string,
  body: PeerAsk,
  opts?: { timeoutMs?: number; inbox?: boolean },
): Promise<string> {
  if (deskAsk) {
    const result = await deskAsk(body);
    if (result.error) throw new Error(result.error);
    if (typeof result.text === "string") return result.text;
    throw new Error("Workhorse desk returned no result");
  }
  const live = readBridgeRecord(process.env.WORKHORSE_STATE_PATH);
  const url = live?.url || process.env.WORKHORSE_BRIDGE_URL;
  const token = live?.token || process.env.WORKHORSE_BRIDGE_TOKEN;
  const timeoutMs =
    opts?.timeoutMs ??
    (body.action === "await-agents"
      ? body.wait === true
        ? Math.max(30, Math.min(3_600, body.timeoutSeconds ?? 600)) * 1_000
        : 15_000
      : body.mode === "bots"
        ? 45_000
        : 10 * 60 * 1000);
  const allowInbox = opts?.inbox !== false;
  if (url && token) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${url.replace(/\/$/, "")}${pathName}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;
        const outcome = interpretPeerAskHttp(response.status, payload);
        if (outcome.ok) return outcome.text;
        if (!outcome.retryable || !live?.inbox || !allowInbox) throw new Error(outcome.error);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (!allowInbox || !live?.inbox || !isRetryablePeerAskTransport(error)) throw error;
    }
  }
  if (!allowInbox || !live?.inbox) throw new Error("Workhorse bridge is not running");
  return askViaInbox(live.inbox, body, timeoutMs);
}

function formatProjectRows(rows: unknown): string {
  const list = Array.isArray(rows) ? rows : [];
  const named = list
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const row = item as { name?: string; folders?: string[] };
      if (!row.name) return "";
      const folder = Array.isArray(row.folders) && row.folders[0] ? ` · ${row.folders[0]}` : "";
      return `- ${row.name}${folder}`;
    })
    .filter(Boolean);
  return named.length === 0 ? "No Workhorse projects on this desk yet." : `Workhorse projects:\n${named.join("\n")}`;
}

export function parseRenameProjectLive(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    const requested = typeof parsed.requested === "string" ? parsed.requested.trim() : name;
    const rows = Array.isArray(parsed.projects) ? parsed.projects : [];
    const listed = rows
      .map((item) => (item && typeof item === "object" ? (item as { name?: string }).name : ""))
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    const visible =
      parsed.visibleOnDesk === true &&
      listed.some((item) => item.trim().toLowerCase() === requested.toLowerCase());
    if (parsed.ok === true && parsed.notified !== true && name && visible) {
      return {
        ...parsed,
        howToUse:
          typeof parsed.howToUse === "string" && parsed.howToUse.trim()
            ? parsed.howToUse
            : `Visible sidebar names: ${listed.join(", ")}. Call workhorse_list_projects. Only say the project is named “${name}” if that list shows it.`,
      };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export function parseCreateProjectLive(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.ok === true && typeof parsed.name === "string" && parsed.name.trim() && parsed.notified !== true) {
      return {
        ...parsed,
        howToUse:
          typeof parsed.howToUse === "string" && parsed.howToUse.trim()
            ? parsed.howToUse
            : `Project “${parsed.name}” is under Projects.${parsed.folder ? ` Linked folder: ${parsed.folder}.` : ""} Call workhorse_list_projects to confirm. Do not say it exists unless it appears there.`,
      };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function createWorkhorseProjectLocal(input: {
  name: string;
  folder?: string;
  fromSessionId?: string;
}): string {
  const dest = process.env.WORKHORSE_STATE_PATH?.trim();
  if (!dest) throw new Error("Workhorse state is not available");
  let full: Record<string, unknown> = {};
  try {
    full = JSON.parse(fs.readFileSync(dest, "utf8")) as Record<string, unknown>;
  } catch {
    full = {};
  }
  const projects = (Array.isArray(full.projects) ? full.projects : [])
    .map((item) => normalizeProject(item))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const sessions = (Array.isArray(full.sessions) ? full.sessions : []) as Array<{
    id: string;
    projectId?: string | null;
  }>;
  const applied = applyCreateWorkhorseProject(projects, sessions, input);
  const next = {
    ...full,
    projects: applied.projects,
    sessions: applied.sessions,
    activeProjectId: applied.activeProjectId,
    ...(applied.activeSessionId ? { activeSessionId: applied.activeSessionId } : {}),
  };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(next, null, 2), "utf8");
  return JSON.stringify(
    {
      ...applied.result,
      howToUse: `Project “${applied.result.name}” is under Projects.${
        applied.result.folder ? ` Linked folder: ${applied.result.folder}.` : ""
      } Call workhorse_list_projects to confirm. Do not say it exists unless that list shows this name.`,
    },
    null,
    2,
  );
}

function fromSessionId(override?: string): string {
  return override?.trim() || process.env.WORKHORSE_FROM_SESSION || "";
}

function botsAsk(
  partial: Omit<PeerAsk, "fromSessionId" | "toSessionId" | "message"> & { message?: string; fromSessionId?: string },
  from?: string,
): PeerAsk {
  return {
    toSessionId: "",
    message: partial.message || partial.action || "list",
    mode: "bots",
    ...partial,
    fromSessionId: fromSessionId(from) || partial.fromSessionId || "",
  };
}

async function listBots(from?: string): Promise<string> {
  try {
    const live = await postBridge("/bots", botsAsk({ action: "list", message: "list" }, from), {
      timeoutMs: 8_000,
      inbox: false,
    });
    const parsed = JSON.parse(live) as { bots?: unknown; summary?: string };
    if (Array.isArray(parsed.bots)) return formatDeskRoster(parsed.bots as Parameters<typeof formatDeskRoster>[0]);
    if (typeof parsed.summary === "string" && parsed.summary.trim()) return live;
  } catch {
    /* fall back to the last saved file */
  }
  return formatDeskRoster(deskRoster());
}

function setupInput(args: Record<string, unknown>): BotSetupInput {
  const importFrom =
    args.importFrom === "auto" || args.importFrom === "openclaw" || args.importFrom === "env" || args.importFrom === "none"
      ? args.importFrom
      : undefined;
  const api = args.api === "openai-completions" || args.api === "anthropic-messages" ? args.api : undefined;
  return {
    importFrom,
    name: typeof args.name === "string" ? args.name : undefined,
    color: typeof args.color === "string" ? args.color : undefined,
    baseUrl: typeof args.baseUrl === "string" ? args.baseUrl : undefined,
    model: typeof args.model === "string" ? args.model : undefined,
    apiKey: typeof args.apiKey === "string" ? args.apiKey : undefined,
    api,
    contextWindow: typeof args.contextWindow === "number" ? args.contextWindow : undefined,
  };
}

async function createDeskBot(draft: CustomLlm): Promise<PublicBotCard> {
  const text = await postBridge(
    "/bots",
    botsAsk({
      action: "create",
      message: "create",
      name: draft.name,
      color: draft.color,
      baseUrl: draft.baseUrl,
      model: draft.model,
      apiKey: draft.apiKey,
      api: draft.api,
      contextWindow: draft.contextWindow,
    }),
  );
  const parsed = JSON.parse(text) as { bot?: PublicBotCard; error?: string };
  if (!parsed.bot?.id) throw new Error(parsed.error || "Workhorse did not create the desk slot");
  return parsed.bot;
}

function deskRoster() {
  const raw = readState();
  return deskCallCatalog({
    settings: normalizeSettings(raw.settings),
    usage: Array.isArray(raw.usage) ? raw.usage : [],
    plans: raw.deskPlans ?? {},
    permits: raw.watchPermits ?? {},
    dayMarks: raw.watchDayMarks,
  });
}

function parseVendorGrant(text: string): { allowed?: boolean; retrySpawn?: boolean } | null {
  try {
    const parsed = JSON.parse(text) as { allowed?: boolean; retrySpawn?: boolean };
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* spawn result is plain text */
  }
  return null;
}

async function askChat(chat: string, message: string, from?: string): Promise<string> {
  const state = readState();
  const listed = catalogSessions(state, { fromSessionId: fromSessionId(from) });
  const match = findSession(listed, chat);
  if (!match) {
    if (shouldSpawnInsteadOfAsk(chat, listed)) {
      return spawnAgent({ prompt: message, chat, description: chat }, from);
    }
    throw new Error(`No Workhorse chat matches “${chat}”`);
  }
  const first = await postBridge("/ask", {
    toSessionId: match.id,
    fromSessionId: fromSessionId(from),
    message,
    mode: "ask",
  });
  if (isVendorDeclinedResult(first)) throw new Error(first.trim());
  const grant = parseVendorGrant(first);
  if (grant?.retrySpawn || grant?.allowed) {
    return postBridge("/ask", {
      toSessionId: match.id,
      fromSessionId: fromSessionId(from),
      message,
      mode: "ask",
    });
  }
  return first;
}

function callerSession(from?: string): { id?: string; parentId?: string | null; hidden?: boolean; projectId?: string | null } | undefined {
  const id = fromSessionId(from);
  if (!id) return undefined;
  const sessions = readState().sessions;
  if (!Array.isArray(sessions)) return undefined;
  const row = sessions.find((item) => item && typeof item === "object" && (item as { id?: string }).id === id);
  return row && typeof row === "object"
    ? (row as { id?: string; parentId?: string | null; hidden?: boolean; projectId?: string | null })
    : undefined;
}

function callerProjectFolder(session?: { projectId?: string | null }): string {
  const projectId = session?.projectId?.trim();
  if (!projectId) return "";
  const projects = readState().projects;
  if (!Array.isArray(projects)) return "";
  const project = projects.find((item) => item && typeof item === "object" && (item as { id?: string }).id === projectId) as
    | { folders?: Array<{ path?: string }> }
    | undefined;
  const pathValue = project?.folders?.[0]?.path;
  return typeof pathValue === "string" ? pathValue.trim() : "";
}

async function spawnAgent(
  input: {
    prompt: string;
    description?: string;
    provider?: string;
    model?: string;
    chat?: string;
    effort?: string;
    timeoutSeconds?: number;
    tokenBudget?: number;
    isolation?: "worktree" | "shared";
    folder?: string;
    wait?: boolean;
  },
  from?: string,
): Promise<string> {
  if (!input.prompt.trim()) throw new Error("prompt is required");
  const caller = callerSession(from);
  const isNested = deskRoleOf(caller) === "worker";
  if (isNested && caller?.id) {
    const state = readState();
    const sessions = (Array.isArray(state?.sessions) ? state.sessions : [])
      .filter((item): item is { id: string; parentId?: string | null } =>
        Boolean(item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"),
      );
    const blocked = nestedSpawnError(sessions, caller.id);
    if (blocked) throw new Error(blocked);
  }
  if (isSpawnOnlyPrompt(input.prompt)) throw new Error(SPAWN_ONLY_PROMPT_ERROR);
  const spawnInput = isNested
    ? {
        ...input,
        provider: "custom",
        model: NESTED_AGENT_MODEL,
        effort: "low",
        timeoutSeconds: Math.min(120, Math.max(30, input.timeoutSeconds ?? 120)),
        tokenBudget: Math.min(5_000, Math.max(1, input.tokenBudget ?? 5_000)),
        isolation: "shared" as const,
      }
    : input;
  const projectFolder = callerProjectFolder(caller);
  const admitted = caller
    ? admitSpawn({
        parent: caller,
        projectFolder,
        folder: spawnInput.folder,
        prompt: spawnInput.prompt,
        allowNested: isNested,
        folderExists: (value) => {
          try {
            return fs.existsSync(value) && fs.statSync(value).isDirectory();
          } catch {
            return false;
          }
        },
      })
    : projectFolder || spawnInput.folder?.trim()
      ? { ok: true as const, cwd: (spawnInput.folder?.trim() || projectFolder) }
      : { ok: true as const, cwd: "" };
  if (!admitted.ok) throw new Error(admitted.error);
  const first = await postBridge("/spawn", {
    toSessionId: "",
    fromSessionId: fromSessionId(from),
    message: spawnInput.prompt,
    mode: "spawn",
    provider: spawnInput.provider,
    model: spawnInput.model,
    description: spawnInput.description,
    chat: spawnInput.chat,
    effort: spawnInput.effort,
    timeoutSeconds: spawnInput.timeoutSeconds,
    tokenBudget: spawnInput.tokenBudget,
    isolation: spawnInput.isolation,
    folder: admitted.cwd,
    wait: spawnInput.wait,
  });
  if (isVendorDeclinedResult(first)) throw new Error(first.trim());
  const grant = parseVendorGrant(first);
  if (grant?.retrySpawn || grant?.allowed) {
    return postBridge("/spawn", {
      toSessionId: "",
      fromSessionId: fromSessionId(from),
      message: spawnInput.prompt,
      mode: "spawn",
      provider: spawnInput.provider,
      model: spawnInput.model,
      description: spawnInput.description,
      chat: spawnInput.chat,
      effort: spawnInput.effort,
      timeoutSeconds: spawnInput.timeoutSeconds,
      tokenBudget: spawnInput.tokenBudget,
      isolation: spawnInput.isolation,
      folder: admitted.cwd,
      wait: spawnInput.wait,
    });
  }
  return first;
}

async function awaitAgents(from?: string, timeoutSeconds?: number, wait?: boolean): Promise<string> {
  const timeoutMs = wait
    ? Math.max(30, Math.min(3_600, timeoutSeconds ?? 600)) * 1_000 + 5_000
    : 15_000;
  return postBridge(
    "/bots",
    botsAsk(
      {
        action: "await-agents",
        message: "await-agents",
        timeoutSeconds,
        wait,
      },
      from,
    ),
    { timeoutMs, inbox: false },
  );
}

async function callTool(name: string, args: Record<string, unknown>, from?: string): Promise<string> {
  if (name === "workhorse_list_chats") {
    return JSON.stringify(catalogSessions(readState(), { fromSessionId: from }), null, 2);
  }
  if (name === "workhorse_read_chat") {
    const chat = typeof args.chat === "string" ? args.chat : "";
    const limit = typeof args.limit === "number" ? args.limit : 40;
    const transcript = sessionTranscript(readState(), chat, limit, from);
    if (!transcript) throw new Error(`No Workhorse chat matches “${chat}”`);
    return JSON.stringify(transcript, null, 2);
  }
  if (name === "workhorse_ask_chat") {
    const chat = typeof args.chat === "string" ? args.chat : "";
    const message = typeof args.message === "string" ? args.message : "";
    if (!message.trim()) throw new Error("message is required");
    return askChat(chat, message, from);
  }
  if (name === "workhorse_spawn_agent") {
    const prompt = typeof args.prompt === "string" ? args.prompt : typeof args.message === "string" ? args.message : "";
    return spawnAgent(
      {
        prompt,
        description: typeof args.description === "string" ? args.description : undefined,
        provider: typeof args.provider === "string" ? args.provider : undefined,
        model: typeof args.model === "string" ? args.model : undefined,
        chat: typeof args.chat === "string" ? args.chat : undefined,
        effort: typeof args.effort === "string" ? args.effort : undefined,
        timeoutSeconds: typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : undefined,
        tokenBudget: typeof args.tokenBudget === "number" ? args.tokenBudget : undefined,
        isolation: args.isolation === "shared" ? "shared" : args.isolation === "worktree" ? "worktree" : undefined,
        folder: typeof args.folder === "string" ? args.folder : undefined,
        wait: args.wait === false ? false : args.wait === true ? true : undefined,
      },
      from,
    );
  }
  if (name === "workhorse_await_agents") {
    return awaitAgents(
      from,
      typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : undefined,
      args.wait === true,
    );
  }
  if (name === "workhorse_list_bots") {
    return listBots(from);
  }
  if (name === "workhorse_detect_custom") {
    return JSON.stringify(publicDetectCard(detectCustomLogin()), null, 2);
  }
  if (name === "workhorse_setup_custom_bot") {
    const result = await runCustomBotSetup(setupInput(args), {
      detect: () => detectCustomLogin(),
      probe: (config) => probeCustomHttp(config),
      create: createDeskBot,
      listed: () => publicBotsFromState(readState()),
    });
    if (!result.ok) throw new Error(result.error);
    return JSON.stringify(
      {
        ok: true,
        created: result.created,
        alreadyOnDesk: result.alreadyOnDesk === true,
        imported: result.imported,
        probe: result.probe,
        bot: result.bot,
        howToUse: result.howToUse,
      },
      null,
      2,
    );
  }
  if (name === "workhorse_list_projects") {
    try {
      const live = await postBridge(
        "/bots",
        botsAsk({ action: "list-projects", message: "list-projects" }, from),
        { timeoutMs: 8_000, inbox: false },
      );
      const parsed = JSON.parse(live) as { projects?: unknown; summary?: string; source?: string };
      if (Array.isArray(parsed.projects)) {
        return JSON.stringify(
          {
            source: parsed.source ?? "live",
            summary: typeof parsed.summary === "string" ? parsed.summary : formatProjectRows(parsed.projects),
            projects: parsed.projects,
          },
          null,
          2,
        );
      }
    } catch {
      /* fall back to the last saved file */
    }
    const raw = readState();
    const projects = Array.isArray(raw.projects) ? raw.projects : [];
    const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    const rows = projects
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as { id?: string; name?: string; folders?: Array<{ path?: string }> };
        if (!record.id || !record.name) return null;
        const folders = Array.isArray(record.folders)
          ? record.folders.map((folder) => folder.path).filter((path): path is string => Boolean(path))
          : [];
        const chats = sessions.filter((session) => {
          if (!session || typeof session !== "object") return false;
          const row = session as { projectId?: string; archivedAt?: number };
          return row.projectId === record.id && typeof row.archivedAt !== "number";
        }).length;
        return { id: record.id, name: record.name, folders, chats };
      })
      .filter((item): item is { id: string; name: string; folders: string[]; chats: number } => item !== null);
    return JSON.stringify({ source: "disk", summary: formatProjectRows(rows), projects: rows }, null, 2);
  }
  if (name === "workhorse_create_project") {
    const projectName = typeof args.name === "string" ? args.name.trim() : "";
    if (!projectName) throw new Error("name is required");
    const folder = typeof args.folder === "string" ? args.folder.trim() : "";
    if (folder) {
      try {
        if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
          throw new Error(`folder is not an existing directory: ${folder}`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(detail);
      }
    }
    const sessionId = fromSessionId(from);
    const notify = () =>
      postBridge(
        "/bots",
        botsAsk(
          {
            action: "create-project",
            message: projectName,
            name: projectName,
            folder: folder || undefined,
            chat: folder || undefined,
          },
          from,
        ),
        { timeoutMs: 12_000, inbox: false },
      );
    try {
      const live = await notify();
      const parsed = parseCreateProjectLive(live);
      if (parsed) return JSON.stringify(parsed, null, 2);
      throw new Error("live desk did not confirm the project");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const rendererDown = /bridge is not running|fetch failed|ECONNREFUSED|not available/i.test(detail);
      if (rendererDown || !process.env.WORKHORSE_BRIDGE_URL?.trim()) {
        try {
          return createWorkhorseProjectLocal({
            name: projectName,
            folder: folder || undefined,
            fromSessionId: sessionId || undefined,
          });
        } catch {
          /* use the live error */
        }
      }
      throw new Error(`create-project failed: ${detail}. Do not tell the user the project exists.`);
    }
  }
  if (name === "workhorse_move_chat") {
    const project = typeof args.project === "string" ? args.project.trim() : typeof args.name === "string" ? args.name.trim() : "";
    if (!project) throw new Error("project is required");
    const chat = typeof args.chat === "string" ? args.chat.trim() : "";
    return postBridge(
      "/bots",
      botsAsk(
        {
          action: "move-chat",
          message: project,
          name: project,
          chat: chat || undefined,
        },
        from,
      ),
      { timeoutMs: 12_000, inbox: false },
    );
  }
  if (name === "workhorse_rename_chat") {
    const title = typeof args.name === "string" ? args.name.trim() : typeof args.title === "string" ? args.title.trim() : "";
    if (!title) throw new Error("name is required");
    const chat = typeof args.chat === "string" ? args.chat.trim() : "";
    return postBridge(
      "/bots",
      botsAsk(
        {
          action: "rename-chat",
          message: title,
          name: title,
          chat: chat || undefined,
        },
        from,
      ),
      { timeoutMs: 12_000, inbox: false },
    );
  }
  if (name === "workhorse_rename_project") {
    const title = typeof args.name === "string" ? args.name.trim() : typeof args.title === "string" ? args.title.trim() : "";
    if (!title) throw new Error("name is required");
    const project = typeof args.project === "string" ? args.project.trim() : "";
    const live = await postBridge(
      "/bots",
      botsAsk(
        {
          action: "rename-project",
          message: title,
          name: title,
          folder: project || undefined,
        },
        from,
      ),
      { timeoutMs: 12_000, inbox: false },
    );
    const parsed = parseRenameProjectLive(live);
    if (parsed) return JSON.stringify(parsed, null, 2);
    throw new Error(
      `rename did not take on the live desk. Call workhorse_list_projects and quote those names. Do not tell the user it is named “${title}”.`,
    );
  }
  if (name === "workhorse_delete_chat") {
    const chat = typeof args.chat === "string" ? args.chat.trim() : typeof args.name === "string" ? args.name.trim() : "";
    const onlyThis = args.onlyThis === true;
    const scope = typeof args.scope === "string" ? args.scope.trim() : "";
    const loose = scope.toLowerCase() === "loose" || chat.toLowerCase() === "loose" || chat.toLowerCase() === "not in a project";
    if (!chat && !onlyThis && !loose) {
      throw new Error("chat title or id is required. This chat cannot be deleted unless onlyThis=true.");
    }
    return postBridge(
      "/bots",
      botsAsk(
        {
          action: "delete-chat",
          message: loose ? "loose" : chat || "this chat",
          name: chat || undefined,
          chat: loose ? "loose" : chat || undefined,
          scope: loose ? "loose" : undefined,
          onlyThis,
        },
        from,
      ),
      { timeoutMs: 12_000, inbox: false },
    );
  }
  if (name === "workhorse_delete_project") {
    const project =
      typeof args.project === "string" ? args.project.trim() : typeof args.name === "string" ? args.name.trim() : "";
    if (!project) throw new Error("project is required");
    const chats = args.chats === "remove" || args.chats === "keep" ? args.chats : "keep";
    return postBridge(
      "/bots",
      botsAsk(
        {
          action: "delete-project",
          message: project,
          name: project,
          chats,
        },
        from,
      ),
      { timeoutMs: 12_000, inbox: false },
    );
  }
  if (name === "workhorse_request_vendor") {
    const vendor =
      typeof args.vendor === "string"
        ? args.vendor
        : typeof args.provider === "string"
          ? args.provider
          : typeof args.name === "string"
            ? args.name
            : "";
    if (!vendor.trim()) throw new Error("vendor is required");
    const reason = typeof args.reason === "string" ? args.reason : "";
    const text = await postBridge(
      "/bots",
      botsAsk(
        {
          action: "request-vendor",
          message: reason || vendor,
          name: vendor,
          chat: vendor,
          provider: vendor,
        },
        from,
      ),
      { timeoutMs: 10 * 60 * 1000, inbox: false },
    );
    if (isVendorDeclinedResult(text)) throw new Error(text.trim());
    const grant = parseVendorGrant(text);
    if (grant && grant.allowed !== true) throw new Error(vendorDeclinedForBot(vendor));
    return text;
  }
  if (name === "workhorse_request_permission") {
    const permission =
      typeof args.permission === "string"
        ? args.permission
        : typeof args.mode === "string"
          ? args.mode
          : "";
    const sandbox = typeof args.sandbox === "string" ? args.sandbox : "";
    const reason = typeof args.reason === "string" ? args.reason : typeof args.message === "string" ? args.message : "";
    return postBridge(
      "/bots",
      botsAsk(
        {
          action: "request-permission",
          message: reason || "needs more access to finish the work",
          name: permission || undefined,
          folder: sandbox || undefined,
          description: reason || undefined,
        },
        from,
      ),
      { timeoutMs: 10 * 60 * 1000, inbox: true },
    );
  }
  if (name === "workhorse_list_references") {
    return postBridge(
      "/bots",
      botsAsk(
        {
          action: "list-references",
          message: "list-references",
          name: typeof args.project === "string" ? args.project : undefined,
        },
        from,
      ),
    );
  }
  if (name === "workhorse_add_reference") {
    const value = typeof args.value === "string" ? args.value : typeof args.url === "string" ? args.url : "";
    if (!value.trim()) throw new Error("value is required");
    return postBridge(
      "/bots",
      botsAsk(
        {
          action: "add-reference",
          message: value,
          chat: value,
          name: typeof args.kind === "string" ? args.kind : undefined,
          description: typeof args.label === "string" ? args.label : undefined,
          bot: typeof args.project === "string" ? args.project : undefined,
        },
        from,
      ),
    );
  }
  if (name === "workhorse_delete_reference") {
    const reference =
      typeof args.reference === "string" ? args.reference : typeof args.value === "string" ? args.value : "";
    if (!reference.trim()) throw new Error("reference is required");
    return postBridge(
      "/bots",
      botsAsk(
        {
          action: "delete-reference",
          message: reference,
          name: typeof args.project === "string" ? args.project : undefined,
          bot: reference,
        },
        from,
      ),
    );
  }
  if (name === "workhorse_delete_bot") {
    const bot = typeof args.bot === "string" ? args.bot : typeof args.name === "string" ? args.name : "";
    if (!bot.trim()) throw new Error("bot is required");
    return postBridge("/bots", botsAsk({ action: "delete", bot, message: "delete", name: bot }));
  }
  if (name === "workhorse_list_skills") {
    const origin = typeof args.origin === "string" ? args.origin.trim().toLowerCase() : "";
    const rows = publicDeskSkills(projectFoldersFromState());
    return JSON.stringify(
      origin ? rows.filter((row) => row.origin === origin) : rows,
      null,
      2,
    );
  }
  if (name === "workhorse_read_skill") {
    const skill = typeof args.skill === "string" ? args.skill : typeof args.name === "string" ? args.name : "";
    if (!skill.trim()) throw new Error("skill is required");
    return JSON.stringify(readDeskSkill(skill, projectFoldersFromState()), null, 2);
  }
  throw new Error(`Unknown tool ${name}`);
}

function projectFoldersFromState(): string[] {
  const projects = readState().projects;
  if (!Array.isArray(projects)) return [];
  const folders: string[] = [];
  for (const project of projects) {
    if (!project || typeof project !== "object") continue;
    const listed = (project as { folders?: unknown }).folders;
    if (!Array.isArray(listed)) continue;
    for (const folder of listed) {
      const value = folder && typeof folder === "object" ? (folder as { path?: unknown }).path : null;
      if (typeof value === "string" && value.trim()) folders.push(value.trim());
    }
  }
  return folders;
}

export async function handleWorkhorseRpc(
  message: JsonRpc,
  ctx?: { fromSessionId?: string },
): Promise<object | undefined> {
  if (message.method === "initialize") {
    if (message.id === undefined) return undefined;
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "go7-workhorse", version: APP_VERSION },
      },
    };
  }
  if (message.method === "notifications/initialized" || message.method === "initialized") return undefined;
  if (message.method === "tools/list") {
    if (message.id === undefined) return undefined;
    const role = deskRoleOf(callerSession(ctx?.fromSessionId));
    return { jsonrpc: "2.0", id: message.id, result: { tools: toolsForDeskRole(TOOLS, role) } };
  }
  if (message.method === "ping") {
    if (message.id === undefined) return undefined;
    return { jsonrpc: "2.0", id: message.id, result: {} };
  }
  if (message.method === "tools/call") {
    if (message.id === undefined) return undefined;
    const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    try {
      const text = await callTool(params.name ?? "", params.arguments ?? {}, ctx?.fromSessionId);
      return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
  if (message.id !== undefined) {
    return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } };
  }
  return undefined;
}

async function onMessage(message: JsonRpc, framing: McpFraming): Promise<void> {
  const response = await handleWorkhorseRpc(message);
  if (response) process.stdout.write(encodeMcpFrame(response, framing));
}

export async function runWorkhorseMcp(): Promise<void> {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  process.stdin.on("error", (error) => {
    console.error("workhorse mcp stdin", error);
  });
  process.stdin.on("end", () => {
    process.exit(0);
  });
  process.stdin.on("data", (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")]);
    const parsed = consumeMcpBuffers(buffer);
    buffer = parsed.rest;
    for (const frame of parsed.frames) {
      void onMessage(frame.message, frame.framing);
    }
  });
  process.stdin.resume();
}

function isMcpEntry(): boolean {
  const entry = process.argv[1] ?? "";
  if (/(^|[\\/])workhorse-mcp\.(c?js|mjs|ts)$/i.test(entry)) return true;
  return process.argv.includes("--workhorse-mcp");
}

if (isMcpEntry()) {
  void runWorkhorseMcp();
}

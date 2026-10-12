/**
 * A team is people, on more than one desk, sharing one named project.
 *
 * The only thing that moves between desks is one append-only journal per
 * project. Each computer keeps its own desk file, its own vendor logins, keys,
 * leftover rings, Permission, Sandbox, grants, learning store, and linked
 * folders. None of those have a field in any event below, and
 * `sanitizeTeamEvent` rebuilds every event from an allowlist on the way in and
 * on the way out, so a stray field cannot ride along.
 *
 * Each device appends only to its own file inside the shared journal folder.
 * Events combine by id, so two desks that wrote while apart agree once they
 * can read each other again.
 *
 * Presence is not an event. It is a heartbeat file per device that expires,
 * so nothing about who was looking is replayed after a disconnect.
 */
import { uid } from "./id";
import type {
  AttachmentKind,
  ChatMessage,
  ChatMessageKind,
  LinkedFolder,
  LocalComputeHostSettings,
  PermissionMode,
  PermissionRequest,
  Project,
  ProviderId,
  SandboxProfile,
  Session,
  UsageEvent,
} from "./types";
import type { WorkshopSettings } from "./workshop-pack";

export const TEAM_LOCATOR_PREFIX = "go7-team:";
export const PRESENCE_TTL_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_TEXT = 200_000;
const MAX_SHORT = 400;

/** This computer's link to one team journal. Lives in this desk file only. */
export type TeamLink = {
  journalId: string;
  /** This computer's copy of the shared journal folder. Never written to the journal. */
  folder: string;
  joinedAt: number;
  /** Title and archive state this desk last agreed with the journal, per chat. */
  baseline?: Record<string, TeamChatMeta>;
};

export type TeamChatMeta = { title: string; archivedAt: number | null };

/** Where a chat that arrived through the journal was started, and where it is running now. */
export type SessionTeamOrigin = { device: string; seat: string; runningOn?: string };

export type JournalAttachment = { id: string; name: string; mimeType?: string; kind?: AttachmentKind; size?: number };

/** An attachment whose bytes stayed on the desk that added it. `on` is that person's seat. */
export type HeldAttachment = JournalAttachment & { on: string };

export type JournalMessage = {
  id: string;
  role: ChatMessage["role"];
  text: string;
  createdAt: number;
  kind?: ChatMessageKind;
  thought?: string;
  toolStatus?: string;
  fromTitle?: string;
  provider?: ProviderId;
  model?: string;
  /** The person who typed it. Only on prompts. */
  seat?: string;
  attachments?: JournalAttachment[];
};

export type TeamChatRecord = {
  id: string;
  title: string;
  createdAt: number;
  provider: ProviderId;
  model: string;
  /** Set on worker chats, which travel as work records. A worker is never a person. */
  parentId?: string;
  workerName?: string;
};

export type TeamUsageRow = {
  id: string;
  chatId?: string;
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
};

export type TeamCeiling = { usd?: number; tokens?: number };
export type TeamWorkshopGrant = { pack: string; sources: string[]; host: string };
export type TeamPermissionAnswer = "once" | "session" | "deny" | "closed";

type EventBase = { id: string; at: number; journal: string; device: string; seat: string };

export type TeamEvent = EventBase &
  (
    | { type: "team.created"; project: { id: string; name: string } }
    | { type: "member.joined" }
    | { type: "chat.created"; chat: TeamChatRecord }
    | { type: "chat.titled"; chatId: string; title: string }
    | { type: "chat.archived"; chatId: string; archivedAt: number | null }
    | { type: "chat.run"; chatId: string; running: boolean }
    | { type: "message.put"; chatId: string; message: JournalMessage }
    | { type: "permission.asked"; chatId: string; requestId: string; tool: string; detail: string }
    | { type: "permission.answered"; chatId: string; requestId: string; answer: TeamPermissionAnswer }
    | { type: "usage.row"; row: TeamUsageRow }
    | { type: "ceiling.set"; ceiling: TeamCeiling | null }
    | { type: "workshop.grant"; grant: TeamWorkshopGrant }
    | { type: "inbox.owner"; owner: string; how: "start" | "handoff" | "take" }
  );

export type TeamEventType = TeamEvent["type"];
type Draft<T extends TeamEventType> = Omit<Extract<TeamEvent, { type: T }>, keyof EventBase | "type"> & { id?: string };

export type PresenceBeat = { device: string; seat: string; chatId: string | null; at: number };

export type TeamLocal = {
  device: string;
  seat: string;
  now: number;
  /** This desk's own defaults for a chat that arrives from another desk. */
  mode: PermissionMode;
  sandbox: SandboxProfile;
};

// ---------------------------------------------------------------------------------------------
// Ids, seats, hashing

export function isTeamId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

/** The seat handle a person shows on a team. A team needs one; there is no made-up fallback. */
export function seatOf(profile: { handle?: string; name?: string } | undefined): string {
  const handle = (profile?.handle ?? "").trim().replace(/^@+/, "");
  return handle.slice(0, 40);
}

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    h ^= text.charCodeAt(index);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function event<T extends TeamEventType>(
  journal: string,
  local: Pick<TeamLocal, "device" | "seat" | "now">,
  type: T,
  body: Draft<T>,
): TeamEvent {
  const { id, ...rest } = body as Draft<T> & { id?: string };
  return {
    ...rest,
    id: id ?? uid("tev"),
    at: local.now,
    journal,
    device: local.device,
    seat: local.seat,
    type,
  } as unknown as TeamEvent;
}

// ---------------------------------------------------------------------------------------------
// Folder paths never enter the journal

const FOLDER_TOKEN = /‹folder:([^›]{1,80})›/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Linked folder roots in text become `‹folder:label›`. The other desk maps the label to its own folder. */
export function redactFolders(text: string, folders: readonly LinkedFolder[]): string {
  let out = text;
  const roots = [...folders].sort((a, b) => b.path.length - a.path.length);
  for (const folder of roots) {
    const root = folder.path.replace(/[\\/]+$/, "");
    if (root.length < 2) continue;
    const pattern = escapeRegExp(root).replace(/\\\\|\//g, "[\\\\/]");
    out = out.replace(new RegExp(pattern, "gi"), `‹folder:${folder.label}›`);
  }
  return out;
}

export function restoreFolders(text: string, folders: readonly LinkedFolder[]): string {
  if (!text.includes("‹folder:")) return text;
  return text.replace(FOLDER_TOKEN, (token, label: string) => {
    const folder = folders.find((item) => item.label === label);
    return folder ? folder.path.replace(/[\\/]+$/, "") : token;
  });
}

// ---------------------------------------------------------------------------------------------
// Sanitizing: every event is rebuilt from an allowlist, both ways

function str(value: unknown, max = MAX_SHORT): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number {
  const n = num(value);
  return n !== undefined && n > 0 ? Math.round(n) : 0;
}

const ROLES = new Set(["user", "assistant", "system"]);
const KINDS = new Set(["tool", "compact", "thought", "peer", "subagent"]);
const ATTACHMENT_KINDS = new Set(["image", "file", "document", "audio", "video"]);
const PROVIDERS = new Set(["grok", "codex", "claude", "cursor", "custom"]);
const ANSWERS = new Set(["once", "session", "deny", "closed"]);

function provider(value: unknown): ProviderId | undefined {
  return typeof value === "string" && PROVIDERS.has(value) ? (value as ProviderId) : undefined;
}

function cleanAttachment(raw: unknown): JournalAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = str(record.id, 128);
  const name = str(record.name, 200);
  if (!id || !name) return null;
  const kind = typeof record.kind === "string" && ATTACHMENT_KINDS.has(record.kind) ? (record.kind as AttachmentKind) : undefined;
  const mimeType = str(record.mimeType, 120);
  const size = num(record.size);
  return { id, name, ...(mimeType ? { mimeType } : {}), ...(kind ? { kind } : {}), ...(size !== undefined && size >= 0 ? { size } : {}) };
}

function cleanMessage(raw: unknown): JournalMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = str(record.id, 128);
  const role = typeof record.role === "string" && ROLES.has(record.role) ? (record.role as JournalMessage["role"]) : null;
  const text = str(record.text, MAX_TEXT);
  if (!id || !role || text === undefined) return null;
  const kind = typeof record.kind === "string" && KINDS.has(record.kind) ? (record.kind as ChatMessageKind) : undefined;
  const attachments = Array.isArray(record.attachments)
    ? record.attachments.map(cleanAttachment).filter((item): item is JournalAttachment => item !== null).slice(0, 64)
    : [];
  const out: JournalMessage = { id, role, text, createdAt: num(record.createdAt) ?? 0 };
  if (kind) out.kind = kind;
  const thought = str(record.thought, MAX_TEXT);
  if (thought) out.thought = thought;
  const toolStatus = str(record.toolStatus, 60);
  if (toolStatus) out.toolStatus = toolStatus;
  const fromTitle = str(record.fromTitle, 200);
  if (fromTitle) out.fromTitle = fromTitle;
  const vendor = provider(record.provider);
  if (vendor) out.provider = vendor;
  const model = str(record.model, 120);
  if (model) out.model = model;
  const seat = str(record.seat, 40);
  if (role === "user" && seat) out.seat = seat;
  if (attachments.length > 0) out.attachments = attachments;
  return out;
}

/**
 * The journal's only door. Anything that is not exactly one of the event shapes
 * above comes back null; anything extra on a valid shape is left behind.
 */
export function sanitizeTeamEvent(raw: unknown): TeamEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const base = {
    id: record.id,
    at: num(record.at),
    journal: record.journal,
    device: record.device,
    seat: str(record.seat, 40),
  };
  if (!isTeamId(base.id) || base.at === undefined || !isTeamId(base.journal) || !isTeamId(base.device)) return null;
  if (base.seat === undefined) return null;
  const head = { id: base.id, at: base.at, journal: base.journal, device: base.device, seat: base.seat };
  const chatId = isTeamId(record.chatId) ? record.chatId : undefined;
  switch (record.type) {
    case "team.created": {
      const project = record.project as Record<string, unknown> | undefined;
      const name = str(project?.name, 200);
      if (!isTeamId(project?.id) || !name) return null;
      return { ...head, type: "team.created", project: { id: project.id, name } };
    }
    case "member.joined":
      return base.seat ? { ...head, type: "member.joined" } : null;
    case "chat.created": {
      const chat = record.chat as Record<string, unknown> | undefined;
      const vendor = provider(chat?.provider);
      const model = str(chat?.model, 120);
      if (!chat || !isTeamId(chat.id) || !vendor || !model) return null;
      const out: TeamChatRecord = {
        id: chat.id,
        title: str(chat.title, 200) ?? "New chat",
        createdAt: num(chat.createdAt) ?? base.at,
        provider: vendor,
        model,
      };
      if (isTeamId(chat.parentId)) out.parentId = chat.parentId;
      const workerName = str(chat.workerName, 60);
      if (workerName) out.workerName = workerName;
      return { ...head, type: "chat.created", chat: out };
    }
    case "chat.titled": {
      const title = str(record.title, 200);
      return chatId && title !== undefined ? { ...head, type: "chat.titled", chatId, title } : null;
    }
    case "chat.archived": {
      const archivedAt = record.archivedAt === null ? null : num(record.archivedAt);
      return chatId && archivedAt !== undefined ? { ...head, type: "chat.archived", chatId, archivedAt } : null;
    }
    case "chat.run":
      return chatId && typeof record.running === "boolean" ? { ...head, type: "chat.run", chatId, running: record.running } : null;
    case "message.put": {
      const message = cleanMessage(record.message);
      return chatId && message ? { ...head, type: "message.put", chatId, message } : null;
    }
    case "permission.asked": {
      const requestId = str(record.requestId, 128);
      const tool = str(record.tool, 120);
      if (!chatId || !requestId || !tool) return null;
      return { ...head, type: "permission.asked", chatId, requestId, tool, detail: str(record.detail, 2_000) ?? "" };
    }
    case "permission.answered": {
      const requestId = str(record.requestId, 128);
      const answer = typeof record.answer === "string" && ANSWERS.has(record.answer) ? (record.answer as TeamPermissionAnswer) : null;
      return chatId && requestId && answer ? { ...head, type: "permission.answered", chatId, requestId, answer } : null;
    }
    case "usage.row": {
      const row = record.row as Record<string, unknown> | undefined;
      const vendor = provider(row?.provider);
      if (!row || !isTeamId(row.id) || !vendor) return null;
      const cost = num(row.costUsd);
      return {
        ...head,
        type: "usage.row",
        row: {
          id: row.id,
          ...(isTeamId(row.chatId) ? { chatId: row.chatId } : {}),
          provider: vendor,
          model: str(row.model, 120) ?? "",
          inputTokens: count(row.inputTokens),
          outputTokens: count(row.outputTokens),
          cacheReadTokens: count(row.cacheReadTokens),
          cacheWriteTokens: count(row.cacheWriteTokens),
          ...(cost !== undefined && cost >= 0 ? { costUsd: cost } : {}),
        },
      };
    }
    case "ceiling.set": {
      if (record.ceiling === null) return { ...head, type: "ceiling.set", ceiling: null };
      const ceiling = record.ceiling as Record<string, unknown> | undefined;
      const usd = num(ceiling?.usd);
      const tokens = num(ceiling?.tokens);
      const out: TeamCeiling = {};
      if (usd !== undefined && usd > 0) out.usd = usd;
      if (tokens !== undefined && tokens > 0) out.tokens = Math.floor(tokens);
      return { ...head, type: "ceiling.set", ceiling: out.usd || out.tokens ? out : null };
    }
    case "workshop.grant": {
      const grant = record.grant as Record<string, unknown> | undefined;
      const pack = str(grant?.pack, 80);
      const host = str(grant?.host, 80);
      if (!pack || !host || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pack)) return null;
      const sources = Array.isArray(grant?.sources)
        ? grant.sources.filter((item): item is string => typeof item === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(item)).slice(0, 8)
        : [];
      return { ...head, type: "workshop.grant", grant: { pack, sources, host } };
    }
    case "inbox.owner": {
      const owner = str(record.owner, 40);
      const how = record.how === "start" || record.how === "handoff" || record.how === "take" ? record.how : null;
      return owner && how ? { ...head, type: "inbox.owner", owner, how } : null;
    }
    default:
      return null;
  }
}

/** Two desks' journals, combined. Same id is the same event; order is time, then id. */
export function combineJournals(...lists: ReadonlyArray<readonly TeamEvent[]>): TeamEvent[] {
  const byId = new Map<string, TeamEvent>();
  for (const list of lists) for (const item of list) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Fold

export type TeamChatState = {
  record: TeamChatRecord;
  device: string;
  seat: string;
  title: string;
  archivedAt: number | null;
  runningOn?: string;
};

export type TeamCard = { requestId: string; chatId: string; tool: string; detail: string; device: string; seat: string; at: number };
export type TeamAnswer = { requestId: string; chatId: string; answer: TeamPermissionAnswer; device: string; seat: string; at: number };
export type TeamUsage = TeamUsageRow & { seat: string; device: string; at: number };

export type TeamView = {
  journalId: string | null;
  project: { id: string; name: string } | null;
  ids: Set<string>;
  /** People. Seats come only from a join, so a worker can never be one. */
  members: string[];
  devices: Array<{ device: string; seat: string }>;
  chats: Map<string, TeamChatState>;
  messages: Map<string, Map<string, { message: JournalMessage; device: string; seat: string; at: number }>>;
  waiting: TeamCard[];
  answers: TeamAnswer[];
  usage: TeamUsage[];
  ceiling: TeamCeiling | null;
  grants: Map<string, TeamWorkshopGrant & { seat: string; at: number }>;
  inbox: { owner: string | null; how?: "start" | "handoff" | "take"; by?: string; at?: number };
};

export function foldTeamJournal(events: readonly TeamEvent[]): TeamView {
  const view: TeamView = {
    journalId: null,
    project: null,
    ids: new Set(),
    members: [],
    devices: [],
    chats: new Map(),
    messages: new Map(),
    waiting: [],
    answers: [],
    usage: [],
    ceiling: null,
    grants: new Map(),
    inbox: { owner: null },
  };
  const asked = new Map<string, TeamCard>();
  const usageIds = new Set<string>();
  /** First time each seat joined. An inbox label is valid only once both people have joined by then. */
  const joinedAt = new Map<string, number>();
  const inboxEvents: Array<Extract<TeamEvent, { type: "inbox.owner" }>> = [];
  for (const item of combineJournals(events)) {
    view.ids.add(item.id);
    view.journalId ??= item.journal;
    switch (item.type) {
      case "team.created":
        view.project ??= item.project;
        break;
      case "member.joined":
        if (item.seat && !view.members.includes(item.seat)) view.members.push(item.seat);
        if (item.seat && !joinedAt.has(item.seat)) joinedAt.set(item.seat, item.at);
        if (!view.devices.some((row) => row.device === item.device)) view.devices.push({ device: item.device, seat: item.seat });
        break;
      case "chat.created":
        if (!view.chats.has(item.chat.id)) {
          view.chats.set(item.chat.id, {
            record: item.chat,
            device: item.device,
            seat: item.seat,
            title: item.chat.title,
            archivedAt: null,
          });
        }
        break;
      case "chat.titled": {
        const chat = view.chats.get(item.chatId);
        if (chat) chat.title = item.title;
        break;
      }
      case "chat.archived": {
        const chat = view.chats.get(item.chatId);
        if (chat) chat.archivedAt = item.archivedAt;
        break;
      }
      case "chat.run": {
        const chat = view.chats.get(item.chatId);
        if (chat && item.device === chat.device) chat.runningOn = item.running ? item.device : undefined;
        break;
      }
      case "message.put": {
        const rows = view.messages.get(item.chatId) ?? new Map();
        rows.set(item.message.id, { message: item.message, device: item.device, seat: item.seat, at: item.at });
        view.messages.set(item.chatId, rows);
        break;
      }
      case "permission.asked":
        asked.set(item.requestId, {
          requestId: item.requestId,
          chatId: item.chatId,
          tool: item.tool,
          detail: item.detail,
          device: item.device,
          seat: item.seat,
          at: item.at,
        });
        break;
      case "permission.answered": {
        const card = asked.get(item.requestId);
        // Only the desk that asked holds the card, so only its answer closes it.
        // Another desk, or an answer for a card that was never asked, is not an answer.
        if (!card || card.device !== item.device) break;
        asked.delete(item.requestId);
        view.answers.push({ requestId: item.requestId, chatId: item.chatId, answer: item.answer, device: item.device, seat: item.seat, at: item.at });
        break;
      }
      case "usage.row":
        if (usageIds.has(item.row.id)) break;
        usageIds.add(item.row.id);
        view.usage.push({ ...item.row, seat: item.seat, device: item.device, at: item.at });
        break;
      case "ceiling.set":
        view.ceiling = item.ceiling;
        break;
      case "workshop.grant":
        view.grants.set(item.grant.pack, { ...item.grant, seat: item.seat, at: item.at });
        break;
      case "inbox.owner":
        // Applied after every join. Start writes the owner in the same instant as the join,
        // and id order can put the owner event first; the join time still has to be <= this event.
        inboxEvents.push(item);
        break;
    }
  }
  for (const item of inboxEvents) {
    const ownerJoined = joinedAt.get(item.owner);
    const byJoined = joinedAt.get(item.seat);
    if (ownerJoined === undefined || byJoined === undefined) continue;
    if (ownerJoined > item.at || byJoined > item.at) continue;
    view.inbox = { owner: item.owner, how: item.how, by: item.seat, at: item.at };
  }
  view.waiting = [...asked.values()];
  return view;
}

// ---------------------------------------------------------------------------------------------
// Locator, start, join

export type TeamLocator = { v: 1; journal: string; project: { id: string; name: string }; from: string; device: string };

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

/** What the first desk hands the second: which journal, which project, who sent it. No path, no key. */
export function teamLocator(input: Omit<TeamLocator, "v">): string {
  return `${TEAM_LOCATOR_PREFIX}${toBase64Url(JSON.stringify({ v: 1, ...input }))}`;
}

export function parseTeamLocator(text: string): TeamLocator | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(TEAM_LOCATOR_PREFIX)) return null;
  try {
    const raw = JSON.parse(fromBase64Url(trimmed.slice(TEAM_LOCATOR_PREFIX.length))) as Record<string, unknown>;
    const project = raw.project as Record<string, unknown> | undefined;
    const name = str(project?.name, 200);
    const from = str(raw.from, 40);
    if (raw.v !== 1 || !isTeamId(raw.journal) || !isTeamId(project?.id) || !name || !from || !isTeamId(raw.device)) return null;
    return { v: 1, journal: raw.journal, project: { id: project.id, name }, from, device: raw.device };
  } catch {
    return null;
  }
}

/** Share a project: the person who sends the locator starts as the inbox owner. */
export function startTeam(input: {
  project: Pick<Project, "id" | "name">;
  folder: string;
  local: Pick<TeamLocal, "device" | "seat" | "now">;
  journalId?: string;
}): { link: TeamLink; events: TeamEvent[]; locator: string } | { error: string } {
  if (!input.local.seat) return { error: "Set a handle in Settings → Profile first. Your team sees you by it." };
  if (!isTeamId(input.project.id)) return { error: "This project id cannot be shared." };
  const journalId = input.journalId ?? uid("team");
  const local = input.local;
  const events = [
    event(journalId, local, "team.created", { id: `tc_${journalId}`, project: { id: input.project.id, name: input.project.name } }),
    event(journalId, local, "member.joined", { id: `tj_${journalId}_${local.device}` }),
    event(journalId, local, "inbox.owner", { owner: local.seat, how: "start" }),
  ];
  return {
    link: { journalId, folder: input.folder, joinedAt: local.now },
    events,
    locator: teamLocator({ journal: journalId, project: { id: input.project.id, name: input.project.name }, from: local.seat, device: local.device }),
  };
}

/**
 * Join from a pasted locator. The new project has no folders; this person links
 * their own. Nothing about keys, leftovers, Permission, or Sandbox is read from
 * the locator, because there is nothing about them in it.
 */
export function joinTeam(input: {
  locator: string;
  folder: string;
  local: Pick<TeamLocal, "device" | "seat" | "now">;
  projects: readonly Project[];
}): { project: Project; events: TeamEvent[] } | { error: string } {
  const parsed = parseTeamLocator(input.locator);
  if (!parsed) return { error: "That is not a Workhorse team locator." };
  if (!input.local.seat) return { error: "Set a handle in Settings → Profile first. Your team sees you by it." };
  if (parsed.device === input.local.device) return { error: "That locator came from this desk." };
  const existing = input.projects.find((project) => project.id === parsed.project.id);
  if (existing?.team && existing.team.journalId !== parsed.journal) return { error: "A different team already uses this project here." };
  const link: TeamLink = { journalId: parsed.journal, folder: input.folder, joinedAt: input.local.now };
  const project: Project = existing
    ? { ...existing, team: link }
    : {
        id: parsed.project.id,
        name: parsed.project.name,
        createdAt: input.local.now,
        openedAt: input.local.now,
        folders: [],
        references: [],
        team: link,
      };
  return {
    project,
    events: [event(parsed.journal, input.local, "member.joined", { id: `tj_${parsed.journal}_${input.local.device}` })],
  };
}

// ---------------------------------------------------------------------------------------------
// Messages in journal form

function journalAttachments(message: ChatMessage): JournalAttachment[] | undefined {
  if (message.teamAttachments?.length) {
    return message.teamAttachments.map(({ on: _on, ...attachment }) => attachment);
  }
  if (!message.images?.length) return undefined;
  return message.images.map((image) => ({
    id: image.id,
    name: image.name,
    ...(image.mimeType ? { mimeType: image.mimeType } : {}),
    ...(image.kind ? { kind: image.kind } : {}),
    ...(typeof image.size === "number" ? { size: image.size } : {}),
  }));
}

export function journalMessageOf(message: ChatMessage, seat: string, folders: readonly LinkedFolder[]): JournalMessage {
  const out: JournalMessage = {
    id: message.id,
    role: message.role,
    text: redactFolders(message.text, folders),
    createdAt: message.createdAt,
  };
  if (message.kind) out.kind = message.kind;
  if (message.thought) out.thought = redactFolders(message.thought, folders);
  if (message.toolStatus) out.toolStatus = message.toolStatus;
  if (message.fromTitle) out.fromTitle = message.fromTitle;
  if (message.provider) out.provider = message.provider;
  if (message.model) out.model = message.model;
  if (message.role === "user" && (message.seat || seat)) out.seat = message.seat || seat;
  const attachments = journalAttachments(message);
  if (attachments) out.attachments = attachments;
  return cleanMessage(out) ?? out;
}

function messageKey(chatId: string, message: JournalMessage): string {
  return `tm_${hash(`${chatId}\u0000${JSON.stringify(message)}`)}_${hash(message.id)}`;
}

function localMessageFrom(
  message: JournalMessage,
  from: { seat: string },
  folders: readonly LinkedFolder[],
  previous?: ChatMessage,
): ChatMessage {
  const next: ChatMessage = {
    ...(previous ?? {}),
    id: message.id,
    role: message.role,
    text: restoreFolders(message.text, folders),
    createdAt: message.createdAt,
    kind: message.kind,
    thought: message.thought ? restoreFolders(message.thought, folders) : undefined,
    toolStatus: message.toolStatus,
    fromTitle: message.fromTitle,
    provider: message.provider,
    model: message.model,
    seat: message.seat,
  };
  if (message.attachments?.length && !previous?.images?.length) {
    next.teamAttachments = message.attachments.map((item) => ({ ...item, on: from.seat }));
  }
  return next;
}

/** A chat's in-flight turn: everything after its last prompt while it runs here. */
function inFlightFrom(session: Session): number {
  if (session.status !== "running" && session.status !== "needs-input") return session.messages.length;
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    if (session.messages[index].role === "user") return index + 1;
  }
  return 0;
}

function runningHere(session: Session): boolean {
  return session.status === "running" || session.status === "needs-input" || session.agentRun?.status === "running";
}

// ---------------------------------------------------------------------------------------------
// Sync one desk against the journal

export type TeamDesk = {
  projects: readonly Project[];
  sessions: readonly Session[];
  pending: readonly PermissionRequest[];
  usage: readonly UsageEvent[];
};

export type TeamSync = {
  sessions: Session[];
  baseline: Record<string, TeamChatMeta>;
  append: TeamEvent[];
  view: TeamView;
  changed: boolean;
};

/**
 * One pass for one team project on one desk: publish what this desk did, then
 * take what the other desks did.
 *
 * Title and archive use the baseline so a local edit is told apart from a
 * remote one. Messages are keyed by their content, so a desk that already has
 * a version never writes it back. A chat's turn that is running here is never
 * touched: its in-flight rows are not published and nothing arriving rewrites
 * them or its status.
 */
export function syncTeamProject(desk: TeamDesk, projectId: string, journal: readonly TeamEvent[], local: TeamLocal): TeamSync | null {
  const project = desk.projects.find((item) => item.id === projectId);
  const link = project?.team;
  if (!project || !link) return null;
  const journalId = link.journalId;
  const append: TeamEvent[] = [];
  const push = (item: TeamEvent) => append.push(item);
  let view = foldTeamJournal(journal);
  const baseline: Record<string, TeamChatMeta> = { ...(link.baseline ?? {}) };
  const folders = project.folders;
  const inProject = desk.sessions.filter((session) => session.projectId === projectId);
  const localIds = new Set(inProject.map((session) => session.id));

  // Publish
  for (const session of inProject) {
    if (!isTeamId(session.id)) continue;
    const mine = !session.team || session.team.device === local.device;
    const known = view.chats.get(session.id);
    const meta: TeamChatMeta = { title: session.title, archivedAt: session.archivedAt ?? null };
    if (!known) {
      if (!mine) continue;
      push(
        event(journalId, local, "chat.created", {
          id: `tch_${journalId}_${session.id}`,
          chat: {
            id: session.id,
            title: session.title,
            createdAt: session.messages[0]?.createdAt ?? local.now,
            provider: session.provider,
            model: session.model,
            ...(session.parentId && isTeamId(session.parentId) ? { parentId: session.parentId } : {}),
            ...(session.workerName ? { workerName: session.workerName } : {}),
          },
        }),
      );
      if (meta.archivedAt !== null) push(event(journalId, local, "chat.archived", { chatId: session.id, archivedAt: meta.archivedAt }));
    } else {
      const base = baseline[session.id];
      if (base && base.title !== meta.title) push(event(journalId, local, "chat.titled", { chatId: session.id, title: meta.title }));
      if (base && base.archivedAt !== meta.archivedAt) {
        push(event(journalId, local, "chat.archived", { chatId: session.id, archivedAt: meta.archivedAt }));
      }
    }
    if (mine) {
      const running = runningHere(session);
      const shown = known?.runningOn === local.device;
      if (running !== shown && (running || known)) push(event(journalId, local, "chat.run", { chatId: session.id, running }));
    }
    const settled = session.messages.slice(0, inFlightFrom(session));
    for (const message of settled) {
      const form = journalMessageOf(message, local.seat, folders);
      const id = messageKey(session.id, form);
      if (view.ids.has(id)) continue;
      view.ids.add(id);
      push(event(journalId, local, "message.put", { id, chatId: session.id, message: form }));
    }
  }

  for (const request of desk.pending) {
    if (!localIds.has(request.sessionId) || !isTeamId(request.sessionId)) continue;
    const id = `tpa_${hash(request.id)}_${hash(local.device)}`;
    if (view.ids.has(id)) continue;
    push(
      event(journalId, local, "permission.asked", {
        id,
        chatId: request.sessionId,
        requestId: request.id,
        tool: request.tool,
        detail: redactFolders(request.detail, folders),
      }),
    );
  }
  for (const card of view.waiting) {
    if (card.device !== local.device) continue;
    if (desk.pending.some((request) => request.id === card.requestId)) continue;
    push(event(journalId, local, "permission.answered", { chatId: card.chatId, requestId: card.requestId, answer: "closed" }));
  }

  for (const row of desk.usage) {
    if (row.projectId !== projectId) continue;
    const id = `tu_${hash(row.id)}_${hash(local.device)}`;
    if (view.ids.has(id)) continue;
    push(
      event(journalId, local, "usage.row", {
        id,
        row: {
          id: isTeamId(row.id) ? row.id : `u_${hash(row.id)}`,
          ...(row.sessionId && isTeamId(row.sessionId) ? { chatId: row.sessionId } : {}),
          provider: row.provider,
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          ...(typeof row.costUsd === "number" ? { costUsd: row.costUsd } : {}),
        },
      }),
    );
  }

  const safe = append.map((item) => sanitizeTeamEvent(item)).filter((item): item is TeamEvent => item !== null);
  if (safe.length > 0) view = foldTeamJournal([...journal, ...safe]);

  // Take
  let changed = safe.length > 0;
  const sessions = desk.sessions.map((session) => {
    if (session.projectId !== projectId) return session;
    const chat = view.chats.get(session.id);
    if (!chat) {
      baseline[session.id] = { title: session.title, archivedAt: session.archivedAt ?? null };
      return session;
    }
    let next = session;
    const base = baseline[session.id];
    const localMeta = { title: session.title, archivedAt: session.archivedAt ?? null };
    const remoteChanged = !base || base.title !== chat.title || base.archivedAt !== chat.archivedAt;
    if (remoteChanged && (localMeta.title !== chat.title || localMeta.archivedAt !== chat.archivedAt)) {
      next = { ...next, title: chat.title, archivedAt: chat.archivedAt };
    }
    if (next.team) {
      const runningOn = chat.runningOn;
      if (next.team.runningOn !== runningOn) next = { ...next, team: { ...next.team, ...(runningOn ? { runningOn } : { runningOn: undefined }) } };
    }
    if (!runningHere(session)) next = mergeMessages(next, view.messages.get(session.id), folders);
    baseline[session.id] = { title: next.title, archivedAt: next.archivedAt ?? null };
    if (next !== session) changed = true;
    return next;
  });

  for (const [chatId, chat] of view.chats) {
    if (sessions.some((session) => session.id === chatId)) continue;
    if (desk.sessions.some((session) => session.id === chatId)) continue;
    const arrived: Session = {
      id: chatId,
      projectId,
      ...(chat.record.parentId ? { parentId: chat.record.parentId, hidden: true } : {}),
      ...(chat.record.workerName ? { workerName: chat.record.workerName } : {}),
      provider: chat.record.provider,
      model: chat.record.model,
      effort: null,
      title: chat.title,
      mode: local.mode,
      sandbox: local.sandbox,
      status: "idle",
      messages: [],
      contextUsed: 0,
      archivedAt: chat.archivedAt,
      team: { device: chat.device, seat: chat.seat, ...(chat.runningOn ? { runningOn: chat.runningOn } : {}) },
    };
    sessions.push(mergeMessages(arrived, view.messages.get(chatId), folders));
    baseline[chatId] = { title: chat.title, archivedAt: chat.archivedAt };
    changed = true;
  }

  const sameBaseline = JSON.stringify(baseline) === JSON.stringify(link.baseline ?? {});
  return { sessions, baseline, append: safe, view, changed: changed || !sameBaseline };
}

type MessageRows = Map<string, { message: JournalMessage; device: string; seat: string; at: number }>;

function mergeMessages(session: Session, rows: MessageRows | undefined, folders: readonly LinkedFolder[]): Session {
  if (!rows) return session;
  let changed = false;
  const out = session.messages.map((message) => {
    const row = rows.get(message.id);
    if (!row) return message;
    if (JSON.stringify(journalMessageOf(message, "", folders)) === JSON.stringify(row.message)) return message;
    changed = true;
    return localMessageFrom(row.message, row, folders, message);
  });
  const have = new Set(session.messages.map((message) => message.id));
  for (const [id, row] of rows) {
    if (have.has(id)) continue;
    out.push(localMessageFrom(row.message, row, folders));
    changed = true;
  }
  if (!changed) return session;
  out.sort((a, b) => a.createdAt - b.createdAt);
  return { ...session, messages: out };
}

// ---------------------------------------------------------------------------------------------
// Presence

export function livePresence(beats: readonly PresenceBeat[], now: number): PresenceBeat[] {
  return beats.filter((beat) => isTeamId(beat.device) && now - beat.at >= -PRESENCE_TTL_MS && now - beat.at <= PRESENCE_TTL_MS);
}

/** People looking at this chat right now. Workers are not in it; they are on the crew tray. */
export function whoIsInChat(beats: readonly PresenceBeat[], chatId: string, now: number): string[] {
  return [...new Set(livePresence(beats, now).filter((beat) => beat.chatId === chatId).map((beat) => beat.seat))].sort();
}

export function offlineDevices(view: TeamView, beats: readonly PresenceBeat[], now: number, here: string): Array<{ device: string; seat: string }> {
  const live = new Set(livePresence(beats, now).map((beat) => beat.device));
  return view.devices.filter((row) => row.device !== here && !live.has(row.device));
}

export function sanitizePresence(raw: unknown): PresenceBeat | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const at = num(record.at);
  const seat = str(record.seat, 40);
  if (!isTeamId(record.device) || at === undefined || !seat) return null;
  return { device: record.device, seat, chatId: isTeamId(record.chatId) ? record.chatId : null, at };
}

// ---------------------------------------------------------------------------------------------
// Usage and the shared ceiling

export type TeamTotal = {
  tokens: number;
  costUsd: number;
  bySeat: Array<{ seat: string; tokens: number; costUsd: number }>;
  /** True while a member's desk is off: its newest rows may not be in the journal yet. */
  partial: boolean;
  offline: string[];
};

function rowTokens(row: Pick<TeamUsageRow, "inputTokens" | "outputTokens">): number {
  return row.inputTokens + row.outputTokens;
}

/**
 * The project's usage across every seat. Leftover percents are not in here:
 * they belong to each login and never enter the journal.
 */
export function teamProjectTotal(input: {
  view: TeamView;
  beats: readonly PresenceBeat[];
  now: number;
  device: string;
  seat: string;
  projectId: string;
  localUsage?: readonly UsageEvent[];
}): TeamTotal {
  const rows: Array<{ id: string; seat: string; tokens: number; costUsd: number }> = input.view.usage.map((row) => ({
    id: row.id,
    seat: row.seat,
    tokens: rowTokens(row),
    costUsd: row.costUsd ?? 0,
  }));
  const seen = new Set(rows.map((row) => row.id));
  for (const row of input.localUsage ?? []) {
    if (row.projectId !== input.projectId) continue;
    const id = isTeamId(row.id) ? row.id : `u_${hash(row.id)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, seat: input.seat, tokens: rowTokens(row), costUsd: row.costUsd ?? 0 });
  }
  const bySeat = new Map<string, { seat: string; tokens: number; costUsd: number }>();
  for (const row of rows) {
    const entry = bySeat.get(row.seat) ?? { seat: row.seat, tokens: 0, costUsd: 0 };
    entry.tokens += row.tokens;
    entry.costUsd += row.costUsd;
    bySeat.set(row.seat, entry);
  }
  const offline = offlineDevices(input.view, input.beats, input.now, input.device).map((row) => row.seat);
  return {
    tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    costUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
    bySeat: [...bySeat.values()].sort((a, b) => a.seat.localeCompare(b.seat)),
    partial: offline.length > 0,
    offline: [...new Set(offline)],
  };
}

/** Why the next send must stop, or null. Checked only when a send starts, so one in progress finishes. */
export function teamCeilingStop(total: Pick<TeamTotal, "tokens" | "costUsd">, ceiling: TeamCeiling | null): string | null {
  if (!ceiling) return null;
  if (ceiling.usd !== undefined && total.costUsd > ceiling.usd) {
    return `This project is over its shared ceiling: $${total.costUsd.toFixed(2)} of $${ceiling.usd.toFixed(2)}.`;
  }
  if (ceiling.tokens !== undefined && total.tokens > ceiling.tokens) {
    return `This project is over its shared ceiling: ${total.tokens} of ${ceiling.tokens} tokens.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Workshop

/** The grant record for one pack on this desk: pack, confirmed sources, and the host's label. Never its URL or token file. */
export function workshopGrantFor(
  settings: WorkshopSettings,
  hosts: readonly LocalComputeHostSettings[],
  packId: string,
): TeamWorkshopGrant | null {
  const pack = settings.packs.find((item) => item.id === packId);
  const host = hosts.find((item) => item.id === pack?.hostId);
  if (!pack || !host) return null;
  return { pack: pack.id, sources: [...pack.sources], host: host.label };
}

/** Which of this desk's hosts serves a grant, by label. A desk with none says so; it gets no cards. */
export function resolveWorkshopGrant(
  grant: TeamWorkshopGrant,
  hosts: readonly LocalComputeHostSettings[],
): { status: "ready"; hostId: string } | { status: "no-host"; message: string } {
  const host = hosts.find((item) => item.enabled && item.label.trim().toLowerCase() === grant.host.trim().toLowerCase());
  if (!host) return { status: "no-host", message: `No host named ${grant.host} on this desk.` };
  return { status: "ready", hostId: host.id };
}

// ---------------------------------------------------------------------------------------------
// Inbox owner

/**
 * Hand the inbox to a person by name, or take it. It is a label on the team,
 * not an answer to any card: the card still waits on the desk running its turn.
 */
export function inboxOwnerEvent(input: {
  view: TeamView;
  to: string;
  how: "handoff" | "take";
  local: Pick<TeamLocal, "device" | "seat" | "now">;
}): { event: TeamEvent } | { error: string } {
  const journal = input.view.journalId;
  if (!journal) return { error: "This project is not on a team." };
  if (!input.view.members.includes(input.local.seat)) return { error: "Join this team before handing its inbox." };
  const to = input.how === "take" ? input.local.seat : input.to.trim().replace(/^@+/, "");
  if (!input.view.members.includes(to)) return { error: `${to || "That name"} is not a person on this team.` };
  if (input.view.inbox.owner === to) return { error: `${to} already owns the inbox.` };
  return { event: event(journal, input.local, "inbox.owner", { owner: to, how: input.how }) };
}

export function ceilingEvent(view: TeamView, ceiling: TeamCeiling | null, local: Pick<TeamLocal, "device" | "seat" | "now">): TeamEvent | null {
  if (!view.journalId) return null;
  return sanitizeTeamEvent(event(view.journalId, local, "ceiling.set", { ceiling }));
}

export function workshopGrantEvent(view: TeamView, grant: TeamWorkshopGrant, local: Pick<TeamLocal, "device" | "seat" | "now">): TeamEvent | null {
  if (!view.journalId) return null;
  return sanitizeTeamEvent(event(view.journalId, local, "workshop.grant", { grant }));
}

export function permissionAnsweredEvent(
  journalId: string,
  request: Pick<PermissionRequest, "id" | "sessionId">,
  answer: "once" | "session" | "deny",
  local: Pick<TeamLocal, "device" | "seat" | "now">,
): TeamEvent | null {
  return sanitizeTeamEvent(event(journalId, local, "permission.answered", { chatId: request.sessionId, requestId: request.id, answer }));
}

/** A chat that is running on another desk can only be stopped there. */
export function canStopHere(session: Pick<Session, "team">, device: string): boolean {
  const runningOn = session.team?.runningOn;
  return !runningOn || runningOn === device;
}

export function normalizeTeamLink(raw: unknown): TeamLink | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (!isTeamId(record.journalId) || typeof record.folder !== "string" || !record.folder.trim()) return undefined;
  const baseline: Record<string, TeamChatMeta> = {};
  if (record.baseline && typeof record.baseline === "object") {
    for (const [id, value] of Object.entries(record.baseline as Record<string, unknown>)) {
      const row = value as Record<string, unknown> | null;
      if (!isTeamId(id) || !row || typeof row.title !== "string") continue;
      baseline[id] = { title: row.title, archivedAt: typeof row.archivedAt === "number" ? row.archivedAt : null };
    }
  }
  return {
    journalId: record.journalId,
    folder: record.folder,
    joinedAt: typeof record.joinedAt === "number" ? record.joinedAt : 0,
    ...(Object.keys(baseline).length > 0 ? { baseline } : {}),
  };
}

export function normalizeSessionTeam(raw: unknown): SessionTeamOrigin | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (!isTeamId(record.device) || typeof record.seat !== "string") return undefined;
  return { device: record.device, seat: record.seat.slice(0, 40), ...(isTeamId(record.runningOn) ? { runningOn: record.runningOn } : {}) };
}

export function normalizeHeldAttachments(raw: unknown): HeldAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: HeldAttachment[] = [];
  for (const item of raw) {
    const clean = cleanAttachment(item);
    const on = str((item as Record<string, unknown> | null)?.on, 40);
    if (clean && on) out.push({ ...clean, on });
  }
  return out.length > 0 ? out : undefined;
}

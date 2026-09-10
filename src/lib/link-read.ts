import type { ChatMessage, Session } from "./types";

/**
 * A Link helper reads through the desk while the desk is up.
 *
 * The helper used to answer every read by parsing the whole saved state file.
 * Fourteen helpers held 380 to 409 MB each that way. Now the desk answers from
 * the state it already holds in memory, so a helper carries one small reply and
 * is never handed a file caught half written.
 *
 * Every reply here is a subset of the saved shape: same field names, fewer
 * fields. That is the whole contract. It lets one reader serve both paths, so
 * when the desk is down the helper parses the file and the same code runs on it.
 *
 * Every projector is an allowlist. Each one names the fields it copies and
 * copies nothing else, so a field added to a session, a bot or the settings
 * later cannot reach a helper until someone writes its name here. A field that
 * carries a shape of its own gets its own list, so no projector copies an
 * object it has not read. `scrubLinkRead` runs after that as the second net,
 * for a value that arrives under a field the desk did not write.
 */

export const LINK_READ_ROUTES = ["chats", "chat", "capacity", "status"] as const;

export type LinkReadRoute = (typeof LINK_READ_ROUTES)[number];

/** Bound on a read route request body and on its reply. Bigger is refused, never cut. */
export const LINK_READ_MAX_BYTES = 256 * 1024;

/**
 * The roster is one row per live chat, so it grows with the desk while the
 * other three routes answer about one thing. A 29 MB desk of 587 chats
 * measured 325 KB here, so the roster gets its own wider bound.
 */
export const LINK_CHATS_MAX_BYTES = 1024 * 1024;

export function linkReadMaxBytes(route: LinkReadRoute): number {
  return route === "chats" ? LINK_CHATS_MAX_BYTES : LINK_READ_MAX_BYTES;
}

/**
 * Text kept on a message a listed chat still needs.
 *
 * The list reader slices a preview to 160 characters and takes the first line
 * of a worker's step, so this is already more than it reads. Sending whole
 * transcripts here put one reply at 6.5 MB against a 29 MB desk.
 */
export const LINK_LIST_MESSAGE_CHARS = 240;

/** Ledger window sent for a capacity read. Wider than any plan window the desk scores. */
export const LINK_CAPACITY_USAGE_DAYS = 32;

/** A read reply. Same field names as the saved file, so the file reader takes it unchanged. */
export type LinkReadState = {
  sessions?: unknown[];
  projects?: unknown[];
  settings?: unknown;
  usage?: unknown[];
  deskPlans?: unknown;
  watchPermits?: unknown;
  watchDayMarks?: unknown;
  externalTasks?: unknown;
};

export type LinkReadRequest = { route: LinkReadRoute; id: string; limit?: number };

/**
 * Keys that never leave the desk on a read route.
 *
 * The second latch, not the first. Every projector below names the fields it
 * copies, so a credential can only reach a helper if an allowlist asks for its
 * field AND this list does not know the name. This catches the case where
 * someone widens an allowlist without thinking, and it catches a value that
 * arrives under a field the desk itself did not write.
 *
 * Read against `src/lib/types.ts` end to end: every other field whose name or
 * comment says credential, token, key, secret, password, bearer, cookie, env or
 * a path to one of those is already here. Deliberately absent are the counters
 * (`tokenBudget`, `usedTokens`, `inputTokens`, `cacheReadTokens`) and the ids
 * that only read like keys: `idempotencyKey` is a request id,
 * `PermissionGrant.key` is a normalized scope, `lockKeys` names bots.
 */
const NEVER_SENT = new Set([
  "apiKey",
  "apikey",
  "credentialId",
  "envCredentialIds",
  "env",
  "token",
  "accessToken",
  "refreshToken",
  "bearer",
  "secret",
  "password",
  "cookie",
  "authorization",
  "bookmark",
  "data",
  // Settings.localCompute.hosts[].tokenFile. A path to a host's token file is
  // not a token, and it still has no business in a reply.
  "tokenFile",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** How deep the scrub walks before it stops trusting what it is looking at. */
export const LINK_SCRUB_MAX_DEPTH = 12;

/** What a shape past the depth cap becomes. Never the shape itself. */
export const LINK_SCRUB_TOO_DEEP = "[too deep to scrub]";

/**
 * Drop a credential, an environment value or attachment bytes wherever they sit.
 *
 * Past the cap the walk stops, so a record or a list below it would travel with
 * its keys never read: thirteen wraps around an `apiKey` used to be enough to
 * carry one out. A cap has to drop what it cannot check, so a shape that deep
 * becomes a marker string and a reader sees plainly that something was cut. A
 * scalar is kept, because its own key was already tested one level up and a
 * scalar hides nothing beneath it.
 */
export function scrubLinkRead<T>(value: T, depth = 0): T {
  if (depth > LINK_SCRUB_MAX_DEPTH) {
    return (isRecord(value) || Array.isArray(value) ? LINK_SCRUB_TOO_DEEP : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item) => scrubLinkRead(item, depth + 1)) as unknown as T;
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (NEVER_SENT.has(key)) continue;
    out[key] = scrubLinkRead(item, depth + 1);
  }
  return out as unknown as T;
}

/**
 * Copy the named fields and nothing else.
 *
 * Every list handed to this holds scalars and lists of scalars only. A field
 * that carries a shape of its own (`agentRun`, `routingDecision`, `hosts`) gets
 * its own list and its own call, so no projector ever copies an object it has
 * not read.
 */
function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

/** `pick` over a list of rows, dropping anything that is not a row. */
function pickRows(source: unknown, fields: readonly string[]): Record<string, unknown>[] | undefined {
  if (!Array.isArray(source)) return undefined;
  return source.filter(isRecord).map((row) => pick(row, fields));
}

/** `/link/chats`, `/link/chat/:id`, `/link/capacity`, `/link/status/:id`. */
export function parseLinkReadPath(pathName: string): LinkReadRequest | null {
  const [rawPath, rawQuery] = pathName.split("?");
  const parts = rawPath.split("/").filter(Boolean);
  if (parts[0] !== "link") return null;
  const route = LINK_READ_ROUTES.find((item) => item === parts[1]);
  if (!route) return null;
  if (parts.length > 3) return null;
  const id = parts[2] ? decodeURIComponent(parts[2]) : "";
  if ((route === "chat" || route === "status") && !id) return null;
  if ((route === "chats" || route === "capacity") && id) return null;
  const limit = Number(new URLSearchParams(rawQuery ?? "").get("limit"));
  return { route, id, ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}) };
}

export function linkReadPath(request: LinkReadRequest, from = ""): string {
  const base = request.id ? `/link/${request.route}/${encodeURIComponent(request.id)}` : `/link/${request.route}`;
  const query = new URLSearchParams();
  if (request.limit) query.set("limit", String(request.limit));
  if (from.trim()) query.set("from", from.trim());
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

/** Which route answers a read tool. A tool absent here still parses the file. */
export function linkReadRouteForTool(name: string, args: Record<string, unknown>, from: string): LinkReadRequest | null {
  if (name === "workhorse_list_chats") return { route: "chats", id: "" };
  if (name === "workhorse_read_chat") {
    const chat = typeof args.chat === "string" ? args.chat.trim() : "";
    if (!chat) return null;
    const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 40;
    return { route: "chat", id: chat, limit };
  }
  if (name === "workhorse_query_capacity") return { route: "capacity", id: "" };
  if (name === "workhorse_agent_status") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    return id ? { route: "status", id } : null;
  }
  // Capabilities reads one row: the calling chat's, for the desk role gate.
  if (name === "workhorse_capabilities") return from ? { route: "status", id: from } : null;
  return null;
}

type LooseMessage = Record<string, unknown>;

function messageRole(message: LooseMessage): string {
  return typeof message.role === "string" ? message.role : "";
}

function messageText(message: LooseMessage): string {
  return typeof message.text === "string" ? message.text : "";
}

/**
 * The few messages a listed chat still needs, in the order they were written.
 *
 * A running worker needs two more than a settled one: the tool line that says
 * what it is doing and the note that says when it last did anything.
 */
function keptListMessages(messages: LooseMessage[], running: boolean): { whole: Set<number>; roleOnly: Set<number> } {
  const kept = new Set<number>();
  const roleOnly = new Set<number>();
  const findLast = (match: (message: LooseMessage) => boolean) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (match(messages[index])) {
        kept.add(index);
        return;
      }
    }
  };
  // The chat preview.
  findLast((message) => messageRole(message) !== "system" && Boolean(messageText(message).trim()));
  // Whether a person ever wrote here, which decides if the chat is listed at
  // all. Only the role is asked for, so only the role travels.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messageRole(messages[index]) !== "user") continue;
    if (!kept.has(index)) roleOnly.add(index);
    break;
  }
  if (!running) return { whole: kept, roleOnly };
  // What this worker is doing now.
  findLast((message) => message.kind === "tool" && Boolean(messageText(message).trim()));
  // Its last note, which is both a step and a clock.
  findLast(
    (message) =>
      messageRole(message) === "assistant" &&
      message.kind !== "tool" &&
      message.kind !== "thought" &&
      Boolean(messageText(message).trim()),
  );
  // The clock again, which a plain user or tool line can also set.
  findLast((message) => Boolean(messageText(message).trim()));
  return { whole: kept, roleOnly };
}

/** Message text bound on a transcript read, so one long report cannot fill a reply. */
export const LINK_READ_MESSAGE_CHARS = 8_000;

function compactMessage(message: LooseMessage, chars = LINK_READ_MESSAGE_CHARS): LooseMessage {
  const text = messageText(message);
  const out: LooseMessage = {
    ...(typeof message.id === "string" ? { id: message.id } : {}),
    role: messageRole(message) || "system",
    text: text.length > chars ? text.slice(0, chars) : text,
    ...(typeof message.createdAt === "number" ? { createdAt: message.createdAt } : {}),
    ...(typeof message.kind === "string" ? { kind: message.kind } : {}),
    ...(typeof message.correlationId === "string" ? { correlationId: message.correlationId } : {}),
    ...(typeof message.peerFromSessionId === "string" ? { peerFromSessionId: message.peerFromSessionId } : {}),
  };
  return out;
}

function sessionMessages(session: LooseMessage): LooseMessage[] {
  return Array.isArray(session.messages) ? (session.messages as LooseMessage[]).filter(isRecord) : [];
}

/**
 * Every scalar a session row carries on a read route.
 *
 * An allowlist, not a filter. A field added to `Session` later cannot reach a
 * helper until its name is written here, whatever it is called. Each name is
 * here because a reader on one of the four routes asks for it: `catalogSessions`
 * decides which chats are listed and how each row prints, and
 * `workerStatusSnapshot` prints a worker's own row.
 *
 * What is not here is the weight and the desk's own business: the transcript
 * and its attachments, the composer draft, the vendor session handle, the
 * lineup, the plan, the ledger, the permission grants, the environment. No
 * reader on these routes asks for any of it.
 */
const SESSION_FIELDS = [
  "id",
  "parentId",
  "projectId",
  "title",
  "workerName",
  "hidden",
  "archivedAt",
  "provider",
  "model",
  "customBotId",
  "effort",
  "mode",
  "status",
  "routingMode",
] as const;

/** `RoutingDecision`: why Auto picked this bot. All scalars. */
const ROUTING_DECISION_FIELDS = [
  "at",
  "taskTier",
  "provider",
  "model",
  "effort",
  "customBotId",
  "score",
  "reason",
  "usedPercent",
  "expectedUsedPercent",
] as const;

/** `WorkerFinding`: the fixed review receipt. */
const FINDING_FIELDS = ["severity", "title", "file", "evidence"] as const;

/** `MissionIteration`: the campaign a worker is carrying. */
const MISSION_FIELDS = [
  "id",
  "mode",
  "objective",
  "acceptanceCriteria",
  "iteration",
  "maxIterations",
  "previousWorkerIds",
  "phase",
] as const;

/**
 * `AgentRun`, as the four routes read it: `workerStatusSnapshot` prints it,
 * `workerProgressCheckpoint` dates it, `deskRoleOf` reads the role, and the
 * completion watch settles a worker on status, `finishedAt` and `correlationId`.
 *
 * The budget meters, the granted seat and the skills a worker was handed are
 * the desk's own and stay there.
 */
const AGENT_RUN_FIELDS = [
  "status",
  "startedAt",
  "finishedAt",
  "error",
  "role",
  "correlationId",
  "changedFiles",
  "exclusions",
  "executionOwner",
  "takeoverReason",
  "usedTokens",
  "budgetPhase",
] as const;

function compactAgentRun(run: unknown): LooseMessage | undefined {
  if (!isRecord(run)) return undefined;
  const findings = pickRows(run.findings, FINDING_FIELDS);
  const mission = isRecord(run.mission) ? pick(run.mission, MISSION_FIELDS) : undefined;
  return {
    ...pick(run, AGENT_RUN_FIELDS),
    ...(findings ? { findings } : {}),
    ...(mission ? { mission } : {}),
  };
}

/**
 * One session row minus its weight. Attachments and composer drafts never
 * travel. The queue keeps the ids the preview filters on, nothing else.
 *
 * The row is built by naming what goes on it, so nothing rides out because a
 * spread carried it. The scrub after is the second net, not the first.
 */
function compactSession(session: LooseMessage, messages: LooseMessage[], count: number): LooseMessage {
  const queue = Array.isArray(session.queue)
    ? (session.queue as LooseMessage[])
        .filter(isRecord)
        .map((item) => (typeof item.userMessageId === "string" ? { userMessageId: item.userMessageId } : {}))
    : undefined;
  const run = compactAgentRun(session.agentRun);
  const routing = isRecord(session.routingDecision)
    ? pick(session.routingDecision, ROUTING_DECISION_FIELDS)
    : undefined;
  return scrubLinkRead({
    ...pick(session, SESSION_FIELDS),
    ...(routing ? { routingDecision: routing } : {}),
    ...(run ? { agentRun: run } : {}),
    messages,
    messageCount: count,
    ...(queue ? { queue } : {}),
  });
}

function isRunning(session: LooseMessage): boolean {
  const run = isRecord(session.agentRun) ? session.agentRun : {};
  const status = typeof run.status === "string" ? run.status : typeof session.status === "string" ? session.status : "";
  return status === "running";
}

function listSession(session: LooseMessage): LooseMessage {
  const messages = sessionMessages(session);
  const { whole, roleOnly } = keptListMessages(messages, isRunning(session));
  const kept = [...whole, ...roleOnly].sort((left, right) => left - right);
  return compactSession(
    session,
    kept.map((index) =>
      whole.has(index) ? compactMessage(messages[index], LINK_LIST_MESSAGE_CHARS) : { role: messageRole(messages[index]) },
    ),
    messages.length,
  );
}

function tailSession(session: LooseMessage, limit: number): LooseMessage {
  const messages = sessionMessages(session);
  return compactSession(
    session,
    messages.slice(-Math.max(1, limit)).map((message) => compactMessage(message)),
    messages.length,
  );
}

/** id and parentId only. The status reader walks the whole tree to place a worker. */
function treeSession(session: LooseMessage): LooseMessage {
  return {
    id: typeof session.id === "string" ? session.id : "",
    ...(typeof session.parentId === "string" ? { parentId: session.parentId } : {}),
  };
}

function compactProjects(projects: unknown): unknown[] {
  if (!Array.isArray(projects)) return [];
  return projects.filter(isRecord).map((project) => ({
    ...(typeof project.id === "string" ? { id: project.id } : {}),
    ...(typeof project.name === "string" ? { name: project.name } : {}),
  }));
}

/** A map the desk keyed itself, holding plain values. A shape under a key is dropped. */
function scalarMap(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === null || typeof value !== "object") out[key] = value;
  }
  return out;
}

/** `UsageEvent`: one line of the desk ledger. All scalars. */
const USAGE_FIELDS = [
  "id",
  "at",
  "provider",
  "model",
  "projectId",
  "sessionId",
  "customBotId",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
  "contextUsed",
  "source",
  "lane",
] as const;

/** The ledger lines one route asked for, each cut to the fields above. */
function compactUsage(usage: unknown, keep: (event: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  if (!Array.isArray(usage)) return [];
  return usage.filter(isRecord).filter(keep).map((event) => pick(event, USAGE_FIELDS));
}

/** `LlmLink`: whether a stock vendor is here and whether the desk can start it. */
const LLM_LINK_FIELDS = [
  "connected",
  "enabled",
  "available",
  "needsAuth",
  "launchable",
  "launchBlocker",
  "name",
  "color",
] as const;

/**
 * `CustomLlm`: the legacy single custom connection.
 *
 * `discovered` is what a provider last offered and is never saved on the bot,
 * so it is not sent either.
 */
const CUSTOM_LLM_FIELDS = [
  "connected",
  "baseUrl",
  "model",
  "contextWindow",
  "api",
  "source",
  "name",
  "color",
  "tested",
  "models",
] as const;

/** `CustomBot`: the roster row `deskCallCatalog` prints and meters. */
const CUSTOM_BOT_FIELDS = [
  "id",
  "name",
  "color",
  "baseUrl",
  "model",
  "models",
  "api",
  "contextWindow",
  "createdAt",
  "enabled",
] as const;

const WATCH_FIELDS = [
  "dailyLimitPercent",
  "lockDaily",
  "desktopNotify",
  "lockKeys",
  "blockSpentSpawns",
  "spentPercent",
] as const;

const ROUTING_FIELDS = [
  "enabled",
  "capacityAware",
  "preferExcess",
  "allowLocal",
  "reservePercent",
  "includeExternalAgents",
] as const;

const LEARNING_FIELDS = [
  "mode",
  "compilerProvider",
  "compilerModel",
  "compilerEffort",
  "compilerCustomBotId",
  "autoRetrieve",
] as const;

/** `LocalComputeHostSettings` minus `tokenFile`, which is where a host's token lives. */
const LOCAL_HOST_FIELDS = ["id", "label", "baseUrl", "enabled", "allowedCallerRoles", "allowedCapabilities"] as const;

/**
 * Settings for a capacity read: the bots, their meters and the watch that holds
 * them. Named field by field, because this is the object that holds every key
 * the desk owns.
 *
 * `mcpServers` is gone entirely. It carries `env`, `envCredentialIds` and a
 * command line that routinely has a key in `args`, and no reader on this route
 * asks for it. `profile` is the person's own name and nothing reads that here.
 * `access`, `skills`, `agentSystems` and `workshop` are the desk's own settings;
 * `normalizeSettings` fills each with its default when it is absent, so a
 * reader gets the same answer either way.
 */
function compactSettings(settings: unknown): LooseMessage | undefined {
  if (!isRecord(settings)) return undefined;
  const llms = isRecord(settings.llms) ? settings.llms : undefined;
  const stock: LooseMessage = {};
  for (const id of ["grok", "claude", "codex", "cursor"] as const) {
    const link = llms && isRecord(llms[id]) ? llms[id] : undefined;
    if (link) stock[id] = pick(link as Record<string, unknown>, LLM_LINK_FIELDS);
  }
  const custom = llms && isRecord(llms.custom) ? pick(llms.custom, CUSTOM_LLM_FIELDS) : undefined;
  const hosts = isRecord(settings.localCompute) ? pickRows(settings.localCompute.hosts, LOCAL_HOST_FIELDS) : undefined;
  return {
    llms: { ...stock, ...(custom ? { custom } : {}) },
    customBots: pickRows(settings.customBots, CUSTOM_BOT_FIELDS) ?? [],
    ...(isRecord(settings.usageBudgets) ? { usageBudgets: scalarMap(settings.usageBudgets) } : {}),
    ...(isRecord(settings.watch) ? { watch: pick(settings.watch, WATCH_FIELDS) } : {}),
    ...(isRecord(settings.routing) ? { routing: pick(settings.routing, ROUTING_FIELDS) } : {}),
    ...(isRecord(settings.learning) ? { learning: pick(settings.learning, LEARNING_FIELDS) } : {}),
    ...(hosts
      ? {
          localCompute: {
            ...(isRecord(settings.localCompute) && settings.localCompute.version !== undefined
              ? { version: settings.localCompute.version }
              : {}),
            hosts,
          },
        }
      : {}),
  };
}

/** `GrokPlanProduct`: one metered window inside a plan. */
const PLAN_PRODUCT_FIELDS = ["product", "label", "usagePercent", "resetsAt", "unlimited"] as const;

/** `GrokPlanUsage`: the official leftover the rings print. */
const PLAN_FIELDS = ["usedPercent", "leftPercent", "period", "resetsAt", "observedAt", "prepaidBalance"] as const;

function compactPlan(plan: unknown): LooseMessage | undefined {
  if (!isRecord(plan)) return undefined;
  const products = pickRows(plan.products, PLAN_PRODUCT_FIELDS);
  return { ...pick(plan, PLAN_FIELDS), ...(products ? { products } : {}) };
}

function compactDeskPlans(plans: unknown): LooseMessage | undefined {
  if (!isRecord(plans)) return undefined;
  const out: LooseMessage = {};
  for (const id of ["grok", "codex", "claude", "cursor"] as const) {
    const plan = compactPlan(plans[id]);
    if (plan) out[id] = plan;
  }
  if (isRecord(plans.custom)) {
    const custom: LooseMessage = {};
    for (const [id, plan] of Object.entries(plans.custom)) {
      const row = compactPlan(plan);
      if (row) custom[id] = row;
    }
    out.custom = custom;
  }
  return out;
}

/** `WatchPermit`: who was let past the daily bank, and for how long. */
const WATCH_PERMIT_FIELDS = ["untilReset", "day"] as const;

function compactWatchPermits(permits: unknown): LooseMessage | undefined {
  if (!isRecord(permits)) return undefined;
  const out: LooseMessage = {};
  for (const [key, permit] of Object.entries(permits)) {
    if (!isRecord(permit)) continue;
    const sessions = isRecord(permit.sessions) ? scalarMap(permit.sessions) : undefined;
    out[key] = { ...pick(permit, WATCH_PERMIT_FIELDS), ...(sessions ? { sessions } : {}) };
  }
  return out;
}

/** `WatchDayMark`: where a vendor's leftover stood when the day turned. */
const DAY_MARK_FIELDS = ["day", "leftover"] as const;

function compactWatchDayMarks(marks: unknown): LooseMessage | undefined {
  if (!isRecord(marks)) return undefined;
  const out: LooseMessage = {};
  for (const [key, mark] of Object.entries(marks)) {
    if (isRecord(mark)) out[key] = pick(mark, DAY_MARK_FIELDS);
  }
  return out;
}

/** `ExternalTask`: one slice sent out to OpenClaw or Hermes. */
const EXTERNAL_TASK_FIELDS = [
  "id",
  "status",
  "startedAt",
  "finishedAt",
  "workspace",
  "result",
  "evidence",
  "grantId",
] as const;

const EXTERNAL_REF_FIELDS = ["runtimeId", "agentId"] as const;

const ENVELOPE_FIELDS = ["traceId", "idempotencyKey", "origin", "visitedSystems", "hopCount"] as const;

function compactExternalTask(task: unknown): LooseMessage | undefined {
  if (!isRecord(task)) return undefined;
  const ref = isRecord(task.ref) ? pick(task.ref, EXTERNAL_REF_FIELDS) : undefined;
  const envelope = isRecord(task.envelope) ? pick(task.envelope, ENVELOPE_FIELDS) : undefined;
  return {
    ...pick(task, EXTERNAL_TASK_FIELDS),
    ...(ref ? { ref } : {}),
    ...(envelope ? { envelope } : {}),
  };
}

function sessionsOf(state: LinkReadState): LooseMessage[] {
  return Array.isArray(state.sessions) ? (state.sessions as LooseMessage[]).filter(isRecord) : [];
}

function callerRow(sessions: LooseMessage[], from: string): LooseMessage | null {
  const id = from.trim();
  if (!id) return null;
  const row = sessions.find((session) => session.id === id);
  return row ? listSession(row) : null;
}

/** `/link/chats`: every listed row, each carrying only what the list reader reads. */
export function projectLinkChats(state: LinkReadState, from = ""): LinkReadState {
  const sessions = sessionsOf(state);
  const listed = sessions.map(listSession);
  const hasCaller = Boolean(from.trim()) && listed.some((session) => session.id === from.trim());
  const caller = hasCaller ? null : callerRow(sessions, from);
  return {
    sessions: caller ? [...listed, caller] : listed,
    projects: compactProjects(state.projects),
  };
}

/**
 * `/link/chat/:id`: the desk matches the name, so a duplicate worker name is
 * refused here on the whole roster and not on a slice of it.
 */
export function projectLinkChat(
  state: LinkReadState,
  query: string,
  limit: number,
  from: string,
  match: (state: LinkReadState, query: string, from: string) => { id: string } | { error: string },
): LinkReadState | { error: string } {
  const resolved = match({ sessions: state.sessions, projects: state.projects }, query, from);
  if ("error" in resolved) return resolved;
  const sessions = sessionsOf(state);
  const found = sessions.find((session) => session.id === resolved.id);
  if (!found) return { error: `No Workhorse chat matches “${query}”` };
  const caller = resolved.id === from.trim() ? null : callerRow(sessions, from);
  return {
    sessions: caller ? [caller, tailSession(found, limit)] : [tailSession(found, limit)],
    projects: compactProjects(state.projects),
  };
}

/**
 * `/link/capacity`: plans, permits, day marks and the recent ledger. Every
 * field on every one of them is named above, and the scrub is the net after.
 */
export function projectLinkCapacity(state: LinkReadState, from = "", now = Date.now()): LinkReadState {
  const since = now - LINK_CAPACITY_USAGE_DAYS * 24 * 60 * 60 * 1000;
  const usage = compactUsage(state.usage, (event) => typeof event.at === "number" && event.at >= since);
  const sessions = sessionsOf(state);
  const caller = callerRow(sessions, from);
  const plans = compactDeskPlans(state.deskPlans);
  const permits = compactWatchPermits(state.watchPermits);
  const dayMarks = compactWatchDayMarks(state.watchDayMarks);
  return {
    settings: scrubLinkRead(compactSettings(state.settings)),
    usage: scrubLinkRead(usage),
    ...(plans ? { deskPlans: scrubLinkRead(plans) } : {}),
    ...(permits ? { watchPermits: scrubLinkRead(permits) } : {}),
    ...(dayMarks ? { watchDayMarks: scrubLinkRead(dayMarks) } : {}),
    ...(caller ? { sessions: [caller] } : {}),
  };
}

/**
 * `/link/status/:id`: the asked row whole, every other row as id and parent so
 * the reader can still tell a descendant from a stranger, and that row's spend.
 */
export function projectLinkStatus(state: LinkReadState, id: string, from = ""): LinkReadState {
  const wanted = id.trim();
  const sessions = sessionsOf(state);
  const keep = new Set([wanted, from.trim()].filter(Boolean));
  const rows = sessions.map((session) => (keep.has(String(session.id)) ? listSession(session) : treeSession(session)));
  const usage = compactUsage(state.usage, (event) => event.sessionId === wanted);
  const tasks = isRecord(state.externalTasks) ? state.externalTasks : null;
  const byId = tasks && isRecord(tasks.byId) ? tasks.byId : null;
  const task = byId ? compactExternalTask(byId[wanted]) : undefined;
  return {
    sessions: rows,
    usage: scrubLinkRead(usage),
    ...(task ? { externalTasks: { byId: { [wanted]: scrubLinkRead(task) } } } : {}),
  };
}

/** A reply that outgrows the bound is refused with a name, never quietly cut. */
export function boundLinkRead(text: string, max = LINK_READ_MAX_BYTES): { text: string } | { error: string } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= max) return { text };
  return { error: `link read reply is ${bytes} bytes, over the ${max} byte bound. Ask for a smaller slice.` };
}

export type LinkReadMessage = ChatMessage;
export type LinkReadSession = Session;

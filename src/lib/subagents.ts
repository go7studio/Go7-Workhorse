import { isExternalAgentAddress } from "./agent-runtime";
import { defaultModel, findChoice, modelsFor, parseEffort, withEffort } from "./models";
import { findSession, type SessionSnapshot } from "./session-bridge";
import type { AgentRun, EffortLevel, ProviderId, Session } from "./types";
import { looksLikeWorkerBrief, type DeskRole } from "./workhorse-rules";

export type { DeskRole };

export type SpawnRequest = {
  fromSessionId: string;
  prompt: string;
  description?: string;
  provider?: string;
  model?: string;
  customBotId?: string;
  chat?: string;
  effort?: string;
  timeoutSeconds?: number;
  tokenBudget?: number;
  isolation?: "worktree" | "shared";
  folder?: string;
  wait?: boolean;
  route?: "auto" | "quick" | "balanced" | "deep";
  planStepId?: string;
  rationale?: string;
  skills?: string[];
  capabilities?: string[];
  tools?: string[];
  constraints?: string[];
};

export type CustomBotHint = {
  id: string;
  name: string;
  model: string;
};

export type ResolvedSpawn = {
  provider: ProviderId;
  model: string;
  effort: EffortLevel | null;
  title: string;
  customBotId?: string;
};

const VENDOR_ALIASES: Record<string, ProviderId> = {
  grok: "grok",
  xai: "grok",
  x: "grok",
  codex: "codex",
  openai: "codex",
  gpt: "codex",
  chatgpt: "codex",
  terra: "codex",
  sol: "codex",
  luna: "codex",
  claude: "claude",
  anthropic: "claude",
  custom: "custom",
  minimax: "custom",
  minipax: "custom",
  cursor: "cursor",
  composer: "cursor",
};

function tokensOf(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseProviderId(value?: string): ProviderId | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "grok" || raw === "claude" || raw === "codex" || raw === "cursor" || raw === "custom") return raw;
  return VENDOR_ALIASES[raw] ?? null;
}

const VENDOR_FILLER = new Set(["please", "bot", "agent", "model", "the", "a", "an", "use", "call", "spawn"]);

/** True when the query is a vendor/model name (Sol, Codex, Grok), not a sidebar title. */
export function isBareVendorOrModel(query: string): boolean {
  const hinted = resolveModelHint(query);
  if (!hinted) return false;
  const tokens = tokensOf(query);
  if (tokens.length === 0 || tokens.length > 4) return false;
  return tokens.every((token) => {
    if (VENDOR_FILLER.has(token) || VENDOR_ALIASES[token] || parseProviderId(token)) return true;
    return modelsFor(hinted.provider).some((model) => `${model.id} ${model.name}`.toLowerCase().includes(token));
  });
}

export function resolveModelHint(query: string): { provider: ProviderId; model: string } | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const exact = findChoice(trimmed);
  if (exact) return { provider: exact.provider, model: exact.model };
  const tokens = tokensOf(trimmed);
  if (tokens.length === 0) return null;

  for (const provider of ["codex", "grok", "claude", "cursor", "custom"] as ProviderId[]) {
    for (const model of modelsFor(provider)) {
      const hay = `${model.id} ${model.name}`.toLowerCase();
      if (tokens.some((token) => token.length >= 3 && hay.includes(token))) {
        return { provider, model: model.id };
      }
    }
  }

  for (const token of tokens) {
    const alias = VENDOR_ALIASES[token];
    if (alias) return { provider: alias, model: defaultModel(alias).id };
  }
  return null;
}

export function isHiddenSession(session: Pick<Session, "hidden" | "parentId">): boolean {
  return Boolean(session.hidden);
}

export function isWorkerSession(
  session?: Pick<Session, "hidden" | "parentId" | "agentRun"> | { hidden?: boolean; parentId?: string | null; agentRun?: unknown } | null,
): boolean {
  return Boolean(session?.hidden || session?.agentRun);
}

export function deskRoleOf(
  session?: Pick<Session, "hidden" | "parentId" | "agentRun"> | { hidden?: boolean; parentId?: string | null; agentRun?: unknown } | null,
): DeskRole {
  if (!session) return "orchestrator";
  return isWorkerSession(session) ? "worker" : "orchestrator";
}

export const WORKER_SPAWN_ERROR =
  "Nested agent limit reached. A worker may create one bounded helper, and grandchildren cannot spawn again.";

export const MAX_AGENT_DEPTH = 2;
export const MAX_NESTED_CHILDREN = 1;
export const SPAWN_ONLY_PROMPT_ERROR = "Worker prompt is a spawn request, not a slice. Write the actual job.";

export const UNBOUND_SPAWN_ERROR =
  "No project folder is bound. Bind a project or pass an existing folder before spawning.";

/**
 * Workers are people, not paper cups.
 *
 * A worker used to be anonymous and disposable: every slice made a new hidden
 * chat, so one orchestrator finished a Grok 4.6 medium job and then started a
 * SECOND Grok 4.6 medium from cold for the next slice on the same project.
 * The first one already knew the tree, the task and what it had just read,
 * and all of that was thrown away.
 *
 * A name is what makes reuse possible: something the desk, the orchestrator
 * and the person can all point at. Plain English, no theme — the point is to
 * be memorable in a sidebar, not clever.
 */
export const WORKER_NAMES = [
  "Wren", "Dexter", "Marlow", "Piper", "Otis", "Hazel", "Rufus", "Nadia",
  "Silas", "Greta", "Milo", "Odette", "Barnaby", "Juno", "Casper", "Wanda",
] as const;

/** The first unused name, then Wren 2, Wren 3 — never a collision. */
export function nextWorkerName(taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (name) => name.trim().toLowerCase()).filter(Boolean));
  for (const name of WORKER_NAMES) {
    if (!used.has(name.toLowerCase())) return name;
  }
  for (let round = 2; ; round += 1) {
    for (const name of WORKER_NAMES) {
      const candidate = `${name} ${round}`;
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
  }
}

export type WorkerRecord = {
  id: string;
  workerName?: string;
  provider: ProviderId;
  model: string;
  effort: EffortLevel | null;
  customBotId?: string;
  projectId: string | null;
  parentId?: string;
  hidden?: boolean;
  archivedAt?: number;
  status: string;
  agentRun?: { status?: string };
};

/** Busy means it is mid-slice. Reusing a busy worker would queue behind it. */
export function workerIsFree(worker: Pick<WorkerRecord, "status" | "agentRun">): boolean {
  return worker.status !== "running" && worker.agentRun?.status !== "running";
}

/**
 * The worker this slice should go back to, or null to start a new one.
 *
 * Scoped to the asking chat and its project, because a name means something
 * to that orchestrator and its work — reaching across projects would hand a
 * worker context from a business it was never shown.
 *
 * Never reuses a BUSY worker. Fanning several slices out at once is the
 * point of the desk, and each of those needs its own worker; the duplicate
 * this fixes is the SEQUENTIAL one, where the first worker had long since
 * finished and was sitting idle with everything it had learned.
 */
export function findReusableWorker(
  want: {
    name?: string;
    provider: ProviderId;
    model: string;
    effort: EffortLevel | null;
    customBotId?: string;
  },
  workers: WorkerRecord[],
  scope: { parentId: string; projectId: string | null },
): WorkerRecord | null {
  const mine = workers.filter(
    (worker) =>
      worker.hidden &&
      !worker.archivedAt &&
      worker.parentId === scope.parentId &&
      worker.projectId === scope.projectId &&
      workerIsFree(worker),
  );
  const asked = want.name?.trim().toLowerCase();
  if (asked) {
    // Named is an address: it means that worker or a new one, never a
    // stranger wearing the name.
    return mine.find((worker) => worker.workerName?.trim().toLowerCase() === asked) ?? null;
  }
  const sameBot = mine.filter(
    (worker) =>
      worker.provider === want.provider &&
      worker.model === want.model &&
      (worker.effort ?? null) === (want.effort ?? null) &&
      (worker.customBotId ?? "") === (want.customBotId ?? ""),
  );
  // The most recently used one knows the most about where this work got to.
  return sameBot.length ? sameBot[sameBot.length - 1] : null;
}

export const WORKER_OMIT_TOOLS = [
  "workhorse_request_vendor",
  "workhorse_list_bots",
  "workhorse_plan",
] as const;

export function agentDepth(
  sessions: Array<{ id: string; parentId?: string | null }>,
  sessionId: string,
): number {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const seen = new Set<string>();
  let depth = 0;
  let current = byId.get(sessionId);
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    depth += 1;
    current = byId.get(current.parentId);
  }
  return depth;
}

export function nestedSpawnError(
  sessions: Array<{ id: string; parentId?: string | null; hidden?: boolean; agentRun?: unknown }>,
  parentId: string,
): string | null {
  const parent = sessions.find((session) => session.id === parentId);
  if (!isWorkerSession(parent)) return null;
  if (agentDepth(sessions, parentId) >= MAX_AGENT_DEPTH) return WORKER_SPAWN_ERROR;
  if (
    sessions.filter((session) => session.parentId === parentId && isWorkerSession(session)).length >= MAX_NESTED_CHILDREN
  ) {
    return WORKER_SPAWN_ERROR;
  }
  return null;
}

/**
 * A lineup is every bot on the desk, once. The cap used to be a flat 2, which
 * rejected the third spawn of the seven the desk skill itself asks for — the
 * orchestrator then reported "only two bots were callable", which was untrue.
 * Spend per vendor is the Watch daily bank's job, not this number's; this only
 * stops a runaway loop. The floor lets a one-vendor desk split a job in parts.
 */
export const MIN_ROOT_WORKERS = 4;

export function maxRootWorkers(deskBots: number): number {
  return Math.max(MIN_ROOT_WORKERS, Math.floor(deskBots));
}

export function rootSpawnError(
  sessions: Array<Pick<Session, "parentId" | "status" | "agentRun" | "hidden">>,
  parentId: string,
  limit = MIN_ROOT_WORKERS,
): string | null {
  const running = sessions.filter(
    (session) =>
      session.parentId === parentId &&
      isWorkerSession(session) &&
      (session.agentRun?.status === "running" || session.status === "running"),
  ).length;
  return running >= limit
    ? `This plan already has ${limit} workers running. Await one before spawning another.`
    : null;
}

/**
 * When a chat hands out work, the desk picks the bot for the slice unless the
 * orchestrator named one. This is the desk's own routing — Settings → Routing,
 * on unless the person turns it off. An explicit provider, model, or chat
 * always wins. It has nothing to do with a person's own chat, which routes
 * only when they set that chat to Auto.
 */
export function shouldAutoRouteSpawn(input: {
  routingEnabled: boolean;
  provider?: unknown;
  model?: unknown;
  chat?: unknown;
}): boolean {
  if (isExternalAgentAddress(input.provider) || isExternalAgentAddress(input.model) || isExternalAgentAddress(input.chat)) {
    return false;
  }
  return input.routingEnabled && !input.provider && !input.model && !input.chat;
}

export function spawnWaitsForReply(input: { wait?: unknown }): boolean {
  return input.wait === true || input.wait === "true" || input.wait === 1 || input.wait === "1";
}

export function parentHasRunningChildren(
  sessions: Array<Pick<Session, "parentId" | "status" | "agentRun" | "hidden">>,
  parentId: string,
): boolean {
  return sessions.some(
    (session) =>
      session.parentId === parentId &&
      isWorkerSession(session) &&
      (session.agentRun?.status === "running" || session.status === "running"),
  );
}

export function collectChildAgentReports(
  sessions: Session[],
  parentId: string,
): Array<{ title: string; status: string; text: string; childSessionId: string }> {
  return sessions
    .filter((session) => session.parentId === parentId && isWorkerSession(session))
    .map((session) => {
      const reply = [...session.messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.text.trim());
      return {
        title: session.title,
        status: session.agentRun?.status ?? session.status,
        text: reply?.text.trim() ?? "",
        childSessionId: session.id,
      };
    });
}

export function isWorkerOmittedTool(name: string): boolean {
  const key = name.trim();
  return (WORKER_OMIT_TOOLS as readonly string[]).includes(key);
}

export function workerOmittedToolError(name: string): string {
  if (name === "workhorse_request_vendor") return WORKER_SPAWN_ERROR;
  return "Workers cannot use this desk tool. Do the assigned slice and return the report.";
}

export function toolsForDeskRole<T extends { name: string }>(tools: T[], role: DeskRole = "orchestrator"): T[] {
  if (role !== "worker") return tools;
  return tools.filter((tool) => !isWorkerOmittedTool(tool.name));
}

export type WorkerBriefInput = {
  fromTitle: string;
  text: string;
  folder: string;
  project?: string;
  slice?: string;
  vendor?: string;
  constraints?: string[];
  skills?: Array<{ name: string; file: string }>;
  capabilities?: string[];
};

export function stripSpawnPreamble(text: string): string {
  let value = text.replace(/\r\n/g, "\n").trim();
  const patterns = [
    /^from another workhorse agent[^\n]*\n+/i,
    /^you are a[^\n]{0,160}(sub-?agent|worker)[^\n]*\n+/i,
    /^the user asked you to (spawn|summon|call)[^\n]*\n+/i,
    /^(please\s+)?(call|spawn|summon)\s+(sub-?agents?|agents?|bots?)[^\n]*\n+/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = value.replace(pattern, "").trim();
      if (next !== value) {
        value = next;
        changed = true;
      }
    }
  }
  return value;
}

export function isSpawnOnlyPrompt(text: string): boolean {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return true;
  if (looksLikeWorkerBrief(trimmed)) return false;
  const first = trimmed.split("\n")[0]?.trim() ?? "";
  const spawnLead =
    /^(please\s+)?(call|spawn|summon)\s+((a|an|the|some)\s+)?(sub-?agents?|agents?|bots?|vendors?|minimax|grok|codex|claude)\b/i;
  if (spawnLead.test(first) && !/\b(your slice|slice:)\b/i.test(trimmed)) return true;
  const only =
    /^(please\s+)?(call|spawn|summon)\s+((a|an|the|some)\s+)?((sub-?agents?|agents?|bots?|vendors?)(\s+and\s+(sub-?agents?|agents?|bots?))?)(\s+(for me|now))?\s*\.?$/i;
  const vendorOnly =
    /^(please\s+)?(call|spawn|summon)\s+((a|an|the)\s+)?(minimax|grok|codex|claude|sol|terra|luna)(\s+bot)?\s*\.?$/i;
  if (only.test(trimmed) || vendorOnly.test(trimmed)) return true;
  return !stripSpawnPreamble(trimmed);
}

export function formatWorkerPrompt(input: WorkerBriefInput): string {
  const folder = input.folder.trim();
  const project = input.project?.trim();
  const slice = input.slice?.trim();
  const vendor = input.vendor?.trim();
  const task = stripSpawnPreamble(input.text) || input.text.trim();
  const lines = [
    "ROLE: worker",
    `ORCHESTRATOR: ${input.fromTitle.trim() || "another agent"}`,
    `PROJECT: ${project || "(none — stop and say so)"}`,
    `FOLDER: ${folder || "(none — stop and say so)"}`,
  ];
  if (slice) lines.push(`SLICE: ${slice}`);
  if (vendor) lines.push(`VENDOR: ${vendor}`);
  if (input.constraints?.length) lines.push(`CONSTRAINTS: ${input.constraints.join("; ")}`);
  if (input.skills?.length) lines.push(`SKILLS: ${input.skills.map((skill) => `${skill.name} @ ${skill.file}`).join("; ")}`);
  if (input.capabilities?.length) lines.push(`CAPABILITIES: ${input.capabilities.join("; ")}`);
  lines.push("");
  lines.push("Do this slice only. Use list_dir / read_file on FOLDER. Quote real files.");
  if (input.skills?.length) lines.push("Read every listed SKILL.md fully before acting.");
  lines.push("For one independent check, you may spawn one quick-route helper with at most 5,000 tokens, then await it. That helper cannot spawn again.");
  lines.push("Do not list bots or request another vendor. Do not ask the user. Do not review any other tree.");
  lines.push("Return the report as plain text.");
  lines.push("");
  lines.push("TASK:");
  lines.push(task);
  return lines.join("\n");
}

export type SpawnAdmissionInput = {
  parent?: { parentId?: string | null; hidden?: boolean; projectId?: string | null } | null;
  projectFolder?: string;
  folder?: string;
  prompt: string;
  folderExists?: (path: string) => boolean;
  allowNested?: boolean;
};

export type SpawnAdmission = { ok: true; cwd: string } | { ok: false; error: string };

export function admitSpawn(input: SpawnAdmissionInput): SpawnAdmission {
  if (deskRoleOf(input.parent) === "worker" && !input.allowNested) return { ok: false, error: WORKER_SPAWN_ERROR };
  if (isSpawnOnlyPrompt(input.prompt)) return { ok: false, error: SPAWN_ONLY_PROMPT_ERROR };
  const cwd = (input.folder ?? "").trim() || (input.projectFolder ?? "").trim();
  if (!cwd) return { ok: false, error: UNBOUND_SPAWN_ERROR };
  if (input.folderExists && !input.folderExists(cwd)) {
    return { ok: false, error: `Folder does not exist: ${cwd}` };
  }
  return { ok: true, cwd };
}

export function subagentLabel(provider: ProviderId, model: string, description?: string): string {
  const named = description?.trim();
  if (named) return named;
  const vendor = { grok: "Grok", claude: "Claude", codex: "Codex", cursor: "Cursor", custom: "Custom" }[provider];
  const short = model.replace(/^gpt-/, "").replace(/^grok-/, "");
  return short && short !== model ? `${vendor} · ${short}` : vendor;
}

function matchCustomBot(bots: CustomBotHint[] | undefined, query: string): CustomBotHint | undefined {
  if (!bots?.length) return undefined;
  const lower = query.trim().toLowerCase();
  if (!lower) return undefined;
  const tokens = tokensOf(lower);
  return bots.find((bot) => {
    const name = bot.name.toLowerCase();
    const model = bot.model.toLowerCase();
    const id = bot.id.toLowerCase();
    return (
      name === lower ||
      model === lower ||
      id === lower ||
      tokens.some((token) => token.length >= 3 && (name.includes(token) || model.includes(token)))
    );
  });
}

export function resolveSpawnSpec(
  input: SpawnRequest,
  sessions: Array<Pick<Session, "id" | "title" | "provider" | "model" | "effort" | "customBotId" | "archivedAt">>,
  parent?: Pick<Session, "provider" | "effort" | "customBotId" | "model"> | null,
  customBots?: CustomBotHint[],
): ResolvedSpawn {
  const listed = sessions
    .filter((session) => typeof session.archivedAt !== "number")
    .map((session) => ({
      id: session.id,
      title: session.title,
      projectId: null,
      projectName: null,
      model: session.model,
      status: "idle",
      archived: false,
      preview: "",
      messageCount: 0,
      provider: session.provider,
    }));
  const chat = input.chat?.trim() ?? "";
  const assignedCustom = input.customBotId
    ? customBots?.find((bot) => bot.id === input.customBotId)
    : undefined;
  if (assignedCustom) {
    return {
      provider: "custom",
      model: input.model?.trim() || assignedCustom.model,
      customBotId: assignedCustom.id,
      effort: withEffort(
        "custom",
        input.model?.trim() || assignedCustom.model,
        parseEffort(input.effort ?? "") ?? parent?.effort ?? "medium",
      ),
      title: subagentLabel("custom", input.model?.trim() || assignedCustom.model, input.description || assignedCustom.name),
    };
  }
  const hintedQuery = [input.provider, input.model, input.chat, input.description].filter(Boolean).join(" ");
  const named =
    (chat && isBareVendorOrModel(chat) ? resolveModelHint(chat) : null) ??
    (isBareVendorOrModel(hintedQuery) ? resolveModelHint(hintedQuery) : null);
  const namedStock = named && named.provider !== "custom" ? named : null;

  const match = chat && !namedStock ? findSession(listed as SessionSnapshot[], chat) : null;
  const matched = match ? sessions.find((session) => session.id === match.id) : undefined;
  if (matched && !namedStock) {
    return {
      provider: matched.provider,
      model: matched.model,
      customBotId: matched.customBotId,
      effort: withEffort(matched.provider, matched.model, parseEffort(input.effort ?? "") ?? matched.effort),
      title: subagentLabel(matched.provider, matched.model, input.description || matched.title),
    };
  }

  const custom = !namedStock ? matchCustomBot(customBots, hintedQuery) : undefined;
  if (custom) {
    return {
      provider: "custom",
      model: custom.model,
      customBotId: custom.id,
      effort: withEffort("custom", custom.model, parseEffort(input.effort ?? "") ?? parent?.effort ?? "medium"),
      title: subagentLabel("custom", custom.model, input.description || custom.name),
    };
  }

  const parentCustom =
    !namedStock && parent?.provider === "custom" && (!input.provider || parseProviderId(input.provider) === "custom")
      ? customBots?.find((bot) => bot.id === parent.customBotId) ??
        customBots?.find((bot) => bot.model === parent.model) ??
        customBots?.[0]
      : undefined;
  if (parentCustom) {
    return {
      provider: "custom",
      model: input.model?.trim() || parentCustom.model,
      customBotId: parentCustom.id,
      effort: withEffort("custom", parentCustom.model, parseEffort(input.effort ?? "") ?? parent?.effort ?? "medium"),
      title: subagentLabel("custom", parentCustom.model, input.description || parentCustom.name),
    };
  }

  const explicit = parseProviderId(input.provider);
  const hinted = namedStock ?? named ?? (explicit ? null : resolveModelHint(hintedQuery));
  const provider = explicit ?? hinted?.provider ?? parent?.provider ?? "grok";
  const rawModel = input.model?.trim() ?? "";
  const mappedModel = rawModel
    ? resolveModelHint(rawModel) ?? resolveModelHint(`${provider} ${rawModel}`)
    : null;
  const model =
    mappedModel?.model ||
    (explicit && !rawModel ? defaultModel(provider).id : hinted?.model) ||
    (rawModel && !isBareVendorOrModel(rawModel) && !parseProviderId(rawModel) ? rawModel : defaultModel(provider).id);
  return {
    provider,
    model,
    effort: withEffort(provider, model, parseEffort(input.effort ?? "") ?? parent?.effort ?? "medium"),
    title: subagentLabel(provider, model, input.description),
  };
}

export function shouldSpawnInsteadOfAsk(chat: string, sessions: SessionSnapshot[]): boolean {
  if (findSession(sessions, chat)) return false;
  return resolveModelHint(chat) !== null;
}

export function formatSubagentPrompt(fromTitle: string, text: string, folder = ""): string {
  return formatWorkerPrompt({ fromTitle, text, folder });
}

export function withSubagentStatus(
  sessions: Session[],
  childId: string,
  status: string,
): Session[] {
  return sessions.map((session) => {
    if (!session.messages.some((message) => message.kind === "subagent" && message.subagentSessionId === childId)) {
      return session;
    }
    return {
      ...session,
      messages: session.messages.map((message) =>
        message.kind === "subagent" && message.subagentSessionId === childId
          ? { ...message, toolStatus: status }
          : message,
      ),
    };
  });
}

export function descendantSessionIds(sessions: Pick<Session, "id" | "parentId">[], parentId: string): string[] {
  const found = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (!session.parentId || found.has(session.id)) continue;
      if (session.parentId === parentId || found.has(session.parentId)) {
        found.add(session.id);
        changed = true;
      }
    }
  }
  return [...found];
}

/** What builds before the `interrupted` status wrote for the same thing. */
export const LEGACY_INTERRUPTED_ERROR = "Subagent was interrupted when Workhorse exited.";

export function normalizeAgentRun(raw: unknown): AgentRun | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Partial<AgentRun>;
  const statuses: AgentRun["status"][] = ["running", "completed", "failed", "cancelled", "timed-out", "budget-exceeded", "interrupted"];
  if (!statuses.includes(row.status as AgentRun["status"]) || typeof row.startedAt !== "number") return undefined;
  // A run still marked running when state was written is a run the desk never
  // got to finish. Calling that "failed" hid the one thing that mattered: the
  // worker was fine, and everything needed to pick it up again is right here.
  //
  // Builds before this wrote that verdict straight to disk, so a wave already
  // on disk reads as failed and the truth is gone — except the old code signed
  // its work. That exact sentence is its fingerprint, and no vendor failure
  // carries it, so an exact match recovers those runs without guessing.
  const interrupted =
    row.status === "running" || (row.status === "failed" && (row.error ?? "").trim() === LEGACY_INTERRUPTED_ERROR);
  return {
    status: interrupted ? "interrupted" : row.status as AgentRun["status"],
    startedAt: row.startedAt,
    isolation: row.isolation === "worktree" ? "worktree" : "shared",
    ...(typeof row.finishedAt === "number" ? { finishedAt: row.finishedAt } : interrupted ? { finishedAt: Date.now() } : {}),
    ...(typeof row.timeoutMs === "number" && row.timeoutMs > 0 ? { timeoutMs: row.timeoutMs } : {}),
    ...(typeof row.tokenBudget === "number" && row.tokenBudget > 0 ? { tokenBudget: Math.floor(row.tokenBudget) } : {}),
    ...(typeof row.usedTokens === "number" && row.usedTokens >= 0 ? { usedTokens: Math.floor(row.usedTokens) } : {}),
    ...(Array.isArray(row.changedFiles) ? { changedFiles: row.changedFiles.filter((item): item is string => typeof item === "string") } : {}),
    ...(Array.isArray(row.conflictFiles) ? { conflictFiles: row.conflictFiles.filter((item): item is string => typeof item === "string") } : {}),
    ...(typeof row.error === "string" && row.error.trim()
      ? { error: row.error.trim() }
      : interrupted
        ? { error: "Workhorse exited while this worker was running. Its brief and its work are kept — resume it from the chat." }
        : {}),
    ...(typeof row.planStepId === "string" && row.planStepId.trim() ? { planStepId: row.planStepId.trim() } : {}),
    ...(typeof row.rationale === "string" && row.rationale.trim() ? { rationale: row.rationale.trim() } : {}),
    ...(Array.isArray(row.skills) ? { skills: row.skills.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) } : {}),
    ...(Array.isArray(row.skillFiles) ? { skillFiles: row.skillFiles.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) } : {}),
    ...(Array.isArray(row.capabilities) ? { capabilities: row.capabilities.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) } : {}),
    ...(Array.isArray(row.tools) ? { tools: row.tools.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) } : {}),
    ...(typeof row.correlationId === "string" && row.correlationId.trim() ? { correlationId: row.correlationId.trim() } : {}),
  };
}

export function overlappingAgentFiles(
  sessions: Pick<Session, "id" | "parentId" | "agentRun">[],
  childId: string,
  files: string[],
): string[] {
  const child = sessions.find((session) => session.id === childId);
  if (!child?.parentId || child.agentRun?.isolation === "worktree") return [];
  const wanted = new Set(files.map((file) => file.replaceAll("\\", "/").toLowerCase()));
  const conflicts = new Set<string>();
  for (const sibling of sessions) {
    if (sibling.id === childId || sibling.parentId !== child.parentId || sibling.agentRun?.isolation === "worktree") continue;
    for (const file of sibling.agentRun?.changedFiles ?? []) {
      if (wanted.has(file.replaceAll("\\", "/").toLowerCase())) conflicts.add(file);
    }
  }
  return [...conflicts];
}

export function subagentTurns(
  session: Pick<Session, "messages"> | undefined,
  since = 0,
): Array<{ id: string; role: "user" | "assistant"; text: string; fromTitle?: string }> {
  if (!session) return [];
  const rows: Array<{ id: string; role: "user" | "assistant"; text: string; fromTitle?: string }> = [];
  for (const message of session.messages) {
    if (message.createdAt < since) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.kind === "tool" || message.kind === "compact" || message.kind === "thought" || message.kind === "subagent") {
      continue;
    }
    const text = message.text.trim();
    if (!text && message.role === "user") continue;
    rows.push({
      id: message.id,
      role: message.role,
      text,
      fromTitle: message.kind === "peer" ? message.fromTitle || "another agent" : undefined,
    });
  }
  return rows;
}

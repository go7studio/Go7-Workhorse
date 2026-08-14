import { defaultModel, findChoice, modelsFor, parseEffort, withEffort } from "./models";
import { findSession, type SessionSnapshot } from "./session-bridge";
import type { AgentRun, EffortLevel, ProviderId, Session } from "./types";

export type SpawnRequest = {
  fromSessionId: string;
  prompt: string;
  description?: string;
  provider?: string;
  model?: string;
  chat?: string;
  effort?: string;
  timeoutSeconds?: number;
  tokenBudget?: number;
  isolation?: "worktree" | "shared";
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
  if (raw === "grok" || raw === "claude" || raw === "codex" || raw === "custom") return raw;
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

  for (const provider of ["codex", "grok", "claude", "custom"] as ProviderId[]) {
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
  return Boolean(session.hidden || session.parentId);
}

export function subagentLabel(provider: ProviderId, model: string, description?: string): string {
  const named = description?.trim();
  if (named) return named;
  const vendor = { grok: "Grok", claude: "Claude", codex: "Codex", custom: "Custom" }[provider];
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
  parent?: Pick<Session, "provider" | "effort"> | null,
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

  const hinted = namedStock ?? named ?? resolveModelHint(hintedQuery);
  const provider = parseProviderId(input.provider) ?? hinted?.provider ?? (parent?.provider === "grok" ? "codex" : "grok");
  const rawModel = input.model?.trim() ?? "";
  const mappedModel = rawModel
    ? resolveModelHint(rawModel) ?? resolveModelHint(`${provider} ${rawModel}`)
    : null;
  const model =
    mappedModel?.model ||
    hinted?.model ||
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

export function formatSubagentPrompt(fromTitle: string, text: string): string {
  return `From another Workhorse agent (“${fromTitle}”):\n\n${text.trim()}`;
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

export function normalizeAgentRun(raw: unknown): AgentRun | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Partial<AgentRun>;
  const statuses: AgentRun["status"][] = ["running", "completed", "failed", "cancelled", "timed-out", "budget-exceeded"];
  if (!statuses.includes(row.status as AgentRun["status"]) || typeof row.startedAt !== "number") return undefined;
  const interrupted = row.status === "running";
  return {
    status: interrupted ? "failed" : row.status as AgentRun["status"],
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
        ? { error: "Subagent was interrupted when Workhorse exited." }
        : {}),
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

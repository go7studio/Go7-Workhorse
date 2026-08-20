import { customBotServes, findCustomBotByModel } from "./custom-bots";
import { projectedOccupancyAfterCompact } from "./portable-compaction";
import { contextWindowFor, largestKnownContextWindow, modelsFor, normalizeModelId, usageModelKey, usageToneForModel } from "./models";
import { PROVIDERS } from "./providers";
import { vendorLabel, vendorTint } from "./settings";
import {
  cursorUsageLane,
  cursorWatchKeyLabel,
  cursorWatchLane,
  isCursorWatchKey,
  type CursorUsageLane,
  type CursorWatchKey,
} from "./cursor-lane";
import type { CustomBot, GrokPlanProduct, GrokPlanUsage, LlmLink, ProviderId, Session, Settings, UsageDraft, UsageEvent, UsageRange, UsageSource } from "./types";

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  costKnown: boolean;
  events: number;
};

export type UsageGroup = UsageTotals & {
  key: string;
  label: string;
  provider: ProviderId;
  color?: string;
};

const EMPTY: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  costKnown: false,
  events: 0,
};

export function eventTotal(event: UsageEvent): number {
  return event.inputTokens + event.outputTokens + event.cacheWriteTokens;
}

function cursorLaneFromRecord(record: Record<string, unknown>, model: string): CursorUsageLane {
  const lane = record.lane;
  if (
    lane === "cursor-models" ||
    lane === "other-models" ||
    lane === "auto-cost" ||
    lane === "auto-routed" ||
    lane === "unknown"
  ) {
    return lane;
  }
  return cursorUsageLane(model);
}

export function contextFromEvent(event: { inputTokens: number; cacheReadTokens?: number }): number {
  return event.inputTokens + (event.cacheReadTokens ?? 0);
}

/** Window occupancy only. Ignores billed input+cache when it overshoots the model window. */
/** A billed compact is booked on the same bot that summarized. Never another ring. */
export function billedCompactUsage(input: {
  provider: ProviderId;
  model: string;
  sessionId: string;
  customBotId?: string;
  projectId?: string;
  inputTokens: number;
  outputTokens: number;
  at?: number;
  id?: string;
}): UsageEvent {
  return {
    id: input.id?.trim() || `use_compact_${input.sessionId}_${input.at ?? 0}`,
    at: input.at ?? Date.now(),
    provider: input.provider,
    model: input.model,
    sessionId: input.sessionId,
    ...(input.customBotId ? { customBotId: input.customBotId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    inputTokens: Math.max(0, Math.round(input.inputTokens)),
    outputTokens: Math.max(0, Math.round(input.outputTokens)),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    source: "compact",
  };
}

/**
 * Excerpt compact never rewrites leftover. A billed summary adds a UsageEvent
 * on that same bot. Leftover percent stays the official meter — we do not
 * invent it from tokens.
 */
export function applyCompactOutcome(input: {
  leftoverPercent: number;
  contextUsed: number;
  windowSize: number;
  omittedMessages: number;
  keptMessages: number;
  summaryChars: number;
  billed?: Parameters<typeof billedCompactUsage>[0];
  usage: UsageEvent[];
}): { leftoverPercent: number; contextUsed: number; usage: UsageEvent[] } {
  const contextUsed = projectedOccupancyAfterCompact({
    contextUsed: input.contextUsed,
    windowSize: input.windowSize,
    omittedMessages: input.omittedMessages,
    keptMessages: input.keptMessages,
    summaryChars: input.summaryChars,
  });
  const usage = input.billed ? [...input.usage, billedCompactUsage(input.billed)] : input.usage;
  return { leftoverPercent: input.leftoverPercent, contextUsed, usage };
}

export function occupancyFromUsage(
  draft: { contextUsed?: number; inputTokens?: number; cacheReadTokens?: number },
  windowSize: number,
): number | undefined {
  const window = Math.max(0, Math.round(windowSize));
  const reported = draft.contextUsed;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
    const value = Math.round(reported);
    if (window === 0 || value <= window) return value;
  }
  const billed = (draft.inputTokens ?? 0) + (draft.cacheReadTokens ?? 0);
  if (billed > 0 && (window === 0 || billed <= window)) return Math.round(billed);
  return undefined;
}

export function applyUsageContext(sessions: Session[], usage: UsageEvent[]): Session[] {
  const latest = new Map<string, UsageEvent>();
  for (const event of usage) {
    if (!event.sessionId || latest.has(event.sessionId)) continue;
    latest.set(event.sessionId, event);
  }
  return sessions.map((session) => {
    const event = latest.get(session.id);
    if (!event) {
      const window = contextWindowFor(session.provider, session.model);
      if (window > 0 && session.contextUsed > window) return { ...session, contextUsed: 0 };
      return session;
    }
    const window = contextWindowFor(session.provider, session.model);
    const occupancy = occupancyFromUsage(
      {
        contextUsed:
          event.contextUsed ?? (session.contextUsed > window && window > 0 ? undefined : session.contextUsed),
        inputTokens: event.inputTokens,
        cacheReadTokens: event.cacheReadTokens,
      },
      window,
    );
    if (occupancy === undefined) {
      return window > 0 && session.contextUsed > window ? { ...session, contextUsed: 0 } : session;
    }
    if (event.contextUsed !== undefined && session.contextUsed !== occupancy) {
      return { ...session, contextUsed: occupancy };
    }
    if (session.contextUsed !== occupancy && (session.contextUsed > occupancy * 1.5 || session.contextUsed > window)) {
      return { ...session, contextUsed: occupancy };
    }
    return session;
  });
}

export function rangeStart(range: UsageRange, now = Date.now()): number {
  if (range === "all") return 0;
  const date = new Date(now);
  if (range === "today") {
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  if (range === "week") return now - 7 * 24 * 60 * 60 * 1000;
  if (range === "month") return now - 30 * 24 * 60 * 60 * 1000;
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

export function inRange(event: UsageEvent, range: UsageRange, now = Date.now()): boolean {
  return event.at >= rangeStart(range, now);
}

function add(base: UsageTotals, event: UsageEvent): UsageTotals {
  const costKnown = base.costKnown || typeof event.costUsd === "number";
  return {
    inputTokens: base.inputTokens + event.inputTokens,
    outputTokens: base.outputTokens + event.outputTokens,
    cacheReadTokens: base.cacheReadTokens + event.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + event.cacheWriteTokens,
    totalTokens: base.totalTokens + eventTotal(event),
    costUsd: base.costUsd + (event.costUsd ?? 0),
    costKnown,
    events: base.events + 1,
  };
}

export function rollup(events: UsageEvent[]): UsageTotals {
  return events.reduce(add, { ...EMPTY });
}

export function byProvider(events: UsageEvent[]): UsageGroup[] {
  return PROVIDERS.map((provider) => {
    const slice = events.filter((event) => event.provider === provider.id);
    return { key: provider.id, label: provider.name, provider: provider.id, ...rollup(slice) };
  });
}

export type DeskUsageCard = UsageGroup & {
  focus: ProviderId | `bot:${string}` | CursorWatchKey;
  color?: string;
};

const DESK_VENDORS: Exclude<ProviderId, "custom">[] = ["grok", "codex", "claude", "cursor"];

export function usageProviderForSession(
  session?: { provider?: ProviderId } | null,
  fallback?: ProviderId,
): ProviderId {
  const provider = session?.provider ?? fallback;
  if (provider === "claude" || provider === "codex" || provider === "cursor" || provider === "custom" || provider === "grok") {
    return provider;
  }
  return "grok";
}

/**
 * Which desk bot a usage report belongs to, and so which provider it files
 * under. The session's provider was trusted first, because custom-bot usage
 * once arrived on the Grok channel stamped `grok` while the session knew
 * better. The other case is now real too: a worker spawned by a Cursor
 * orchestrator reports under the orchestrator's session, so the session says
 * `cursor` while the report says `custom` and names Kimi. The model is the
 * fact both sides agree on — a report naming a custom bot's model is that
 * bot's, whatever session it arrived under.
 */
export function usageHomeForReport(
  report: { provider?: ProviderId; model: string; customBotId?: string },
  owner: { provider?: ProviderId; customBotId?: string } | null | undefined,
  bots: Pick<CustomBot, "id" | "name" | "model" | "models">[],
): { provider: ProviderId; customBotId?: string } {
  if (report.customBotId && bots.some((bot) => bot.id === report.customBotId)) {
    return { provider: "custom", customBotId: report.customBotId };
  }
  if (report.provider === "custom" || owner?.provider === "custom") {
    if (owner?.customBotId && bots.some((bot) => bot.id === owner.customBotId)) {
      return { provider: "custom", customBotId: owner.customBotId };
    }
    const matches = bots.filter(
      (bot) => bot.model === report.model || bot.id === report.model || bot.name === report.model || customBotServes(bot, report.model),
    );
    return { provider: "custom", ...(matches.length === 1 ? { customBotId: matches[0]!.id } : {}) };
  }
  return { provider: usageProviderForSession(undefined, report.provider ?? owner?.provider) };
}

export function customBotUsageEvents(
  events: UsageEvent[],
  bot: Pick<CustomBot, "id" | "name" | "model" | "models">,
): UsageEvent[] {
  return events.filter((event) => {
    if (event.provider !== "custom") return false;
    if (event.customBotId) return event.customBotId === bot.id;
    return event.model === bot.model || event.model === bot.id || event.model === bot.name || customBotServes(bot, event.model);
  });
}

/** Move MiniMax/custom tokens that were stored as Grok onto the matching desk bot. */
export function rehomeCustomUsage(
  events: UsageEvent[],
  bots: Pick<CustomBot, "id" | "name" | "model" | "models">[],
  sessions: Pick<Session, "id" | "provider" | "customBotId" | "model">[] = [],
): UsageEvent[] {
  if (events.length === 0 || (bots.length === 0 && sessions.length === 0)) return events;
  return events.map((event) => {
    // An event filed under a desk vendor whose model is a custom bot's is that
    // bot's: a Kimi worker under a Cursor orchestrator was stored as
    // cursor/hf:moonshotai/Kimi-K3. Only an exact model match moves it — a
    // Cursor event on a Cursor model must stay where it is.
    const namedBot = findCustomBotByModel(bots, event.model);
    if (namedBot && event.provider !== "custom") {
      const { lane: _lane, ...rest } = event;
      return { ...rest, provider: "custom", customBotId: namedBot.id };
    }
    if (event.provider === "claude" || event.provider === "codex" || event.provider === "cursor") return event;
    const session = event.sessionId ? sessions.find((item) => item.id === event.sessionId) : undefined;
    if (session && session.provider !== "custom") return event;
    const sessionBotId = session?.provider === "custom" ? session.customBotId : undefined;
    const bot =
      bots.find((item) => item.id === event.customBotId || item.id === sessionBotId) ??
      findCustomBotByModel(bots, event.model) ??
      bots.find((item) => item.id === event.model || item.name === event.model);
    if (!bot) return event;
    if (!session && event.provider === "grok") return event;
    if (event.provider === "custom" && event.customBotId === bot.id) return event;
    return { ...event, provider: "custom", customBotId: bot.id };
  });
}

export function cursorLaneEvents(events: UsageEvent[], key: CursorWatchKey): UsageEvent[] {
  return events.filter((event) => {
    if (event.provider !== "cursor") return false;
    if (event.lane === "other-models" || event.lane === "auto-routed") return key === "cursor:other-models";
    if (event.lane === "cursor-models" || event.lane === "auto-cost") return key === "cursor:cursor-models";
    return cursorWatchLane(event.model) === key;
  });
}

export function deskUsageCards(
  events: UsageEvent[],
  settings: {
    llms: Settings["llms"] | { grok: LlmLink; claude: LlmLink; codex: LlmLink; cursor?: LlmLink };
    customBots: CustomBot[];
  },
): DeskUsageCard[] {
  const cards: DeskUsageCard[] = [];
  for (const id of DESK_VENDORS) {
    if (!settings.llms[id]?.connected) continue;
    if (id === "cursor") {
      for (const key of ["cursor:cursor-models", "cursor:other-models"] as const) {
        const slice = cursorLaneEvents(events, key);
        cards.push({
          key,
          focus: key,
          label: cursorWatchKeyLabel(key),
          provider: "cursor",
          color: vendorTint("cursor", settings.llms.cursor),
          ...rollup(slice),
        });
      }
      continue;
    }
    const slice = events.filter((event) => event.provider === id);
    cards.push({
      key: id,
      focus: id,
      label: vendorLabel(id, settings.llms[id]),
      provider: id,
      color: vendorTint(id, settings.llms[id]),
      ...rollup(slice),
    });
  }
  for (const bot of settings.customBots) {
    cards.push({
      key: bot.id,
      focus: `bot:${bot.id}`,
      label: bot.name,
      provider: "custom",
      color: bot.color,
      ...rollup(customBotUsageEvents(events, bot)),
    });
  }
  return cards;
}

export function vendorUsedPercent(
  row: Pick<DeskUsageCard, "focus" | "provider" | "key">,
  plans: {
    grok?: GrokPlanUsage;
    codex?: GrokPlanUsage;
    claude?: GrokPlanUsage;
    custom?: Record<string, GrokPlanUsage | undefined>;
  },
  events: UsageEvent[] = [],
  budget?: number,
  bot?: Pick<CustomBot, "id" | "name" | "model">,
): number {
  const plan = leftoverForCard(row, plans);
  if (plan && Number.isFinite(plan.usedPercent)) {
    return Math.min(100, Math.max(0, plan.usedPercent));
  }
  const slice =
    row.provider === "custom" && bot
      ? customBotUsageEvents(events, bot)
      : events.filter((event) => event.provider === row.provider);
  const used = rollup(slice).totalTokens;
  if (budget && budget > 0 && used > 0) return Math.min(100, (used / budget) * 100);
  return 0;
}

export function colorLuma(color: string): number | null {
  const match = color.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((part) => part + part).join("").slice(0, 6);
  else hex = hex.slice(0, 6);
  const red = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const green = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(hex.slice(4, 6), 16) / 255;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function tideNeedsDarkInk(
  vendorColor: string,
  provider: ProviderId,
  theme: "light" | "dark" | "workhorse",
): boolean {
  const luma = colorLuma(vendorColor);
  if (luma != null) return luma > 0.58;
  if (provider === "grok") return theme !== "light";
  return false;
}

/** Remaining allowance for the This chat tide. 99% left fills the box. */
export function vendorTidePercent(
  row: Pick<DeskUsageCard, "focus" | "provider" | "key">,
  plans: {
    grok?: GrokPlanUsage;
    codex?: GrokPlanUsage;
    claude?: GrokPlanUsage;
    custom?: Record<string, GrokPlanUsage | undefined>;
  },
  events: UsageEvent[] = [],
  budget?: number,
  bot?: Pick<CustomBot, "id" | "name" | "model">,
): number {
  const plan = leftoverForCard(row, plans);
  if (plan && Number.isFinite(plan.leftPercent)) {
    return Math.min(100, Math.max(0, plan.leftPercent));
  }
  return Math.min(100, Math.max(0, 100 - vendorUsedPercent(row, plans, events, budget, bot)));
}

export function leftoverForCard(
  row: Pick<DeskUsageCard, "focus" | "provider" | "key">,
  plans: {
    grok?: GrokPlanUsage;
    codex?: GrokPlanUsage;
    claude?: GrokPlanUsage;
    cursor?: GrokPlanUsage;
    custom?: Record<string, GrokPlanUsage | undefined>;
  },
): GrokPlanUsage | undefined {
  if (row.focus.startsWith("bot:")) {
    const id = row.focus.slice(4);
    return plans.custom?.[row.key] ?? plans.custom?.[id] ?? plans.custom?.[row.focus];
  }
  if (isCursorWatchKey(String(row.focus))) {
    return cursorLanePlan(plans.cursor, row.focus as CursorWatchKey);
  }
  if (row.provider === "cursor") {
    return cursorLanePlan(plans.cursor, cursorWatchLane(row.key));
  }
  if (row.provider === "grok") return plans.grok;
  if (row.provider === "codex") return plans.codex;
  if (row.provider === "claude") return plans.claude;
  return undefined;
}

/** Copy under the leftover ring when the weekly plan is missing. */
export function leftoverMissingCopy(input: {
  hasKey: boolean;
  fetchKnown: boolean;
  canLoad: boolean;
  planName: string;
}): string {
  if (!input.hasKey) return "This key isn't stored. Paste it on the bot in Settings to track leftover.";
  if (input.fetchKnown) return "Couldn't read weekly leftover for this key.";
  if (input.canLoad) return "Loading weekly plan usage…";
  return `Restart Workhorse to load ${input.planName} plan usage.`;
}

export function cursorLanePlan(plan: GrokPlanUsage | undefined, key: CursorWatchKey): GrokPlanUsage | undefined {
  if (!plan) return undefined;
  const productName = key === "cursor:other-models" ? "other-models" : "cursor-models";
  const product = plan.products.find((item) => item.product === productName);
  if (!product) return undefined;
  return {
    usedPercent: product.usagePercent,
    leftPercent: Math.max(0, 100 - product.usagePercent),
    period: "monthly",
    resetsAt: product.resetsAt ?? plan.resetsAt,
    prepaidBalance: 0,
    products: [product],
  };
}

const TIME_WINDOW = /^(session|weekly(_all|_scoped)?|primary|interval|five_hour|5h)$/i;
const SHORT_WINDOW = /^(session|primary|interval|five_hour|5h)$/i;
/**
 * The allowance: what the subscription grants over its billing period. Codex
 * calls its weekly `primary`, so this is by product id, not by label.
 */
const ALLOWANCE_WINDOW = /^(weekly(_all)?|primary)$/i;
/** A rate limit that refills within hours. Not an allowance. */
const BURST_WINDOW = /^(session|interval|five_hour|5h)$/i;

function clampLeftover(value: number): number {
  return Math.min(100, Math.max(0, value));
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1|[a-z0-9-]+\.local)$/i;

/** A model served from this machine. It has no allowance to report, ever. */
export function isLocalEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    return LOCAL_HOST.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export type PlanAllowance =
  | { status: "known"; leftPercent: number; window?: GrokPlanProduct }
  | { status: "unmetered"; why: "declared" | "dead-gauge" | "local" }
  | { status: "unknown" };

/**
 * How much of this plan is left, decided once.
 *
 * The ring, the MCP capacity snapshot and routing each used to answer this
 * their own way and disagree. On 2026-08-20 one MiniMax plan — weekly 0%, 5h
 * 100% — read `0%` on the ring, `known: 100` to the MCP, and `unmetered` to
 * routing. Kimi, weekly 47% used, read `100%` on the ring because the ring
 * showed the 5h burst instead of the allowance.
 *
 * A burst window is a rate limit, not an allowance: spending it means wait
 * twenty minutes, not the subscription is gone.
 */
export function planAllowance(
  plan: GrokPlanUsage | undefined,
  options: { local?: boolean; provider?: ProviderId } = {},
): PlanAllowance {
  // A model on this machine has no cap to report and never will.
  if (options.local) return { status: "unmetered", why: "local" };
  if (!plan) return { status: "unknown" };
  const windows = planTimeWindows(plan);
  const allowance =
    options.provider === "claude"
      ? windows.find((item) => item.product === "weekly_all")
      : windows.find((item) => ALLOWANCE_WINDOW.test(item.product));
  if (allowance?.unlimited) return { status: "unmetered", why: "declared" };
  if (allowance) {
    // A gauge reading exactly zero while a burst window drains is not a full
    // allowance — it is a gauge that never moves. MiniMax reports an
    // unlimited weekly seat that way, with no flag to say so.
    const burstDrawn = windows.some(
      (item) => BURST_WINDOW.test(item.product) && !item.unlimited && item.usagePercent > 0,
    );
    if (allowance.usagePercent === 0 && burstDrawn) return { status: "unmetered", why: "dead-gauge" };
    return { status: "known", leftPercent: clampLeftover(100 - allowance.usagePercent), window: allowance };
  }
  const metered = windows.find((item) => !item.unlimited);
  if (metered) {
    return { status: "known", leftPercent: clampLeftover(100 - metered.usagePercent), window: metered };
  }
  if (windows.length > 0) return { status: "unmetered", why: "declared" };
  if (Number.isFinite(plan.leftPercent)) return { status: "known", leftPercent: clampLeftover(plan.leftPercent) };
  return { status: "unknown" };
}

export function isPlanTimeWindow(product: string): boolean {
  return TIME_WINDOW.test(product);
}

export function planTimeWindows(plan: GrokPlanUsage | undefined): GrokPlanProduct[] {
  return (plan?.products ?? []).filter((item) => isPlanTimeWindow(item.product));
}

export function weeklyPlanLeftover(plan: GrokPlanUsage | undefined): number | undefined {
  if (!plan) return undefined;
  const weekly = plan.products.find((item) => /weekly/i.test(item.product));
  if (weekly?.unlimited) return undefined;
  if (weekly) return Math.min(100, Math.max(0, 100 - weekly.usagePercent));
  if (plan.products.some((item) => item.unlimited && /weekly/i.test(item.product))) return undefined;
  if (Number.isFinite(plan.leftPercent)) return Math.min(100, Math.max(0, plan.leftPercent));
  return undefined;
}

export function pickPlanWindow(
  plan: GrokPlanUsage | undefined,
  id?: string,
  provider?: ProviderId,
): GrokPlanProduct | undefined {
  const windows = planTimeWindows(plan);
  const pool = windows.length > 0 ? windows : (plan?.products ?? []);
  if (pool.length === 0) return undefined;
  if (id) {
    const hit = pool.find((item) => item.product === id);
    if (hit) return hit;
  }
  if (provider === "claude") {
    return pool.find((item) => item.product === "weekly_all") ?? pool[0];
  }
  return (
    pool.find((item) => !item.unlimited && SHORT_WINDOW.test(item.product)) ??
    pool.find((item) => !item.unlimited) ??
    pool[0]
  );
}

export function pickClaudeWindow(
  plan: GrokPlanUsage | undefined,
  id?: string,
): GrokPlanProduct | undefined {
  return pickPlanWindow(plan, id, "claude");
}

function claudeWindowTab(item: GrokPlanProduct): string {
  if (item.product === "session") return item.label === "5h" ? "5h" : "Session";
  if (item.product === "weekly_all" || item.product === "weekly") return "Weekly";
  return item.label;
}

export function claudeWindowTabs(plan: GrokPlanUsage | undefined): { id: string; label: string }[] {
  return (plan?.products ?? []).map((item) => ({ id: item.product, label: claudeWindowTab(item) }));
}

export function planWindowChip(
  plan: GrokPlanUsage | undefined,
  options: { local?: boolean; provider?: ProviderId } = {},
): string | undefined {
  const windows = planTimeWindows(plan);
  if (windows.length === 0) return undefined;
  const allowance = planAllowance(plan, options);
  const deadGauge = allowance.status === "unmetered" && allowance.why === "dead-gauge";
  return windows
    .map((item) => {
      // Once the allowance is judged unmetered, its gauge stops being a
      // number worth printing: "Weekly: 0%" is the fiction we just saw through.
      const uncapped = item.unlimited || (deadGauge && ALLOWANCE_WINDOW.test(item.product));
      return uncapped ? `${item.label}: ∞` : `${item.label}: ${Math.round(item.usagePercent)}%`;
    })
    .join(" · ");
}

/** All desk rings are leftover: 100% means the allowance is still full. ∞ means no cap. */
export function planRingView(
  row: Pick<DeskUsageCard, "focus" | "provider" | "key">,
  plans: Parameters<typeof leftoverForCard>[1],
  claudeWindow?: string,
  options: { local?: boolean } = {},
): { value: number; label: string; plan?: GrokPlanUsage; unmetered?: boolean } | undefined {
  const plan = leftoverForCard(row, plans);
  // A model on this machine reports no allowance because it has none. That is
  // an answer, not a gap, so it reads ∞ rather than the "…" of a meter we
  // tried and failed to read.
  if (!plan) return options.local ? { value: 1, label: "∞", unmetered: true } : undefined;
  // A window the person picked from the tabs wins: they asked for that one.
  if (claudeWindow) {
    const chosen = (plan.products ?? []).find((item) => item.product === claudeWindow);
    if (chosen) {
      if (chosen.unlimited) return { value: 1, label: "∞", plan, unmetered: true };
      const left = clampLeftover(100 - chosen.usagePercent);
      return { value: left / 100, label: `${Math.round(left)}%`, plan };
    }
  }
  const allowance = planAllowance(plan, { ...options, provider: row.provider });
  if (allowance.status === "unmetered") return { value: 1, label: "∞", plan, unmetered: true };
  if (allowance.status === "known") {
    return { value: allowance.leftPercent / 100, label: `${Math.round(allowance.leftPercent)}%`, plan };
  }
  return undefined;
}

export function formatPlanReset(iso?: string, now = Date.now()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const delta = date.getTime() - now;
  if (delta > 0 && delta < 12 * 60 * 60 * 1000) {
    const hours = Math.floor(delta / 3_600_000);
    const minutes = Math.max(0, Math.round((delta % 3_600_000) / 60_000));
    if (hours <= 0) return `Resets in ${minutes} min`;
    return `Resets in ${hours} hr${minutes ? ` ${minutes} min` : ""}`;
  }
  return `Resets ${date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

function customBotForEvent(event: UsageEvent, bots: HeatBotHint[]): HeatBotHint | undefined {
  if (event.customBotId) {
    const hit = bots.find((bot) => bot.id === event.customBotId);
    if (hit) return hit;
  }
  const slug = usageModelKey(event.model);
  return bots.find(
    (bot) =>
      usageModelKey(bot.model) === slug || usageModelKey(bot.name) === slug || bot.id === event.model,
  );
}

export function byModel(events: UsageEvent[], customBots: CustomBot[] = []): UsageGroup[] {
  const map = new Map<string, UsageGroup>();
  for (const event of events) {
    const provider = event.provider;
    const model = normalizeModelId(provider, event.model);
    const bot = provider === "custom" ? customBotForEvent(event, customBots) : undefined;
    const key = bot ? `bot:${bot.id}:${usageModelKey(model)}` : `${provider}:${usageModelKey(model)}`;
    const current = map.get(key) ?? {
      key,
      label: model,
      provider,
      ...(bot?.color ? { color: bot.color } : {}),
      ...EMPTY,
    };
    map.set(key, {
      ...add(current, event),
      key,
      label: model,
      provider,
      ...(current.color ? { color: current.color } : {}),
    });
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

export type UsageDay = {
  key: string;
  letter: string;
  totalTokens: number;
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_LETTERS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

function startOfDay(now: number): Date {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function weekDays(events: UsageEvent[], now = Date.now()): UsageDay[] {
  return stretchBuckets(events, "week", now);
}

export function stretchBuckets(events: UsageEvent[], range: UsageRange, now = Date.now()): UsageDay[] {
  if (range === "today") {
    const start = startOfDay(now);
    const parts: { key: string; letter: string; fromHour: number }[] = [
      { key: "night", letter: "Night", fromHour: 0 },
      { key: "morning", letter: "Morning", fromHour: 6 },
      { key: "afternoon", letter: "Afternoon", fromHour: 12 },
      { key: "evening", letter: "Evening", fromHour: 18 },
    ];
    return parts.map((part) => {
      const from = start.getTime() + part.fromHour * 60 * 60 * 1000;
      const to = from + 6 * 60 * 60 * 1000;
      return {
        key: part.key,
        letter: part.letter,
        totalTokens: rollup(events.filter((event) => event.at >= from && event.at < to)).totalTokens,
      };
    });
  }

  if (range === "week") {
    const monday = startOfDay(now);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const days: UsageDay[] = [];
    for (let index = 0; index < 7; index += 1) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + index);
      const from = day.getTime();
      const to = from + 24 * 60 * 60 * 1000;
      days.push({
        key: `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`,
        letter: DAY_NAMES[day.getDay()] ?? "Monday",
        totalTokens: rollup(events.filter((event) => event.at >= from && event.at < to)).totalTokens,
      });
    }
    return days;
  }

  if (range === "month") {
    const first = startOfDay(now);
    first.setDate(1);
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const weeks: UsageDay[] = [];
    for (let startDate = 1; startDate <= daysInMonth; startDate += 7) {
      const endDate = Math.min(startDate + 6, daysInMonth);
      const from = new Date(first.getFullYear(), first.getMonth(), startDate).getTime();
      const to = new Date(first.getFullYear(), first.getMonth(), endDate + 1).getTime();
      weeks.push({
        key: `${first.getFullYear()}-${first.getMonth() + 1}-w${startDate}`,
        letter: `${startDate}–${endDate}`,
        totalTokens: rollup(events.filter((event) => event.at >= from && event.at < to)).totalTokens,
      });
    }
    return weeks;
  }

  const cursor = startOfDay(now);
  cursor.setDate(1);
  cursor.setMonth(cursor.getMonth() - 11);
  const months: UsageDay[] = [];
  for (let index = 0; index < 12; index += 1) {
    const from = new Date(cursor.getFullYear(), cursor.getMonth() + index, 1).getTime();
    const to = new Date(cursor.getFullYear(), cursor.getMonth() + index + 1, 1).getTime();
    const stamp = new Date(from);
    months.push({
      key: `${stamp.getFullYear()}-${stamp.getMonth() + 1}`,
      letter: MONTH_LETTERS[stamp.getMonth()] ?? "J",
      totalTokens: rollup(events.filter((event) => event.at >= from && event.at < to)).totalTokens,
    });
  }
  return months;
}

export type HeatBot = {
  provider: ProviderId;
  key?: string;
  label: string;
  color?: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
};

type HeatBotHint = Pick<CustomBot, "id" | "name" | "model" | "color">;

export type VendorLooks = Partial<
  Record<Exclude<ProviderId, "custom">, Pick<LlmLink, "name" | "color">>
>;

export function heatCellBots(
  events: UsageEvent[],
  customBots: HeatBotHint[] = [],
  looks: VendorLooks = {},
): HeatBot[] {
  const rows = new Map<string, HeatBot>();
  for (const event of events) {
    const bot = customBotForEvent(event, customBots);
    const provider = bot ? "custom" : usageToneForModel(event.model, event.provider);
    const look = provider === "custom" ? undefined : looks[provider];
    const key = bot ? `bot:${bot.id}` : provider;
    const current = rows.get(key);
    const tokens = (current?.tokens ?? 0) + eventTotal(event);
    const inputTokens = (current?.inputTokens ?? 0) + event.inputTokens;
    const outputTokens = (current?.outputTokens ?? 0) + event.outputTokens;
    rows.set(key, {
      provider,
      key: bot?.id ?? current?.key,
      label: bot?.name || look?.name?.trim() || (provider === "custom" ? "Custom" : PROVIDERS.find((item) => item.id === provider)?.name || provider),
      color: bot?.color || look?.color || current?.color,
      tokens,
      inputTokens,
      outputTokens,
    });
  }
  return [...rows.values()].filter((row) => row.tokens > 0);
}

export function vendorInk(provider: ProviderId, color?: string): string {
  return color && color.trim() ? color : `var(--${provider})`;
}

/** Sunset, magenta, violet, blue — the layers in the Workhorse mark. */
export const HORSE_NATIVE_INKS = ["#fc561e", "#f0245d", "#6f21e7", "#2040e0"] as const;

export type ProfileHorseInk = {
  key: string;
  label: string;
  color: string;
  tokens: number;
  share: number;
};

function withHorseShares(inks: Array<Omit<ProfileHorseInk, "share">>): ProfileHorseInk[] {
  const total = inks.reduce((sum, ink) => sum + ink.tokens, 0) || 1;
  return inks.map((ink) => ({ ...ink, share: ink.tokens / total }));
}

/** Unique inks for bots that have billed usage. Empty means show the native mark. */
export function profileHorseInks(
  usage: UsageEvent[],
  settings: {
    customBots: CustomBot[];
    llms: Settings["llms"];
  },
): ProfileHorseInk[] {
  const bots = heatCellBots(usage, settings.customBots, {
    grok: settings.llms.grok,
    claude: settings.llms.claude,
    codex: settings.llms.codex,
    cursor: settings.llms.cursor,
  });
  if (bots.length === 0) {
    return withHorseShares(
      HORSE_NATIVE_INKS.map((color, index) => ({
        key: `horse-${index}`,
        label: "Workhorse",
        color,
        tokens: 1,
      })),
    );
  }
  return withHorseShares(
    [...bots]
      .sort((a, b) => b.tokens - a.tokens)
      .map((bot) => ({
        key: bot.key ? `bot:${bot.key}` : bot.provider,
        label: bot.label,
        color: vendorInk(bot.provider, bot.color),
        tokens: bot.tokens,
      })),
  );
}

/** Keep 1% bots as a speck; drop true trace spend. */
export function profileHorseVisualInks(inks: ProfileHorseInk[]): ProfileHorseInk[] {
  const used = inks.filter((ink) => !ink.key.startsWith("horse-"));
  if (used.length === 0) return inks;
  const visible = used.filter((ink) => ink.share >= 0.01);
  const source = visible.length > 0 ? visible : used.slice(0, 1);
  return withHorseShares(
    source.map((ink) => ({
      key: ink.key,
      label: ink.label,
      color: ink.color,
      tokens: ink.tokens,
    })),
  );
}

export const HORSE_BLOB_COUNT = 64;

export type ProfileHorseBlob = {
  key: string;
  color: string;
  left: number;
  top: number;
  size: number;
  delay: number;
  duration: number;
  driftX: number;
  driftY: number;
};

/** Irregular drifting blobs. Count follows share; colors stay themselves. */
export function profileHorseBlobs(inks: ProfileHorseInk[], count = HORSE_BLOB_COUNT): ProfileHorseBlob[] {
  if (inks.length === 0) return [];
  const picks: ProfileHorseInk[] = [];
  const errors = inks.map(() => 0);
  for (let index = 0; index < count; index += 1) {
    let best = 0;
    for (let slot = 0; slot < inks.length; slot += 1) {
      errors[slot] += inks[slot].share;
      if (errors[slot] > errors[best]) best = slot;
    }
    errors[best] -= 1;
    picks.push(inks[best]);
  }
  return picks.map((ink, index) => {
    const radius = Math.sqrt((index + 0.5) / count) * 44;
    const angle = index * 2.399963229728653;
    const left = Math.min(92, Math.max(8, 50 + Math.cos(angle) * radius + (((index * 0.6180339887) % 1) - 0.5) * 16));
    const top = Math.min(92, Math.max(8, 50 + Math.sin(angle) * radius * 1.08 + (((index * 0.4142135623) % 1) - 0.5) * 16));
    const signX = index % 2 === 0 ? 1 : -1;
    const signY = index % 3 === 0 ? -1 : 1;
    return {
      key: `${ink.key}-${index}`,
      color: ink.color,
      left,
      top,
      size: 8 + ((index * 17) % 15),
      delay: -((index * 0.73) % 11),
      duration: 2.8 + ((index * 13) % 70) / 10,
      driftX: signX * (5 + ((index * 11) % 16) * 0.25),
      driftY: signY * (4.5 + ((index * 7) % 14) * 0.25),
    };
  });
}

export type ProfileHorseTip = {
  title: "Your Workhorse";
  blurb: string;
  parts: ProfileHorseInk[];
};

export function profileHorseTip(inks: ProfileHorseInk[]): ProfileHorseTip {
  const used = inks.filter((ink) => !ink.key.startsWith("horse-"));
  if (used.length === 0) {
    return {
      title: "Your Workhorse",
      blurb: "Your usage colors the mark.",
      parts: [],
    };
  }
  return {
    title: "Your Workhorse",
    blurb: "Made from the bots you have called.",
    parts: used,
  };
}

function pct(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
}

export type StretchBlend = UsageRange;

type HeatSlice = { color: string; start: number; end: number };

function heatSlices(bots: HeatBot[]): HeatSlice[] {
  const total = bots.reduce((sum, bot) => sum + bot.tokens, 0);
  if (total <= 0) return [];
  let at = 0;
  return bots.map((bot) => {
    const start = at;
    at += (bot.tokens / total) * 100;
    return { color: vendorInk(bot.provider, bot.color), start, end: at };
  });
}

/** Mix at each slice seam, in percent of the circle. */
const PIE_SEAM = (2 / 360) * 100;

function seamFade(span: number, neighbor: number): number {
  return Math.min(PIE_SEAM, Math.max(0, span) / 2, Math.max(0, neighbor) / 2);
}

function conicPie(slices: HeatSlice[]): string {
  if (slices.length === 0) return "";
  if (slices.length === 1) return `${slices[0].color} 0% 100%`;
  const spans = slices.map((slice) => Math.max(0, slice.end - slice.start));
  const stops = slices.map((slice, index) => {
    const fadeIn = seamFade(spans[index], spans[(index + slices.length - 1) % slices.length]);
    const fadeOut = seamFade(spans[index], spans[(index + 1) % slices.length]);
    return `${slice.color} ${pct(slice.start + fadeIn)}% ${pct(slice.end - fadeOut)}%`;
  });
  return `conic-gradient(from -90deg, ${stops.join(", ")})`;
}

/** Clock pie for every This-stretch range, with a hairline blend at each seam. */
export function cellDotBackground(
  cell: Pick<HeatCell, "tokens" | "bots" | "pad">,
  _peak: number,
  _blend: StretchBlend = "today",
): string | undefined {
  if (cell.pad || cell.tokens <= 0 || cell.bots.length === 0) return undefined;
  if (cell.bots.length === 1) {
    return vendorInk(cell.bots[0].provider, cell.bots[0].color);
  }
  const slices = heatSlices(cell.bots);
  if (slices.length === 0) return undefined;
  return conicPie(slices);
}

export type HeatCell = {
  key: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  bots: HeatBot[];
  label: string;
  pad?: boolean;
};

export type StretchHeatmap = {
  rows: number;
  columns: HeatCell[][];
  labels: { text: string; column: number }[];
};

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function mondayOnOrBefore(date: Date): Date {
  const monday = startOfDay(date.getTime());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

function sliceCell(
  events: UsageEvent[],
  from: number,
  to: number,
  key: string,
  label: string,
  pad = false,
  customBots: HeatBotHint[] = [],
  looks: VendorLooks = {},
): HeatCell {
  if (pad) {
    return { key, tokens: 0, inputTokens: 0, outputTokens: 0, bots: [], label, pad: true };
  }
  const slice = events.filter((event) => event.at >= from && event.at < to);
  const totals = rollup(slice);
  return {
    key,
    tokens: totals.totalTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    bots: heatCellBots(slice, customBots, looks),
    label,
    pad: false,
  };
}

function weekGrid(
  events: UsageEvent[],
  from: Date,
  to: Date,
  customBots: HeatBotHint[] = [],
  looks: VendorLooks = {},
): StretchHeatmap {
  const columns: HeatCell[][] = [];
  const labels: { text: string; column: number }[] = [];
  let cursor = mondayOnOrBefore(from);
  let lastMonth = -1;
  let column = 0;
  const end = to.getTime();
  const start = from.getTime();
  while (cursor.getTime() < end) {
    const cells: HeatCell[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const day = new Date(cursor);
      day.setDate(cursor.getDate() + offset);
      const fromDay = day.getTime();
      const pad = fromDay < start || fromDay >= end;
      cells.push(
        sliceCell(
          events,
          fromDay,
          fromDay + 24 * 60 * 60 * 1000,
          `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`,
          `${MONTH_SHORT[day.getMonth()]} ${day.getDate()}`,
          pad,
          customBots,
          looks,
        ),
      );
    }
    if (cursor.getMonth() !== lastMonth && cursor.getTime() + 6 * 24 * 60 * 60 * 1000 >= start) {
      labels.push({ text: MONTH_FULL[cursor.getMonth()] ?? "", column });
      lastMonth = cursor.getMonth();
    }
    columns.push(cells);
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() + 7);
    column += 1;
  }
  return { rows: 7, columns, labels };
}

export function stretchHeatmap(
  events: UsageEvent[],
  range: UsageRange,
  now = Date.now(),
  customBots: HeatBotHint[] = [],
  looks: VendorLooks = {},
): StretchHeatmap {
  if (range === "today") {
    const start = startOfDay(now);
    const columns: HeatCell[][] = [];
    const labels: { text: string; column: number }[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const from = start.getTime() + hour * 60 * 60 * 1000;
      const clock = hour % 12 === 0 ? 12 : hour % 12;
      const stamp = `${clock} ${hour < 12 ? "AM" : "PM"}`;
      columns.push([sliceCell(events, from, from + 60 * 60 * 1000, `h${hour}`, stamp, false, customBots, looks)]);
      if (hour % 6 === 0) labels.push({ text: stamp, column: hour });
    }
    return { rows: 1, columns, labels };
  }

  if (range === "week") {
    const monday = mondayOnOrBefore(new Date(now));
    const columns: HeatCell[][] = [];
    const labels: { text: string; column: number }[] = [];
    for (let index = 0; index < 7; index += 1) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + index);
      const from = day.getTime();
      const name = DAY_NAMES[day.getDay()] ?? "Monday";
      columns.push([
        sliceCell(
          events,
          from,
          from + 24 * 60 * 60 * 1000,
          `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`,
          name,
          false,
          customBots,
          looks,
        ),
      ]);
      labels.push({ text: name, column: index });
    }
    return { rows: 1, columns, labels };
  }

  if (range === "month") {
    const start = startOfDay(now);
    start.setDate(start.getDate() - 29);
    const columns: HeatCell[][] = [];
    const labels: { text: string; column: number }[] = [];
    for (let index = 0; index < 30; index += 1) {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      const from = day.getTime();
      const stamp = `${MONTH_SHORT[day.getMonth()]} ${day.getDate()}`;
      columns.push([
        sliceCell(
          events,
          from,
          from + 24 * 60 * 60 * 1000,
          `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`,
          stamp,
          false,
          customBots,
          looks,
        ),
      ]);
      if (index === 0 || day.getDate() === 1 || index % 5 === 0) {
        labels.push({
          text: index === 0 || day.getDate() === 1 ? stamp : String(day.getDate()),
          column: index,
        });
      }
    }
    return { rows: 1, columns, labels };
  }

  const start = startOfDay(now);
  start.setDate(1);
  start.setMonth(start.getMonth() - 11);
  const end = startOfDay(now);
  end.setDate(end.getDate() + 1);
  return weekGrid(events, start, end, customBots, looks);
}

export function heatmapPeak(map: StretchHeatmap): HeatCell | null {
  let peak: HeatCell | null = null;
  for (const column of map.columns) {
    for (const cell of column) {
      if (cell.pad) continue;
      if (!peak || cell.tokens > peak.tokens) peak = cell;
    }
  }
  return peak && peak.tokens > 0 ? peak : null;
}

export function heatLevel(tokens: number, peak: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || peak <= 0) return 0;
  const ratio = tokens / peak;
  if (ratio > 0.75) return 4;
  if (ratio > 0.45) return 3;
  if (ratio > 0.2) return 2;
  return 1;
}

export function modelsForProvider(events: UsageEvent[], provider: ProviderId): UsageGroup[] {
  const live = byModel(events.filter((event) => event.provider === provider));
  const leftover = new Map(live.map((row) => [row.label, row]));
  const rows: UsageGroup[] = [];
  for (const model of modelsFor(provider)) {
    const found = leftover.get(model.id);
    leftover.delete(model.id);
    rows.push(
      found
        ? { ...found, label: model.name }
        : { key: `${provider}:${model.id}`, label: model.name, provider, ...EMPTY },
    );
  }
  for (const extra of leftover.values()) rows.push(extra);
  return rows;
}

export type RemainingUsage = {
  budget: number;
  spent: number;
  left: number;
  usedRatio: number;
  leftRatio: number;
};

export type DeskPulseLine = { id: string; text: string };

export function deskPulseLines(input: {
  usage: Array<{
    at: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
  }>;
  sessions: Array<{ hidden?: boolean; parentId?: string; archivedAt?: number | null }>;
  now?: number;
}): DeskPulseLine[] {
  const now = input.now ?? Date.now();
  const events = input.usage.map((event) => ({
    id: "pulse",
    provider: "grok" as const,
    model: "",
    at: event.at,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens ?? 0,
    cacheWriteTokens: event.cacheWriteTokens ?? 0,
    costUsd: event.costUsd,
  }));
  const today = rollup(events.filter((event) => inRange(event, "today", now)));
  const all = rollup(events);
  const chats = input.sessions.filter((session) => !session.hidden && !session.archivedAt).length;
  const lines: DeskPulseLine[] = [];
  if (today.totalTokens > 0) lines.push({ id: "today", text: `${formatTokens(today.totalTokens)} today` });
  if (all.totalTokens > 0) lines.push({ id: "tokens", text: `${formatTokens(all.totalTokens)} tokens` });
  if (all.inputTokens > 0 || all.outputTokens > 0) {
    lines.push({
      id: "io",
      text: `${formatTokens(all.inputTokens)} in · ${formatTokens(all.outputTokens)} out`,
    });
  }
  lines.push({ id: "chats", text: chats === 1 ? "1 chat" : `${chats} chats` });
  if (all.events > 0) lines.push({ id: "turns", text: all.events === 1 ? "1 turn" : `${all.events} turns` });
  return lines;
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** The whole prompt the model held: fresh input plus what it read back from cache. */
export function promptTokens(row: { inputTokens: number; cacheReadTokens?: number }): number {
  return row.inputTokens + (row.cacheReadTokens ?? 0);
}

/**
 * "in" is fresh input only. Cache reads are the same context replayed each
 * turn, and were once folded into "in" — so a chat that read 74 new tokens
 * against 3.9M of cached history said "3.9M in", beside a total that left the
 * cache out. Now the two figures are named apart, and both add up to the total.
 */
export function formatIoLine(row: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  events?: number;
}): string {
  if (row.events === 0) return "No token data";
  const cached = row.cacheReadTokens ?? 0;
  const parts = [`${formatTokens(row.inputTokens)} in`];
  if (cached > 0) parts.push(`${formatTokens(cached)} cached`);
  parts.push(`${formatTokens(row.outputTokens)} out`);
  return parts.join(" · ");
}

export function formatCost(totals: UsageTotals): string {
  if (!totals.costKnown) return "—";
  if (totals.costUsd < 0.01) return `$${totals.costUsd.toFixed(4)}`;
  return `$${totals.costUsd.toFixed(2)}`;
}

export function usageHasBilledTokens(draft: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): boolean {
  return (
    (draft.inputTokens ?? 0) > 0 ||
    (draft.outputTokens ?? 0) > 0 ||
    (draft.cacheReadTokens ?? 0) > 0 ||
    (draft.cacheWriteTokens ?? 0) > 0
  );
}

export function addUsageDraft(base: UsageDraft, next: UsageDraft): UsageDraft {
  return {
    ...base,
    ...next,
    inputTokens: base.inputTokens + next.inputTokens,
    outputTokens: base.outputTokens + next.outputTokens,
    cacheReadTokens: (base.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens: (base.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
    costUsd: next.costUsd ?? base.costUsd,
    contextUsed: next.contextUsed ?? base.contextUsed,
  };
}

function draftBucket(draft: Pick<UsageDraft, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">) {
  return {
    inputTokens: draft.inputTokens,
    outputTokens: draft.outputTokens,
    cacheReadTokens: draft.cacheReadTokens ?? 0,
    cacheWriteTokens: draft.cacheWriteTokens ?? 0,
  };
}

function coversUsage(
  larger: ReturnType<typeof draftBucket>,
  smaller: ReturnType<typeof draftBucket>,
): boolean {
  return (
    larger.inputTokens >= smaller.inputTokens &&
    larger.outputTokens >= smaller.outputTokens &&
    larger.cacheReadTokens >= smaller.cacheReadTokens &&
    larger.cacheWriteTokens >= smaller.cacheWriteTokens
  );
}

/** Fold a later snapshot into the in-flight turn. Prefer a covering total over summing it. */
export function mergeUsageDraft(base: UsageDraft, next: UsageDraft): UsageDraft {
  return finalizeTurnUsage([base, next]);
}

function uniqueDrafts(drafts: UsageDraft[]): UsageDraft[] {
  const seen = new Set<string>();
  const unique: UsageDraft[] = [];
  for (const draft of drafts) {
    const bucket = draftBucket(draft);
    const key = `${bucket.inputTokens}:${bucket.outputTokens}:${bucket.cacheReadTokens}:${bucket.cacheWriteTokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(draft);
  }
  return unique;
}

function isCoveringTotal(
  candidate: ReturnType<typeof draftBucket>,
  otherSum: ReturnType<typeof draftBucket>,
): boolean {
  if (!coversUsage(candidate, otherSum)) return false;
  const close =
    candidate.inputTokens <= Math.max(otherSum.inputTokens * 1.15, otherSum.inputTokens + 32) &&
    candidate.outputTokens <= Math.max(otherSum.outputTokens * 1.15, otherSum.outputTokens + 16) &&
    candidate.cacheReadTokens <= Math.max(otherSum.cacheReadTokens * 1.15, otherSum.cacheReadTokens + 256);
  const broader = otherSum.cacheReadTokens > 0 && candidate.cacheReadTokens >= otherSum.cacheReadTokens * 2;
  return close || broader;
}

function isMonotoneCovering(drafts: UsageDraft[]): UsageDraft | undefined {
  if (drafts.length < 2) return undefined;
  for (let index = 1; index < drafts.length; index += 1) {
    const previous = draftBucket(drafts[index - 1]!);
    const current = draftBucket(drafts[index]!);
    if (!coversUsage(current, previous)) return undefined;
  }
  return drafts[drafts.length - 1];
}

function lastDefined<T>(drafts: UsageDraft[], pick: (draft: UsageDraft) => T | undefined): T | undefined {
  return drafts.reduce<T | undefined>((kept, draft) => pick(draft) ?? kept, undefined);
}

/**
 * Add the bills of one turn's HTTP requests. Output is always new work, so it
 * always adds. Input only adds when the vendor split fresh from cached — then
 * each request's `inputTokens` is what the model read for the first time. A
 * vendor that reports one inclusive prompt figure and no cache bucket sends the
 * whole conversation again on every request; adding those books the same
 * context once per tool call. For that vendor the last prompt already contains
 * every earlier one, so it stands as the turn's input.
 */
export function sumRequestBills(requests: UsageDraft[]): UsageDraft {
  const last = requests[requests.length - 1]!;
  const splitsCache = requests.some((draft) => (draft.cacheReadTokens ?? 0) > 0 || (draft.cacheWriteTokens ?? 0) > 0);
  if (splitsCache || requests.length === 1) return requests.reduce(addUsageDraft);
  return {
    ...last,
    inputTokens: Math.max(...requests.map((draft) => draft.inputTokens)),
    outputTokens: requests.reduce((sum, draft) => sum + draft.outputTokens, 0),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/**
 * Fold every usage report from one turn into the one event that gets stored.
 *
 * Reports carry a `source`, and the source decides how they combine:
 *
 * - a `turn` total is the vendor's own figure for the whole turn. It replaces
 *   everything else. If two arrive, the last wins — the adapter re-sent it,
 *   it did not bill twice.
 * - `request` reports are single HTTP bills. A tool loop makes many, and each
 *   is real work, so they add. Their prompts already split fresh input from
 *   cache reads (see parseCustomUsage), so summing does not re-book context.
 * - `gauge` reports carry contextUsed and cost, never tokens.
 * - an `estimate` only stands when nothing measured arrived.
 *
 * Reports without a source predate tagging. For those the old size-based
 * guess still runs below: it stays for events already on disk, and for any
 * adapter not yet tagging. Once a turn has one tagged report, tags rule.
 */
export function finalizeTurnUsage(drafts: UsageDraft[]): UsageDraft {
  if (drafts.length === 0) {
    return { provider: "grok", model: "", inputTokens: 0, outputTokens: 0 };
  }
  // A subagent is already-billed work from a separate child session. It is
  // recorded on its own, so it must never enter the fold: the fold returns a
  // single draft, and four children finishing in one turn would collapse to
  // one — or displace the parent's own turn.
  drafts = drafts.filter((draft) => draft.source !== "subagent");
  if (drafts.length === 0) return { provider: "grok", model: "", inputTokens: 0, outputTokens: 0 };
  if (drafts.some((draft) => draft.source)) {
    const contextUsed = lastDefined(drafts, (draft) => draft.contextUsed);
    const costUsd = lastDefined(drafts, (draft) => draft.costUsd);
    const trailer = { ...(contextUsed !== undefined ? { contextUsed } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
    const turns = drafts.filter((draft) => draft.source === "turn" && usageHasBilledTokens(draft));
    if (turns.length) return { ...turns[turns.length - 1]!, ...trailer };
    const requests = drafts.filter((draft) => draft.source === "request" && usageHasBilledTokens(draft));
    if (requests.length) return { ...sumRequestBills(requests), ...trailer };
    const untagged = drafts.filter((draft) => !draft.source && usageHasBilledTokens(draft));
    if (untagged.length) return { ...finalizeTurnUsage(untagged), ...trailer };
    const estimates = drafts.filter((draft) => draft.source === "estimate" && usageHasBilledTokens(draft));
    if (estimates.length) return { ...estimates[estimates.length - 1]!, ...trailer };
    // Only gauges: no tokens to book, but the context and cost are still true.
    return { ...drafts[drafts.length - 1]!, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...trailer };
  }
  const unique = uniqueDrafts(drafts);
  if (unique.length === 1) return unique[0];
  const monotone = isMonotoneCovering(unique);
  if (monotone) {
    return {
      ...monotone,
      ...draftBucket(monotone),
      costUsd: drafts.reduce((cost, draft) => draft.costUsd ?? cost, monotone.costUsd),
      contextUsed: drafts.reduce((used, draft) => draft.contextUsed ?? used, monotone.contextUsed),
    };
  }
  for (const candidate of unique) {
    const others = unique.filter((draft) => draft !== candidate);
    const otherSum = others.reduce(addUsageDraft);
    if (isCoveringTotal(draftBucket(candidate), draftBucket(otherSum))) {
      return {
        ...candidate,
        ...draftBucket(candidate),
        costUsd: drafts.reduce((cost, draft) => draft.costUsd ?? cost, candidate.costUsd),
        contextUsed: drafts.reduce((used, draft) => draft.contextUsed ?? used, candidate.contextUsed),
      };
    }
  }
  return unique.reduce(addUsageDraft);
}

/**
 * Workhorse used to add Grok's inclusive turn_completed prompt (fresh+cache)
 * on top of the exclusive last-request buckets, which stored
 * input = cache + 2*fresh and output = 2*out. Undo that when the cache
 * share is high enough that this cannot be a normal uncached exclusive turn.
 */
export function repairInflatedTurn<T extends { inputTokens: number; outputTokens: number; cacheReadTokens: number }>(
  event: T,
): T {
  const cache = event.cacheReadTokens;
  const input = event.inputTokens;
  const output = event.outputTokens;
  if (cache <= 0 || input <= cache || output < 2 || output % 2 !== 0) return event;
  const twiceFresh = input - cache;
  if (twiceFresh <= 0 || twiceFresh % 2 !== 0) return event;
  if (cache / input < 0.4) return event;
  return {
    ...event,
    inputTokens: twiceFresh / 2,
    outputTokens: output / 2,
  };
}

function sameUsageBuckets(left: UsageEvent, right: UsageEvent): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens
  );
}

export function collapseInflatedUsage(events: UsageEvent[]): UsageEvent[] {
  if (events.length < 2) return events.map(repairInflatedTurn);
  const drop = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event.sessionId) continue;
    const duplicate = events.find(
      (other, otherIndex) =>
        otherIndex > index &&
        other.sessionId === event.sessionId &&
        Math.abs(other.at - event.at) <= 2000 &&
        sameUsageBuckets(event, other),
    );
    if (duplicate) drop.add(event.id);
  }
  const remaining = events.filter((event) => !drop.has(event.id));
  for (const event of remaining) {
    if (event.cacheReadTokens > 0 || event.cacheWriteTokens > 0) continue;
    if (!event.sessionId || event.inputTokens <= 0) continue;
    const sibling = remaining.find(
      (other) =>
        other.id !== event.id &&
        other.sessionId === event.sessionId &&
        other.cacheReadTokens > 0 &&
        other.inputTokens < event.inputTokens &&
        other.outputTokens <= event.outputTokens &&
        Math.abs(other.at - event.at) <= 2500,
    );
    if (sibling) drop.add(event.id);
  }
  return events.filter((event) => !drop.has(event.id)).map(repairInflatedTurn);
}

function asCursorLane(value: unknown): CursorUsageLane | undefined {
  if (
    value === "cursor-models" ||
    value === "other-models" ||
    value === "auto-cost" ||
    value === "auto-routed" ||
    value === "unknown"
  ) {
    return value;
  }
  return undefined;
}

function collapseStackedCustomTurns(events: UsageEvent[]): UsageEvent[] {
  const drop = new Set<string>();
  const bySession = new Map<string, UsageEvent[]>();
  for (const event of events) {
    if (event.provider !== "custom" || !event.sessionId) continue;
    const list = bySession.get(event.sessionId) ?? [];
    list.push(event);
    bySession.set(event.sessionId, list);
  }
  for (const group of bySession.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => a.at - b.at);
    let monotone = true;
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      if (current.inputTokens + (current.cacheReadTokens ?? 0) < previous.inputTokens + (previous.cacheReadTokens ?? 0)) {
        monotone = false;
        break;
      }
    }
    if (!monotone) continue;
    const keep = ordered[ordered.length - 1]!;
    for (const event of ordered) {
      if (event.id !== keep.id) drop.add(event.id);
    }
  }
  return drop.size ? events.filter((event) => !drop.has(event.id)) : events;
}

const USAGE_SOURCES = new Set(["turn", "request", "gauge", "estimate", "subagent", "compact"]);

/**
 * One event stores one turn. A turn's fresh input can be at most one prompt,
 * and no prompt is wider than the widest window on the desk. An event past
 * that was written by the old fold summing every request's prompt in a tool
 * loop — a 21-turn Kimi chat stored 3.59M that way — and cannot be undone
 * exactly, because the per-request bills are gone. What is left is what the
 * model held at the end: contextUsed if it was kept, else the ceiling. That
 * still overstates the fresh input, but by at most one prompt, not twenty.
 */
export function repairSummedPromptTurn<T extends { inputTokens: number; contextUsed?: number; source?: UsageSource }>(
  event: T,
  ceiling = largestKnownContextWindow(),
): T {
  if (event.source && event.source !== "estimate") return event;
  if (event.inputTokens <= ceiling) return event;
  const held = event.contextUsed !== undefined && event.contextUsed > 0 ? Math.min(event.contextUsed, ceiling) : ceiling;
  return { ...event, inputTokens: held };
}

export function normalizeUsage(raw: unknown): UsageEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: UsageEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    // Older builds guessed Cursor/custom tokens from transcript characters and
    // backfilled Cursor rows on restart. Those are not provider measurements.
    // Drop the rows during hydration so a missing count remains unknown.
    if (
      record.source === "estimate" ||
      (record.provider === "cursor" && typeof record.id === "string" && record.id.startsWith("use_cursor_"))
    ) {
      continue;
    }
    if (
      record.provider !== "grok" &&
      record.provider !== "claude" &&
      record.provider !== "codex" &&
      record.provider !== "custom" &&
      record.provider !== "cursor"
    ) {
      continue;
    }
    if (typeof record.model !== "string" || !record.model) continue;
    const tokenCount = (value: unknown) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
    };
    const inputTokens = tokenCount(record.inputTokens);
    const outputTokens = tokenCount(record.outputTokens);
    const cacheReadTokens = tokenCount(record.cacheReadTokens);
    const cacheWriteTokens = tokenCount(record.cacheWriteTokens);
    const model = normalizeModelId(record.provider, record.model);
    const lane =
      record.provider === "cursor" ? asCursorLane(record.lane) ?? cursorUsageLane(model) : undefined;
    events.push({
      id: typeof record.id === "string" ? record.id : `use_${events.length}`,
      at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : Date.now(),
      provider: record.provider,
      model,
      projectId: typeof record.projectId === "string" ? record.projectId : undefined,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
      customBotId: typeof record.customBotId === "string" && record.customBotId ? record.customBotId : undefined,
      lane: record.provider === "cursor" ? cursorLaneFromRecord(record, model) : undefined,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd:
        typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costUsd >= 0
          ? record.costUsd
          : undefined,
      contextUsed:
        typeof record.contextUsed === "number" && Number.isFinite(record.contextUsed)
          ? Math.max(0, Math.round(record.contextUsed))
          : undefined,
      ...(typeof record.source === "string" && USAGE_SOURCES.has(record.source) ? { source: record.source as UsageSource } : {}),
      ...(lane ? { lane } : {}),
    });
  }
  return collapseStackedCustomTurns(collapseInflatedUsage(events)).map((event) => repairSummedPromptTurn(event));
}

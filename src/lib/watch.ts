import { providerById } from "./providers";
import type {
  CustomBot,
  GrokPlanUsage,
  ProviderId,
  Session,
  Settings,
  UsageEvent,
  WatchDayMark,
  WatchDayMarks,
  WatchDismissed,
  WatchPermits,
  WatchSettings,
} from "./types";
import { customBotAttached, customBotEnabled } from "./custom-bots";
import { defaultModel, modelsFor } from "./models";
import {
  cursorLaneEvents,
  customBotUsageEvents,
  deskUsageCards,
  eventTotal,
  formatPlanReset,
  leftoverForCard,
  planRingView,
  planAllowance,
  isLocalEndpoint,
  weeklyPlanLeftover,
} from "./usage";
import { cursorWatchKeyLabel, cursorWatchLane, isCursorWatchKey, type CursorWatchKey } from "./cursor-lane";
import { DAY_SHARE_PERCENT, DEFAULT_SPENT_PERCENT, DEFAULT_WATCH } from "./watch-defaults";

export { DAY_SHARE_PERCENT, DEFAULT_SPENT_PERCENT, DEFAULT_WATCH } from "./watch-defaults";

export type WatchPlans = {
  grok?: GrokPlanUsage;
  codex?: GrokPlanUsage;
  claude?: GrokPlanUsage;
  cursor?: GrokPlanUsage;
  custom?: Record<string, GrokPlanUsage | undefined>;
};

export type WatchNoticeKind = "daily" | "low" | "spent" | "reset";

export type WatchNotice = {
  id: string;
  key: string;
  label: string;
  kind: WatchNoticeKind;
  tone: "info" | "warn" | "hold";
  title: string;
  detail: string;
  resetsAt?: string;
};

export type WatchNoticeSummary = {
  title: string;
  detail: string;
  tone: WatchNotice["tone"];
};

export type WatchVendorStatus = {
  key: string;
  label: string;
  provider: ProviderId;
  color?: string;
  leftover?: number;
  ringLeft?: number;
  ringLabel?: string;
  usedPercent?: number;
  period?: GrokPlanUsage["period"];
  resetsAt?: string;
  prepaidBalance?: number;
  todayTokens: number;
  todayUsed?: number;
  allowedPercent: number;
  overPercent: number;
  dailyLimit: number;
  dailyOver: boolean;
  weekDay?: { day: number; days: number };
  holding: boolean;
  notices: WatchNotice[];
};

export type WatchHoldReason = "daily" | "spent";

export type WatchHold = {
  sessionId: string;
  key: string;
  label: string;
  leftover: number;
  reason: WatchHoldReason;
  todayUsed?: number;
  usedPercent?: number;
  allowedPercent?: number;
  overPercent?: number;
  dailyLimit?: number;
  text: string;
  images?: import("./types").ChatImage[];
  replaceUserId?: string;
  steer?: boolean;
  /** Internal goal continuation prompts should not become visible chat bubbles. */
  hideUser?: boolean;
  restoreText?: string;
};

export function normalizeWatch(raw: unknown): WatchSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_WATCH };
  const record = raw as Partial<WatchSettings> & { dailyWarnPercent?: unknown };
  const lockKeys = Array.isArray(record.lockKeys)
    ? record.lockKeys.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined;
  const spent = Number(record.spentPercent);
  return {
    dailyLimitPercent: DAY_SHARE_PERCENT,
    lockDaily: record.lockDaily === true,
    desktopNotify: record.desktopNotify !== false,
    // Older saves predate the flag and should still get the guard.
    blockSpentSpawns: record.blockSpentSpawns !== false,
    spentPercent: Number.isFinite(spent) ? Math.min(50, Math.max(0, spent)) : DEFAULT_SPENT_PERCENT,
    ...(lockKeys ? { lockKeys } : {}),
  };
}

export function watchPicksKey(watch: WatchSettings, key: string): boolean {
  if (Array.isArray(watch.lockKeys)) return watch.lockKeys.includes(key);
  return watch.lockDaily;
}

export function watchLocksKey(watch: WatchSettings, key: string): boolean {
  return watchPicksKey(watch, key);
}

export function toggleWatchLockKey(watch: WatchSettings, key: string, allKeys: string[]): WatchSettings {
  const current = Array.isArray(watch.lockKeys) ? [...watch.lockKeys] : watch.lockDaily ? [...allKeys] : [];
  const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
  return { ...watch, lockKeys: next };
}

export function isDesktopWatchNotice(notice: Pick<WatchNotice, "kind">): boolean {
  return notice.kind === "daily" || notice.kind === "spent";
}

function watchNoticeSummaryLine(notice: WatchNotice): string {
  if (notice.kind === "spent") return `Allowance spent — ${notice.detail}`;
  if (notice.kind === "daily") {
    const over = notice.title.match(/(\d+% over pace)/i)?.[1];
    return `${over ?? "Daily bank used"} — ${notice.detail}`;
  }
  return `${notice.title} — ${notice.detail}`;
}

/** Collapse simultaneous Watch notices into one message and one dismissal. */
export function summarizeWatchNotices(notices: WatchNotice[]): WatchNoticeSummary | null {
  if (notices.length === 0) return null;
  if (notices.length === 1) {
    const notice = notices[0]!;
    return { title: notice.title, detail: notice.detail, tone: notice.tone };
  }
  const labels = [...new Set(notices.map((notice) => notice.label))];
  const tone = notices.some((notice) => notice.tone === "hold")
    ? "hold"
    : notices.some((notice) => notice.tone === "warn")
      ? "warn"
      : "info";
  return {
    title: `${notices.length} usage alerts${labels.length === 1 ? ` for ${labels[0]}` : ""}`,
    detail: notices.map(watchNoticeSummaryLine).join(" · "),
    tone,
  };
}

export function normalizeWatchPermits(raw: unknown): WatchPermits {
  if (!raw || typeof raw !== "object") return {};
  const next: WatchPermits = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !value || typeof value !== "object") continue;
    const record = value as { untilReset?: unknown; day?: unknown; sessions?: unknown };
    const permit: WatchPermits[string] = {};
    if (record.untilReset === true) permit.untilReset = true;
    if (typeof record.day === "string" && record.day) permit.day = record.day;
    if (record.sessions && typeof record.sessions === "object" && !Array.isArray(record.sessions)) {
      const sessions: Record<string, string> = {};
      for (const [id, day] of Object.entries(record.sessions as Record<string, unknown>)) {
        if (id && typeof day === "string" && day) sessions[id] = day;
      }
      if (Object.keys(sessions).length) permit.sessions = sessions;
    }
    if (permit.untilReset || permit.day || permit.sessions) next[key] = permit;
  }
  return next;
}

export function normalizeWatchDismissed(raw: unknown): WatchDismissed {
  if (!raw || typeof raw !== "object") return {};
  const next: WatchDismissed = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value) next[key] = value;
  }
  return next;
}

export function normalizeWatchDayMarks(raw: unknown): WatchDayMarks {
  if (!raw || typeof raw !== "object") return {};
  const next: WatchDayMarks = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !value || typeof value !== "object") continue;
    const record = value as Partial<WatchDayMark>;
    if (typeof record.day !== "string" || !record.day) continue;
    if (typeof record.leftover !== "number" || !Number.isFinite(record.leftover)) continue;
    next[key] = { day: record.day, leftover: Math.max(0, Math.min(100, record.leftover)) };
  }
  return next;
}

export function dayKey(now = Date.now()): string {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function startOfLocalDay(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const MS_DAY = 24 * 60 * 60 * 1000;

/** Which day of a monthly billing cycle this is (1–28…31), from the previous reset to `resetsAt`. */
export function monthDayIndex(resetsAt?: string, now = Date.now()): { day: number; days: number } {
  if (resetsAt) {
    const reset = Date.parse(resetsAt);
    if (!Number.isNaN(reset)) {
      const resetDay = startOfLocalDay(reset);
      const today = startOfLocalDay(now);
      const start = new Date(resetDay);
      start.setMonth(start.getMonth() - 1);
      const startDay = startOfLocalDay(start.getTime());
      const days = Math.max(28, Math.round((resetDay - startDay) / MS_DAY));
      if (today >= resetDay) return { day: days, days };
      const elapsed = Math.round((today - startDay) / MS_DAY);
      return { day: Math.min(days, Math.max(1, elapsed + 1)), days };
    }
  }
  const local = new Date(now);
  const days = new Date(local.getFullYear(), local.getMonth() + 1, 0).getDate();
  return { day: local.getDate(), days };
}

/** Which day of the vendor week this is (1–7). Monthly plans use the billing month instead. */
export function weekDayIndex(
  resetsAt?: string,
  now = Date.now(),
  period?: "weekly" | "monthly" | "unknown",
): { day: number; days: number } {
  if (period === "monthly") return monthDayIndex(resetsAt, now);
  const days = 7;
  if (resetsAt) {
    const reset = Date.parse(resetsAt);
    if (!Number.isNaN(reset)) {
      const daysLeft = Math.round((startOfLocalDay(reset) - startOfLocalDay(now)) / MS_DAY);
      if (daysLeft <= 0) return { day: days, days };
      return { day: Math.min(days, Math.max(1, days - daysLeft + 1)), days };
    }
  }
  const local = new Date(now);
  const mondayFirst = (local.getDay() + 6) % 7;
  return { day: mondayFirst + 1, days };
}

export function watchKeyForSession(session: Pick<Session, "provider" | "customBotId"> & { model?: string }): string {
  if (session.provider === "cursor") return cursorWatchLane(session.model);
  return session.customBotId ? `bot:${session.customBotId}` : session.provider;
}

export function deskRowForKey(
  key: string,
  settings: { customBots: CustomBot[] },
): {
  focus: ProviderId | `bot:${string}` | CursorWatchKey;
  provider: ProviderId;
  key: string;
  label: string;
  color?: string;
  bot?: CustomBot;
} {
  if (key.startsWith("bot:")) {
    const id = key.slice(4);
    const bot = settings.customBots.find((item) => item.id === id);
    return {
      focus: `bot:${id}`,
      provider: "custom",
      key: id,
      label: bot?.name ?? "Custom",
      color: bot?.color,
      bot,
    };
  }
  if (isCursorWatchKey(key)) {
    return {
      focus: key,
      provider: "cursor",
      key,
      label: cursorWatchKeyLabel(key),
    };
  }
  const provider: ProviderId =
    key === "claude" || key === "codex" || key === "cursor" || key === "custom" ? key : "grok";
  return {
    focus: provider,
    provider,
    key: provider,
    label: provider === "custom" ? "Custom" : providerById(provider).name,
  };
}

export function leftoverPercentForKey(
  key: string,
  plans: WatchPlans,
  settings: { customBots: CustomBot[] },
): number | undefined {
  const row = deskRowForKey(key, settings);
  return weeklyPlanLeftover(leftoverForCard(row, plans));
}

export function eventsForWatchKey(
  events: UsageEvent[],
  key: string,
  settings: { customBots: CustomBot[] },
): UsageEvent[] {
  const row = deskRowForKey(key, settings);
  if (row.bot) return customBotUsageEvents(events, row.bot);
  if (isCursorWatchKey(key)) return cursorLaneEvents(events, key);
  return events.filter((event) => event.provider === row.provider);
}

export function todayTokens(events: UsageEvent[], now = Date.now()): number {
  const start = startOfLocalDay(now);
  return events.reduce((sum, event) => (event.at >= start ? sum + eventTotal(event) : sum), 0);
}

export function weekTokens(events: UsageEvent[], now = Date.now()): number {
  const start = now - 7 * 24 * 60 * 60 * 1000;
  return events.reduce((sum, event) => (event.at >= start ? sum + eventTotal(event) : sum), 0);
}

/** Bar fill: weekly cards use used/allowed (stacked bank). Monthly cards use used/100 so the month can fill over 28–31 days. */
export function watchDayFill(row: {
  usedPercent?: number;
  allowedPercent: number;
  weekDay?: { days: number };
}): number {
  if (row.usedPercent == null || !Number.isFinite(row.usedPercent)) return 0;
  const used = Math.max(0, row.usedPercent);
  if (row.weekDay && row.weekDay.days > 7) return Math.min(1, used / 100);
  if (row.allowedPercent > 0) return Math.min(1, used / row.allowedPercent);
  return 0;
}

/** Unused daily slices stack. Weekly: Day 4 at 100/7 each is 400/7. Monthly uses 100/days. */
export function rollingAllowed(dailyLimit: number, weekDay: number, days = 7): number {
  const slice = days === 7 ? Math.max(0, dailyLimit) : 100 / Math.max(1, days);
  return Math.min(100, slice * Math.max(1, weekDay));
}

export function weekUsedFromLeftover(
  leftover?: number,
  usedPercent?: number,
  plan?: GrokPlanUsage,
): number | undefined {
  if (plan?.products.some((item) => item.unlimited && /weekly/i.test(item.product))) return undefined;
  const raw =
    typeof leftover === "number" && Number.isFinite(leftover)
      ? 100 - leftover
      : typeof usedPercent === "number" && Number.isFinite(usedPercent)
        ? usedPercent
        : undefined;
  if (raw == null) return undefined;
  return Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;
}

export function todayUsedOfWeek(input: {
  leftover?: number;
  usedPercent?: number;
  todayTokens: number;
  weekTokens: number;
  mark?: WatchDayMark;
  day: string;
  dailyLimit?: number;
  weekDay?: number;
  cycleDays?: number;
}): number | undefined {
  const parts: number[] = [];
  if (input.leftover != null && input.mark?.day === input.day) {
    parts.push(Math.max(0, input.mark.leftover - input.leftover));
  }
  if (input.usedPercent != null && input.usedPercent > 0 && input.weekTokens > 0 && input.todayTokens > 0) {
    const pool = input.weekTokens / (input.usedPercent / 100);
    if (pool > 0) parts.push((input.todayTokens / pool) * 100);
  }
  // Vendor leftover is the source of truth. Local tokens miss Grok Desktop etc.
  // If this is day 2, yesterday could have used at most one daily slice —
  // anything above that must be today's.
  if (input.usedPercent != null && input.dailyLimit != null && input.dailyLimit > 0 && input.weekDay != null) {
    const days = input.cycleDays && input.cycleDays > 0 ? input.cycleDays : 7;
    const slice = days === 7 ? input.dailyLimit : 100 / days;
    const prior = slice * Math.max(0, input.weekDay - 1);
    parts.push(Math.max(0, input.usedPercent - prior));
  }
  if (parts.length === 0) return undefined;
  return Math.max(...parts);
}

export function syncWatchDayMarks(
  marks: WatchDayMarks,
  leftovers: Record<string, number | undefined>,
  now = Date.now(),
): WatchDayMarks {
  const day = dayKey(now);
  let changed = false;
  const next = { ...marks };
  for (const [key, leftover] of Object.entries(leftovers)) {
    if (leftover == null) continue;
    const mark = next[key];
    if (!mark || mark.day !== day) {
      next[key] = { day, leftover };
      changed = true;
    }
  }
  return changed ? next : marks;
}

export function dismissStamp(notice: Pick<WatchNotice, "kind" | "resetsAt">, now = Date.now()): string {
  return notice.kind === "reset" && notice.resetsAt ? notice.resetsAt : dayKey(now);
}

export function noticeIsDismissed(notice: WatchNotice, dismissed: WatchDismissed, now = Date.now()): boolean {
  const stamp = dismissed[notice.id];
  if (!stamp) return false;
  return stamp === dismissStamp(notice, now);
}

export function pruneWatchPermits(permits: WatchPermits, now = Date.now()): WatchPermits {
  const today = dayKey(now);
  let changed = false;
  const next: WatchPermits = {};
  for (const [key, permit] of Object.entries(permits)) {
    const sessions: Record<string, string> = {};
    for (const [id, day] of Object.entries(permit.sessions ?? {})) {
      if (day === today) sessions[id] = today;
      else changed = true;
    }
    const kept: WatchPermits[string] = {};
    if (permit.day === today) kept.day = today;
    else if (permit.day) changed = true;
    if (Object.keys(sessions).length) kept.sessions = sessions;
    if (kept.day || kept.sessions) next[key] = kept;
    else if (permit.day || permit.sessions) changed = true;
  }
  if (!changed && Object.keys(next).length === Object.keys(permits).length) return permits;
  return next;
}

export function evaluateWatchHold(input: {
  session: Pick<Session, "provider" | "customBotId"> & { model?: string; id?: string; parentId?: string };
  settings: { watch?: WatchSettings; customBots: CustomBot[] };
  plans: WatchPlans;
  permits: WatchPermits;
  permitted?: boolean;
  usage?: UsageEvent[];
  dayMarks?: WatchDayMarks;
  now?: number;
}): {
  key: string;
  label: string;
  leftover: number;
  reason: WatchHoldReason;
  todayUsed?: number;
  usedPercent?: number;
  allowedPercent?: number;
  overPercent?: number;
  dailyLimit?: number;
} | null {
  if (input.permitted) return null;
  const watch = input.settings.watch ?? DEFAULT_WATCH;
  const key = watchKeyForSession(input.session);
  const row = deskRowForKey(key, input.settings);
  const leftover = leftoverPercentForKey(key, input.plans, input.settings);
  const now = input.now ?? Date.now();
  const day = dayKey(now);
  const plan = leftoverForCard(row, input.plans);
  const usedPercent = weekUsedFromLeftover(leftover, plan?.usedPercent, plan);
  const resetsAt = plan?.resetsAt ?? plan?.products.find((item) => item.resetsAt)?.resetsAt;
  const cycle = weekDayIndex(resetsAt, now, plan?.period);
  const allowedPercent = rollingAllowed(watch.dailyLimitPercent, cycle.day, cycle.days);
  const permit = input.permits[key];
  if (!watchLocksKey(watch, key)) return null;
  if (input.session.id && permit?.sessions?.[input.session.id] === day) return null;
  if (input.session.parentId && permit?.sessions?.[input.session.parentId] === day) return null;
  if (leftover != null && leftover <= 0.5 && permit?.day !== day) {
    return {
      key,
      label: row.label,
      leftover,
      reason: "spent",
      todayUsed: usedPercent,
      usedPercent: usedPercent ?? 100,
      allowedPercent,
      overPercent: Math.max(0, (usedPercent ?? 100) - allowedPercent),
      dailyLimit: watch.dailyLimitPercent,
    };
  }
  if (usedPercent != null && usedPercent >= allowedPercent && permit?.day !== day) {
    return {
      key,
      label: row.label,
      leftover: leftover ?? 0,
      reason: "daily",
      todayUsed: usedPercent,
      usedPercent,
      allowedPercent,
      overPercent: Math.max(0, usedPercent - allowedPercent),
      dailyLimit: watch.dailyLimitPercent,
    };
  }
  return null;
}

/**
 * Occupancy is window fill. It never holds a send. Only leftover and the
 * daily bank do that.
 */
export function occupancyCannotHoldSend(_occupancy?: number, _windowSize?: number): null {
  return null;
}

export function watchHoldMessage(hold: {
  label: string;
  reason?: WatchHoldReason;
  usedPercent?: number;
  allowedPercent?: number;
  overPercent?: number;
}): string {
  if (hold.reason === "spent") {
    return `${hold.label} has no leftover left this week. Switch to another model. Do not call it again unless the user allows this chat.`;
  }
  const used = Math.round(hold.usedPercent ?? 0);
  const allowed = Math.round(hold.allowedPercent ?? 0);
  const over = Math.round(hold.overPercent ?? 0);
  return `${hold.label} used its daily bank (${used}% used · ${allowed}% bank${over ? ` · ${over}% over` : ""}). Today's share is spent so the rest of the week still has leftover. Switch to another model, or let the user allow this chat.`;
}

export function watchBarTitle(hold: { label: string; reason?: WatchHoldReason }): string {
  return hold.reason === "spent" ? `${hold.label} is out for the week` : `${hold.label} used its daily bank`;
}

export function watchBarDetail(hold: { reason?: WatchHoldReason; pending?: boolean }): string {
  if (hold.reason === "spent") {
    return hold.pending
      ? "No leftover left until the plan resets. Switch model, or allow this conversation to send."
      : "No leftover left until the plan resets. Switch to another model to keep going.";
  }
  return hold.pending
    ? "Today's share of the week is used. Switch model, or allow this conversation to continue."
    : "Today's share of the week is used so leftover can last later days. Switch model, or allow this conversation.";
}

function resetSoon(iso: string | undefined, now: number): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  const delta = at - now;
  return delta <= 12 * 60 * 60 * 1000;
}

function vendorNotices(status: WatchVendorStatus, watch: WatchSettings, now: number): WatchNotice[] {
  const notices: WatchNotice[] = [];
  const leftover = status.leftover;
  const locked = watchLocksKey(watch, status.key);
  if (leftover != null && leftover <= 0.5) {
    notices.push({
      id: `spent:${status.key}`,
      key: status.key,
      label: status.label,
      kind: "spent",
      tone: locked ? "hold" : "warn",
      title: `${status.label} allowance is spent`,
      detail: status.resetsAt
        ? `Nothing left on this plan window. ${formatPlanReset(status.resetsAt, now)}.`
        : "Nothing left on this plan window until it refreshes.",
      resetsAt: status.resetsAt,
    });
  }
  if (status.dailyOver) {
    const dayLabel = status.weekDay ? `Day ${status.weekDay.day}/${status.weekDay.days}` : "Today";
    const used = Math.round(status.usedPercent ?? status.todayUsed ?? 0);
    const over = Math.round(status.overPercent);
    const expected = Math.round(status.allowedPercent);
    notices.push({
      id: `daily:${status.key}:${dayKey(now)}`,
      key: status.key,
      label: status.label,
      kind: "daily",
      tone: locked ? "hold" : "warn",
      title: over > 0 ? `${status.label} is ${over}% over pace` : `${status.label} used its daily bank`,
      detail: `${dayLabel} · ${used}% used · ${expected}% expected`,
    });
  }
  if (status.resetsAt && resetSoon(status.resetsAt, now)) {
    const at = Date.parse(status.resetsAt);
    const overdue = !Number.isNaN(at) && at <= now;
    notices.push({
      id: `reset:${status.key}:${status.resetsAt}`,
      key: status.key,
      label: status.label,
      kind: "reset",
      tone: overdue ? "warn" : "info",
      title: overdue ? `${status.label} window should have reset` : `${status.label} resets soon`,
      detail: overdue
        ? "The vendor window looks overdue. Recheck leftover on Usage if it stays stale."
        : `${formatPlanReset(status.resetsAt, now)}.`,
      resetsAt: status.resetsAt,
    });
  }
  return notices;
}

function watchShowsCard(
  card: { focus: string; provider: ProviderId; key: string },
  settings: { llms: Settings["llms"]; customBots: CustomBot[] },
): boolean {
  if (card.provider === "custom" || String(card.focus).startsWith("bot:")) {
    const id = String(card.focus).startsWith("bot:") ? String(card.focus).slice(4) : card.key;
    return customBotEnabled(settings.customBots.find((bot) => bot.id === id));
  }
  const link =
    card.provider === "claude" || card.provider === "codex" || card.provider === "cursor"
      ? settings.llms[card.provider]
      : settings.llms.grok;
  return Boolean(link?.connected) && link?.enabled !== false;
}

export function watchVendorStatuses(input: {
  settings: {
    watch?: WatchSettings;
    usageBudgets: Partial<Record<ProviderId, number>>;
    llms: Settings["llms"];
    customBots: CustomBot[];
  };
  usage: UsageEvent[];
  plans: WatchPlans;
  permits: WatchPermits;
  dayMarks?: WatchDayMarks;
  now?: number;
}): WatchVendorStatus[] {
  const now = input.now ?? Date.now();
  const day = dayKey(now);
  const watch = input.settings.watch ?? DEFAULT_WATCH;
  const cards = deskUsageCards(input.usage, input.settings).filter((card) =>
    watchShowsCard(card, input.settings),
  );
  return cards.map((card) => {
    const key = String(card.focus);
    const leftover = leftoverPercentForKey(key, input.plans, input.settings);
    const plan = leftoverForCard(card, input.plans);
    const ring = planRingView(card, input.plans);
    const slice = eventsForWatchKey(input.usage, key, input.settings);
    const usedPercent = weekUsedFromLeftover(leftover, plan?.usedPercent, plan);
    const today = todayTokens(slice, now);
    const resetsAt = plan?.resetsAt ?? plan?.products.find((item) => item.resetsAt)?.resetsAt;
    const weekDay = weekDayIndex(resetsAt, now, plan?.period);
    const allowedPercent = rollingAllowed(watch.dailyLimitPercent, weekDay.day, weekDay.days);
    const todayUsed = todayUsedOfWeek({
      leftover,
      usedPercent,
      todayTokens: today,
      weekTokens: weekTokens(slice, now),
      mark: input.dayMarks?.[key],
      day,
      dailyLimit: watch.dailyLimitPercent,
      weekDay: weekDay.day,
      cycleDays: weekDay.days,
    });
    const overPercent = usedPercent != null ? Math.max(0, usedPercent - allowedPercent) : 0;
    const dailyOver = usedPercent != null && usedPercent >= allowedPercent;
    const hold = evaluateWatchHold({
      session: {
        provider: card.provider,
        model: key === "cursor:other-models" ? "claude-sonnet" : key === "cursor:cursor-models" ? "composer-2.5" : "",
        customBotId: key.startsWith("bot:") ? key.slice(4) : undefined,
      },
      settings: input.settings,
      plans: input.plans,
      permits: input.permits,
      usage: input.usage,
      dayMarks: input.dayMarks,
      now,
    });
    const base: WatchVendorStatus = {
      key,
      label: card.label,
      provider: card.provider,
      color: card.color,
      leftover,
      ringLeft: ring ? ring.value * 100 : leftover,
      ringLabel: ring?.label ?? (leftover != null ? `${Math.round(leftover)}%` : undefined),
      usedPercent,
      period: plan?.period,
      resetsAt,
      prepaidBalance: plan && plan.prepaidBalance > 0 ? plan.prepaidBalance : undefined,
      todayTokens: today,
      todayUsed,
      allowedPercent,
      overPercent,
      dailyLimit: watch.dailyLimitPercent,
      dailyOver,
      weekDay,
      holding: Boolean(hold),
      notices: [],
    };
    return { ...base, notices: vendorNotices(base, watch, now) };
  });
}

export function collectWatchNotices(
  statuses: WatchVendorStatus[],
  dismissed: WatchDismissed,
  now = Date.now(),
): WatchNotice[] {
  return statuses.flatMap((status) => status.notices).filter((notice) => !noticeIsDismissed(notice, dismissed, now));
}

export function leftoverByWatchKey(
  statuses: WatchVendorStatus[],
): Record<string, number | undefined> {
  return Object.fromEntries(statuses.map((status) => [status.key, status.leftover]));
}

export type DeskCallStatus = "ok" | "disabled" | "not_connected" | "spent" | "day_bank";

export type DeskCallRow = {
  id: string;
  name: string;
  provider: ProviderId;
  model?: string;
  models?: Array<{ id: string; name: string }>;
  kind: "vendor" | "custom";
  leftoverPercent?: number;
  usedPercent?: number;
  period?: GrokPlanUsage["period"];
  resetsAt?: string;
  canCall: boolean;
  status: DeskCallStatus;
  reason?: string;
};

const DESK_STOCK: Exclude<ProviderId, "custom">[] = ["grok", "codex", "claude", "cursor"];

function deskCallRow(input: {
  key: string;
  name: string;
  provider: ProviderId;
  model?: string;
  models?: Array<{ id: string; name: string }>;
  kind: "vendor" | "custom";
  connected: boolean;
  enabled: boolean;
  leftover?: number;
  usedPercent?: number;
  period?: GrokPlanUsage["period"];
  allowedPercent?: number;
  overPercent?: number;
  resetsAt?: string;
  holding: boolean;
  /** Treat no-leftover as un-callable even when the daily bank is not holding. */
  blockSpent: boolean;
  spentPercent: number;
}): DeskCallRow {
  let code: DeskCallStatus = "ok";
  let reason: string | undefined;
  let canCall = true;
  if (!input.connected) {
    code = "not_connected";
    canCall = false;
    reason = `${input.name} is not attached on this desk.`;
  } else if (!input.enabled) {
    code = "disabled";
    canCall = false;
    reason = `${input.name} is turned off in Settings → LLMs.`;
  } else if (
    (input.blockSpent || input.holding) &&
    input.leftover != null &&
    input.leftover <= (input.blockSpent ? input.spentPercent : 0.5)
  ) {
    // Running out is the vendor's own fact. Gating it on the daily bank let a
    // 0% vendor list as callable, so an orchestrator obeying "spawn only a
    // canCall row" picked it and the worker died at the CLI.
    code = "spent";
    canCall = false;
    reason = watchHoldMessage({ label: input.name, reason: "spent" });
  } else if (input.holding) {
    code = "day_bank";
    canCall = false;
    reason = watchHoldMessage({
      label: input.name,
      reason: "daily",
      usedPercent: input.usedPercent,
      allowedPercent: input.allowedPercent,
      overPercent: input.overPercent,
    });
  }
  return {
    id: input.key,
    name: input.name,
    provider: input.provider,
    model: input.model,
    models: input.models,
    kind: input.kind,
    leftoverPercent: input.leftover,
    usedPercent: input.usedPercent,
    period: input.period,
    resetsAt: input.resetsAt,
    canCall,
    status: code,
    reason,
  };
}

export function deskCallCatalog(input: {
  settings: {
    watch?: WatchSettings;
    usageBudgets: Partial<Record<ProviderId, number>>;
    llms: Settings["llms"];
    customBots: CustomBot[];
  };
  usage: UsageEvent[];
  plans: WatchPlans;
  permits: WatchPermits;
  dayMarks?: WatchDayMarks;
  now?: number;
}): DeskCallRow[] {
  const statuses = watchVendorStatuses(input);
  const catalogWatch = input.settings.watch ?? DEFAULT_WATCH;
  const blockSpent = catalogWatch.blockSpentSpawns !== false;
  const spentPercent = Number.isFinite(catalogWatch.spentPercent)
    ? (catalogWatch.spentPercent as number)
    : DEFAULT_SPENT_PERCENT;
  const byKey = new Map(statuses.map((status) => [status.key, status]));
  const rows: DeskCallRow[] = [];
  for (const id of DESK_STOCK) {
    const link = input.settings.llms[id];
    if (link?.connected && link.enabled === false) continue;
    if (id === "cursor") {
      const composer = byKey.get("cursor:cursor-models");
      const api = byKey.get("cursor:other-models");
      const connected = Boolean(link?.connected);
      const enabled = Boolean(link?.connected && link?.enabled !== false);
      const composerModels = modelsFor("cursor").filter((item) => cursorWatchLane(item.id) === "cursor:cursor-models");
      const apiModels = modelsFor("cursor").filter((item) => cursorWatchLane(item.id) === "cursor:other-models");
      rows.push(
        deskCallRow({
          key: "cursor:cursor-models",
          name: composer?.label ?? "Cursor · Composer",
          provider: "cursor",
          model: "composer-2.5",
          models: composerModels.map((item) => ({ id: item.id, name: item.name })),
          kind: "vendor",
          connected,
          enabled,
          leftover: composer?.leftover,
          usedPercent: composer?.usedPercent,
          period: composer?.period,
          allowedPercent: composer?.allowedPercent,
          overPercent: composer?.overPercent,
          resetsAt: composer?.resetsAt,
          holding: Boolean(composer?.holding),
          blockSpent,
          spentPercent,
        }),
      );
      rows.push(
        deskCallRow({
          key: "cursor:other-models",
          name: api?.label ?? "Cursor · API",
          provider: "cursor",
          model: apiModels[0]?.id,
          models: apiModels.map((item) => ({ id: item.id, name: item.name })),
          kind: "vendor",
          connected,
          enabled,
          leftover: api?.leftover,
          usedPercent: api?.usedPercent,
          period: api?.period,
          allowedPercent: api?.allowedPercent,
          overPercent: api?.overPercent,
          resetsAt: api?.resetsAt,
          holding: Boolean(api?.holding),
          blockSpent,
          spentPercent,
        }),
      );
      continue;
    }
    const status = byKey.get(id);
    rows.push(
      deskCallRow({
        key: id,
        name: status?.label ?? providerById(id).name,
        provider: id,
        model: defaultModel(id).id,
        models: modelsFor(id).map((item) => ({ id: item.id, name: item.name })),
        kind: "vendor",
        connected: Boolean(link?.connected),
        enabled: Boolean(link?.connected && link?.enabled !== false),
        leftover: status?.leftover,
        usedPercent: status?.usedPercent,
        period: status?.period,
        allowedPercent: status?.allowedPercent,
        overPercent: status?.overPercent,
        resetsAt: status?.resetsAt,
        holding: Boolean(status?.holding),
        blockSpent,
        spentPercent,
      }),
    );
  }
  for (const bot of input.settings.customBots) {
    if (!customBotEnabled(bot)) continue;
    const status = byKey.get(`bot:${bot.id}`);
    rows.push(
      deskCallRow({
        key: `bot:${bot.id}`,
        name: bot.name,
        provider: "custom",
        model: bot.model,
        models: [
          { id: bot.model, name: bot.name },
          ...modelsFor("custom")
            .filter((item) => item.id !== bot.model)
            .map((item) => ({ id: item.id, name: item.name })),
        ],
        kind: "custom",
        connected: customBotAttached(bot),
        enabled: customBotEnabled(bot),
        leftover: status?.leftover,
        usedPercent: status?.usedPercent,
        period: status?.period,
        allowedPercent: status?.allowedPercent,
        overPercent: status?.overPercent,
        resetsAt: status?.resetsAt,
        holding: Boolean(status?.holding),
        blockSpent,
        spentPercent,
      }),
    );
  }
  return rows;
}

export function vendorCallBlocked(
  input: Parameters<typeof evaluateWatchHold>[0] & {
    settings: {
      customBots: CustomBot[];
      llms?: Settings["llms"];
    };
  },
): string | null {
  const hold = evaluateWatchHold(input);
  if (hold) return watchHoldMessage(hold);
  if (input.session.provider === "custom") {
    const bot =
      input.settings.customBots.find((item) => item.id === input.session.customBotId) ??
      input.settings.customBots.find((item) => item.model === (input.session as { model?: string }).model);
    if (bot && !customBotEnabled(bot)) return `${bot.name} is not on this desk.`;
    return null;
  }
  const link = input.settings.llms?.[input.session.provider];
  if (link?.connected && link.enabled === false) {
    return `${providerById(input.session.provider).name} is not on this desk.`;
  }
  return null;
}

export function deskCallRowFor(
  rows: DeskCallRow[],
  query: { provider?: ProviderId | string | null; customBotId?: string; name?: string },
): DeskCallRow | undefined {
  const provider = query.provider?.trim().toLowerCase();
  const name = query.name?.trim().toLowerCase();
  return (
    (query.customBotId ? rows.find((item) => item.id === `bot:${query.customBotId}`) : undefined) ??
    (provider && provider !== "custom" ? rows.find((item) => item.id === provider || item.provider === provider) : undefined) ??
    (name
      ? rows.find((item) => item.name.toLowerCase() === name || item.model?.toLowerCase() === name || item.id === name)
      : undefined)
  );
}

export function deskCallPromptable(row: DeskCallRow | undefined): row is DeskCallRow & {
  status: "day_bank" | "spent" | "disabled";
} {
  return Boolean(row && (row.status === "day_bank" || row.status === "spent" || row.status === "disabled"));
}

/** Spawn/ask only waits on Allow when that vendor used its daily bank. */
export function vendorOverrideNeeded(row: DeskCallRow | undefined): boolean {
  return row?.status === "day_bank";
}

/** Spawn skips this vendor — do not pop Allow or ask the user. */
export function spawnIsNoGo(row: DeskCallRow | undefined): string | null {
  if (!row) return "That vendor is not on this desk. Skip it.";
  if (row.canCall) return null;
  if (row.status === "disabled") return "That vendor is not on this desk. Skip it.";
  if (row.status === "day_bank") {
    return `${row.name} is a no-go — daily bank spent. Skip it. Do not ask the user to Allow.`;
  }
  return `${row.reason || `${row.name} is not callable right now.`} Skip it. Do not ask the user to Allow.`;
}

export function spawnAllowed(row: DeskCallRow | undefined): boolean {
  return spawnIsNoGo(row) === null && Boolean(row?.canCall);
}

export function vendorGrantedForChat(
  permits: WatchPermits,
  key: string,
  sessionId: string,
  now = Date.now(),
): boolean {
  return Boolean(key && sessionId && permits[key]?.sessions?.[sessionId] === dayKey(now));
}

export { isVendorDeclinedResult, vendorDeclinedForBot } from "./vendor-decline";

export function deskCallBlockFor(
  rows: DeskCallRow[],
  query: { provider?: ProviderId | string | null; customBotId?: string; name?: string },
): string | null {
  const row = deskCallRowFor(rows, query);
  if (!row || row.canCall) return null;
  return `${row.reason || `${row.name} is not callable right now.`} Do not wait, retry, or leave a hanging call.`;
}

export function formatPlanLine(row: Pick<DeskCallRow, "leftoverPercent" | "usedPercent" | "period">): string {
  const period = row.period === "monthly" ? "month" : row.period === "weekly" ? "week" : "plan";
  if (row.leftoverPercent == null) return `${period} leftover not loaded yet`;
  const left = Math.round(row.leftoverPercent);
  const used =
    row.usedPercent != null && Number.isFinite(row.usedPercent)
      ? Math.round(row.usedPercent)
      : Math.max(0, 100 - left);
  return `${left}% leftover of this ${period}'s plan overall (${used}% used this ${period} so far — the whole ${period} pool, not this prompt)`;
}

export function callableDeskRows(rows: DeskCallRow[]): DeskCallRow[] {
  return rows.filter((row) => row.canCall);
}

function routingStrengths(row: DeskCallRow): string[] {
  const text = `${row.name} ${row.model ?? ""} ${(row.models ?? []).map((model) => `${model.id} ${model.name}`).join(" ")}`.toLowerCase();
  if (/kimi|moonshot/.test(text)) return ["visual audit", "images", "UI/UX"];
  if (/minimax-m3/.test(text)) return ["orchestration", "tools", "low cost"];
  if (/fable|mythos/.test(text)) return ["visual", "creative", "complex"];
  if (/5\.6-sol|opus|grok-4\.6/.test(text)) return ["coding", "agent work", "cheaper frontier"];
  if (/5\.6-terra|sonnet|grok-4\.5/.test(text)) return ["implementation", "review", "balanced cost"];
  if (/5\.6-luna|haiku|mini/.test(text)) return ["quick tasks", "verification", "low cost"];
  return ["general work"];
}

export function formatDeskRoster(rows: DeskCallRow[]): string {
  const attached = rows.filter((row) => row.status !== "not_connected" && row.status !== "disabled");
  const held = attached.filter((row) => !row.canCall);
  const callable = callableDeskRows(attached);
  const lines = [
    "Desk bots on this Workhorse window:",
    "Leftover and used percents are that vendor’s plan total across every chat and tool, not the cost of one spawn or prompt.",
  ];
  for (const row of attached) {
    const leftover = formatPlanLine(row);
    const flag = row.canCall
      ? row.kind === "custom"
        ? "you can call this (API key is on the desk)"
        : "you can call this"
      : row.reason || "not callable right now";
    const models =
      row.models && row.models.length > 0
        ? row.models.map((item) => item.name).join(", ")
        : row.model ?? row.provider;
    lines.push(`- ${row.name} — models: ${models} — ${leftover} — ${flag}`);
  }
  if (attached.length === 0) lines.push("- None attached yet.");
  const customCallable = callable.filter((row) => row.kind === "custom");
  if (customCallable.length > 0) {
    lines.push(
      `Custom API bots on this desk: ${customCallable.map((row) => row.name).join(", ")}. A key is attached — spawn them (provider custom). Do not claim a keyed custom slot is missing.`,
    );
  }
  if (callable.length > 0) {
    lines.push(
      `Callable now: ${callable.map((row) => row.name).join(", ")}. For ordinary work, leave provider, model, and effort unset so the desk routes by task fit and capacity. Use a named row only for an explicit user assignment or requested full lineup.`,
    );
  } else {
    lines.push("Nothing is callable right now.");
  }
  if (held.length === 0) lines.push("None of these are on Watch hold.");
  lines.push("Name every attached bot when asked. Only refuse to spawn or ask one if it says not callable.");
  lines.push("If you mention leftover or used %, say it is the vendor plan overall, never this one shot.");
  return JSON.stringify(
    {
      leftoverMeans: "Plan remaining for that vendor across all chats, not this spawn or prompt.",
      summary: lines.join("\n"),
      bots: attached.map((row) => ({ ...row, strengths: routingStrengths(row) })),
      routingRule: "Workhorse chooses from callable bots by task fit and capacity. Explicit user assignments win.",
    },
    null,
    2,
  );
}

export const CAPACITY_SNAPSHOT_VERSION = 1 as const;
/** Cached official-meter age past this is stale. Six hours. */
export const CAPACITY_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export type CapacityMeterStatus = "known" | "unknown" | "unmetered";
export type CapacityFreshness = "fresh" | "stale" | "unknown";
export type CapacityReasonCode = Exclude<DeskCallStatus, "ok">;

export type CapacityMeter = {
  status: CapacityMeterStatus;
  remainingPercent?: number;
  usedPercent?: number;
  resetsAt?: string;
  observedAt?: string;
};

export type CapacityRow = {
  id: string;
  kind: "vendor" | "custom";
  provider: ProviderId;
  name: string;
  models: Array<{ id: string; name: string }>;
  availability: {
    canCall: boolean;
    status: DeskCallStatus;
    reasonCode?: CapacityReasonCode;
  };
  meter: CapacityMeter;
};

export type CapacitySnapshot = {
  version: typeof CAPACITY_SNAPSHOT_VERSION;
  asOf: string;
  freshness: CapacityFreshness;
  rows: CapacityRow[];
};

export type CapacitySnapshotQuery = {
  now?: number;
  fetchedAt?: number;
  provider?: string;
  callableOnly?: boolean;
  plans?: WatchPlans;
  settings?: { customBots: CustomBot[] };
};

function finitePercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isDeskCapacityProvider(value: string): value is ProviderId {
  return value === "grok" || value === "claude" || value === "codex" || value === "cursor" || value === "custom";
}

function officialCapacityMeter(input: {
  leftover?: number;
  used?: number;
  resetsAt?: string;
  observedAt?: string;
  unmetered?: boolean;
}): CapacityMeter {
  if (input.unmetered) return { status: "unmetered" };
  const remaining = finitePercent(input.leftover);
  const used = finitePercent(input.used);
  if (remaining == null && used == null) return { status: "unknown" };
  return {
    status: "known",
    ...(remaining != null ? { remainingPercent: remaining } : {}),
    ...(used != null ? { usedPercent: used } : {}),
    ...(input.resetsAt ? { resetsAt: input.resetsAt } : {}),
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
  };
}

function rowMatchesCapacityProvider(row: DeskCallRow, provider: string): boolean {
  const needle = provider.trim().toLowerCase();
  if (!needle) return true;
  const id = row.id.toLowerCase();
  return id === needle || row.provider === needle || id === `bot:${needle}`;
}

function publicCapacityModels(row: DeskCallRow): Array<{ id: string; name: string }> {
  if (row.models && row.models.length > 0) {
    return row.models.map((item) => ({ id: item.id, name: item.name }));
  }
  if (row.model) return [{ id: row.model, name: row.model }];
  return [];
}

/** Official leftover/used only. Never `100 - leftover`. */
export function capacityMeterForRow(
  row: DeskCallRow,
  plans?: WatchPlans,
  settings?: { customBots: CustomBot[] },
): CapacityMeter {
  if (plans && settings) {
    const leftover = leftoverPercentForKey(row.id, plans, settings);
    const deskRow = deskRowForKey(row.id, settings);
    const plan = leftoverForCard(deskRow, plans);
    // One decision for every surface. Reading the flag alone missed the plan
    // whose weekly gauge never moves, and this snapshot answered `known: 100`
    // for it while the ring answered 0% — a guessed 100 either way.
    const unmetered =
      planAllowance(plan, {
        provider: deskRow.provider,
        local: isLocalEndpoint(deskRow.bot?.baseUrl),
      }).status === "unmetered";
    return officialCapacityMeter({
      leftover,
      used: plan?.usedPercent,
      resetsAt: row.resetsAt ?? plan?.resetsAt,
      observedAt: plan?.observedAt,
      unmetered,
    });
  }
  return officialCapacityMeter({
    leftover: row.leftoverPercent,
    used: row.usedPercent,
    resetsAt: row.resetsAt,
  });
}

function snapshotFreshness(now: number, fetchedAt: number | undefined, rows: CapacityRow[]): CapacityFreshness {
  if (fetchedAt != null && now - fetchedAt > CAPACITY_STALE_AFTER_MS) return "stale";
  if (rows.some((row) => row.meter.status === "known")) return "fresh";
  return "unknown";
}

/**
 * Versioned leftover snapshot for harness MCP. Builds only public fields.
 * Does not invent used from remaining, fold Cursor pools, or add a total.
 */
export function projectCapacitySnapshot(rows: DeskCallRow[], query: CapacitySnapshotQuery = {}): CapacitySnapshot {
  const now = query.now ?? Date.now();
  const fetchedAt = query.fetchedAt;
  const provider = query.provider?.trim() ?? "";
  const out: CapacityRow[] = [];
  for (const row of rows) {
    if (!isDeskCapacityProvider(row.provider)) continue;
    if (row.kind !== "vendor" && row.kind !== "custom") continue;
    if (/^(openclaw|hermes)(\/|$)/i.test(row.id)) continue;
    if (provider && !rowMatchesCapacityProvider(row, provider)) continue;
    if (query.callableOnly && !row.canCall) continue;
    const status = row.status;
    const reasonCode: CapacityReasonCode | undefined = status === "ok" ? undefined : status;
    out.push({
      id: row.id,
      kind: row.kind,
      provider: row.provider,
      name: row.name,
      models: publicCapacityModels(row),
      availability: {
        canCall: row.canCall,
        status,
        ...(reasonCode ? { reasonCode } : {}),
      },
      meter: capacityMeterForRow(row, query.plans, query.settings),
    });
  }
  return {
    version: CAPACITY_SNAPSHOT_VERSION,
    asOf: new Date(fetchedAt ?? now).toISOString(),
    freshness: snapshotFreshness(now, fetchedAt, out),
    rows: out,
  };
}

/** This chat’s vendor plus any vendor it is calling. */
export function watchNoticeKeysForChat(
  session: Pick<Session, "provider" | "customBotId" | "id" | "messages">,
  sessions: Array<Pick<Session, "id" | "parentId" | "provider" | "customBotId">>,
): string[] {
  const keys = new Set<string>([watchKeyForSession(session)]);
  for (const child of sessions) {
    if (child.parentId === session.id || session.messages.some((item) => item.subagentSessionId === child.id)) {
      keys.add(watchKeyForSession(child));
    }
  }
  return [...keys];
}

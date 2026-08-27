import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { FuelRing } from "./FuelRing";
import { modelsFor, shortModelName, usageModelLabel } from "../lib/models";
import { isCursorWatchKey } from "../lib/cursor-lane";
import { useStoreSelector } from "../lib/store";
import { sameUsageDesk, selectUsageDesk } from "../lib/store-select";
import type { ProviderId, UsageRange } from "../lib/types";
import { ContextMeter } from "./ContextMeter";
import {
  byModel,
  customBotUsageEvents,
  cursorLaneEvents,
  deskUsageCards,
  leftoverFetchKnown,
  leftoverForCard,
  leftoverMissingCopy,
  planRingView,
  isLocalEndpoint,
  pickClaudeWindow,
  pickPlanWindow,
  claudeWindowTabs,
  planTimeWindows,
  planWindowChip,
  formatPlanObservation,
  formatPlanReset,
  formatCost,
  formatIoLine,
  formatTokens,
  usageFocusFacts,
  inRange,
  modelsForProvider,
  heatLevel,
  heatmapPeak,
  cellDotBackground,
  stretchHeatmap,
  type HeatCell,
  type StretchHeatmap,
  type UsageGroup,
} from "../lib/usage";

const RANGES: { id: UsageRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "all", label: "All" },
];

const planWindowByFocus = new Map<string, string>();

type Focus = ProviderId | `bot:${string}` | "overview" | "cursor:cursor-models" | "cursor:other-models";

function SplitBar({
  label,
  value,
  peak,
  tone,
  color,
  display,
}: {
  label: string;
  value: number;
  peak: number;
  tone: ProviderId;
  color?: string;
  display?: string;
}) {
  const width = value <= 0 ? 4 : Math.max(4, Math.round((value / Math.max(peak, 1)) * 220));
  return (
    <div className="usage-split">
      <span>{label}</span>
      <div className="usage-split-track">
        <i
          className={tone}
          style={{
            width,
            ...(color ? { background: color } : {}),
          }}
        />
      </div>
      <em>{display ?? formatTokens(value)}</em>
    </div>
  );
}

function cellSummary(cell: HeatCell): string {
  if (cell.tokens <= 0) return `${cell.label}: no tokens`;
  const bots = cell.bots.map((bot) => `${bot.label} ${formatTokens(bot.tokens)}`).join(", ");
  const io = formatIoLine(cell);
  return bots
    ? `${cell.label}: ${formatTokens(cell.tokens)} tokens · ${io} · ${bots}`
    : `${cell.label}: ${formatTokens(cell.tokens)} tokens · ${io}`;
}

function Stretch({
  map,
  range,
  hideBots = false,
}: {
  map: StretchHeatmap;
  range: UsageRange;
  hideBots?: boolean;
}) {
  const [shown, setShown] = useState(map);
  const [swap, setSwap] = useState<"out" | "in" | null>(null);
  const rangeRef = useRef(range);
  const box = useRef<HTMLDivElement>(null);
  const peak = heatmapPeak(shown);
  const max = peak?.tokens ?? 1;
  const [tip, setTip] = useState<{ cell: HeatCell; left: number; top: number; place: "above" | "below" } | null>(
    null,
  );

  useEffect(() => {
    if (rangeRef.current === range) {
      setShown(map);
      return;
    }
    rangeRef.current = range;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const apply = () => {
      flushSync(() => setShown(map));
    };
    const view = document as Document & {
      startViewTransition?: (update: () => void) => { finished: Promise<void> };
    };
    if (!reduce && typeof view.startViewTransition === "function") {
      const run = view.startViewTransition(apply);
      void run.finished.catch(() => undefined);
      return;
    }
    if (reduce) {
      apply();
      return;
    }
    const from = box.current?.offsetHeight ?? 0;
    setSwap("out");
    setTip(null);
    const hide = window.setTimeout(() => {
      apply();
      setSwap("in");
      const el = box.current;
      if (el && from > 0) {
        const to = el.offsetHeight;
        if (Math.abs(to - from) > 1) {
          el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
            duration: 480,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          });
        }
      }
      window.setTimeout(() => setSwap(null), 520);
    }, 150);
    return () => window.clearTimeout(hide);
  }, [map, range]);

  const showTip = (cell: HeatCell, node: HTMLElement) => {
    if (cell.pad) return;
    const dot = node.getBoundingClientRect();
    const width = 208;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, dot.left + dot.width / 2 - width / 2));
    const place: "above" | "below" = dot.top > window.innerHeight - dot.bottom && dot.top > 88 ? "above" : "below";
    const top = place === "above" ? dot.top - 8 : dot.bottom + 8;
    setTip({ cell, left, top, place });
  };

  const onDot = (cell: HeatCell, node: HTMLElement) => {
    showTip(cell, node);
  };

  return (
    <div
      ref={box}
      className={`usage-stretch${swap ? ` swap-${swap}` : ""}`}
      onMouseLeave={() => setTip(null)}
      style={{ ["--stretch-cols" as string]: String(shown.columns.length) }}
    >
      <div className="usage-stretch-head">
        <div className="section-label" style={{ margin: 0 }}>
          This stretch
        </div>
        {peak && (
          <span className="usage-stretch-peak">
            Peak {peak.label} · {formatTokens(peak.tokens)}
          </span>
        )}
      </div>
      <div
        className={`usage-dots${shown.rows === 1 ? " flat" : ""}${shown.columns.length <= 7 && shown.rows === 1 ? " week" : ""}${shown.columns.length > 12 ? " dense" : ""}`}
        role="img"
        aria-label="Usage over this stretch"
      >
        {shown.columns.map((column, index) => (
          <div
            key={column[0]?.key ?? index}
            className="usage-dot-col"
            style={{ ["--i" as string]: String(index) }}
          >
            {column.map((cell) => {
              const fill = cell.pad ? undefined : cellDotBackground(cell, max, range);
              const multi = !cell.pad && cell.bots.length > 1;
              return (
                <button
                  key={cell.key}
                  type="button"
                  className={`usage-dot l${cell.pad ? 0 : heatLevel(cell.tokens, max)}${cell.pad ? " pad" : ""}${fill ? " ink" : ""}${multi ? " pie" : ""}`}
                  style={
                    fill
                      ? {
                          ["--dot-ink" as string]: fill,
                          ...(!multi ? { background: fill } : {}),
                        }
                      : undefined
                  }
                  disabled={cell.pad}
                  aria-label={cell.pad ? undefined : cellSummary(cell)}
                  onMouseEnter={(event) => onDot(cell, event.currentTarget)}
                  onFocus={(event) => onDot(cell, event.currentTarget)}
                  onBlur={() => setTip(null)}
                >
                  {multi && fill ? <span className="usage-dot-fill" style={{ background: fill }} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="usage-dot-labels">
        {shown.labels.map((item, index) => {
          const next = shown.labels[index + 1];
          const start = item.column + 1;
          const end = next ? next.column + 1 : shown.columns.length + 1;
          return (
            <span key={`label-${item.column}-${item.text}`} style={{ gridColumn: `${start} / ${end}` }}>
              {item.text}
            </span>
          );
        })}
      </div>
      {tip && (
        <div className={`usage-tip ${tip.place}`} style={{ left: tip.left, top: tip.top }}>
          <strong>{tip.cell.label}</strong>
          <span>{formatTokens(tip.cell.tokens)} tokens</span>
          <span>
            {formatTokens(tip.cell.inputTokens)} in · {formatTokens(tip.cell.outputTokens)} out
          </span>
          {!hideBots && tip.cell.bots.length > 0 ? (
            <ul>
              {tip.cell.bots.map((bot) => (
                <li key={bot.key ?? `${bot.provider}:${bot.label}`}>
                  <span>
                    <i
                      className={`dot ${bot.provider}`}
                      style={bot.color ? { background: bot.color } : undefined}
                    />
                    {bot.label}
                  </span>
                  <em>
                    {formatTokens(bot.tokens)}
                    <small>
                      {formatTokens(bot.inputTokens)} in · {formatTokens(bot.outputTokens)} out
                    </small>
                  </em>
                </li>
              ))}
            </ul>
          ) : !hideBots && tip.cell.bots.length === 0 ? (
            <span>No bot spend in this cell</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function modelShare(tokens: number, total: number): number {
  if (tokens <= 0 || total <= 0) return 0;
  return (tokens / total) * 100;
}

function ModelRow({
  row,
  showDot = false,
  total = 0,
}: {
  row: UsageGroup;
  showDot?: boolean;
  total?: number;
}) {
  const width = modelShare(row.totalTokens, total);
  return (
    <li className="usage-model">
      <div className="usage-model-top">
        <span>
          {showDot && (
            <span
              className={`dot ${row.provider}`}
              style={row.color ? { background: row.color } : undefined}
            />
          )}
          {row.label}
          <em>
            {formatIoLine(row)}
          </em>
        </span>
        <strong>{formatTokens(row.totalTokens)}</strong>
      </div>
      <div className="usage-split-track wide">
        <i
          className={row.provider}
          style={{
            width: `${width}%`,
            minWidth: width > 0 && width < 1.2 ? 3 : undefined,
            ...(row.color ? { background: row.color } : {}),
          }}
        />
      </div>
    </li>
  );
}

function formatReset(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function planLoaderFor(row: { provider: ProviderId; focus: string }): boolean {
  if (row.provider === "grok") return Boolean(window.workhorse?.grokPlanUsage);
  if (row.provider === "codex") return Boolean(window.workhorse?.codexPlanUsage);
  if (row.provider === "claude") return Boolean(window.workhorse?.claudePlanUsage);
  if (row.provider === "cursor") return Boolean(window.workhorse?.cursorPlanUsage);
  return Boolean(window.workhorse?.customPlanUsage);
}

export function UsagePane({
  embedded = false,
  tabs,
  homeSignal = 0,
}: {
  embedded?: boolean;
  tabs?: ReactNode;
  homeSignal?: number;
}) {
  const {
    usage,
    usageRange,
    setUsageRange,
    closeUsage,
    grokPlan,
    refreshGrokPlan,
    codexPlan,
    refreshCodexPlan,
    claudePlan,
    refreshClaudePlan,
    cursorPlan,
    refreshCursorPlan,
    customPlans,
    customPlanKnown,
    vendorPlanKnown,
    refreshCustomPlans,
    settings,
  } = useStoreSelector(selectUsageDesk, sameUsageDesk);
  const [focus, setFocus] = useState<Focus>("overview");
  const [claudeWindow, setClaudeWindowState] = useState(
    () => planWindowByFocus.get("overview") ?? "weekly_all",
  );
  const setClaudeWindow = (id: string, key = String(focus)) => {
    planWindowByFocus.set(key, id);
    setClaudeWindowState(id);
  };
  useEffect(() => {
    if (homeSignal > 0) setFocus("overview");
  }, [homeSignal]);
  useEffect(() => {
    const key = String(focus);
    const saved = planWindowByFocus.get(key);
    if (saved) {
      setClaudeWindowState(saved);
      return;
    }
    setClaudeWindowState(focus === "claude" ? "weekly_all" : "");
  }, [focus]);
  const range = usageRange ?? "month";
  const events = (usage ?? []).filter((event) => inRange(event, range));
  const cards = deskUsageCards(events, settings);
  const models = byModel(events, settings.customBots).map((row) => ({
    ...row,
    label: usageModelLabel(row.provider, row.label),
  }));
  const modelsTotal = models.reduce((sum, row) => sum + row.totalTokens, 0);
  const vendorLooks = {
    grok: settings.llms.grok,
    claude: settings.llms.claude,
    codex: settings.llms.codex,
  };
  const heatmap = stretchHeatmap(events, range, Date.now(), settings.customBots, vendorLooks);
  const focused = focus === "overview" ? null : cards.find((row) => row.focus === focus) ?? null;
  const focusedEvents =
    focused?.focus.startsWith("bot:") && focused.provider === "custom"
      ? customBotUsageEvents(
          events,
          settings.customBots.find((bot) => `bot:${bot.id}` === focused.focus) ?? {
            id: focused.key,
            name: focused.label,
            model: focused.label,
          },
        )
      : focused && isCursorWatchKey(focused.focus)
        ? cursorLaneEvents(events, focused.focus)
        : focused
          ? events.filter((event) => event.provider === focused.provider)
          : [];
  const focusedModels =
    !focused
      ? []
      : focused.provider === "custom"
        ? byModel(focusedEvents, settings.customBots).map((row) => ({
            ...row,
            label: shortModelName("custom", row.label),
          }))
        : modelsForProvider(events, focused.provider)
            .filter((row) => row.totalTokens > 0 || row.events > 0)
            .map((row) => ({
              ...row,
              label: shortModelName(focused.provider, row.label),
            }));
  const focusedTotal = focusedModels.reduce((sum, row) => sum + row.totalTokens, 0);
  const focusFacts = focused ? usageFocusFacts(focused, focusedEvents) : null;
  useEffect(() => {
    const pull = () => {
      refreshGrokPlan();
      refreshCodexPlan();
      refreshClaudePlan();
      refreshCursorPlan();
      refreshCustomPlans();
    };
    pull();
    const timer = window.setInterval(pull, 180_000);
    return () => window.clearInterval(timer);
  }, [refreshGrokPlan, refreshCodexPlan, refreshClaudePlan, refreshCursorPlan, refreshCustomPlans]);

  const deskPlans = { grok: grokPlan, codex: codexPlan, claude: claudePlan, cursor: cursorPlan, custom: customPlans };
  const plan = focused ? leftoverForCard(focused, deskPlans) : undefined;
  const timeWindows = planTimeWindows(plan);
  const claudePick = pickClaudeWindow(focused?.provider === "claude" ? plan : claudePlan, claudeWindow);
  const windowPick = focused
    ? pickPlanWindow(plan, claudeWindow, focused.provider)
    : undefined;
  const claudeTabs = claudeWindowTabs(focused?.provider === "claude" ? plan : plan);
  const windowTabs =
    focused?.provider === "claude"
      ? claudeTabs
      : timeWindows.map((item) => ({ id: item.product, label: item.label }));
  const planName = focused?.provider === "grok" ? "SuperGrok" : focused?.label ?? "Weekly";
  const focusedBot =
    focused?.focus.startsWith("bot:")
      ? settings.customBots.find((bot) => `bot:${bot.id}` === focused.focus)
      : undefined;
  const weeklyUnlimited = Boolean(plan?.products.some((item) => item.unlimited && /weekly/i.test(item.product)));
  const showCodexLeftover = focused?.provider === "codex";
  const selectedUsagePercent =
    windowPick?.usagePercent ??
    (focused?.provider === "claude"
      ? (claudePick?.usagePercent ?? plan?.usedPercent ?? 0)
      : (plan?.usedPercent ?? 0));
  const allowanceFact = windowPick?.unlimited
    ? "∞"
    : `${Math.round(showCodexLeftover ? Math.max(0, 100 - selectedUsagePercent) : selectedUsagePercent)}%`;
  const planCopyBase = plan
    ? weeklyUnlimited
      ? windowPick && !windowPick.unlimited && windowPick.resetsAt
        ? `${windowPick.label} limit · ${formatPlanReset(windowPick.resetsAt)}.`
        : "5h limit."
    : plan.leftPercent <= 0
      ? plan.resetsAt
        ? `Spent · ${formatReset(plan.resetsAt)}.`
        : "Weekly allowance spent."
      : plan.resetsAt
        ? `${planName} · ${formatReset(plan.resetsAt)}.`
        : `${planName} allowance.`
    : undefined;
  const observation = formatPlanObservation(plan?.observedAt);
  const planCopy = planCopyBase && observation
    ? `${planCopyBase.replace(/\.$/, "")} · ${observation}.`
    : planCopyBase;
  const back = () => {
    if (focus !== "overview") {
      setFocus("overview");
      return;
    }
    closeUsage();
  };

  return (
    <section className={embedded ? "usage-embed" : "picker usage-page"}>
      {embedded ? (
        // The same bar Settings draws for every other tab, so the page does
        // not shift when Usage is chosen. Back is ours: from a drilled-in
        // view it steps out first.
        <div className="settings-bar">
          {tabs}
          <button className="tiny" type="button" onClick={back}>
            Back
          </button>
        </div>
      ) : (
        <div className="usage-head">
          <h2>Usage</h2>
          <button className="tiny" type="button" onClick={back}>
            Back
          </button>
        </div>
      )}

      {focus === "overview" ? (
        <>
          <div className="usage-overview">
            <div className="actions usage-ranges">
              {RANGES.map((item) => (
                <button
                  key={item.id}
                  className={usageRange === item.id ? "tiny active-kind" : "tiny"}
                  type="button"
                  onClick={() => setUsageRange(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="usage-brains">
              {cards.map((row, index) => {
                // A model served from this machine has no allowance to draw.
                const local = isLocalEndpoint(
                  settings.customBots.find((bot) => `bot:${bot.id}` === row.focus)?.baseUrl,
                );
                const ring = planRingView(row, deskPlans, planWindowByFocus.get(String(row.focus)), { local });
                const chip = planWindowChip(leftoverForCard(row, deskPlans), { local, provider: row.provider });
                return (
                  <button
                    key={row.key}
                    className="usage-brain"
                    type="button"
                    onClick={() => setFocus(row.focus)}
                  >
                    <FuelRing
                      value={ring?.value}
                      size={104}
                      tone={row.provider}
                      color={row.color}
                      delay={index * 90}
                      label={ring ? ring.label : "…"}
                    />
                    <span>{row.label}</span>
                    <em>
                      {chip
                        ? chip
                        : row.provider === "claude" && claudePick
                          ? `${Math.round(Math.max(0, 100 - claudePick.usagePercent))}% ${claudePick.label.toLowerCase()}`
                          : formatIoLine(row)}
                    </em>
                  </button>
                );
              })}
            </div>
          </div>
          <Stretch map={heatmap} range={range} />
          {models.length > 0 && (
            <ul className="usage-models">
              {models.map((row) => (
                <ModelRow key={row.key} row={row} showDot total={modelsTotal} />
              ))}
            </ul>
          )}
        </>
      ) : focused ? (
        <>
          <div className="actions usage-ranges">
            {RANGES.map((item) => (
              <button
                key={item.id}
                className={usageRange === item.id ? "tiny active-kind" : "tiny"}
                type="button"
                onClick={() => setUsageRange(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {timeWindows.length > 0 ? (
            <div className="usage-limits">
              <div className="usage-limits-head">
                <span className="sheet-label">Plan usage limits</span>
                {focused.provider !== "cursor" ? (
                  <ContextMeter
                    referenceOnly
                    fallbackWindow={focusedBot?.contextWindow ?? modelsFor(focused.provider)[0]?.contextWindow}
                  />
                ) : null}
              </div>
              {windowTabs.length > 0 ? (
                <div className="actions usage-ranges usage-limits-windows">
                  {windowTabs.map((item) => (
                    <button
                      key={item.id}
                      className={windowPick?.product === item.id ? "tiny active-kind" : "tiny"}
                      type="button"
                      onClick={() => setClaudeWindow(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {timeWindows.map((item) => {
                const displayPercent = showCodexLeftover
                  ? Math.max(0, 100 - item.usagePercent)
                  : item.usagePercent;
                return (
                  <button
                    key={item.product}
                    className={`usage-limit${windowPick?.product === item.product ? " on" : ""}${item.unlimited ? " unlimited" : ""}`}
                    type="button"
                    onClick={() => setClaudeWindow(item.product)}
                  >
                    <div className="usage-limit-top">
                      <strong>{item.label}</strong>
                      <em>{item.unlimited ? "Unlimited" : `${Math.round(displayPercent)}% ${showCodexLeftover ? "left" : "used"}`}</em>
                    </div>
                    <div className="usage-split-track wide">
                      <i
                        className={focused.provider}
                        style={{
                          width: item.unlimited ? "100%" : `${Math.max(3, Math.round(displayPercent))}%`,
                          ...(focused.color ? { background: focused.color } : {}),
                        }}
                      />
                    </div>
                    {item.unlimited ? <span>No weekly cap on this seat</span> : item.resetsAt ? <span>{formatPlanReset(item.resetsAt)}</span> : null}
                  </button>
                );
              })}
              {planCopy ? (
                <div className="usage-limits-foot">
                  <p className="usage-limit-note">{planCopy}</p>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="usage-plan">
              <FuelRing
                value={plan ? plan.leftPercent / 100 : undefined}
                size={120}
                tone={focused.provider}
                color={focused.color}
                label={plan ? `${Math.round(plan.leftPercent)}% left` : "…"}
              />
              <div className="usage-plan-copy">
                <span className="sheet-label">Weekly allowance</span>
                <p>
                  {planCopy ??
                    leftoverMissingCopy({
                      hasKey: focused.provider !== "custom" || Boolean(focusedBot?.apiKey?.trim()),
                      fetchKnown: leftoverFetchKnown({
                        provider: focused.provider,
                        botId: focusedBot?.id,
                        vendorPlanKnown,
                        customPlanKnown,
                      }),
                      canLoad: planLoaderFor(focused),
                      planName,
                    })}
                </p>
                {focused.provider !== "cursor" ? (
                  <ContextMeter
                    referenceOnly
                    fallbackWindow={focusedBot?.contextWindow ?? modelsFor(focused.provider)[0]?.contextWindow}
                  />
                ) : null}
              </div>
            </div>
          )}
          <div className="usage-facts">
            <div className="usage-fact">
              <span>API traffic</span>
              <strong>{focusFacts?.apiTraffic ?? "-"}</strong>
            </div>
            <div className="usage-fact">
              <span>{plan ? (showCodexLeftover ? "Left" : "Used") : "Cost"}</span>
              <strong>
                {plan ? allowanceFact : formatCost(focused)}
              </strong>
            </div>
            <div className="usage-fact">
              <span>Latest context</span>
              <strong>{focusFacts?.latestContext ?? "-"}</strong>
            </div>
            <div className="usage-fact">
              <span>Requests</span>
              <strong>{focusFacts?.requests ?? 0}</strong>
            </div>
            <div className="usage-fact">
              <span>Chats</span>
              <strong>{focusFacts?.chats ?? 0}</strong>
            </div>
          </div>
          <div className="usage-detail">
            <div className="usage-detail-copy">
              <SplitBar
                label="In"
                value={focused.inputTokens}
                peak={Math.max(focused.inputTokens, focused.outputTokens)}
                tone={focused.provider}
                color={focused.color}
              />
              <SplitBar
                label="Out"
                value={focused.outputTokens}
                peak={Math.max(focused.inputTokens, focused.outputTokens)}
                tone={focused.provider}
                color={focused.color}
              />
            </div>
          </div>
          <Stretch
            map={stretchHeatmap(focusedEvents, range, Date.now(), settings.customBots, vendorLooks)}
            range={range}
            hideBots
          />
          {focusedModels.length > 0 && (
            <ul className="usage-models">
              {focusedModels.map((row) => (
                <ModelRow
                  key={row.key}
                  row={{ ...row, color: row.color ?? focused.color }}
                  total={focusedTotal}
                />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

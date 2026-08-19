import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { estimateChatContext, type ChatContextStats, type ContextCategory } from "../lib/context-stats";
import { contextWindowFor, formatWindow } from "../lib/models";
import { deskInk } from "../lib/settings";
import { useActiveSession, useStore } from "../lib/store";
import type { Session } from "../lib/types";
import { formatTokens } from "../lib/usage";

function categoryShare(tokens: number, total: number): number {
  if (tokens <= 0 || total <= 0) return 0;
  return Math.max(2, Math.round((tokens / total) * 1000));
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

function useAnimatedNumber(target: number, sessionId: string | undefined, duration = 680): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  const lastSession = useRef(sessionId);

  useEffect(() => {
    if (lastSession.current !== sessionId) {
      lastSession.current = sessionId;
      from.current = target;
      setValue(target);
      return;
    }
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = target;
      setValue(target);
      return;
    }
    const startValue = from.current;
    if (Math.abs(startValue - target) < 1) {
      from.current = target;
      setValue(target);
      return;
    }
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const next = startValue + (target - startValue) * easeOut(t);
      setValue(next);
      if (t < 1) frame = window.requestAnimationFrame(tick);
      else from.current = target;
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [target, sessionId, duration]);

  return value;
}

function ContextRows({ rows }: { rows: ContextCategory[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="context-rows">
      {rows.map((row) => (
        <li key={row.id} className={row.informational ? "info" : undefined}>
          <span>
            {row.label}
            {row.detail ? <em>{row.detail}</em> : null}
          </span>
          <strong>{formatTokens(row.tokens)}</strong>
        </li>
      ))}
    </ul>
  );
}

export function placeContextPop(input: {
  meter: { top: number; bottom: number; left: number; right: number; width: number; height: number };
  pop: { width: number; height: number };
  viewport: { width: number; height: number };
  gap?: number;
}): { top: number; left: number } {
  const gap = input.gap ?? 8;
  const { meter, pop, viewport } = input;
  const maxLeft = Math.max(12, viewport.width - pop.width - 12);
  const left = Math.min(Math.max(12, meter.left + meter.width / 2 - pop.width / 2), maxLeft);
  const below = meter.bottom + gap;
  const fitsBelow = below + pop.height <= viewport.height - 12;
  const top = fitsBelow ? below : Math.max(12, meter.top - pop.height - gap);
  return { top, left };
}

export function ContextMeter({
  session: sessionProp,
  compact = false,
  fallbackWindow,
  matchProvider,
  matchBotId,
  referenceOnly = false,
}: {
  session?: Session | null;
  compact?: boolean;
  fallbackWindow?: number;
  matchProvider?: import("../lib/types").ProviderId;
  matchBotId?: string;
  /** Catalog window size only — do not bind to a live chat. */
  referenceOnly?: boolean;
} = {}) {
  const liveSession = useActiveSession();
  const matchedSession =
    referenceOnly
      ? undefined
      : matchProvider &&
          (!liveSession ||
            liveSession.provider !== matchProvider ||
            (matchBotId ? liveSession.customBotId !== matchBotId : false))
        ? undefined
        : liveSession;
  const session = sessionProp ?? matchedSession;
  const store = useStore();
  const customWindow =
    (session?.customBotId
      ? store.settings.customBots.find((bot) => bot.id === session.customBotId)?.contextWindow
      : undefined) ?? store.settings?.llms.custom.contextWindow ?? fallbackWindow;
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<ChatContextStats | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const windowSize = session
    ? contextWindowFor(session.provider, session.model, customWindow)
    : 0;
  const ink = session ? deskInk(session, store.settings) : undefined;
  const estimate = useMemo(() => {
    if (!session) return null;
    return estimateChatContext({
      contextUsed: session.contextUsed,
      windowSize,
      messages: session.messages,
    });
  }, [session, windowSize]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const box = root.current?.getBoundingClientRect();
      if (!box) return;
      const popBox = pop.current?.getBoundingClientRect();
      setAnchor(
        placeContextPop({
          meter: box,
          pop: { width: popBox?.width || 292, height: popBox?.height || 220 },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      );
    };
    place();
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const timer = window.setTimeout(() => document.addEventListener("mousedown", onPointer), 0);
    window.addEventListener("resize", place);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    setLive(null);
  }, [session?.id]);

  useEffect(() => {
    if (referenceOnly) return;
    if (!session || session.provider !== "grok") return;
    if (!window.workhorse?.grokSessionInfo) return;
    let cancelled = false;
    void window.workhorse
      .grokSessionInfo(session.id)
      .then((next) => {
        if (!cancelled && next) setLive(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [referenceOnly, session?.id, session?.provider, session?.status]);

  const stats = live ?? estimate;
  const shownUsed = stats?.used ?? 0;
  const shownTotal = stats?.total ?? fallbackWindow ?? 0;
  const animatedUsed = useAnimatedNumber(shownUsed, session?.id);
  if ((!session || !estimate || !stats) && !(fallbackWindow && fallbackWindow > 0)) return null;
  if ((!session || !estimate || !stats) && fallbackWindow && fallbackWindow > 0) {
    return (
      <div className="context-meter-wrap">
        <span className="context-meter quiet">
          <span className="context-copy">
            <strong>{formatWindow(fallbackWindow)}</strong>
            <em>context</em>
          </span>
        </span>
      </div>
    );
  }
  if (!session || !estimate || !stats) return null;
  const ratio = Math.min(1, animatedUsed / Math.max(shownTotal, 1));
  const size = compact ? 24 : 36;
  const stroke = compact ? 2.4 : 3.2;
  const radius = size / 2 - stroke;
  const length = 2 * Math.PI * radius;
  const shown = animatedUsed > 0 ? Math.max(ratio, 0.045) : 0;
  const stackTotal = Math.max(stats.total, stats.used + stats.free, 1);
  const empty = stats.used === 0 && stats.occupying.length === 0;

  return (
    <div
      className={`context-meter-wrap ${session.provider}${compact ? " compact" : ""}`}
      style={ink ? ({ ["--desk-ink"]: ink } as CSSProperties) : undefined}
      ref={root}
    >
      <button
        type="button"
        className={`context-meter ${session.provider}`}
        title={`${shownUsed.toLocaleString()} of ${shownTotal.toLocaleString()} tokens retained for the next request`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span className="context-ring" aria-hidden="true">
          <svg viewBox={`0 0 ${size} ${size}`}>
            <circle className="context-ring-track" cx={size / 2} cy={size / 2} r={radius} />
            <circle
              className="context-ring-fill"
              cx={size / 2}
              cy={size / 2}
              r={radius}
              strokeDasharray={length}
              strokeDashoffset={length * (1 - shown)}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </svg>
        </span>
        <span className="context-copy">
          <strong>{animatedUsed > 0 ? formatWindow(Math.round(animatedUsed)) : "0"}</strong>
          <em>of {formatWindow(shownTotal)}</em>
        </span>
      </button>
      {open && (
        <div
          ref={pop}
          className="context-pop"
          role="dialog"
          aria-label="This chat’s context"
          style={anchor ? { top: anchor.top, left: anchor.left } : { top: 56, left: 12 }}
        >
          <header>
            <strong>Retained context</strong>
            <span>
              {formatTokens(stats.used)} of {formatTokens(stats.total)} · {stats.usagePct}%
            </span>
          </header>
          <div className="context-stack" aria-hidden="true">
            {stats.occupying.map((row) => (
              <i
                key={row.id}
                className={`seg ${row.id}`}
                style={{ flexGrow: categoryShare(row.tokens, stackTotal) }}
              />
            ))}
            <i className="seg free" style={{ flexGrow: Math.max(categoryShare(stats.free, stackTotal), 8) }} />
          </div>
          {empty ? (
            <p className="context-empty">Context empty.</p>
          ) : (
            <>
              <ContextRows
                rows={[
                  ...stats.occupying,
                  { id: "free", label: "Free space", tokens: stats.free },
                ]}
              />
              {stats.extra.length > 0 && (
                <>
                  <p className="context-aside">Not counted</p>
                  <ContextRows rows={stats.extra} />
                </>
              )}
            </>
          )}
          {stats.autoCompactAt ? (
            <footer>
              <span>Auto-compact at {stats.autoCompactAt}%</span>
            </footer>
          ) : null}
        </div>
      )}
    </div>
  );
}

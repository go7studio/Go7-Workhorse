import { useEffect, useMemo, useRef, useState } from "react";
import { estimateChatContext, type ChatContextStats, type ContextCategory } from "../lib/context-stats";
import {
  contextWindowFor,
  effortsFor,
  formatWindow,
  modelName,
  modelsFor,
} from "../lib/models";
import { customBotEnabled } from "../lib/custom-bots";
import { PROVIDERS } from "../lib/providers";
import {
  deskInk,
  hasAttachedLlm,
  vendorAttachedForSession,
  vendorEnabled,
  vendorLabel,
  vendorTint,
} from "../lib/settings";
import { useActiveSession, useStore } from "../lib/store";
import type { EffortLevel } from "../lib/types";
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

export function ContextMeter() {
  const session = useActiveSession();
  const store = useStore();
  const customWindow =
    (session?.customBotId
      ? store.settings.customBots.find((bot) => bot.id === session.customBotId)?.contextWindow
      : undefined) ?? store.settings?.llms.custom.contextWindow;
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<ChatContextStats | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const windowSize = session
    ? contextWindowFor(session.provider, session.model, customWindow)
    : 0;
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
      setAnchor({ top: box.bottom + 8, right: Math.max(12, window.innerWidth - box.right) });
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
  }, [session?.id, session?.provider, session?.status]);

  const stats = live ?? estimate;
  const shownUsed = stats?.used ?? 0;
  const shownTotal = stats?.total ?? 0;
  const animatedUsed = useAnimatedNumber(shownUsed, session?.id);
  if (!session || !estimate || !stats) return null;
  const ratio = Math.min(1, animatedUsed / Math.max(shownTotal, 1));
  const size = 36;
  const stroke = 3.2;
  const radius = size / 2 - stroke;
  const length = 2 * Math.PI * radius;
  const shown = animatedUsed > 0 ? Math.max(ratio, 0.045) : 0;
  const stackTotal = Math.max(stats.total, stats.used + stats.free, 1);
  const empty = stats.used === 0 && stats.occupying.length === 0;

  return (
    <div className={`context-meter-wrap ${session.provider}`} ref={root}>
      <button
        type="button"
        className={`context-meter ${session.provider}`}
        title={`${shownUsed.toLocaleString()} of ${shownTotal.toLocaleString()} tokens in this chat`}
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
          className="context-pop"
          role="dialog"
          aria-label="This chat’s context"
          style={anchor ? { top: anchor.top, right: anchor.right } : { top: 56, right: 22 }}
        >
          <header>
            <strong>This chat</strong>
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
            <p className="context-empty">Nothing in this chat is using the context window yet.</p>
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
                  <p className="context-aside">Also loaded, not counted in the bar</p>
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

function BrainSlider() {
  const session = useActiveSession();
  const { setSessionEffort } = useStore();
  if (!session) return null;
  const levels = effortsFor(session.provider, session.model);
  if (levels.length === 0) return null;

  const index = Math.max(0, levels.findIndex((item) => item.id === session.effort));

  return (
    <div className="brain">
      <span className="brain-label">Brain</span>
      <label className="brain-track">
        <span className="brain-dots" aria-hidden="true">
          {levels.map((item) => (
            <i key={item.id} className={item.id === session.effort ? "on" : undefined} />
          ))}
        </span>
        <input
          type="range"
          min={0}
          max={levels.length - 1}
          step={1}
          value={index}
          aria-label="Brain level"
          onChange={(event) => {
            const next = levels[Number(event.target.value)]?.id as EffortLevel | undefined;
            if (next) setSessionEffort(next);
          }}
        />
      </label>
      <span className="brain-value">{levels[index]?.label ?? levels[0]?.label}</span>
    </div>
  );
}

export function ModelMenu() {
  const session = useActiveSession();
  const store = useStore();
  const { setSessionModel, openSettings } = store;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  if (!session) return null;
  const ink = deskInk(session, store.settings);
  const attached = vendorAttachedForSession(session, store.settings);
  const deskHasLlm = hasAttachedLlm(store.settings);

  return (
    <div className="chat-bar-ai">
      <div className="model-menu" ref={root}>
        <button
          className="model-trigger"
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => {
            if (!deskHasLlm) {
              openSettings("llms");
              return;
            }
            setOpen((value) => !value);
          }}
        >
          {attached ? (
            <span className={`dot ${session.provider}`} style={ink ? { background: ink } : undefined} />
          ) : null}
          <strong>
            {attached
              ? session.customBotId
                ? store.settings.customBots.find((bot) => bot.id === session.customBotId)?.name ??
                  modelName(session.provider, session.model)
                : modelName(session.provider, session.model)
              : "Attach LLM"}
          </strong>
          <span className="caret" aria-hidden="true" />
        </button>
        {open && (
          <div className="model-pop" role="listbox">
            {PROVIDERS.filter((provider) => provider.id !== "custom").map((provider) => {
              const providerId = provider.id as Exclude<typeof provider.id, "custom">;
              if (!vendorEnabled(store.settings.llms[providerId])) return null;
              return (
              <div key={provider.id} className="model-group">
                <div className="section-label">{vendorLabel(providerId, store.settings.llms[providerId])}</div>
                {modelsFor(provider.id).map((model) => {
                  const active = session.provider === providerId && session.model === model.id;
                  const tint = vendorTint(providerId, store.settings.llms[providerId]);
                  return (
                    <button
                      key={model.id}
                      className={active ? "active" : undefined}
                      type="button"
                      onClick={() => {
                        setSessionModel(providerId, model.id);
                        setOpen(false);
                      }}
                    >
                      <span
                        className={`dot ${providerId}`}
                        style={tint ? { background: tint } : undefined}
                      />
                      <span className="model-line">
                        {model.name}
                        <em>{formatWindow(model.contextWindow)}</em>
                      </span>
                    </button>
                  );
                })}
              </div>
              );
            })}
            {store.settings.customBots.some((bot) => customBotEnabled(bot)) && (
              <div className="model-group">
                <div className="section-label">Your bots</div>
                {store.settings.customBots
                  .filter((bot) => customBotEnabled(bot))
                  .map((bot) => {
                  const active = session.customBotId === bot.id;
                  return (
                    <button
                      key={bot.id}
                      className={active ? "active" : undefined}
                      type="button"
                      onClick={() => {
                        setSessionModel("custom", bot.model, bot.id);
                        setOpen(false);
                      }}
                    >
                      <span className="dot custom" style={{ background: bot.color }} />
                      <span className="model-line">
                        {bot.name}
                        <em>{formatWindow(bot.contextWindow)}</em>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      {attached ? <BrainSlider /> : null}
    </div>
  );
}

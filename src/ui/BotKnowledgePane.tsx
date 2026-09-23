import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ORCHESTRATION_TASK_DOMAINS,
  botKnowledgeSnapshot,
  domainIntelligenceBar,
} from "../lib/domain-benchmark";
import { activeRouteLoad, orchestrationTierNote } from "../lib/routing";
import { useStore } from "../lib/store";
import type { RoutingTaskTier, TaskDomain } from "../lib/types";
import { measureRunDraws } from "../lib/usage";
import { watchVendorStatuses } from "../lib/watch";
import { BotKnowledgeRubricButton, BotKnowledgeRubricSheet, type RubricTarget } from "./BotKnowledgeRubric";

const TIERS: { id: RoutingTaskTier; label: string }[] = [
  { id: "quick", label: "Quick" },
  { id: "balanced", label: "Balanced" },
  { id: "deep", label: "Deep" },
];

const DOMAIN_LABEL: Record<TaskDomain, string> = {
  coding: "Coding",
  "image-generation": "Image generation",
  writing: "Writing",
  visual: "Visual",
  data: "Data",
  general: "General",
};

function rowMotionKey(row: { provider: string; model: string; customBotId?: string }) {
  return `${row.provider}:${row.model}:${row.customBotId ?? ""}`;
}

/** Ten ticks, ten points each: the one a score or bar of 0–100 lands on. */
function tickOf(points: number): number {
  return Math.max(1, Math.round(points / 10));
}

function ScoreMark({ score, bar }: { score: number; bar: number }) {
  const meets = score >= bar;
  return (
    <div className={`bk-score${meets ? " meets" : " below"}`}>
      <strong>
        {score}
        <span>/100</span>
      </strong>
      <span className="bk-ticks" aria-hidden="true">
        {Array.from({ length: 10 }, (_, index) => {
          const step = index + 1;
          const tone = [step <= Math.round(score / 10) ? "fill" : "", step === tickOf(bar) ? "bar" : ""].filter(Boolean).join(" ");
          return <i key={step} className={tone} />;
        })}
      </span>
    </div>
  );
}

function PlanLeftover({ line, visible }: { line: string; visible: string }) {
  const short5h = /^(\d+)% used · 5h$/.exec(visible);
  const match =
    /^(\d+)% leftover of this (\w+)'s plan overall \((\d+)% used this \2 so far — the whole \2 pool, not this prompt\)$/.exec(
      line,
    );
  const leftover = short5h
    ? Math.max(0, 100 - Number(short5h[1]))
    : match
      ? Number(match[1])
      : null;
  if (leftover === null) return <span className="bk-plan-line">{visible || line}</span>;
  return (
    <span className="bk-plan-meter">
      <span className="bk-plan-track" aria-hidden="true">
        <i style={{ width: `${leftover}%` }} />
      </span>
      <span className="bk-plan-line">{visible}</span>
    </span>
  );
}

export function BotKnowledgePane() {
  const store = useStore();
  const [domains, setDomains] = useState<TaskDomain[]>(["coding"]);
  const [tier, setTier] = useState<RoutingTaskTier>("balanced");
  const [rubricTarget, setRubricTarget] = useState<RubricTarget | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const rowRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const { settings, grokPlan, codexPlan, claudePlan, cursorPlan, customPlans, usage, watchPermits, watchDayMarks, sessions } =
    store;
  const plans = useMemo(
    () => ({ grok: grokPlan, codex: codexPlan, claude: claudePlan, cursor: cursorPlan, custom: customPlans }),
    [grokPlan, codexPlan, claudePlan, cursorPlan, customPlans],
  );
  const statuses = useMemo(
    () => watchVendorStatuses({ settings, usage, plans, permits: watchPermits, dayMarks: watchDayMarks }),
    [settings, usage, plans, watchPermits, watchDayMarks],
  );
  const loadKey = JSON.stringify(activeRouteLoad(sessions));
  const drawsKey = useMemo(() => JSON.stringify(measureRunDraws(usage, sessions)), [usage, sessions]);
  const snapshot = useMemo(
    () =>
      botKnowledgeSnapshot({
        settings,
        routing: settings.routing,
        statuses,
        plans,
        domain: domains[0] ?? "coding",
        domains,
        tier,
        usage,
        permits: watchPermits,
        activeLoad: JSON.parse(loadKey) as Record<string, number>,
        draws: JSON.parse(drawsKey) as ReturnType<typeof measureRunDraws>,
      }),
    [settings, statuses, plans, domains, tier, usage, watchPermits, loadKey, drawsKey],
  );
  const bar = domainIntelligenceBar(tier);
  const motionKey = `${domains.join(",")}:${tier}:${snapshot.models.map((row) => rowMotionKey(row)).join("|")}`;

  useLayoutEffect(() => {
    const tbody = tbodyRef.current;
    if (!tbody) return;
    const ease = getComputedStyle(document.documentElement).getPropertyValue("--ease").trim() || "ease";
    const rows = tbody.querySelectorAll<HTMLTableRowElement>("tr[data-row-key]");
    for (const row of rows) {
      const key = row.dataset.rowKey;
      if (!key) continue;
      const next = row.getBoundingClientRect();
      const prev = rowRectsRef.current.get(key);
      if (prev) {
        const dy = prev.top - next.top;
        if (Math.abs(dy) > 0.5) {
          row.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
            duration: 200,
            easing: ease,
            fill: "both",
          });
        }
      }
      rowRectsRef.current.set(key, next);
    }
  }, [motionKey]);

  const toggleDomain = (id: TaskDomain) => {
    setDomains((current) => {
      if (current.includes(id)) {
        if (current.length === 1) return current;
        return current.filter((item) => item !== id);
      }
      const order = ORCHESTRATION_TASK_DOMAINS as readonly TaskDomain[];
      return [...current, id].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    });
  };

  return (
    <div className="settings-pane bot-knowledge-pane">
      <header className="settings-pane-head">
        <h2>Bot knowledge</h2>
        <p className="settings-pane-lead">
          What orchestration reads when Orchestrate or Mission is on: task domains, the intelligence bar, callable models in
          benchmark order, and each vendor&apos;s plan leftover overall — never one spawn, and never keys or URLs.
        </p>
      </header>
      <div className="settings-group">
        <div className="settings-row">
          <div className="settings-row-copy">
            <strong>Task domains</strong>
            <p className="settings-row-hint">Pick one or more. Orchestration still elects a single domain per prompt.</p>
          </div>
          <div className="settings-control">
            <span className="agent-chips bk-domain-chips" role="group" aria-label="Task domains">
              {ORCHESTRATION_TASK_DOMAINS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`agent-chip${domains.includes(id) ? " on" : ""}`}
                  aria-pressed={domains.includes(id)}
                  onClick={() => toggleDomain(id)}
                >
                  {DOMAIN_LABEL[id]}
                </button>
              ))}
            </span>
          </div>
        </div>
        <label className="settings-row">
          <div className="settings-row-copy">
            <strong>Route tier</strong>
          </div>
          <div className="settings-control">
            <select value={tier} onChange={(event) => setTier(event.target.value as RoutingTaskTier)} aria-label="Route tier">
              {TIERS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        </label>
      </div>
      <div className="bk-board">
        <div className="bk-scale">
          <span className="bk-ticks" aria-hidden="true">
            {Array.from({ length: 10 }, (_, index) => {
              const step = index + 1;
              const tone = [step <= tickOf(bar) ? "fill" : "", step === tickOf(bar) ? "bar" : ""].filter(Boolean).join(" ");
              return <i key={step} className={tone} />;
            })}
          </span>
          <p>
            Intelligence bar for this view: <strong>{bar}</strong>/100 · {orchestrationTierNote(tier)}
            {domains.length > 1 ? (
              <>
                {" "}
                · scoring uses the lowest score across {domains.map((id) => DOMAIN_LABEL[id]).join(", ")}
              </>
            ) : null}
          </p>
        </div>
        <table className="bot-knowledge-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Score</th>
              <th>Source</th>
              <th>Callable</th>
              <th>Plan leftover</th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {snapshot.models.map((row) => {
              const key = rowMotionKey(row);
              const login = row.loginLabel ?? "";
              const callableLabel = row.callableLabel ?? (row.callable ? "Callable" : "Not callable");
              return (
                <tr key={key} data-row-key={key} className={row.score < bar ? "below-bar" : "meets-bar"}>
                  <td className="bk-name">
                    <span className="bk-model-label">
                      {row.label}
                      {login ? <span className="bk-login-tag">{login}</span> : null}
                    </span>
                    {domains.length > 1 ? (
                      <span className="bk-row-domains" aria-label={`Domains: ${domains.map((id) => DOMAIN_LABEL[id]).join(", ")}`}>
                        {domains.map((id) => (
                          <span key={id} className="bk-domain-tag">
                            {DOMAIN_LABEL[id]}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </td>
                  <td className="bk-score-cell">
                    <ScoreMark score={row.score} bar={bar} />
                  </td>
                  <td className="bk-source">{row.source}</td>
                  <td className="bk-row-actions">
                    <BotKnowledgeRubricButton
                      label={row.label}
                      onOpen={() =>
                        setRubricTarget({
                          provider: row.provider,
                          model: row.model,
                          customBotId: row.customBotId,
                          label: row.label,
                        })
                      }
                    />
                    <span className={`bk-callable-pill${row.callable ? " yes" : ""}`} title={callableLabel}>
                      <i aria-hidden="true" />
                      <span>{callableLabel}</span>
                    </span>
                  </td>
                  <td className="bk-plan" aria-label={row.planLine}>
                    <PlanLeftover line={row.planLine} visible={row.planVisibleLine ?? ""} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {snapshot.models.length === 0 ? <p className="bk-empty">No models on this desk.</p> : null}
        {rubricTarget ? (
          <BotKnowledgeRubricSheet
            target={rubricTarget}
            settings={store.settings}
            onClose={() => setRubricTarget(null)}
            onSave={(key, rubric) => store.saveBotKnowledgeRubric(key, rubric)}
            onReset={(key) => store.saveBotKnowledgeRubric(key, null)}
          />
        ) : null}
      </div>
    </div>
  );
}

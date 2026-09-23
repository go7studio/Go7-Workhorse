import { useMemo, useState } from "react";
import { ORCHESTRATION_TASK_DOMAINS, botKnowledgeSnapshot, durationLabel } from "../lib/domain-benchmark";
import { botScoresSummary } from "../lib/bot-scores";
import { activeRouteLoad } from "../lib/routing";
import { useStore } from "../lib/store";
import type { RoutingTaskTier, TaskDomain } from "../lib/types";
import { watchVendorStatuses } from "../lib/watch";

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

const ORIGIN_LABEL = {
  public: "public",
  "desk-table": "desk table",
  "family-prior": "family prior",
} as const;

function since(iso: string | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return "never";
  return `${durationLabel(now - at)} ago`;
}

export function BotKnowledgePane() {
  const store = useStore();
  const [domain, setDomain] = useState<TaskDomain>("coding");
  const [tier, setTier] = useState<RoutingTaskTier>("balanced");
  const { settings, grokPlan, codexPlan, claudePlan, cursorPlan, customPlans, usage, watchPermits, watchDayMarks, sessions, botScores } =
    store;
  const plans = useMemo(
    () => ({ grok: grokPlan, codex: codexPlan, claude: claudePlan, cursor: cursorPlan, custom: customPlans }),
    [grokPlan, codexPlan, claudePlan, cursorPlan, customPlans],
  );
  const statuses = useMemo(
    () => watchVendorStatuses({ settings, usage, plans, permits: watchPermits, dayMarks: watchDayMarks }),
    [settings, usage, plans, watchPermits, watchDayMarks],
  );
  // Running workers change on every token; the load they put on each pool does not.
  const loadKey = JSON.stringify(activeRouteLoad(sessions));
  const snapshot = useMemo(
    () =>
      botKnowledgeSnapshot({
        settings,
        routing: settings.routing,
        statuses,
        plans,
        domain,
        tier,
        activeLoad: JSON.parse(loadKey) as Record<string, number>,
      }),
    // botScores: a new leaderboard re-scores every row.
    [settings, statuses, plans, domain, tier, loadKey, botScores],
  );
  const now = Date.now();
  const summary = botScoresSummary(botScores?.feed ?? null);
  const status = botScores?.status;

  return (
    <div className="settings-pane bot-knowledge-pane">
      <header className="settings-pane-head">
        <h2>Bot knowledge</h2>
        <p className="settings-pane-lead">
          What orchestration reads when Orchestrate or Mission is on: each bot&apos;s score for the kind of work, where
          that score came from, and its plan terms — leftover, time to reset, pace, and workers already on it. Plan terms
          are the vendor pool overall, never one spawn. No keys or URLs.
        </p>
      </header>
      <div className="settings-row bot-knowledge-source">
        <div className="settings-row-copy">
          <strong>Scores</strong>
          <span>
            {summary ? (
              <>
                {summary.source} leaderboard ({summary.license}) · {summary.models} models
                {summary.newestPublished ? ` · published ${summary.newestPublished}` : ""} · checked{" "}
                {since(status?.checkedAt ?? summary.fetchedAt, now)}. Bots without a public score use the desk table.
              </>
            ) : (
              <>Desk table only — the public leaderboard has not loaded yet.</>
            )}
            {status?.lastError ? <span className="bot-knowledge-error"> Last check failed: {status.lastError}</span> : null}
          </span>
        </div>
        <div className="settings-control">
          <button
            className="tiny"
            type="button"
            disabled={!window.workhorse?.scoresRefresh || status?.refreshing === true}
            onClick={() => void store.refreshBotScores()}
          >
            {status?.refreshing ? "Checking…" : "Check now"}
          </button>
        </div>
      </div>
      <div className="settings-row">
        <label>
          <span>Task domain</span>
          <select value={domain} onChange={(event) => setDomain(event.target.value as TaskDomain)} aria-label="Task domain">
            {ORCHESTRATION_TASK_DOMAINS.map((id) => (
              <option key={id} value={id}>
                {DOMAIN_LABEL[id]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Route tier</span>
          <select value={tier} onChange={(event) => setTier(event.target.value as RoutingTaskTier)} aria-label="Route tier">
            {TIERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="settings-note">
        Bar for this domain and tier: <strong>{snapshot.bar}</strong>/10 — never above the best bot this desk can call.
      </p>
      <table className="bot-knowledge-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Model</th>
            <th>Score</th>
            <th>Source</th>
            <th>Plan</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.models.map((row) => (
            <tr
              key={`${row.provider}:${row.model}:${row.customBotId ?? ""}`}
              className={row.clearsBar ? undefined : "below-bar"}
            >
              <td>{row.rank ?? "—"}</td>
              <td>{row.label}</td>
              <td>
                {row.score}/10
                {row.agentic !== undefined ? <span className="bot-knowledge-agentic"> · agentic {row.agentic}</span> : null}
              </td>
              <td>
                <span className={`bot-knowledge-origin ${row.origin}`}>{ORIGIN_LABEL[row.origin]}</span> {row.source}
              </td>
              <td>{row.planLine}</td>
              <td>{row.skip ?? row.why.slice(1).join(" · ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="settings-note bot-knowledge-credit">
        Public scores: LMArena leaderboard dataset (huggingface.co/datasets/lmarena-ai/leaderboard-dataset), CC BY 4.0.
        Checked once a day; downloaded only when it changes.
      </p>
    </div>
  );
}

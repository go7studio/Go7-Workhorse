import { useMemo, useState } from "react";
import {
  ORCHESTRATION_TASK_DOMAINS,
  botKnowledgeSnapshot,
  domainIntelligenceBar,
} from "../lib/domain-benchmark";
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

export function BotKnowledgePane() {
  const store = useStore();
  const [domain, setDomain] = useState<TaskDomain>("coding");
  const [tier, setTier] = useState<RoutingTaskTier>("balanced");
  const plans = {
    grok: store.grokPlan,
    codex: store.codexPlan,
    claude: store.claudePlan,
    cursor: store.cursorPlan,
    custom: store.customPlans,
  };
  const statuses = watchVendorStatuses({
    settings: store.settings,
    usage: store.usage,
    plans,
    permits: store.watchPermits,
    dayMarks: store.watchDayMarks,
  });
  const snapshot = useMemo(
    () =>
      botKnowledgeSnapshot({
        settings: store.settings,
        routing: store.settings.routing,
        statuses,
        plans,
        domain,
        tier,
      }),
    [store.settings, statuses, plans, domain, tier],
  );
  const bar = domainIntelligenceBar(tier);

  return (
    <div className="settings-pane bot-knowledge-pane">
      <header className="settings-pane-head">
        <h2>Bot knowledge</h2>
        <p className="settings-pane-lead">
          What orchestration reads when Orchestrate or Mission is on: task domain, the intelligence bar, callable models in
          benchmark order, and each vendor&apos;s plan leftover overall — never one spawn, and never keys or URLs.
        </p>
      </header>
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
        Intelligence bar for this domain: <strong>{bar}</strong>/10
      </p>
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
        <tbody>
          {snapshot.models.map((row) => (
            <tr key={`${row.provider}:${row.model}:${row.customBotId ?? ""}`} className={row.score < bar ? "below-bar" : undefined}>
              <td>{row.label}</td>
              <td>{row.score}/10</td>
              <td>{row.source}</td>
              <td>{row.callable ? "yes" : "no"}</td>
              <td>{row.planLine}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

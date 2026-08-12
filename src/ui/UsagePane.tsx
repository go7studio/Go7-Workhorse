import { providerById } from "../lib/providers";
import { useStore } from "../lib/store";
import { byModel, byProvider, formatCost, formatTokens, inRange, rollup } from "../lib/usage";
import type { UsageRange } from "../lib/types";

const RANGES: { id: UsageRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "all", label: "All" },
];

export function UsagePane() {
  const { usage, usageRange, setUsageRange, closeUsage } = useStore();
  const events = (usage ?? []).filter((event) => inRange(event, usageRange ?? "month"));
  const overall = rollup(events);
  const providers = byProvider(events);
  const models = byModel(events);
  const peak = Math.max(1, ...providers.map((row) => row.totalTokens));

  return (
    <section className="picker project-home">
      <div className="link-head">
        <h2>Usage</h2>
        <button className="tiny" type="button" onClick={closeUsage}>
          Back
        </button>
      </div>
      <p>
        Tokens from every brain in this window. Broken out by vendor and by model,
        then added up. Adapters write the ledger — preview chats do not invent spend.
      </p>

      <div className="actions" style={{ marginBottom: 20 }}>
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

      <div className="usage-hero">
        <strong>{formatTokens(overall.totalTokens)}</strong>
        <span>tokens overall</span>
        <span className="row-meta">
          {formatTokens(overall.inputTokens)} in · {formatTokens(overall.outputTokens)} out
          {overall.cacheReadTokens + overall.cacheWriteTokens > 0
            ? ` · ${formatTokens(overall.cacheReadTokens + overall.cacheWriteTokens)} cache`
            : ""}
          {` · ${formatCost(overall)}`}
        </span>
      </div>

      <div className="section-label">By vendor</div>
      <ul className="chip-list usage-list">
        {providers.map((row) => (
          <li key={row.key} className="usage-row">
            <div className="usage-row-top">
              <span>
                <span className={`dot ${row.provider}`} />
                {row.label}
              </span>
              <strong>{formatTokens(row.totalTokens)}</strong>
            </div>
            <div className="usage-bar">
              <i style={{ width: `${(row.totalTokens / peak) * 100}%` }} className={row.provider} />
            </div>
            <span className="row-meta">
              {formatTokens(row.inputTokens)} in · {formatTokens(row.outputTokens)} out · {formatCost(row)}
            </span>
          </li>
        ))}
      </ul>

      <div className="section-label">By model</div>
      {models.length === 0 ? (
        <p className="row-meta">No model rows yet. They appear when an adapter reports usage.</p>
      ) : (
        <ul className="chip-list usage-list">
          {models.map((row) => (
            <li key={row.key} className="usage-row">
              <div className="usage-row-top">
                <span>
                  <span className={`dot ${row.provider}`} />
                  {providerById(row.provider).name} · {row.label}
                </span>
                <strong>{formatTokens(row.totalTokens)}</strong>
              </div>
              <span className="row-meta">
                {formatTokens(row.inputTokens)} in · {formatTokens(row.outputTokens)} out · {formatCost(row)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

import { rankRoutingCandidates, routingCandidatesForDesk } from "../lib/routing";
import { useStore } from "../lib/store";
import { watchVendorStatuses } from "../lib/watch";

export function RoutingPane() {
  const store = useStore();
  const routing = store.settings.routing;
  const plans = {
    grok: store.grokPlan,
    codex: store.codexPlan,
    claude: store.claudePlan,
    custom: store.customPlans,
  };
  const statuses = watchVendorStatuses({
    settings: store.settings,
    usage: store.usage,
    plans,
    permits: store.watchPermits,
    dayMarks: store.watchDayMarks,
  });
  const candidates = routingCandidatesForDesk(store.settings, statuses, plans);
  const rows = (["quick", "balanced", "deep"] as const).map((tier) => ({
    tier,
    winner: rankRoutingCandidates(candidates, { prompt: "", tier }, routing)[0],
  }));
  return (
    <>
      <div className="link-block">
        <label className="field">
          <span>Auto route</span>
          <input type="checkbox" checked={routing.enabled} onChange={(event) => store.updateRouting({ enabled: event.target.checked })} />
        </label>
        <label className="field">
          <span>Use capacity</span>
          <input type="checkbox" checked={routing.capacityAware} onChange={(event) => store.updateRouting({ capacityAware: event.target.checked })} />
        </label>
        <label className="field">
          <span>Prefer spare usage</span>
          <input type="checkbox" checked={routing.preferExcess} onChange={(event) => store.updateRouting({ preferExcess: event.target.checked })} />
        </label>
        <label className="field">
          <span>Allow local models</span>
          <input type="checkbox" checked={routing.allowLocal} onChange={(event) => store.updateRouting({ allowLocal: event.target.checked })} />
        </label>
        <label className="field">
          <span>Weekly reserve %</span>
          <input
            type="number"
            min={0}
            max={50}
            step={5}
            value={routing.reservePercent}
            onChange={(event) => store.updateRouting({ reservePercent: Number(event.target.value) })}
          />
        </label>
      </div>
      <div className="usage-brains">
        {rows.map(({ tier, winner }) => (
          <div className="usage-brain" key={tier}>
            <span className="llm-mark on">{tier === "quick" ? "Q" : tier === "deep" ? "D" : "B"}</span>
            <span>{tier === "quick" ? "Quick" : tier === "deep" ? "Deep" : "Balanced"}</span>
            <em>{winner ? `${winner.label}${winner.capacityDelta == null ? "" : winner.capacityDelta >= 0 ? ` · ${Math.round(winner.capacityDelta)}% spare` : ` · ${Math.round(Math.abs(winner.capacityDelta))}% over`}` : "No match"}</em>
          </div>
        ))}
      </div>
    </>
  );
}

import { rankRoutingCandidates, routingCandidatesForDesk } from "../lib/routing";
import type { RankedRoutingCandidate } from "../lib/routing";
import { vendorTint } from "../lib/settings";
import { useStore } from "../lib/store";
import type { RoutingSettings } from "../lib/types";
import { watchVendorStatuses } from "../lib/watch";

const TIERS = [
  { id: "quick", mark: "Q", label: "Quick", hint: "Short asks: rename, format, list, translate." },
  { id: "balanced", mark: "B", label: "Balanced", hint: "Most work." },
  { id: "deep", mark: "D", label: "Deep", hint: "Debug, refactor, review, research, and long prompts with media." },
] as const;

function spareCopy(winner: RankedRoutingCandidate | undefined): string {
  if (!winner) return "No match";
  // "Spare" used to be the pace delta, which read like a fuel gauge: Sol at
  // 98% left showed "4% spare" the day its week began. Say what is left and
  // how the draw compares to pace, separately.
  if (winner.paceUnmetered) return `${winner.label} · unmetered`;
  if (winner.capacityDelta == null || winner.usedPercent == null) return winner.label;
  const left = Math.max(0, Math.round(100 - winner.usedPercent));
  const delta = Math.round(winner.capacityDelta);
  const pace = Math.abs(delta) < 10 ? "on pace" : delta > 0 ? `${delta}% under pace` : `${-delta}% over pace`;
  return `${winner.label} · ${left}% left · ${pace}`;
}

export function RoutingPane() {
  const store = useStore();
  const routing = store.settings.routing;
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
  const candidates = routingCandidatesForDesk(store.settings, statuses, plans);
  const inPlay = candidates.filter((item) => item.connected && (routing.allowLocal || !item.profile.local)).length;
  const picks = TIERS.map((tier) => ({
    ...tier,
    winner: rankRoutingCandidates(candidates, { prompt: "", tier: tier.id }, routing)[0] as RankedRoutingCandidate | undefined,
  }));

  const set = (patch: Partial<RoutingSettings>) => store.updateRouting(patch);
  // Prefer spare and Weekly reserve only act inside the leftover weighing, so
  // with that off they are shown but inert.
  const weighs = routing.capacityAware;

  const ringFor = (winner: RankedRoutingCandidate | undefined) => {
    if (!winner) return { className: "llm-mark", style: undefined };
    if (winner.provider === "custom") {
      const bot = store.settings.customBots.find((item) => item.id === winner.customBotId);
      return { className: "llm-mark on", style: bot ? { borderColor: bot.color } : undefined };
    }
    const tint = vendorTint(winner.provider, store.settings.llms[winner.provider]);
    return { className: `llm-mark ${winner.provider} on`, style: tint ? { borderColor: tint } : undefined };
  };

  return (
    <>
      <div className="settings-group">
        <SwitchRow
          label="Route the work the desk hands out"
          copy="Auto-pick a bot and effort for delegated work."
          on={routing.enabled}
          onChange={(on) => set({ enabled: on })}
        />
        <SwitchRow
          label="Include harnesses"
          copy="Let granted harnesses join Auto routing."
          on={routing.includeExternalAgents === true}
          onChange={(on) => set({ includeExternalAgents: on })}
        />
        <SwitchRow
          label="Allow local models"
          copy="Let a free on-device bot win."
          on={routing.allowLocal}
          onChange={(on) => set({ allowLocal: on })}
        />
        <SwitchRow
          label="Weigh leftover"
          copy="Score each bot by how far it is under its weekly pace."
          on={routing.capacityAware}
          onChange={(on) => set({ capacityAware: on })}
        />
        <SwitchRow
          label="Prefer spare"
          copy="Favor whoever has the most left, not only avoid whoever is behind."
          on={routing.preferExcess}
          disabled={!weighs}
          onChange={(on) => set({ preferExcess: on })}
        />
        <div className={`settings-row${weighs ? "" : " off"}`}>
          <div className="settings-row-copy">
            <strong>Weekly reserve</strong>
            <span>Down-rank bots at or below this weekly reserve. A bank about to reset is spent down, not benched.</span>
          </div>
          <div className="settings-control">
            <input
              type="number"
              min={0}
              max={50}
              step={5}
              value={routing.reservePercent}
              disabled={!weighs}
              aria-label="Weekly reserve percent"
              onChange={(event) => set({ reservePercent: Number(event.target.value) })}
            />
            <span className="unit">%</span>
          </div>
        </div>
      </div>

      <div className="settings-picks">
        <div className="settings-picks-head">
          <div className="section-label">Picks now</div>
          {/* Auto chats always draw from these; spawned workers do while the
              switch above is on. */}
          <span>{`From ${inPlay} ${inPlay === 1 ? "bot" : "bots"} · ${routing.enabled ? "Auto chats and spawned workers" : "Auto chats only"}`}</span>
        </div>
        <div className="usage-brains">
          {picks.map((tier) => {
            const ring = ringFor(tier.winner);
            return (
              <div className="usage-brain" key={tier.id} title={tier.hint}>
                <span className={ring.className} style={ring.style}>
                  {tier.mark}
                </span>
                <span>{tier.label}</span>
                <em>{spareCopy(tier.winner)}</em>
              </div>
            );
          })}
        </div>
      </div>
      <p className="row-meta settings-note">
        Quick is for short asks; Deep is for harder work.
      </p>
    </>
  );
}

function SwitchRow({
  label,
  copy,
  on,
  disabled = false,
  onChange,
}: {
  label: string;
  copy: string;
  on: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className={`settings-row${disabled ? " off" : ""}`}>
      <div className="settings-row-copy">
        <strong>{label}</strong>
        <span>{copy}</span>
      </div>
      <div className="settings-control">
        <button
          className={`switch${on ? " on" : ""}`}
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={label}
          disabled={disabled}
          onClick={() => onChange(!on)}
        />
      </div>
    </div>
  );
}

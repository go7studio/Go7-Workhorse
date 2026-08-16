import { useState } from "react";
import { useStore } from "../lib/store";
import { DEFAULT_WATCH, toggleWatchLockKey, watchPicksKey, watchVendorStatuses } from "../lib/watch";
import { FuelRing } from "./FuelRing";

function dayCopy(row: ReturnType<typeof watchVendorStatuses>[number], picked: boolean): string {
  const allowed = Math.round(row.allowedPercent);
  const used = row.usedPercent;
  const day = row.weekDay ? `Day ${row.weekDay.day} of ${row.weekDay.days}` : null;
  if (!picked) return [day, "Roams free"].filter(Boolean).join(" · ");
  if (row.holding && row.overPercent > 0) {
    return [day, `${Math.round(row.overPercent)}% over`].filter(Boolean).join(" · ");
  }
  if (row.holding) return [day, "Locked"].filter(Boolean).join(" · ");
  if (used == null) return [day, `${allowed}% bank`].filter(Boolean).join(" · ");
  return [day, `${Math.round(used)} / ${allowed}%`].filter(Boolean).join(" · ");
}

export function WatchPane() {
  const store = useStore();
  const [picking, setPicking] = useState(false);
  const watch = store.settings.watch ?? DEFAULT_WATCH;
  const statuses = watchVendorStatuses({
    settings: store.settings,
    usage: store.usage,
    plans: {
      grok: store.grokPlan,
      codex: store.codexPlan,
      claude: store.claudePlan,
      custom: store.customPlans,
    },
    permits: store.watchPermits,
    dayMarks: store.watchDayMarks,
  });

  return (
    <>
      <div className="watch-bar">
        <button
          className={`watch-option link-block${picking ? " on" : ""}`}
          type="button"
          aria-pressed={picking}
          onClick={() => setPicking((on) => !on)}
        >
          <strong>Daily bank</strong>
          <p className="watch-copy">
            {picking
              ? "Click bots to add or remove them. Click Daily bank again when you're done — selected bots stay on it."
              : "Click this, then click the bots that should stay on the daily bank. Click it again to put the tool away."}
          </p>
        </button>
        <div className="watch-option link-block">
          <div className="watch-option-head">
            <strong>Desktop notification</strong>
            <button
              className={`watch-toggle${watch.desktopNotify ? " on" : ""}`}
              type="button"
              role="switch"
              aria-checked={watch.desktopNotify}
              aria-label="Desktop notification"
              onClick={() => store.updateWatch({ desktopNotify: !watch.desktopNotify })}
            />
          </div>
          <p className="watch-copy">
            On by default. If Workhorse is in the background, your desktop tells you when a bot needs Allow or used its daily
            bank. The in-app banner still shows either way.
          </p>
        </div>
      </div>

      {statuses.length === 0 ? (
        <p className="row-meta">Add a bot on LLMs and leftover will show up here.</p>
      ) : (
        <div className={`usage-brains watch-brains${picking ? "" : " off"}`}>
          {statuses.map((row, index) => {
            const leftover = row.leftover;
            const fill =
              row.allowedPercent > 0 && row.usedPercent != null
                ? Math.min(1, row.usedPercent / row.allowedPercent)
                : 0;
            const picked = watchPicksKey(watch, row.key);
            return (
              <button
                key={row.key}
                type="button"
                className={`usage-brain watch-brain${picked ? " pick" : ""}${row.dailyOver ? " warn" : ""}${row.holding ? " hold" : ""}`}
                aria-pressed={picked}
                disabled={!picking}
                title={
                  !picking
                    ? "Click Daily bank to change who stays on it"
                    : picked
                      ? `${row.label} is spaced by the daily bank`
                      : `${row.label} roams free`
                }
                onClick={() =>
                  store.updateWatch(toggleWatchLockKey(watch, row.key, statuses.map((item) => item.key)))
                }
              >
                <FuelRing
                  value={leftover != null ? leftover / 100 : 0}
                  size={104}
                  tone={row.provider}
                  color={row.color}
                  delay={index * 90}
                  over={row.overPercent > 0 ? Math.min(1, row.overPercent / 100) : 0}
                  label={leftover != null ? `${Math.round(leftover)}%` : "…"}
                />
                <span>{row.label}</span>
                <em>{dayCopy(row, picked)}</em>
                <div className="watch-day-track" aria-hidden="true">
                  <i
                    className={row.provider}
                    style={{
                      width: `${Math.max(row.todayUsed ? 6 : 0, Math.round(fill * 100))}%`,
                      ...(row.color ? { background: row.color } : {}),
                    }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

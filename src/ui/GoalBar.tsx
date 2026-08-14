import { goalCommandForAction, goalDisplay } from "../lib/goal";
import { useActiveSession, useStore } from "../lib/store";

export function GoalBar() {
  const session = useActiveSession();
  const store = useStore();
  const view = goalDisplay(session?.goal);
  if (!view) return null;
  return (
    <div className={`goal-bar ${view.status}`} role="region" aria-label={view.title}>
      <span className="goal-bar-mark" aria-hidden="true" />
      <div className="goal-bar-copy">
        <strong>{view.status === "paused" ? "Paused" : "Active goal"}</strong>
        <span title={view.objective}>{view.objective}</span>
      </div>
      <div className="goal-bar-actions">
        {view.actions.map((action) => (
          <button
            key={action}
            className={action === "clear" ? "goal-action quiet" : "goal-action primary-action"}
            type="button"
            aria-label={action === "clear" ? "Clear goal" : undefined}
            onClick={() => store.send(goalCommandForAction(action))}
          >
            {action === "pause" ? "Pause" : action === "resume" ? "Resume" : "End"}
          </button>
        ))}
      </div>
    </div>
  );
}

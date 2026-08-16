import { goalCommandForAction, goalDisplayForSession } from "../lib/goal";
import { useActiveSession, useStore } from "../lib/store";

export function GoalBar() {
  const session = useActiveSession();
  const store = useStore();
  const view = goalDisplayForSession(session);
  const plan = session?.planRun;
  if (!view && !plan) return null;
  const completed = plan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const planLabel = plan ? `Plan ${completed}/${plan.steps.length} · ${plan.status}` : "";
  const title = view?.title ?? plan?.objective ?? "Plan";
  return (
    <div className={`goal-bar ${view?.status ?? plan?.status ?? "active"}`} role="region" aria-label={title}>
      <span className="goal-bar-mark" aria-hidden="true" />
      <div className="goal-bar-copy">
        <strong>{view ? `${view.status === "paused" ? "Paused" : "Active goal"}${plan ? ` · ${planLabel}` : ""}` : planLabel}</strong>
        <span title={view?.objective ?? plan?.objective}>{view?.objective ?? plan?.objective}</span>
      </div>
      <div className="goal-bar-actions">
        {(view?.actions ?? []).map((action) => (
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

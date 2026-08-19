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
        <strong>{view ? `${view.status === "paused" ? "Paused" : "Active"} ${view.mode}${plan ? ` · ${planLabel}` : ""}` : planLabel}</strong>
        <span title={view?.objective ?? plan?.objective}>{view?.objective ?? plan?.objective}</span>
      </div>
      <div className="goal-bar-actions">
        {plan ? (
          <label className="row-meta">
            <input
              type="checkbox"
              checked={Boolean(plan.externalGrant && !plan.externalGrant.consumedAt)}
              onChange={(event) => {
                if (session) store.grantPlanExternalAgents(session.id, event.target.checked);
              }}
            />
            Allow OpenClaw/Hermes for this plan
          </label>
        ) : null}
        {(view?.actions ?? []).map((action) => (
          <button
            key={action}
            className={action === "clear" ? "goal-action quiet" : "goal-action primary-action"}
            type="button"
            aria-label={action === "clear" ? "Clear goal" : undefined}
            onClick={() => store.send(goalCommandForAction(action, view?.mode))}
          >
            {action === "pause" ? "Pause" : action === "resume" ? "Resume" : "End"}
          </button>
        ))}
      </div>
      {session?.lineup?.rows.some((row) => row.kind === "external") ? (
        <div className="goal-bar-copy">
          {session.lineup.rows
            .filter((row) => row.kind === "external")
            .map((row) => (
              <span key={row.childId}>
                {row.runtimeId}/{row.agentId} · {row.status}
                {row.workspace ? ` · ${row.workspace}` : ""}
                {row.finishedAt ? ` · ${Math.max(0, row.finishedAt - row.startedAt)}ms` : ""}
                {row.report ? ` · ${row.report}` : ""}
                {row.correlationId ? ` · ${row.correlationId}` : ""}
              </span>
            ))}
        </div>
      ) : null}
    </div>
  );
}

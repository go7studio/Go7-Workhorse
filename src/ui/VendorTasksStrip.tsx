import { useEffect, useState } from "react";
import { formatWorked } from "../lib/turns";
import {
  groupVendorTasks,
  vendorTaskElapsedMs,
  vendorTaskStatusLabel,
  type VendorBackgroundTask,
} from "../lib/vendor-tasks";

function TaskRow({ task, now }: { task: VendorBackgroundTask; now: number }) {
  const elapsed = formatWorked(vendorTaskElapsedMs(task, now));
  const status = vendorTaskStatusLabel(task.status);
  const live = task.status === "running";
  return (
    <div className={`vendor-task${live ? " live" : ""} ${task.status}`} title={task.command || task.name}>
      <span className="vendor-task-kind">{task.kind === "watcher" ? "Monitor" : "Task"}</span>
      <span className="vendor-task-name">{task.name}</span>
      <span className="vendor-task-meta">
        {elapsed}
        {status ? ` · ${status}` : ""}
      </span>
    </div>
  );
}

export function VendorTasksStrip({ tasks }: { tasks?: VendorBackgroundTask[] }) {
  const grouped = groupVendorTasks(tasks);
  const live = grouped.tasks.some((item) => item.status === "running") || grouped.watchers.some((item) => item.status === "running");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  if (grouped.tasks.length === 0 && grouped.watchers.length === 0) return null;
  return (
    <div className="vendor-tasks" role="region" aria-label="Tasks and watchers">
      {grouped.tasks.length > 0 ? (
        <div className="vendor-tasks-group">
          <span className="vendor-tasks-label">Tasks {grouped.tasks.length}</span>
          {grouped.tasks.map((task) => (
            <TaskRow key={task.id} task={task} now={now} />
          ))}
        </div>
      ) : null}
      {grouped.watchers.length > 0 ? (
        <div className="vendor-tasks-group">
          <span className="vendor-tasks-label">Watchers {grouped.watchers.length}</span>
          {grouped.watchers.map((task) => (
            <TaskRow key={task.id} task={task} now={now} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

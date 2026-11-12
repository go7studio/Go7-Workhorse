import { useEffect, useState } from "react";
import {
  backgroundBrowserElapsedMs,
  backgroundBrowserStatusLabel,
  visibleBackgroundBrowsers,
  type BackgroundBrowserSession,
} from "../lib/background-browser";
import { formatWorked } from "../lib/turns";

function BrowserRow({
  session,
  now,
  onStop,
}: {
  session: BackgroundBrowserSession;
  now: number;
  onStop?: (id: string) => void;
}) {
  const elapsed = formatWorked(backgroundBrowserElapsedMs(session, now));
  const status = backgroundBrowserStatusLabel(session.status);
  const live = session.status === "running";
  const mode =
    session.mode === "chrome"
      ? "Chrome"
      : session.mode === "background-headed"
        ? "Background"
        : "Headless";
  return (
    <div
      className={`vendor-task${live ? " live" : ""} ${session.status}`}
      title={session.detail || session.name}
    >
      <span className="vendor-task-kind">{mode}</span>
      <span className="vendor-task-name">{session.name}</span>
      <span className="vendor-task-meta">
        {elapsed}
        {status ? ` · ${status}` : ""}
      </span>
      {live && onStop ? (
        <button
          className="tiny"
          type="button"
          aria-label={`Stop ${session.name}`}
          onClick={() => onStop(session.id)}
        >
          Stop
        </button>
      ) : null}
    </div>
  );
}

/** Small chat strip: name, elapsed, running/killed — Stop kills the process tree. */
export function BackgroundBrowserStrip({
  sessions,
  onStop,
}: {
  sessions?: BackgroundBrowserSession[];
  onStop?: (id: string) => void;
}) {
  const visible = visibleBackgroundBrowsers(sessions);
  const live = visible.some((item) => item.status === "running");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  if (visible.length === 0) return null;
  return (
    <div className="vendor-tasks" role="region" aria-label="Background browser">
      <div className="vendor-tasks-group">
        <span className="vendor-tasks-label">Browser {visible.length}</span>
        {visible.map((session) => (
          <BrowserRow key={session.id} session={session} now={now} onStop={onStop} />
        ))}
      </div>
    </div>
  );
}

import { modeLabel } from "../lib/commands";
import { providerById } from "../lib/providers";
import { useActiveProject, useProjectSessions, useStore } from "../lib/store";

export function Sidebar() {
  const store = useStore();
  const project = useActiveProject();
  const sessions = useProjectSessions(store.activeProjectId);

  return (
    <aside className="sidebar">
      <div className="brand">
        <h1>Workhorse</h1>
        <p>One desk, every agent</p>
      </div>

      <button className="ghost open-project" type="button" onClick={() => void store.openProject()}>
        Open project
      </button>

      <div className="section-label">Projects</div>
      <div className="scroll">
        {store.projects.length === 0 && (
          <p className="row-meta" style={{ padding: "0 10px" }}>
            Choose a folder to work in.
          </p>
        )}
        {store.projects.map((item) => (
          <button
            key={item.id}
            className={item.id === store.activeProjectId ? "row active" : "row"}
            type="button"
            onClick={() => store.selectProject(item.id)}
          >
            <span>
              <span className="row-title">{item.name}</span>
              <span className="row-meta">{item.path}</span>
            </span>
          </button>
        ))}

        {project && (
          <>
            <div className="section-label">Sessions</div>
            {sessions.length === 0 && (
              <p className="row-meta" style={{ padding: "0 10px" }}>
                No sessions yet.
              </p>
            )}
            {sessions.map((session) => {
              const provider = providerById(session.provider);
              return (
                <button
                  key={session.id}
                  className={session.id === store.activeSessionId ? "row active" : "row"}
                  type="button"
                  onClick={() => store.selectSession(session.id)}
                >
                  <span className={`dot ${session.provider}`} />
                  <span>
                    <span className="row-title">{session.title}</span>
                    <span className="row-meta">
                      {provider.name} · {modeLabel(session.mode)}
                    </span>
                  </span>
                </button>
              );
            })}
          </>
        )}
      </div>
    </aside>
  );
}

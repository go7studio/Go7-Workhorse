import { modeLabel } from "../lib/commands";
import { folderSummary } from "../lib/project";
import { providerById } from "../lib/providers";
import { useActiveProject, useProjectSessions, useStore } from "../lib/store";

export function Sidebar() {
  const store = useStore();
  const project = useActiveProject();
  const chats = useProjectSessions(store.activeProjectId);

  return (
    <aside className="sidebar">
      <div className="brand">
        <h1>Workhorse</h1>
        <p>Projects and chats</p>
      </div>

      <button className="ghost open-project" type="button" onClick={() => store.openSheet("project")}>
        New project
      </button>
      {project && (
        <button className="ghost open-project" type="button" onClick={() => store.startSession("grok")}>
          New chat
        </button>
      )}

      <div className="section-label">Projects</div>
      <div className="scroll">
        {store.projects.length === 0 && (
          <p className="row-meta" style={{ padding: "0 10px" }}>
            Create a project. Folders are optional.
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
              <span className="row-meta">{folderSummary(item)}</span>
            </span>
          </button>
        ))}

        {project && (
          <>
            <div className="section-label">Chats</div>
            {chats.length === 0 && (
              <p className="row-meta" style={{ padding: "0 10px" }}>
                No chats yet.
              </p>
            )}
            {chats.map((session) => {
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

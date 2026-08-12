import { useState } from "react";
import { folderSummary } from "../lib/project";
import { useActiveProject, useProjectSessions, useStore } from "../lib/store";
import { formatTokens, inRange, rollup } from "../lib/usage";
import { ChatRow } from "./ChatRow";

export function Sidebar() {
  const store = useStore();
  const project = useActiveProject();
  const chats = useProjectSessions(store.activeProjectId);
  const archived = useProjectSessions(store.activeProjectId, true);
  const [showArchived, setShowArchived] = useState(false);
  const [dropId, setDropId] = useState<string | null>(null);
  const tokens = rollup((store.usage ?? []).filter((event) => inRange(event, store.usageRange ?? "month"))).totalTokens;

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
        <button className="ghost open-project" type="button" onClick={() => store.startSession()}>
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
            className={
              item.id === dropId
                ? "row drop-over"
                : item.id === store.activeProjectId
                  ? "row active"
                  : "row"
            }
            type="button"
            onClick={() => store.selectProject(item.id)}
            onDragOver={(event) => {
              if (![...event.dataTransfer.types].includes("text/workhorse-chat")) return;
              event.preventDefault();
              setDropId(item.id);
            }}
            onDragLeave={() => setDropId((current) => (current === item.id ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData("text/workhorse-chat");
              setDropId(null);
              if (id) store.moveSession(id, item.id);
            }}
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
            {chats.map((session) => (
              <ChatRow key={session.id} session={session} />
            ))}
            {archived.length > 0 && (
              <>
                <button className="section-label archive-toggle" type="button" onClick={() => setShowArchived((value) => !value)}>
                  Archived ({archived.length})
                </button>
                {showArchived && archived.map((session) => <ChatRow key={session.id} session={session} />)}
              </>
            )}
          </>
        )}
      </div>
      <footer className="sidebar-dock">
        <button
          className={store.panel === "settings" ? "row active" : "row"}
          type="button"
          onClick={() => (store.panel === "settings" ? store.closeSettings() : store.openSettings())}
        >
          <span>
            <span className="row-title">Settings</span>
            <span className="row-meta">{formatTokens(tokens)} tokens · profile, LLMs</span>
          </span>
        </button>
      </footer>
    </aside>
  );
}

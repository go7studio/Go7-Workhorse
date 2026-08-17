import { useEffect, useState } from "react";
import horseMark from "../../assets/app-icons/go7-workhorse-transparent.png";
import { APP_VERSION } from "../lib/app-info";
import { hiddenProjectChatCount, PROJECT_CHAT_LIMIT, visibleProjectChats } from "../lib/chats";
import { nestProjectChats } from "../lib/lineup";
import { folderSummary } from "../lib/project";
import { useLooseSessions, useProjectSessions, useStore } from "../lib/store";
import { deskPulseLines } from "../lib/usage";
import type { Project } from "../lib/types";
import { ChatRow } from "./ChatRow";
import { SplitHandle } from "./SplitHandle";
import { SIDEBAR_PANE } from "../lib/pane";
import { searchChats } from "../lib/search";

function LooseChats() {
  const store = useStore();
  const chats = useLooseSessions();
  const archived = useLooseSessions(true);
  const [showArchived, setShowArchived] = useState(false);
  const [openCrew, setOpenCrew] = useState<Record<string, boolean>>({});
  const nested = nestProjectChats(chats);
  useEffect(() => {
    const active = store.sessions.find((item) => item.id === store.activeSessionId);
    if (!active?.parentId) return;
    setOpenCrew((current) => (current[active.parentId!] ? current : { ...current, [active.parentId!]: true }));
  }, [store.activeSessionId, store.sessions]);
  if (chats.length === 0 && archived.length === 0) return null;
  return (
    <div className="loose-chats">
      <div className="section-label">Chats</div>
      {nested.map((session) => (
        <div key={session.id} className="project-chat-block">
          <ChatRow
            session={session}
            workerCount={session.workers.length}
            workersOpen={Boolean(openCrew[session.id])}
            onToggleWorkers={() =>
              setOpenCrew((current) => ({ ...current, [session.id]: !current[session.id] }))
            }
          />
          {openCrew[session.id]
            ? session.workers.map((worker) => <ChatRow key={worker.id} session={worker} nested />)
            : null}
        </div>
      ))}
      {archived.length > 0 && (
        <>
          <button className="archive-toggle" type="button" onClick={() => setShowArchived((value) => !value)}>
            Archived ({archived.length})
          </button>
          {showArchived && archived.map((session) => <ChatRow key={session.id} session={session} />)}
        </>
      )}
    </div>
  );
}

function ProjectFolder({
  project,
  open,
  dropOver,
  onToggle,
  onDropTarget,
}: {
  project: Project;
  open: boolean;
  dropOver: boolean;
  onToggle: () => void;
  onDropTarget: (id: string | null) => void;
}) {
  const store = useStore();
  const chats = useProjectSessions(project.id);
  const archived = useProjectSessions(project.id, true);
  const [showMore, setShowMore] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [openCrew, setOpenCrew] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const active = store.sessions.find((item) => item.id === store.activeSessionId);
    if (!active?.parentId) return;
    setOpenCrew((current) => (current[active.parentId!] ? current : { ...current, [active.parentId!]: true }));
  }, [store.activeSessionId, store.sessions]);
  const settingsOpen = store.panel === "settings" || store.panel === "add-bot";
  const selected = !settingsOpen && project.id === store.activeProjectId;
  const nested = nestProjectChats(chats);
  const visible = visibleProjectChats(nested, showMore, store.activeSessionId);
  const hidden = hiddenProjectChatCount(nested.length, showMore);
  const count = nested.length + archived.length;

  return (
    <div className={`project-folder${open ? " open" : ""}${selected ? " selected" : ""}${dropOver ? " drop-over" : ""}`}>
      <div className="project-head">
        <button
          className="twist"
          type="button"
          aria-expanded={open}
          aria-label={open ? `Hide chats in ${project.name}` : `Show chats in ${project.name}`}
          onClick={onToggle}
        />
        <button
          className={selected && !store.activeSessionId ? "row active" : "row"}
          type="button"
          onClick={() => {
            store.selectProject(project.id);
            if (!open) onToggle();
          }}
          onDragOver={(event) => {
            if (![...event.dataTransfer.types].includes("text/workhorse-chat")) return;
            event.preventDefault();
            onDropTarget(project.id);
          }}
          onDragLeave={() => onDropTarget(null)}
          onDrop={(event) => {
            event.preventDefault();
            const id = event.dataTransfer.getData("text/workhorse-chat");
            onDropTarget(null);
            if (id) store.moveSession(id, project.id);
          }}
        >
          <span>
            <span className="row-title">{project.name}</span>
            <span className="row-meta">
              {count === 0 ? folderSummary(project) : `${count} chat${count === 1 ? "" : "s"} · ${folderSummary(project)}`}
            </span>
          </span>
        </button>
        <button
          className="tiny project-new"
          type="button"
          aria-label={`New chat in ${project.name}`}
          title="New chat in this project"
          onClick={(event) => {
            event.stopPropagation();
            store.startSession(project.id);
            if (!open) onToggle();
          }}
        >
          +
        </button>
      </div>
      <div className="project-chats-slot" aria-hidden={!open}>
        <div className="project-chats">
          {chats.length === 0 && archived.length === 0 && (
            <p className="row-meta nest-empty">No chats yet.</p>
          )}
          {visible.map((session) => (
            <div key={session.id} className="project-chat-block">
              <ChatRow
                session={session}
                workerCount={session.workers.length}
                workersOpen={Boolean(openCrew[session.id])}
                onToggleWorkers={() =>
                  setOpenCrew((current) => ({ ...current, [session.id]: !current[session.id] }))
                }
              />
              {openCrew[session.id]
                ? session.workers.map((worker) => (
                    <ChatRow key={worker.id} session={worker} nested />
                  ))
                : null}
            </div>
          ))}
          {nested.length > PROJECT_CHAT_LIMIT && hidden > 0 && (
            <button className="archive-toggle" type="button" onClick={() => setShowMore((value) => !value)}>
              {showMore ? "Show less" : `Show more (${hidden})`}
            </button>
          )}
          {archived.length > 0 && (
            <>
              <button className="archive-toggle" type="button" onClick={() => setShowArchived((value) => !value)}>
                Archived ({archived.length})
              </button>
              {showArchived && archived.map((session) => <ChatRow key={session.id} session={session} />)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsPulse() {
  const store = useStore();
  const lines = deskPulseLines({ usage: store.usage ?? [], sessions: store.sessions });
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (lines.length < 2) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % lines.length), 5600);
    return () => window.clearInterval(timer);
  }, [lines.length]);
  const line = lines[index % Math.max(lines.length, 1)];
  if (!line) return <span className="row-meta">Settings</span>;
  return (
    <span key={line.id} className="row-meta settings-pulse">
      {line.text}
    </span>
  );
}

function UpdateChip() {
  const store = useStore();
  const offer = store.appUpdate;
  if (!offer) return null;
  const label = store.appUpdateBusy
    ? `Installing Workhorse ${offer.version}`
    : store.appUpdateError
      ? store.appUpdateError
      : `Install Workhorse ${offer.version}`;
  return (
    <button
      className={`brand-update${store.appUpdateBusy ? " busy" : ""}${store.appUpdateError ? " error" : ""}`}
      type="button"
      aria-label={label}
      title={label}
      disabled={store.appUpdateBusy}
      onClick={() => {
        if (!store.appUpdate) return;
        void store.applyAppUpdate(offer.version);
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 12.5V3.5M4.2 7 8 3.2 11.8 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export function Sidebar() {
  const store = useStore();
  const [query, setQuery] = useState("");
  const [openIds, setOpenIds] = useState<string[]>(() => (store.activeProjectId ? [store.activeProjectId] : []));
  const [dropId, setDropId] = useState<string | null>(null);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const liveProjects = store.projects.filter((item) => !item.archivedAt);
  const archivedProjects = store.projects.filter((item) => item.archivedAt);
  const results = searchChats(store.sessions, store.projects, query);

  useEffect(() => {
    if (!store.activeProjectId) return;
    setOpenIds((current) =>
      current.includes(store.activeProjectId!) ? current : [...current, store.activeProjectId!],
    );
  }, [store.activeProjectId]);

  return (
    <aside className="sidebar">
      <SplitHandle
        value={store.sidebarWidth}
        onChange={store.setSidebarWidth}
        min={SIDEBAR_PANE.min}
        max={SIDEBAR_PANE.max}
        reset={SIDEBAR_PANE.fallback}
        label="Resize sidebar"
      />
      <div className="brand">
        <button
          className="brand-mark-btn"
          type="button"
          aria-pressed={store.theme === "workhorse"}
          aria-label={store.theme === "workhorse" ? "Leave Workhorse theme" : "Use Workhorse theme"}
          title={store.theme === "workhorse" ? "Back to previous look" : "Workhorse theme"}
          onClick={() => store.toggleWorkhorseTheme()}
        >
          <img className="brand-mark" src={horseMark} alt="" />
        </button>
        <div className="brand-copy">
          <div className="brand-title">
            <h1>Workhorse</h1>
            <span className="brand-ver">v{APP_VERSION}</span>
          </div>
          <p>One desk, every agent</p>
        </div>
        <UpdateChip />
      </div>

      <button className="ghost open-project" type="button" onClick={() => store.openSheet("project")}>
        New project
      </button>
      <button className="ghost open-project" type="button" onClick={() => store.startSession(null)}>
        New chat
      </button>

      <div className="global-find">
        <input
          value={query}
          aria-label="Search all chats"
          placeholder="Search all chats"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {query.trim() ? (
        <div className="global-results" aria-label="Chat search results">
          {results.length ? results.map((result) => (
            <button
              key={`${result.sessionId}:${result.messageId ?? "title"}`}
              type="button"
              onClick={() => { store.selectSession(result.sessionId); setQuery(""); }}
            >
              <strong>{result.title}</strong>
              <span>{result.project} / {result.provider}</span>
              <em>{result.snippet}</em>
            </button>
          )) : <p className="row-meta">No chat or message matches.</p>}
        </div>
      ) : null}

      <div className="scroll">
        <div className="section-label">Projects</div>
        {liveProjects.length === 0 && (
          <p className="row-meta" style={{ padding: "0 10px" }}>
            No projects.
          </p>
        )}
        {liveProjects.map((item) => (
          <ProjectFolder
            key={item.id}
            project={item}
            open={openIds.includes(item.id)}
            dropOver={dropId === item.id}
            onToggle={() =>
              setOpenIds((current) =>
                current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id],
              )
            }
            onDropTarget={setDropId}
          />
        ))}
        {archivedProjects.length > 0 && (
          <>
            <button
              className="archive-toggle"
              type="button"
              onClick={() => setShowArchivedProjects((value) => !value)}
            >
              Archived projects ({archivedProjects.length})
            </button>
            {showArchivedProjects &&
              archivedProjects.map((item) => (
                <ProjectFolder
                  key={item.id}
                  project={item}
                  open={openIds.includes(item.id)}
                  dropOver={dropId === item.id}
                  onToggle={() =>
                    setOpenIds((current) =>
                      current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id],
                    )
                  }
                  onDropTarget={setDropId}
                />
              ))}
          </>
        )}
        <LooseChats />
      </div>
      <footer className="sidebar-dock">
        <button
          className={store.panel === "settings" || store.panel === "add-bot" ? "row active" : "row"}
          type="button"
          onClick={() =>
            store.panel === "settings" || store.panel === "add-bot" ? store.closeSettings() : store.openSettings()
          }
        >
          <span>
            <span className="row-title">Settings</span>
            <SettingsPulse />
          </span>
        </button>
      </footer>
    </aside>
  );
}

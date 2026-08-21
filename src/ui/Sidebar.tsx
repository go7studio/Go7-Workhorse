import { memo, useEffect, useMemo, useState } from "react";
import horseMark from "../../assets/app-icons/go7-workhorse-transparent.png";
import { APP_VERSION } from "../lib/app-info";
import { hiddenProjectChatCount, lastProjectChat, PROJECT_CHAT_LIMIT, visibleProjectChats } from "../lib/chats";
import { missionRowLook } from "../lib/lineup";
import { useStoreReader, useStoreSelector, type Store } from "../lib/store";
import { deskPulseLines } from "../lib/usage";
import type { Project, Session } from "../lib/types";
import { ChatRow, type ChatRowDesk } from "./ChatRow";
import { SplitHandle } from "./SplitHandle";
import { SIDEBAR_PANE } from "../lib/pane";
import { searchChats } from "../lib/search";
import { buildSidebarChatIndex, sameSidebarSessions, type NestedSidebarSession, type SidebarChatIndex } from "../lib/sidebar-index";

type SidebarStore = Pick<
  Store,
  | "projects"
  | "sessions"
  | "usage"
  | "settings"
  | "theme"
  | "activeProjectId"
  | "activeSessionId"
  | "panel"
  | "sidebarWidth"
  | "setSidebarWidth"
  | "toggleWorkhorseTheme"
  | "openSheet"
  | "startSession"
  | "selectProject"
  | "moveSession"
  | "selectSession"
  | "renameSession"
  | "forkFrom"
  | "exportSession"
  | "archiveSession"
  | "deleteWorkers"
  | "deleteSession"
  | "openSettings"
  | "closeSettings"
>;

type SidebarUpdateStore = Pick<
  Store,
  | "appUpdate"
  | "appUpdateBusy"
  | "appUpdateError"
  | "applyAppUpdate"
>;

function selectSidebarStore(store: Store): SidebarStore {
  return store;
}

function sameSidebarStore(left: SidebarStore, right: SidebarStore): boolean {
  return (
    left.projects === right.projects &&
    sameSidebarSessions(left.sessions, right.sessions) &&
    left.usage === right.usage &&
    left.settings === right.settings &&
    left.theme === right.theme &&
    left.activeProjectId === right.activeProjectId &&
    left.activeSessionId === right.activeSessionId &&
    left.panel === right.panel &&
    left.sidebarWidth === right.sidebarWidth
  );
}

function selectSidebarUpdateStore(store: Store): SidebarUpdateStore {
  return store;
}

function sameSidebarUpdateStore(left: SidebarUpdateStore, right: SidebarUpdateStore): boolean {
  return (
    left.appUpdate === right.appUpdate &&
    left.appUpdateBusy === right.appUpdateBusy &&
    left.appUpdateError === right.appUpdateError &&
    left.applyAppUpdate === right.applyAppUpdate
  );
}

function rowDesk(store: SidebarStore, index: SidebarChatIndex, session: Session): ChatRowDesk {
  return {
    activeSessionId: store.activeSessionId,
    settingsOpen: store.panel === "settings" || store.panel === "add-bot",
    settings: store.settings,
    projects: store.projects,
    parent: session.parentId ? index.parentsById.get(session.parentId) : undefined,
    link: index.linksBySession.get(session.id),
    actions: store,
  };
}

function CrewList({
  session,
  open,
  store,
  index,
}: {
  session: NestedSidebarSession;
  open: boolean;
  store: SidebarStore;
  index: SidebarChatIndex;
}) {
  if (session.workers.length === 0) return null;
  return (
    <div className={`crew-slot${open ? " open" : ""}`} aria-hidden={!open}>
      <div className="crew-slot-inner">
        {session.workers.map((worker) => (
          <ChatRow key={worker.id} session={worker} desk={rowDesk(store, index, worker)} nested />
        ))}
      </div>
    </div>
  );
}

function LooseChats({ store, index }: { store: SidebarStore; index: SidebarChatIndex }) {
  const chats = index.liveByProject.get(null) ?? [];
  const archived = index.archivedByProject.get(null) ?? [];
  const [showArchived, setShowArchived] = useState(false);
  const [openCrew, setOpenCrew] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const active = store.activeSessionId ? index.parentsById.get(store.activeSessionId) : undefined;
    if (!active?.parentId) return;
    setOpenCrew((current) => (current[active.parentId!] ? current : { ...current, [active.parentId!]: true }));
  }, [store.activeSessionId, index]);
  if (chats.length === 0 && archived.length === 0) return null;
  return (
    <div className="loose-chats">
      <div className="section-label">Chats</div>
      {chats.map((session) => (
        <div key={session.id} className="project-chat-block">
          <ChatRow
            session={session}
            desk={rowDesk(store, index, session)}
            workerCount={session.workers.length}
            mission={missionRowLook(session, session.workers)}
            workersOpen={Boolean(openCrew[session.id])}
            onToggleWorkers={() =>
              setOpenCrew((current) => ({ ...current, [session.id]: !current[session.id] }))
            }
          />
          <CrewList session={session} open={Boolean(openCrew[session.id])} store={store} index={index} />
        </div>
      ))}
      {archived.length > 0 && (
        <>
          <button className="archive-toggle" type="button" onClick={() => setShowArchived((value) => !value)}>
            Archived ({archived.length})
          </button>
          {showArchived && archived.map((session) => <ChatRow key={session.id} session={session} desk={rowDesk(store, index, session)} />)}
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
  store,
  index,
}: {
  project: Project;
  open: boolean;
  dropOver: boolean;
  onToggle: () => void;
  onDropTarget: (id: string | null) => void;
  store: SidebarStore;
  index: SidebarChatIndex;
}) {
  const chats = index.liveByProject.get(project.id) ?? [];
  const archived = index.archivedByProject.get(project.id) ?? [];
  const [showMore, setShowMore] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [openCrew, setOpenCrew] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const active = store.activeSessionId ? index.parentsById.get(store.activeSessionId) : undefined;
    if (!active?.parentId) return;
    setOpenCrew((current) => (current[active.parentId!] ? current : { ...current, [active.parentId!]: true }));
  }, [store.activeSessionId, index]);
  const settingsOpen = store.panel === "settings" || store.panel === "add-bot";
  const selected = !settingsOpen && project.id === store.activeProjectId;
  const visible = visibleProjectChats(chats, showMore, store.activeSessionId);
  const hidden = hiddenProjectChatCount(chats.length, showMore);

  return (
    <div className={`project-folder${open ? " open" : ""}${selected ? " selected" : ""}${dropOver ? " drop-over" : ""}`}>
      <div className="project-head">
        <button
          className="twist"
          type="button"
          aria-expanded={open}
          aria-label={open ? `Hide chats in ${project.name}` : `Show chats in ${project.name}`}
          onClick={onToggle}
        >
          <svg className="twist-folder twist-folder-closed" viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M2 3.5A1.5 1.5 0 0 1 3.5 2h2.88c.4 0 .78.16 1.06.44l1.12 1.12c.10.10.0.4.44.44H12.5A1.5 1.5 0 0 1 14 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5z"
            />
          </svg>
          <svg className="twist-folder twist-folder-open" viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M2 3.5A1.5 1.5 0 0 1 3.5 2h2.88c.4 0 .78.16 1.06.44l.8.8H12.5A1.5 1.5 0 0 1 14 4.75V6H4.15A2.1 2.1 0 0 0 2.1 7.85L2 8.2z"
            />
            <path
              fill="currentColor"
              d="M2.2 7.4h12.45L13.05 14.2H3.2A1.45 1.45 0 0 1 1.78 12.8L2.2 7.4z"
            />
          </svg>
        </button>
        <button
          className={selected && !store.activeSessionId ? "row active" : "row"}
          type="button"
          onClick={() => {
            if (open) {
              onToggle();
              return;
            }
            const last = lastProjectChat(chats);
            if (last) store.selectSession(last.id);
            else store.selectProject(project.id);
            onToggle();
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
          <span className="row-title">{project.name}</span>
        </button>
        <button
          className={`tiny project-info${selected && !store.activeSessionId ? " active" : ""}`}
          type="button"
          aria-label={`Open ${project.name} info`}
          title="Project info"
          onClick={(event) => {
            event.stopPropagation();
            store.selectProject(project.id);
          }}
        >
          i
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
                desk={rowDesk(store, index, session)}
                workerCount={session.workers.length}
            mission={missionRowLook(session, session.workers)}
                workersOpen={Boolean(openCrew[session.id])}
                onToggleWorkers={() =>
                  setOpenCrew((current) => ({ ...current, [session.id]: !current[session.id] }))
                }
              />
              <CrewList session={session} open={Boolean(openCrew[session.id])} store={store} index={index} />
            </div>
          ))}
          {chats.length > PROJECT_CHAT_LIMIT && hidden > 0 && (
            <button className="archive-toggle" type="button" onClick={() => setShowMore((value) => !value)}>
              {showMore ? "Show less" : `Show more (${hidden})`}
            </button>
          )}
          {archived.length > 0 && (
            <>
              <button className="archive-toggle" type="button" onClick={() => setShowArchived((value) => !value)}>
                Archived ({archived.length})
              </button>
              {showArchived && archived.map((session) => <ChatRow key={session.id} session={session} desk={rowDesk(store, index, session)} />)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsPulse({ store }: { store: Pick<SidebarStore, "usage" | "sessions"> }) {
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

const SidebarUpdate = memo(function SidebarUpdate() {
  const store = useStoreSelector(selectSidebarUpdateStore, sameSidebarUpdateStore);
  const offer = store.appUpdate;
  if (!offer) return null;
  const label = store.appUpdateBusy ? "Updating…" : store.appUpdateError ? "Try update again" : "Update now";
  const detail = store.appUpdateError ? "Update failed" : `Workhorse ${offer.version}`;
  return (
    <button
      className={`sidebar-update${store.appUpdateBusy ? " busy" : ""}${store.appUpdateError ? " error" : ""}`}
      type="button"
      aria-label={`${label}. ${detail}`}
      disabled={store.appUpdateBusy}
      onClick={() => {
        if (!store.appUpdate) return;
        void store.applyAppUpdate(offer.version);
      }}
    >
      <span className="sidebar-update-icon">
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <path d="M5.1 13.2h7.8a3 3 0 0 0 .2-6 4.4 4.4 0 0 0-8.4 1.2 2.4 2.4 0 0 0 .4 4.8Z" />
          <path d="M9 8.7v5.1m-2-1.9 2 2 2-2" />
        </svg>
      </span>
      <span className="sidebar-update-copy" aria-hidden="true">
        <span className="row-title">{label}</span>
        <span className="row-meta">{detail}</span>
      </span>
    </button>
  );
});

export function Sidebar() {
  const store = useStoreSelector(selectSidebarStore, sameSidebarStore);
  const readStore = useStoreReader();
  const [query, setQuery] = useState("");
  const [openIds, setOpenIds] = useState<string[]>(() => (store.activeProjectId ? [store.activeProjectId] : []));
  const [dropId, setDropId] = useState<string | null>(null);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const index = useMemo(() => buildSidebarChatIndex(store.sessions), [store.sessions]);
  const liveProjects = useMemo(() => store.projects.filter((item) => !item.archivedAt), [store.projects]);
  const archivedProjects = useMemo(() => store.projects.filter((item) => item.archivedAt), [store.projects]);
  const results = useMemo(() => {
    if (!query.trim()) return [];
    const latest = readStore();
    return searchChats(latest.sessions, latest.projects, query);
  }, [query, readStore]);

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
            store={store}
            index={index}
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
                  store={store}
                  index={index}
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
        <LooseChats store={store} index={index} />
      </div>
      <footer className="sidebar-dock">
        <button
          className={`row sidebar-settings${store.panel === "settings" || store.panel === "add-bot" ? " active" : ""}`}
          type="button"
          onClick={() =>
            store.panel === "settings" || store.panel === "add-bot" ? store.closeSettings() : store.openSettings()
          }
        >
          <span>
            <span className="row-title">Settings</span>
            <SettingsPulse store={store} />
          </span>
        </button>
        <SidebarUpdate />
      </footer>
    </aside>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { formatChatSidebar } from "../lib/session";
import { deskInk, vendorAttachedForSession } from "../lib/settings";
import { chatLinksFromSessions } from "../lib/tool-labels";
import { useStore } from "../lib/store";
import type { Session } from "../lib/types";

export function ChatRow({
  session,
  nested = false,
  workerCount = 0,
  workersOpen = false,
  onToggleWorkers,
}: {
  session: Session;
  nested?: boolean;
  workerCount?: number;
  workersOpen?: boolean;
  onToggleWorkers?: () => void;
}) {
  const store = useStore();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const archived = typeof session.archivedAt === "number";
  const bot = session.customBotId
    ? store.settings.customBots.find((item) => item.id === session.customBotId)
    : undefined;
  const stockLink = session.provider !== "custom" ? store.settings.llms[session.provider] : undefined;
  const parent = session.parentId ? store.sessions.find((item) => item.id === session.parentId) : undefined;
  const ink = deskInk(session, store.settings) ?? (parent ? deskInk(parent, store.settings) : undefined);
  const rowLabel = vendorAttachedForSession(session, store.settings)
    ? formatChatSidebar({
        provider: session.provider,
        model: session.model,
        effort: session.effort,
        mode: session.mode,
        botName: bot?.name ?? stockLink?.name,
      })
    : "Attach LLM";
  const link = useMemo(
    () => chatLinksFromSessions(store.sessions).find((item) => item.sessionId === session.id),
    [store.sessions, session.id],
  );

  useEffect(() => {
    if (!menu && !confirmDelete) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setMenu(false);
        setConfirmDelete(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu, confirmDelete]);

  useEffect(() => {
    if (renaming) {
      setDraft(session.title);
      requestAnimationFrame(() => field.current?.select());
    }
  }, [renaming, session.title]);

  const commitRename = () => {
    store.renameSession(session.id, draft);
    setRenaming(false);
  };

  return (
    <div
      className={`chat-row${nested ? " nested-worker" : ""}${store.panel !== "settings" && store.panel !== "add-bot" && session.id === store.activeSessionId ? " active" : ""}${link ? " peer-link" : ""}`}
      ref={root}
      draggable={!renaming}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/workhorse-chat", session.id);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      {renaming ? (
        <form
          className="rename-form"
          onSubmit={(event) => {
            event.preventDefault();
            commitRename();
          }}
        >
          <input
            ref={field}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Escape") setRenaming(false);
            }}
          />
        </form>
      ) : (
        <button className="row chat-open" type="button" onClick={() => store.selectSession(session.id)}>
          <span
            className={`dot ${session.provider}${session.status === "running" ? " pulse" : ""}`}
            style={ink ? { background: ink, color: ink } : undefined}
          />
          <span>
            <span className="row-title">{session.title}</span>
            <span className={`row-meta${link ? " peer" : ""}`}>
              {link
                ? link.label
                : nested
                  ? session.status === "running"
                    ? "Worker · Working…"
                    : "Worker"
                  : session.status === "running"
                    ? "Working…"
                    : session.status === "needs-input"
                      ? "Needs you"
                      : rowLabel}
            </span>
          </span>
        </button>
      )}

      {workerCount > 0 && onToggleWorkers ? (
        <button
          className={`tiny crew-twist${workersOpen ? " open" : ""}`}
          type="button"
          aria-expanded={workersOpen}
          aria-label={workersOpen ? "Hide worker chats" : `Show ${workerCount} worker chats`}
          title={workersOpen ? "Hide workers" : `${workerCount} workers`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleWorkers();
          }}
        >
          {workerCount}
        </button>
      ) : null}

      <button
        className="tiny chat-more"
        type="button"
        aria-label="Chat actions"
        onClick={() => {
          setConfirmDelete(false);
          setMenu((value) => !value);
        }}
      >
        ···
      </button>

      {menu && (
        <div className="chat-menu">
          <button
            type="button"
            onClick={() => {
              setMenu(false);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => {
              const last = [...session.messages]
                .reverse()
                .find((message) => message.role === "user" || message.role === "assistant");
              setMenu(false);
              if (last) store.forkFrom(last.id, session.id);
            }}
          >
            Fork chat
          </button>
          <div className="chat-move">
            <span>{session.projectId ? "Move to" : "Add to"}</span>
            {store.projects
              .filter((project) => project.id !== session.projectId)
              .map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => {
                    store.moveSession(session.id, project.id);
                    setMenu(false);
                  }}
                >
                  {project.name}
                </button>
              ))}
            {store.projects.filter((project) => project.id !== session.projectId).length === 0 && (
              <em>No other project</em>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setMenu(false);
              void store.exportSession(session.id);
            }}
          >
            Export chat
          </button>
          <button
            type="button"
            onClick={() => {
              store.archiveSession(session.id, !archived);
              setMenu(false);
            }}
          >
            {archived ? "Unarchive" : "Archive"}
          </button>
          {workerCount > 0 ? (
            <button
              className="danger"
              type="button"
              onClick={() => {
                store.deleteWorkers(session.id);
                setMenu(false);
              }}
            >
              Delete workers
            </button>
          ) : null}
          {confirmDelete ? (
            <button
              className="danger"
              type="button"
              onClick={() => {
                store.deleteSession(session.id);
                setMenu(false);
              }}
            >
              Delete for good
            </button>
          ) : (
            <button className="danger" type="button" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

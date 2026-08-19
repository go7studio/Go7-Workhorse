import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { lastTalkedAt } from "../lib/chats";
import { clampMenuPosition } from "../lib/edit-menu";
import { formatChatSidebar } from "../lib/session";
import { effortLabel, modelName } from "../lib/models";
import { deskInk, vendorAttachedForSession } from "../lib/settings";
import { chatLinksFromSessions } from "../lib/tool-labels";
import { useStore } from "../lib/store";
import type { Session } from "../lib/types";
import { TimeStamp } from "./TimeStamp";

export function workerSidebarLabel(session: Session, botName?: string): string {
  const name = botName?.trim() || modelName(session.provider, session.model);
  const effort = effortLabel(session.effort ?? null);
  const run = session.agentRun?.status;
  let state = "Ready";
  if (session.status === "running" || run === "running") state = "Working…";
  else if (run === "completed") state = "Done";
  else if (run === "failed") state = "Failed";
  else if (run === "timed-out") state = "Timed out";
  else if (run === "budget-exceeded") state = "Budget stop";
  else if (run === "interrupted") state = "Interrupted";
  else if (run === "cancelled") state = "Cancelled";
  else if (session.status === "needs-input") state = "Needs you";
  const iteration = session.agentRun?.mission?.iteration ?? 0;
  const pass = iteration > 1 ? `Pass ${iteration}` : "";
  return [name, effort, pass, state].filter(Boolean).join(" · ");
}

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
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveSide, setMoveSide] = useState<"right" | "left">("right");
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  const movePanel = useRef<HTMLDivElement>(null);
  const [menuAt, setMenuAt] = useState<{ top: number; left: number } | null>(null);
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
        routingMode: session.routingMode,
      })
    : "Attach LLM";
  const workerLabel = workerSidebarLabel(session, bot?.name ?? stockLink?.name);
  const link = useMemo(
    () => chatLinksFromSessions(store.sessions).find((item) => item.sessionId === session.id),
    [store.sessions, session.id],
  );

  useEffect(() => {
    if (!menu && !confirmDelete) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (root.current?.contains(target) || menuBox.current?.contains(target)) return;
      setMenu(false);
      setMoveOpen(false);
      setConfirmDelete(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu, confirmDelete]);

  useEffect(() => {
    if (!menu) setMoveOpen(false);
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu) {
      setMenuAt(null);
      return;
    }
    const place = () => {
      const btn = moreBtn.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const width = menuBox.current?.offsetWidth || 160;
      const height = menuBox.current?.offsetHeight || 240;
      const next = clampMenuPosition(
        rect.right - width,
        rect.bottom + 4,
        width,
        height,
        window.innerWidth,
        window.innerHeight,
      );
      setMenuAt({ left: next.x, top: next.y });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [menu, confirmDelete]);

  useLayoutEffect(() => {
    if (!moveOpen || !movePanel.current) {
      setMoveSide("right");
      return;
    }
    const box = movePanel.current.getBoundingClientRect();
    setMoveSide(box.right > window.innerWidth - 8 ? "left" : "right");
  }, [moveOpen]);

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

  const talkedAt = lastTalkedAt(session);

  return (
    <div
      className={`chat-row${nested ? " nested-worker" : ""}${store.panel !== "settings" && store.panel !== "add-bot" && session.id === store.activeSessionId ? " active" : ""}${link ? " peer-link" : ""}${menu || confirmDelete ? " menu-open" : ""}`}
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
        <button
          className="row chat-open"
          type="button"
          onClick={() => store.selectSession(session.id)}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setRenaming(true);
          }}
        >
          <span
            className={`dot ${session.provider}${session.status === "running" ? " pulse" : ""}`}
            style={ink ? { background: ink, color: ink } : undefined}
          />
          <span>
            <span className="row-title" title="Double-click to rename">
              {session.title}
            </span>
            <span className={`row-meta${link ? " peer" : ""}`}>
              {link
                ? link.label
                : nested && (session.hidden || session.agentRun)
                  ? workerLabel
                  : session.status === "running"
                    ? "Working…"
                    : session.status === "needs-input"
                      ? "Needs you"
                      : rowLabel}
            </span>
          </span>
          <TimeStamp at={talkedAt} className="row-talked" />
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
        ref={moreBtn}
        className="tiny chat-more"
        type="button"
        aria-label="Chat actions"
        aria-expanded={menu}
        onClick={(event) => {
          event.stopPropagation();
          setConfirmDelete(false);
          setMoveOpen(false);
          setMenu((value) => !value);
        }}
      >
        ···
      </button>

      {menu &&
        createPortal(
          <div
            ref={menuBox}
            className="chat-menu floating"
            role="menu"
            style={menuAt ? { top: menuAt.top, left: menuAt.left } : { visibility: "hidden", top: 0, left: 0 }}
          >
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
            <div className={`chat-move${moveOpen ? " open" : ""}`}>
              <button
                type="button"
                className="chat-move-toggle"
                aria-expanded={moveOpen}
                onClick={() => setMoveOpen((value) => !value)}
              >
                <span>{session.projectId ? "Move to" : "Add to"}</span>
                <i className="twist" aria-hidden="true" />
              </button>
              {moveOpen ? (
                <div ref={movePanel} className={`chat-move-panel ${moveSide}`} role="menu">
                  {store.projects
                    .filter((project) => project.id !== session.projectId)
                    .map((project) => (
                      <button
                        key={project.id}
                        type="button"
                        onClick={() => {
                          store.moveSession(session.id, project.id);
                          setMenu(false);
                          setMoveOpen(false);
                        }}
                      >
                        {project.name}
                      </button>
                    ))}
                  {store.projects.filter((project) => project.id !== session.projectId).length === 0 && (
                    <em>No other project</em>
                  )}
                </div>
              ) : null}
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
          </div>,
          document.body,
        )}
    </div>
  );
}

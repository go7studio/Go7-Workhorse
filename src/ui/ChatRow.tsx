import { useEffect, useRef, useState } from "react";
import { modeLabel } from "../lib/commands";
import { choiceLabel } from "../lib/models";
import { useStore } from "../lib/store";
import type { Session } from "../lib/types";

export function ChatRow({ session }: { session: Session }) {
  const store = useStore();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const archived = typeof session.archivedAt === "number";

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
      className={session.id === store.activeSessionId ? "chat-row active" : "chat-row"}
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
          <span className={`dot ${session.provider}`} />
          <span>
            <span className="row-title">{session.title}</span>
            <span className="row-meta">
              {choiceLabel(session)} · {modeLabel(session.mode)}
            </span>
          </span>
        </button>
      )}

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
          <div className="chat-move">
            <span>Move to</span>
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
              store.archiveSession(session.id, !archived);
              setMenu(false);
            }}
          >
            {archived ? "Unarchive" : "Archive"}
          </button>
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

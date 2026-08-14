import { useEffect, useMemo, useState } from "react";
import { projectEdits, type ProjectEdit } from "../lib/project-edits";
import { useActiveProject, useStore } from "../lib/store";
import { EditedList } from "./EditedList";
import { FileReview } from "./FileReview";

export function ProjectHome() {
  const project = useActiveProject();
  const store = useStore();
  const { linkFolder, unlinkFolder, removeReference, openSheet } = store;
  const [open, setOpen] = useState<ProjectEdit | null>(null);
  const [deleteAsk, setDeleteAsk] = useState(false);
  const [stats, setStats] = useState<Record<string, { added: number; deleted: number }>>({});
  const roots = useMemo(() => project?.folders.map((folder) => folder.path) ?? [], [project]);
  const edits = useMemo(
    () =>
      project
        ? projectEdits(
            store.sessions.filter((session) => session.projectId === project.id),
            roots,
          )
        : [],
    [project, store.sessions, roots],
  );
  const editKey = edits.map((item) => item.path).join("\n");

  useEffect(() => {
    if (!window.workhorse?.editStats || edits.length === 0) {
      setStats({});
      return;
    }
    void window.workhorse.editStats(
      edits.map((item) => item.path),
      roots,
    ).then((next) => setStats(next ?? {}));
  }, [editKey, roots]);

  if (!project) return null;

  if (open) {
    return (
      <FileReview
        file={open}
        files={edits}
        stats={stats}
        roots={roots}
        onOpen={setOpen}
        onClose={() => setOpen(null)}
      />
    );
  }

  return (
    <section className="picker project-home project-overview">
      <header className="project-hero">
        <div className="link-head">
          <p className="eyebrow">Project</p>
          {deleteAsk ? (
            <div className="actions">
              <button
                className="tiny"
                type="button"
                onClick={() => {
                  store.deleteProject(project.id, "keep");
                  setDeleteAsk(false);
                }}
              >
                Move chats to Chats
              </button>
              <button
                className="tiny danger"
                type="button"
                onClick={() => {
                  store.deleteProject(project.id, "remove");
                  setDeleteAsk(false);
                }}
              >
                Delete chats
              </button>
              <button className="tiny" type="button" onClick={() => setDeleteAsk(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="actions">
              <button
                className="tiny"
                type="button"
                onClick={() => store.archiveProject(project.id, !project.archivedAt)}
              >
                {project.archivedAt ? "Unarchive" : "Archive"}
              </button>
              <button className="tiny danger" type="button" onClick={() => setDeleteAsk(true)}>
                Delete
              </button>
            </div>
          )}
        </div>
        <h2>{project.name}</h2>
        <p className="lede">
          {deleteAsk
            ? "Remove this project. Keep its chats in the sidebar Chats list, or delete those chats too."
            : "Linked folders and the files this project has changed. New chat stays in the sidebar."}
        </p>
      </header>

      <div className="link-block">
        <div className="link-head">
          <span className="section-label" style={{ margin: 0 }}>
            Folders
          </span>
          <button className="tiny" type="button" onClick={() => void linkFolder()}>
            Link folder
          </button>
        </div>
        {project.folders.length === 0 ? (
          <p className="row-meta">Optional. Link one or more working directories.</p>
        ) : (
          <ul className="chip-list">
            {project.folders.map((folder) => (
              <li key={folder.id} className="chip">
                <span>
                  <strong>{folder.label}</strong>
                  <span className="path">{folder.path}</span>
                </span>
                <button className="tiny" type="button" onClick={() => unlinkFolder(folder.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="link-block">
        <div className="link-head">
          <span className="section-label" style={{ margin: 0 }}>
            References
          </span>
          <button className="tiny" type="button" onClick={() => openSheet("reference")}>
            Add reference
          </button>
        </div>
        {project.references.length === 0 ? (
          <p className="row-meta">Files, URLs, or notes. Also optional.</p>
        ) : (
          <ul className="chip-list">
            {project.references.map((reference) => (
              <li key={reference.id} className="chip">
                <span>
                  <strong>
                    {reference.kind} · {reference.label}
                  </strong>
                  <span className="path">{reference.value}</span>
                </span>
                <button className="tiny" type="button" onClick={() => removeReference(reference.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <EditedList
        edits={edits}
        stats={stats}
        empty="Files chats change in this project will show up here."
        onOpen={setOpen}
      />
    </section>
  );
}

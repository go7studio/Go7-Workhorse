import { useEffect, useMemo, useRef, useState } from "react";
import { clampPaneWidth, FILE_PANE } from "../lib/pane";
import {
  editListKey,
  holdEditStats,
  markStatsFetched,
  projectFileChanges,
  projectWritesKey,
  sameEditList,
  sameEditPath,
  startEditStatsHarvest,
  type ProjectEdit,
} from "../lib/project-edits";
import { useActiveProject, useStore } from "../lib/store";
import { EditedList } from "./EditedList";
import { FileViewer } from "./FileViewer";
import { SplitHandle } from "./SplitHandle";

export function ProjectHome() {
  const project = useActiveProject();
  const store = useStore();
  const { linkFolder, unlinkFolder, removeReference, openSheet } = store;
  const [open, setOpen] = useState<ProjectEdit | null>(null);
  const [fileOut, setFileOut] = useState(false);
  const [deleteAsk, setDeleteAsk] = useState(false);
  const [fileWidth, setFileWidth] = useState(() => FILE_PANE.fallback);
  const [hidden, setHidden] = useState<string[]>([]);
  const [stats, setStats] = useState<Record<string, { added: number; deleted: number }>>({});
  const [heldVisible, setHeldVisible] = useState<ProjectEdit[]>([]);
  const fetchedStats = useRef<Record<string, string>>({});
  const roots = useMemo(() => project?.folders.map((folder) => folder.path) ?? [], [project]);
  const writesKey = useMemo(
    () => (project ? projectWritesKey(store.sessions, project.id) : ""),
    [project?.id, store.sessions],
  );
  const changes = useMemo(
    () =>
      project
        ? projectFileChanges(
            store.sessions.filter((session) => session.projectId === project.id),
            roots,
          )
        : { created: [], edited: [] },
    [writesKey, roots, project],
  );
  const listed = useMemo(() => [...changes.created, ...changes.edited], [changes]);
  const visible = useMemo(
    () => listed.filter((item) => !hidden.some((path) => sameEditPath(path, item.path))),
    [listed, hidden],
  );
  const display = visible.length > 0 ? visible : listed.length > 0 ? [] : heldVisible;
  const editKey = editListKey(listed);
  const liveOpen = open ? (display.find((item) => sameEditPath(item.path, open.path)) ?? open) : null;
  const rootKey = roots.join("\n");

  useEffect(() => {
    setOpen(null);
    setFileOut(false);
    setDeleteAsk(false);
    setHidden([]);
    setHeldVisible([]);
    setStats({});
    fetchedStats.current = {};
  }, [project?.id]);

  useEffect(() => {
    fetchedStats.current = {};
  }, [rootKey]);

  useEffect(() => {
    if (visible.length === 0) return;
    setHeldVisible((previous) => (sameEditList(previous, visible) ? previous : visible));
  }, [visible]);

  useEffect(() => {
    const api = window.workhorse;
    if (!api?.editStats || listed.length === 0) return;
    const paths = listed.map((item) => item.path);
    return startEditStatsHarvest({
      items: listed,
      getFetched: () => fetchedStats.current,
      rootKey,
      roots,
      editStats: (files, folders, created) => api.editStats(files, folders, created),
      onChunk: (next, stale) => {
        fetchedStats.current = markStatsFetched(fetchedStats.current, stale, rootKey);
        setStats((previous) => holdEditStats(previous, next, paths));
      },
    });
  }, [editKey, rootKey, project?.id]);

  if (!project) return null;

  const closeFilePane = () => {
    if (!open || fileOut) return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOpen(null);
      setFileOut(false);
      return;
    }
    setFileOut(true);
  };
  const openFile = (file: ProjectEdit) => {
    if (open && sameEditPath(open.path, file.path)) {
      closeFilePane();
      return;
    }
    setFileOut(false);
    setOpen(file);
  };
  const dismissFile = (file: ProjectEdit) => {
    setHidden((current) => (current.some((path) => sameEditPath(path, file.path)) ? current : [...current, file.path]));
    if (open && sameEditPath(open.path, file.path)) closeFilePane();
  };

  return (
    <section
      className={`project-home-shell${open ? " has-file" : ""}`}
      style={open ? { ["--file-pane" as string]: `${fileWidth}px` } : undefined}
    >
      <div className="picker project-home project-overview">
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
          {deleteAsk && <p className="lede">Keep or delete its chats.</p>}
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
            <p className="row-meta">No folders.</p>
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
          {project.references.length > 0 ? (
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
          ) : null}
        </div>

        <EditedList
          compact={display.length > 0}
          startOpen
          label="Changes"
          edits={display}
          stats={stats}
          onOpen={openFile}
          onDismiss={dismissFile}
        />
      </div>
      {open ? (
        <aside
          className={`session-file${fileOut ? " out" : ""}`}
          style={{ width: fileWidth }}
          aria-label="Open file"
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget || !fileOut) return;
            setOpen(null);
            setFileOut(false);
          }}
        >
          <SplitHandle
            value={fileWidth}
            onChange={(next) => setFileWidth(clampPaneWidth(next, FILE_PANE))}
            min={FILE_PANE.min}
            max={FILE_PANE.max}
            reset={FILE_PANE.fallback}
            invert
            label="Resize file pane"
          />
          <FileViewer file={liveOpen ?? open} roots={roots} onClose={closeFilePane} />
        </aside>
      ) : null}
    </section>
  );
}

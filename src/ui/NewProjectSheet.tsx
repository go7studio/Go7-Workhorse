import { useEffect, useRef, useState } from "react";
import { folderName } from "../lib/id";
import { useStore } from "../lib/store";

function pathFromDropped(file: File): string {
  const full = window.workhorse?.pathForFile?.(file)?.trim() ?? "";
  if (!full) return "";
  if (file.type) return full.replace(/[\\/][^\\/]+$/, "") || full;
  return full;
}

export function NewProjectSheet() {
  const { sheet, createProject, closeSheet } = useStore();
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (sheet === "project") {
      setName("");
      setFolders([]);
      setOver(false);
      requestAnimationFrame(() => field.current?.focus());
    }
  }, [sheet]);

  if (sheet !== "project") return null;

  const addFolders = (paths: string[]) => {
    const next = paths.map((path) => path.trim()).filter(Boolean);
    if (next.length === 0) return;
    setFolders((current) => {
      const seen = new Set(current);
      const added = next.filter((path) => !seen.has(path));
      return added.length === 0 ? current : [...current, ...added];
    });
    setName((current) => current.trim() || folderName(next[0] ?? "") || current);
  };

  const pickFolder = async () => {
    const picked = window.workhorse ? await window.workhorse.pickFolder() : null;
    if (picked) addFolders([picked]);
  };

  const submit = () => {
    createProject(name, folders);
    closeSheet();
  };

  return (
    <div className="sheet-backdrop" onClick={closeSheet}>
      <form
        className="sheet project-sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h3>New project</h3>
        <label className="sheet-field">
          <span className="sheet-label">Name</span>
          <span className="sheet-name">
            <i className="sheet-folder-icon" aria-hidden="true" />
            <input
              ref={field}
              value={name}
              placeholder="Project name"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeSheet();
              }}
            />
          </span>
        </label>
        <div className="sheet-field">
          <span className="sheet-label">Source folders</span>
          {folders.length > 0 && (
            <ul className="source-folder-list">
              {folders.map((folder) => (
                <li key={folder}>
                  <span>
                    <strong>{folderName(folder)}</strong>
                    <em>{folder}</em>
                  </span>
                  <button
                    className="tiny"
                    type="button"
                    aria-label={`Remove ${folderName(folder)}`}
                    onClick={() => setFolders((current) => current.filter((item) => item !== folder))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            className={`source-drop${over ? " over" : ""}`}
            type="button"
            onClick={() => void pickFolder()}
            onDragEnter={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setOver(false);
              const paths = [...event.dataTransfer.files].map(pathFromDropped).filter(Boolean);
              addFolders(paths);
            }}
          >
            <i className="source-drop-icon" aria-hidden="true" />
            <strong>Add folders</strong>
            <span>Choose or drop folders.</span>
          </button>
        </div>
        <div className="actions">
          <button className="ghost" type="button" onClick={closeSheet}>
            Cancel
          </button>
          <button className="primary" type="submit">
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

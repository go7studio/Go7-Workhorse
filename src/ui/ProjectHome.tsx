import { useActiveProject, useStore } from "../lib/store";

export function ProjectHome() {
  const project = useActiveProject();
  const { startSession, linkFolder, unlinkFolder, removeReference, openSheet } = useStore();
  if (!project) return null;

  return (
    <section className="picker project-home">
      <h2>{project.name}</h2>
      <p>
        {project.folders.length === 0
          ? "Nothing linked yet. You can still chat. Add folders or references when you want them."
          : "Chats in this project can use the linked folders and references."}
      </p>

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

      <div className="actions" style={{ marginTop: 20 }}>
        <button className="primary" type="button" onClick={() => startSession()}>
          New chat
        </button>
      </div>
      <p className="row-meta" style={{ marginTop: 10 }}>
        Pick the model and brain level from the menu on the chat.
      </p>
    </section>
  );
}

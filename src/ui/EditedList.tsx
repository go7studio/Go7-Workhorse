import { useState } from "react";
import { formatDiffStat } from "../lib/file-diff";
import { formatEditWhen, type ProjectEdit } from "../lib/project-edits";
import { providerById } from "../lib/providers";

export function EditedList({
  edits,
  stats,
  empty,
  compact = false,
  onOpen,
}: {
  edits: ProjectEdit[];
  stats: Record<string, { added: number; deleted: number }>;
  empty?: string;
  compact?: boolean;
  onOpen: (file: ProjectEdit) => void;
}) {
  const [open, setOpen] = useState(!compact);
  const totalAdded = edits.reduce((sum, item) => sum + (stats[item.path]?.added ?? 0), 0);
  const totalDeleted = edits.reduce((sum, item) => sum + (stats[item.path]?.deleted ?? 0), 0);
  const summary = (
    <>
      {edits.length === 0 ? "None yet" : `${edits.length} file${edits.length === 1 ? "" : "s"}`}
      {edits.length > 0 && (
        <>
          {"  ·  "}
          <span className="file-diff-stat">
            <span className="diff-add">+{totalAdded}</span>
            <span className="diff-del">−{totalDeleted}</span>
          </span>
        </>
      )}
    </>
  );

  return (
    <div className={`link-block edited-block${compact ? " compact" : ""}${compact && open ? " open" : ""}`}>
      {compact ? (
        <button
          className="edited-toggle"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="section-label" style={{ margin: 0 }}>
            Edited
          </span>
          <span className="row-meta">{summary}</span>
        </button>
      ) : (
        <div className="link-head">
          <span className="section-label" style={{ margin: 0 }}>
            Edited
          </span>
          <span className="row-meta">{summary}</span>
        </div>
      )}
      {edits.length === 0 && empty ? <p className="row-meta">{empty}</p> : null}
      {edits.length > 0 && (!compact || open) ? (
        <ul className="file-list">
          {edits.map((item) => {
            const added = stats[item.path]?.added ?? 0;
            const deleted = stats[item.path]?.deleted ?? 0;
            return (
              <li key={item.path}>
                <button
                  className="file-row"
                  type="button"
                  onClick={() => onOpen(item)}
                  aria-label={`${item.name}, ${formatDiffStat(added, deleted)}`}
                >
                  <span>
                    <strong>{item.name}</strong>
                    <span className="row-meta">
                      {item.folder ? `${item.folder}  ·  ` : ""}
                      {item.edits} edit{item.edits === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="file-meta">
                    <span className="file-diff-stat">
                      <span className="diff-add">+{added}</span>
                      <span className="diff-del">−{deleted}</span>
                    </span>
                    <i className={`dot ${item.provider}`} />
                    {providerById(item.provider).name}
                    {"  ·  "}
                    {formatEditWhen(item.at)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

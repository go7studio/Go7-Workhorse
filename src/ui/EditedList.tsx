import { memo, useEffect, useRef, useState } from "react";

const FOLD_MS = 200;
import { formatDiffStat } from "../lib/file-diff";
import {
  editPathKey,
  formatEditWhen,
  holdEditStats,
  statForPath,
  type ProjectEdit,
} from "../lib/project-edits";
import { deskInk, deskLabel } from "../lib/settings";
import { useStore } from "../lib/store";
import { DiffStat } from "./DiffStat";

export const EditedList = memo(function EditedList({
  edits,
  stats,
  empty,
  compact = false,
  startOpen,
  showLineStats = true,
  label = "Edited",
  unit = "edit",
  onOpen,
  onDismiss,
}: {
  edits: ProjectEdit[];
  stats: Record<string, { added: number; deleted: number }>;
  empty?: string;
  compact?: boolean;
  startOpen?: boolean;
  showLineStats?: boolean;
  label?: string;
  unit?: "edit" | "new";
  onOpen: (file: ProjectEdit) => void;
  onDismiss?: (file: ProjectEdit) => void;
}) {
  const store = useStore();
  const [open, setOpen] = useState(startOpen ?? !compact);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heldStats = useRef(stats);
  heldStats.current = holdEditStats(
    heldStats.current,
    stats,
    edits.map((item) => item.path),
  );
  const shownStats = heldStats.current;
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const toggleOpen = () => {
    if (!compact) {
      setOpen((value) => !value);
      return;
    }
    if (open) {
      setOpen(false);
      setClosing(true);
      clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => setClosing(false), FOLD_MS);
      return;
    }
    clearTimeout(closeTimer.current);
    setClosing(false);
    setOpen(true);
  };
  if (compact && edits.length === 0) return null;
  const totalAdded = edits.reduce((sum, item) => sum + (statForPath(shownStats, item.path)?.added ?? 0), 0);
  const totalDeleted = edits.reduce((sum, item) => sum + (statForPath(shownStats, item.path)?.deleted ?? 0), 0);
  const showTotalStat = showLineStats && (totalAdded > 0 || totalDeleted > 0);
  const summary = (
    <>
      {edits.length === 0 ? "None yet" : `${edits.length} file${edits.length === 1 ? "" : "s"}`}
      {showTotalStat ? (
        <>
          {"  ·  "}
          <DiffStat added={totalAdded} deleted={totalDeleted} />
        </>
      ) : null}
    </>
  );

  return (
    <div className={`link-block edited-block${compact ? " compact" : ""}${compact && open ? " open" : ""}${compact && closing ? " closing" : ""}`}>
      {compact ? (
        <div className="edited-bar">
          <button
            className="edited-toggle"
            type="button"
            aria-expanded={open}
            onClick={toggleOpen}
          >
            <span className="section-label" style={{ margin: 0 }}>
              {label}
            </span>
            <span className="row-meta">{summary}</span>
          </button>
        </div>
      ) : (
        <div className="link-head">
          <span className="section-label" style={{ margin: 0 }}>
            {label}
          </span>
          <span className="row-meta">{summary}</span>
        </div>
      )}
      {edits.length === 0 && empty ? <p className="row-meta">{empty}</p> : null}
      {edits.length > 0 ? (
        <div className="edited-files-slot" aria-hidden={compact && !open && !closing}>
          <ul className="file-list">
          {edits.map((item) => {
            const line = statForPath(shownStats, item.path);
            const added = line?.added;
            const deleted = line?.deleted;
            const showRowStat = showLineStats && added != null && deleted != null && (added > 0 || deleted > 0);
            const kindLabel = item.kind === "created" ? "Created" : "Edited";
            const count = `${item.edits} ${unit}${item.edits === 1 || unit === "new" ? "" : "s"}`;
            const ink = deskInk(item, store.settings);
            const who = deskLabel(item, store.settings);
            return (
              <li key={editPathKey(item.path)} className={onDismiss ? "file-item" : undefined}>
                <button
                  className="file-row"
                  type="button"
                  onClick={() => onOpen(item)}
                  aria-label={
                    showRowStat
                      ? `${item.name}, ${kindLabel}, ${formatDiffStat(added ?? 0, deleted ?? 0)}`
                      : `${item.name}, ${kindLabel}`
                  }
                >
                  <span>
                    <strong>{item.name}</strong>
                    <span className="row-meta">
                      {compact ? (
                        <>
                          <span className="file-kind">{kindLabel}</span>
                          {item.folder ? `  ·  ${item.folder}` : ""}
                        </>
                      ) : (
                        <>
                          {item.folder ? `${item.folder}  ·  ` : ""}
                          {count}
                        </>
                      )}
                    </span>
                  </span>
                  <span className="file-meta">
                    {showRowStat ? <DiffStat added={added ?? 0} deleted={deleted ?? 0} /> : null}
                    <span className="file-when">
                      <i
                        className={`dot ${item.provider}`}
                        style={ink ? { background: ink, color: ink } : undefined}
                      />
                      {who}
                      <span aria-hidden="true">·</span>
                      {formatEditWhen(item.at)}
                    </span>
                  </span>
                </button>
                {onDismiss ? (
                  <button
                    className="file-close-x"
                    type="button"
                    onClick={() => onDismiss(item)}
                    aria-label={`Dismiss ${item.name}`}
                  >
                    ×
                  </button>
                ) : null}
              </li>
            );
          })}
          </ul>
        </div>
      ) : null}
    </div>
  );
});

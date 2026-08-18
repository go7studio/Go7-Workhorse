import { memo, useEffect, useRef, useState } from "react";
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

const FOLD_MS = 200;

function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function cardOpenWidth(el: HTMLElement) {
  const host = el.offsetParent instanceof HTMLElement ? el.offsetParent : el.parentElement;
  const cap = host ? host.clientWidth - 44 : 420;
  return Math.min(420, Math.max(0, cap));
}

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
  const [boxWidth, setBoxWidth] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const pillWidth = useRef(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heldStats = useRef(stats);
  heldStats.current = holdEditStats(
    heldStats.current,
    stats,
    edits.map((item) => item.path),
  );
  const shownStats = heldStats.current;
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!compact || open || closing) return;
    const width = boxRef.current?.offsetWidth ?? 0;
    if (width) pillWidth.current = width;
  });
  const toggleOpen = () => {
    if (!compact) {
      setOpen((value) => !value);
      return;
    }
    const el = boxRef.current;
    const ms = prefersReducedMotion() ? 0 : FOLD_MS;
    clearTimeout(closeTimer.current);
    if (open) {
      const from = el?.offsetWidth ?? 420;
      const to = pillWidth.current || from;
      setBoxWidth(from);
      setOpen(false);
      setClosing(true);
      const shrink = () => setBoxWidth(to);
      if (ms === 0) shrink();
      else requestAnimationFrame(() => requestAnimationFrame(shrink));
      closeTimer.current = setTimeout(() => {
        setClosing(false);
        setBoxWidth(null);
      }, ms);
      return;
    }
    if (el && !pillWidth.current) pillWidth.current = el.offsetWidth;
    const from = el?.offsetWidth ?? pillWidth.current;
    const to = el ? cardOpenWidth(el) : 420;
    setClosing(false);
    setBoxWidth(from);
    setOpen(true);
    const grow = () => setBoxWidth(to);
    if (ms === 0) grow();
    else requestAnimationFrame(() => requestAnimationFrame(grow));
    closeTimer.current = setTimeout(() => setBoxWidth(null), ms);
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
    <div
      ref={boxRef}
      className={`link-block edited-block${compact ? " compact" : ""}${compact && open ? " open" : ""}${compact && closing ? " closing" : ""}`}
      style={compact && boxWidth != null ? { width: boxWidth } : undefined}
    >
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

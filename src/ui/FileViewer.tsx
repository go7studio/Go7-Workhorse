import { startTransition, useEffect, useRef, useState } from "react";
import { buildFileDiff, type FileDiff } from "../lib/file-diff";
import { editSearchRoots, sameEditPath, type ProjectEdit } from "../lib/project-edits";
import { DiffStat } from "./DiffStat";

export function FileViewer({
  file,
  roots,
  onClose,
  docked = false,
}: {
  file: ProjectEdit;
  roots: string[];
  onClose: () => void;
  docked?: boolean;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [missing, setMissing] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const [directory, setDirectory] = useState(false);
  const [paintedRows, setPaintedRows] = useState(400);
  const shownPath = useRef(file.path);
  const rootKey = roots.join("\n");
  const created = file.kind === "created";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const requestPath = file.path;
    const pathChanged = !sameEditPath(shownPath.current, requestPath);
    shownPath.current = requestPath;
    if (pathChanged) {
      setDiff(null);
      setMissing(false);
      setUnreadable(false);
      setDirectory(false);
    }
    const searchRoots = editSearchRoots(rootKey ? rootKey.split("\n") : [], file.folder);
    const stillThisFile = () => sameEditPath(shownPath.current, requestPath);
    if (window.workhorse?.fileDiff) {
      void window.workhorse
        .fileDiff(requestPath, searchRoots, created)
        .then((next) => {
          if (!stillThisFile()) return;
          const resolved = next ?? buildFileDiff(requestPath, "", "");
          setDiff(resolved);
          setDirectory(Boolean(resolved.directory));
          setMissing(!resolved.directory && !resolved.after && !resolved.before);
        })
        .catch(() => {
          if (!stillThisFile()) return;
          setDiff(buildFileDiff(requestPath, "", ""));
          setMissing(true);
        });
      return;
    }
    if (!window.workhorse?.readSourceFile) {
      setDiff(buildFileDiff(requestPath, "", ""));
      setMissing(true);
      return;
    }
    void window.workhorse
      .readSourceFile(requestPath, searchRoots)
      .then((source) => {
        if (!stillThisFile()) return;
        if (source?.directory) {
          setDiff(buildFileDiff(source.path || requestPath, "", ""));
          setDirectory(true);
          return;
        }
        if (!source || source.missing) {
          setDiff(buildFileDiff(requestPath, "", ""));
          setMissing(true);
          return;
        }
        if (source.unreadable) {
          setDiff(buildFileDiff(source.path || requestPath, "", ""));
          setUnreadable(true);
          return;
        }
        setDiff(buildFileDiff(source.path || requestPath, created ? "" : source.text, source.text));
      })
      .catch(() => {
        if (!stillThisFile()) return;
        setDiff(buildFileDiff(requestPath, "", ""));
        setMissing(true);
      });
  }, [file.path, file.name, file.folder, file.edits, file.at, created, rootKey]);

  const rows = diff?.lines ?? [];
  useEffect(() => {
    setPaintedRows(Math.min(400, rows.length));
    if (rows.length <= 400) return;
    let cancelled = false;
    let frame = 0;
    let current = 400;
    const paintMore = () => {
      if (cancelled) return;
      current = Math.min(rows.length, current + 800);
      startTransition(() => setPaintedRows(current));
      if (current < rows.length) frame = requestAnimationFrame(paintMore);
    };
    frame = requestAnimationFrame(paintMore);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [diff]);
  const shownFilePath = diff?.path || file.path;
  const shownName = diff?.name || file.name;
  const viewOnly = !file.kind && file.edits < 1;
  const showDiffStat = Boolean(!viewOnly && diff && (diff.added > 0 || diff.deleted > 0));

  return (
    <section className={docked ? "file-viewer docked" : "file-review file-viewer"}>
      <header className="file-review-tabs">
        <div className="file-review-meta">
          <strong>{shownName}</strong>
          <span className="path">{shownFilePath}</span>
          {showDiffStat && diff ? <DiffStat added={diff.added} deleted={diff.deleted} /> : null}
        </div>
        <button className="file-close-x" type="button" aria-label="Close file" onClick={onClose} />
      </header>
      <div className="file-review-body">
        <div className="file-review-main">
          <pre className="file-review-code source">
            {!diff ? <span className="row-meta">Reading file…</span> : null}
            {directory ? <span className="row-meta">Folder.</span> : null}
            {missing ? <span className="row-meta">File not found.</span> : null}
            {unreadable ? <span className="row-meta">Can't display this file.</span> : null}
            {rows.slice(0, paintedRows).map((line, index) => (
              <span key={index} className={`diff-line ${line.kind}`}>
                <i>{line.kind === "del" ? (line.oldNo ?? "") : (line.newNo ?? index + 1)}</i>
                <em>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</em>
                {line.text || " "}
              </span>
            ))}
          </pre>
        </div>
      </div>
    </section>
  );
}

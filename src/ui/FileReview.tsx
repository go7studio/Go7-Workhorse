import { useEffect, useMemo, useRef, useState } from "react";
import type { FileDiff } from "../lib/file-diff";
import { buildFileDiff, formatDiffStat } from "../lib/file-diff";
import { editPathKey, mergeEdits, sameEditPath, type ProjectEdit } from "../lib/project-edits";

export function FileReview({
  file,
  files,
  stats,
  roots,
  onOpen,
  onClose,
  onTracked,
  preferSource = false,
  overlay = false,
}: {
  file: ProjectEdit;
  files: ProjectEdit[];
  stats: Record<string, { added: number; deleted: number }>;
  roots: string[];
  onOpen: (file: ProjectEdit) => void;
  onClose: () => void;
  onTracked?: (file: ProjectEdit) => void;
  preferSource?: boolean;
  overlay?: boolean;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [mode, setMode] = useState<"diff" | "source">(preferSource ? "source" : "diff");
  const [filter, setFilter] = useState("");
  const [tabs, setTabs] = useState<ProjectEdit[]>([file]);
  const rootKey = roots.join("\n");
  const shownPath = useRef(file.path);
  const fileRef = useRef(file);
  fileRef.current = file;
  const onTrackedRef = useRef(onTracked);
  onTrackedRef.current = onTracked;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    setTabs((current) =>
      current.some((item) => sameEditPath(item.path, file.path)) ? current : [...current, file],
    );
    if (preferSource) setMode("source");
  }, [file.path, file.name, preferSource]);

  useEffect(() => {
    const requestPath = file.path;
    if (!sameEditPath(shownPath.current, requestPath)) {
      setDiff(null);
    }
    shownPath.current = requestPath;
    const apply = (next: FileDiff | null) => {
      if (!sameEditPath(shownPath.current, requestPath)) return;
      const resolved = next ?? buildFileDiff(requestPath, "", "");
      setDiff(resolved);
      if (next && (next.added > 0 || next.deleted > 0)) {
        const current = fileRef.current;
        onTrackedRef.current?.({
          ...current,
          path: next.path || requestPath,
          name: next.name || current.name,
          edits: Math.max(1, current.edits),
        });
      }
    };
    const searchRoots = rootKey ? rootKey.split("\n") : [];
    if (!window.workhorse?.fileDiff) {
      apply(null);
      return;
    }
    void window.workhorse
      .fileDiff(requestPath, searchRoots)
      .then((next) => apply(next))
      .catch(() => apply(null));
  }, [file.path, rootKey]);

  const openFile = (next: ProjectEdit) => {
    setTabs((current) =>
      current.some((item) => sameEditPath(item.path, next.path)) ? current : [...current, next],
    );
    if (!sameEditPath(file.path, next.path)) onOpen(next);
  };

  const closeTab = (path: string) => {
    const next = tabs.filter((item) => !sameEditPath(item.path, path));
    if (next.length === 0) {
      onClose();
      return;
    }
    setTabs(next);
    if (sameEditPath(file.path, path)) onOpen(next[next.length - 1] ?? next[0]!);
  };

  const added = diff?.added ?? stats[file.path]?.added ?? 0;
  const deleted = diff?.deleted ?? stats[file.path]?.deleted ?? 0;
  const listed = useMemo(() => {
    const unique = mergeEdits(files, []);
    const q = filter.trim().toLowerCase();
    if (!q) return unique;
    return unique.filter((item) => item.name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q));
  }, [files, filter]);

  const rows =
    mode === "source"
      ? (diff?.lines ?? []).filter((line) => line.kind !== "del")
      : (diff?.lines ?? []);

  return (
    <section className={`file-review${overlay ? " overlay" : ""}`}>
      <header className="file-review-tabs">
        <div className="file-review-tab-row" role="tablist" aria-label="Open files">
          {tabs.map((tab) => (
            <button
              key={editPathKey(tab.path)}
              className={`file-review-tab${sameEditPath(tab.path, file.path) ? " on" : ""}`}
              type="button"
              role="tab"
              aria-selected={sameEditPath(tab.path, file.path)}
              onClick={() => openFile(tab)}
            >
              <span>{tab.name}</span>
              <span
                className="file-review-tab-x"
                aria-label={`Close ${tab.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.path);
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <div className="file-review-modes">
          <button className={mode === "source" ? "tiny on" : "tiny"} type="button" onClick={() => setMode("source")}>
            Source
          </button>
          <button className={mode === "diff" ? "tiny on" : "tiny"} type="button" onClick={() => setMode("diff")}>
            Diff
          </button>
          <button className="tiny file-review-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </header>
      <div className="file-review-body">
        <div className="file-review-main">
          <div className="file-review-meta">
            <strong>{file.name}</strong>
            <span className="path">{diff?.path ?? file.path}</span>
            <span className="file-diff-stat" aria-label={formatDiffStat(added, deleted)}>
              <span className="diff-add">+{added}</span>
              <span className="diff-del">−{deleted}</span>
            </span>
          </div>
          <pre className={`file-review-code ${mode}`}>
            {!diff && <span className="row-meta">Reading file…</span>}
            {diff && !diff.after && !diff.before ? (
              <span className="row-meta">Couldn’t find this file on disk. Check the path or link the project folder.</span>
            ) : null}
            {rows.map((line, index) => (
              <span key={`${mode}-${index}`} className={`diff-line ${line.kind}`}>
                <i>{mode === "source" ? line.newNo ?? "" : line.kind === "del" ? line.oldNo ?? "" : line.newNo ?? ""}</i>
                <em>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</em>
                {line.text || " "}
              </span>
            ))}
          </pre>
        </div>
        <aside className="file-review-rail">
          <input
            className="file-review-filter"
            value={filter}
            placeholder="Filter files…"
            onChange={(event) => setFilter(event.target.value)}
          />
          <ul className="file-review-list">
            {listed.map((item) => {
              const plus = stats[item.path]?.added ?? 0;
              const minus = stats[item.path]?.deleted ?? 0;
              return (
                <li key={editPathKey(item.path)}>
                  <button
                    className={sameEditPath(item.path, file.path) ? "on" : undefined}
                    type="button"
                    onClick={() => openFile(item)}
                  >
                    <strong>{item.name}</strong>
                    <span className="file-diff-stat">
                      <span className="diff-add">+{plus}</span>
                      <span className="diff-del">−{minus}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
    </section>
  );
}

import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { commandNeedsInput, commandsForSession, filterPalette, shortModeLabel } from "../lib/commands";
import {
  collectDroppedFiles,
  dataTransferLooksLikeFiles,
  droppedFromDiskPaths,
  droppedFromPickerFile,
  filesFromClipboard,
  folderNameFromPath,
  groupAttachments,
  imageSrc,
  isPicture,
  attachmentLabel,
  MAX_IMAGES,
  readChatAttachment,
  type DroppedFile,
} from "../lib/images";
import { wrapMarkdown } from "../lib/markdown";
import { effortLabel, modelName } from "../lib/models";
import { deskInk } from "../lib/settings";
import { useStoreSelector } from "../lib/store";
import { sameComposerDesk, selectComposerDesk } from "../lib/store-select";
import type { ChatImage, CrewMode } from "../lib/types";
import { crewModeLabel, hasCrewMode, orderedCrewModes, toggleCrewMode } from "../lib/workhorse-rules";

export function isEditableKeyTarget(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  if (el.closest("textarea, select, [contenteditable='true'], [data-keep-keys], .terminal-pane")) return true;
  const input = el instanceof HTMLInputElement ? el : el.closest("input");
  if (!input) return false;
  const type = input.type;
  return !["button", "submit", "checkbox", "radio", "file", "reset", "range", "color", "hidden"].includes(type);
}

export function isComposerTypeToFocus(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}): boolean {
  if (event.isComposing || event.key === "Dead") return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key === " ") return true;
  return event.key.length === 1;
}

/** Half the session pane; empty or unknown height stays one line. */
export function composerMaxHeightPx(paneHeight: number): number {
  if (!Number.isFinite(paneHeight) || paneHeight <= 0) return 24;
  return Math.max(24, Math.round(paneHeight * 0.5));
}

/** Distance from the session column bottom to the top of the composer dock (queue, thumbs, field). */
export function pinComposerInput(col: { getBoundingClientRect: () => { bottom: number }; style: { setProperty: (name: string, value: string) => void } }, dock: { getBoundingClientRect: () => { top: number } }): number {
  const bottom = Math.max(0, Math.round(col.getBoundingClientRect().bottom - dock.getBoundingClientRect().top));
  col.style.setProperty("--composer-input", `${bottom}px`);
  return bottom;
}

export function fitComposerField(el: HTMLTextAreaElement, value: string, paneHeight?: number): void {
  if (!value) {
    el.style.height = "";
    return;
  }
  const pane = paneHeight ?? (el.closest(".session-col") as HTMLElement | null)?.clientHeight ?? 0;
  const cap = composerMaxHeightPx(pane);
  el.style.height = "0px";
  el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
}

function CrewModeIcon({ mode, size = 12 }: { mode: CrewMode; size?: number }) {
  if (mode === "mission") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <path d="M4.2 2.4v11.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M4.2 3.1h7.4L9.4 6.4l2.2 3.3H4.2z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="3.4" r="1.7" fill="currentColor" />
      <circle cx="3.4" cy="12.6" r="1.7" fill="currentColor" />
      <circle cx="12.6" cy="12.6" r="1.7" fill="currentColor" />
      <path
        d="M8 5.2v2.1M8 7.3 4.4 11.1M8 7.3l3.6 3.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export const Composer = memo(function Composer({
  setupOpen,
  onToggleSetup,
  dropRoot,
}: {
  setupOpen?: boolean;
  onToggleSetup?: () => void;
  dropRoot?: RefObject<HTMLElement | null>;
}) {
  const {
    session,
    send,
    cancelRun,
    dropQueued,
    steerQueued,
    watchRestore,
    clearWatchRestore,
    settings,
    setComposerDraft,
    setCrewMode,
    deskSkills,
  } = useStoreSelector(selectComposerDesk, sameComposerDesk);
  const ink = session ? deskInk(session, settings) : undefined;
  const running = session?.status === "running";
  const queue = session?.queue ?? [];
  const [value, setValue] = useState(() => session?.composerDraft ?? "");
  const [images, setImages] = useState<ChatImage[]>(() => session?.composerImages ?? []);
  const [over, setOver] = useState(false);
  const [active, setActive] = useState(0);
  const [plusOpen, setPlusOpen] = useState(false);
  const [crewOpen, setCrewOpen] = useState(false);
  const [crewWidth, setCrewWidth] = useState(0);
  const [shownCrew, setShownCrew] = useState<CrewMode[]>([]);
  const field = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const crewInner = useRef<HTMLDivElement>(null);
  const sessionId = session?.id;
  const valueRef = useRef(value);
  const imagesRef = useRef(images);
  valueRef.current = value;
  imagesRef.current = images;

  const extras = useMemo(() => commandsForSession(session, deskSkills), [deskSkills, session]);
  const crewModes = orderedCrewModes(session?.crewModes);

  useEffect(() => {
    setCrewOpen(false);
    setCrewWidth(0);
    setShownCrew([]);
  }, [sessionId]);

  useEffect(() => {
    if (crewModes.length < 2) setCrewOpen(false);
  }, [crewModes.length]);

  useEffect(() => {
    if (crewModes.length > 0) setShownCrew(crewModes);
  }, [crewModes]);

  useEffect(() => {
    const el = crewInner.current;
    const next = crewModes.length === 0 ? 0 : el ? Math.ceil(el.scrollWidth) : 0;
    const frame = window.requestAnimationFrame(() => setCrewWidth(next));
    return () => window.cancelAnimationFrame(frame);
  }, [crewModes, crewOpen, shownCrew]);
  const displayCrew = crewModes.length > 0 ? crewModes : shownCrew;
  const crewStacked = displayCrew.length >= 2 && !crewOpen;
  const crewLeaving = crewModes.length === 0 && displayCrew.length > 0;
  const open = value.startsWith("/") && images.length === 0;
  const matches = useMemo(() => (open ? filterPalette(value, extras) : []), [extras, open, value]);
  const canSend = Boolean(value.trim() || images.length);

  useEffect(() => {
    setActive(0);
  }, [value]);

  useEffect(() => {
    const dock = wrap.current;
    const col = dock?.closest(".session-col");
    const stack = dock?.querySelector(".composer-dock") ?? dock;
    if (!(col instanceof HTMLElement) || !(stack instanceof HTMLElement)) return;
    const pin = () => pinComposerInput(col, stack);
    pin();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(pin);
    observer.observe(stack);
    observer.observe(col);
    return () => observer.disconnect();
  }, [sessionId]);

  useEffect(() => {
    if (!watchRestore) return;
    setValue(watchRestore.text);
    setImages(watchRestore.images ?? []);
    clearWatchRestore();
  }, [watchRestore, clearWatchRestore]);

  useEffect(() => {
    if (!sessionId) return;
    const timer = window.setTimeout(() => {
      setComposerDraft(sessionId, value, images);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [sessionId, value, images, setComposerDraft]);

  useEffect(() => {
    return () => {
      if (sessionId) setComposerDraft(sessionId, valueRef.current, imagesRef.current, true);
    };
  }, [sessionId, setComposerDraft]);

  useEffect(() => {
    if (!sessionId) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isComposerTypeToFocus(event) || event.defaultPrevented) return;
      if (isEditableKeyTarget(event.target)) return;
      const el = field.current;
      if (!el || event.target === el) return;
      event.preventDefault();
      const next = `${valueRef.current}${event.key}`;
      setValue(next);
      el.focus();
      const place = () => el.setSelectionRange(next.length, next.length);
      queueMicrotask(place);
      requestAnimationFrame(place);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [sessionId]);

  useEffect(() => {
    document.querySelector(".palette button.active")?.scrollIntoView({ block: "nearest" });
  }, [active, matches]);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    fitComposerField(el, value);
    const pane = el.closest(".session-col");
    if (!(pane instanceof HTMLElement) || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitComposerField(el, valueRef.current));
    observer.observe(pane);
    return () => observer.disconnect();
  }, [value]);

  const addFiles = async (files: Array<File | DroppedFile>) => {
    if (files.length === 0) return;
    const next: ChatImage[] = [];
    for (const item of files) {
      const dropped = item instanceof File
        ? droppedFromPickerFile(item, window.workhorse?.pathForFile(item) || undefined)
        : item;
      const image = dropped.attachment ?? (dropped.file ? await readChatAttachment(dropped.file, dropped.sourcePath) : null);
      if (image) next.push(dropped.folder ? { ...image, folder: dropped.folder } : image);
    }
    if (next.length === 0) return;
    setImages((current) => [...current, ...next].slice(0, MAX_IMAGES));
  };

  const pickCrewMode = (mode: CrewMode) => {
    if (!sessionId) return;
    setCrewMode(toggleCrewMode(session?.crewModes, mode));
  };

  const attachFromMenu = async () => {
    setPlusOpen(false);
    const pick = window.workhorse?.pickAttach;
    if (pick) {
      const paths = await pick();
      if (paths.length === 0) return;
      const dropped = await droppedFromDiskPaths(paths);
      if (dropped.length > 0) void addFiles(dropped);
      return;
    }
    filePicker.current?.click();
  };

  useEffect(() => {
    setPlusOpen(false);
  }, [sessionId]);

  useEffect(() => {
    if (!plusOpen) return;
    const onDown = (event: PointerEvent) => {
      const dock = wrap.current;
      if (!(event.target instanceof Node) || !dock) {
        setPlusOpen(false);
        return;
      }
      const attach = dock.querySelector(".composer-attach");
      const menu = dock.querySelector(".composer-plus-menu");
      if (attach?.contains(event.target) || menu?.contains(event.target)) return;
      setPlusOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [plusOpen]);

  useEffect(() => {
    const root = dropRoot?.current ?? wrap.current;
    if (!root) return;
    const hover = (on: boolean) => {
      setOver(on);
      root.classList.toggle("drop-over", on);
    };
    const onDragOver = (event: DragEvent) => {
      if (!dataTransferLooksLikeFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      hover(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return;
      hover(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!dataTransferLooksLikeFiles(event.dataTransfer)) return;
      event.preventDefault();
      hover(false);
      void collectDroppedFiles(event.dataTransfer).then((files) => addFiles(files));
    };
    root.addEventListener("dragover", onDragOver);
    root.addEventListener("dragleave", onDragLeave);
    root.addEventListener("drop", onDrop);
    return () => {
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("dragleave", onDragLeave);
      root.removeEventListener("drop", onDrop);
    };
  }, [dropRoot]);

  const submit = (text = value, mode?: "queue" | "steer") => {
    if (open && matches[active]) {
      pick(matches[active]);
      return;
    }
    if (!text.trim() && images.length === 0) return;
    send(text, { images, steer: running && mode === "steer" });
    setValue("");
    setImages([]);
    if (sessionId) setComposerDraft(sessionId, "", [], true);
  };

  const pick = (command: typeof matches[number]) => {
    if (commandNeedsInput(command, value.startsWith(command.name) ? value : command.name)) {
      setValue(`${command.name} `);
      requestAnimationFrame(() => {
        const el = field.current;
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
      });
      return;
    }
    send(value.startsWith(`${command.name} `) || value === command.name ? value : command.name);
    setValue("");
    setImages([]);
    if (sessionId) setComposerDraft(sessionId, "", [], true);
  };

  const applyMark = (mark: string) => {
    const el = field.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = wrapMarkdown(value, start, end, mark);
    setValue(next.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.start, next.end);
    });
  };

  return (
    <div className={`composer-wrap${over ? " drop-over" : ""}`} ref={wrap}>
      <div className="composer-dock">
        {open && matches.length > 0 && (
          <div className="palette" role="listbox">
            {matches.map((command, index) => (
              <button
                key={command.id}
                className={index === active ? "active" : undefined}
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(command)}
              >
                <code>{command.name}</code>
                <em>{command.hint}</em>
              </button>
            ))}
          </div>
        )}
        {queue.filter((item) => item.hideUser !== true).length > 0 && (
          <ul className="prompt-queue">
            {queue.filter((item) => item.hideUser !== true).map((item, index) => (
              <li key={item.id} className="prompt-queue-item">
                <span className="prompt-queue-when">{index === 0 ? "Next" : `Then ${index + 1}`}</span>
                <span className="prompt-queue-text">{item.text.trim() || "(image)"}</span>
                {running ? (
                  <button type="button" className="prompt-queue-steer" onClick={() => steerQueued(item.id)}>
                    Steer
                  </button>
                ) : null}
                <button type="button" aria-label="Remove queued prompt" onClick={() => dropQueued(item.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {images.length > 0 && (
          <ul className="composer-thumbs">
            {groupAttachments(images).map((group) => {
              if (group.type === "folder") {
                return (
                  <li key={`folder:${group.name}`} className="composer-thumb file folder">
                    <span className="composer-file" title={`${group.name} · ${group.files.length} files`}>
                      {group.name}
                      <em>
                        {group.files.length} file{group.files.length === 1 ? "" : "s"}
                      </em>
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${group.name}`}
                      onClick={() =>
                        setImages((current) =>
                          current.filter((item) => (item.folder || folderNameFromPath(item.name)) !== group.name),
                        )
                      }
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                        <path
                          d="M3 3l6 6M9 3 3 9"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  </li>
                );
              }
              const image = group.file;
              return (
                <li key={image.id} className={`composer-thumb${isPicture(image) ? "" : " file"}`}>
                  {isPicture(image) ? (
                    <img src={imageSrc(image)} alt={image.name} />
                  ) : (
                    <span className="composer-file" title={image.name}>
                      {image.name}
                      <em>{attachmentLabel(image)}</em>
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${image.name}`}
                    onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d="M3 3l6 6M9 3 3 9"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
        <textarea
          ref={field}
          data-composer-field="true"
          rows={1}
          value={value}
          placeholder={
            over
              ? "Drop files or folders"
              : running
                ? "Queue for next, or Steer to redirect"
                : "Message, drop a file or folder, or type /"
          }
          onPaste={(event) => {
            const files = filesFromClipboard(event.clipboardData);
            if (files.length === 0) return;
            event.preventDefault();
            void addFiles(files);
          }}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setActive((index) => (index + delta + matches.length) % Math.max(matches.length, 1));
            }
            if ((event.metaKey || event.ctrlKey) && !event.altKey) {
              if (event.key === "b") {
                event.preventDefault();
                applyMark("**");
                return;
              }
              if (event.key === "i") {
                event.preventDefault();
                applyMark("*");
                return;
              }
              if (event.key === "e") {
                event.preventDefault();
                applyMark("`");
                return;
              }
            }
            if (event.key === "Tab" && open && matches[active]) {
              event.preventDefault();
              pick(matches[active]);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit(value, running && (event.altKey || event.metaKey) ? "steer" : "queue");
            }
            if (event.key === "Escape") {
              if (plusOpen) {
                event.preventDefault();
                setPlusOpen(false);
                return;
              }
              setValue("");
              setImages([]);
              if (sessionId) setComposerDraft(sessionId, "", [], true);
            }
          }}
        />
        <input
          ref={filePicker}
          className="composer-file-input"
          type="file"
          multiple
          accept="image/*,.txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.rtf,.odt,audio/*,video/*"
          onChange={(event) => {
            void addFiles([...event.target.files ?? []]);
            event.target.value = "";
          }}
        />
        {plusOpen && (
          <div className="composer-plus-menu" role="menu">
            <button
              type="button"
              className="plus-row orchestrate"
              role="menuitemcheckbox"
              aria-checked={hasCrewMode(session?.crewModes, "orchestrate")}
              onClick={() => pickCrewMode("orchestrate")}
            >
              <span className="plus-icon orchestrate" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="3.4" r="1.7" fill="currentColor" />
                  <circle cx="3.4" cy="12.6" r="1.7" fill="currentColor" />
                  <circle cx="12.6" cy="12.6" r="1.7" fill="currentColor" />
                  <path
                    d="M8 5.2v2.1M8 7.3 4.4 11.1M8 7.3l3.6 3.8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <span className="plus-copy">
                <strong>Orchestrate</strong>
                <em>This chat spawns workers</em>
              </span>
            </button>
            <button
              type="button"
              className="plus-row mission"
              role="menuitemcheckbox"
              aria-checked={hasCrewMode(session?.crewModes, "mission")}
              onClick={() => pickCrewMode("mission")}
            >
              <span className="plus-icon mission" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M4.2 2.4v11.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  <path d="M4.2 3.1h7.4L9.4 6.4l2.2 3.3H4.2z" fill="currentColor" />
                </svg>
              </span>
              <span className="plus-copy">
                <strong>Mission</strong>
                <em>Adaptive waves until done</em>
              </span>
            </button>
            <hr />
            <button type="button" className="plus-row attach" role="menuitem" onClick={() => void attachFromMenu()}>
              <span className="plus-icon attach" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M5.6 7.4 9.1 3.9a2.4 2.4 0 1 1 3.4 3.4l-4.8 4.8a3.2 3.2 0 0 1-4.5-4.5l4.4-4.4"
                    stroke="currentColor"
                    strokeWidth="1.55"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="plus-copy">
                <strong>Attach</strong>
                <em>Files or folders</em>
              </span>
            </button>
          </div>
        )}
        <div className="composer-tools">
        <button
          className={`composer-attach${plusOpen ? " on" : ""}`}
          type="button"
          aria-label="Attach or choose a mode"
          aria-haspopup="menu"
          aria-expanded={plusOpen}
          title="Attach or choose a mode"
          onClick={() => setPlusOpen((open) => !open)}
        >
          +
        </button>
        {displayCrew.length > 0 || crewWidth > 0 ? (
          <div
            className={`composer-crew${crewLeaving ? " leaving" : ""}`}
            style={{ width: crewWidth }}
            onTransitionEnd={(event) => {
              if (event.propertyName !== "width") return;
              if (crewModes.length === 0) {
                setShownCrew([]);
                setCrewWidth(0);
              }
            }}
          >
            <div className="composer-crew-inner" ref={crewInner}>
              {crewStacked ? (
                <button
                  type="button"
                  className="composer-crew-chip more"
                  aria-label={`Show ${displayCrew.length} modes`}
                  title={displayCrew.map(crewModeLabel).join(", ")}
                  onClick={() => setCrewOpen(true)}
                >
                  <span className="crew-more-stack" aria-hidden="true">
                    {displayCrew.map((mode) => (
                      <span key={mode} className={`plus-icon ${mode}`}>
                        <CrewModeIcon mode={mode} />
                      </span>
                    ))}
                  </span>
                  <span className="crew-more-count">+{displayCrew.length}</span>
                </button>
              ) : (
                displayCrew.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className="composer-crew-chip"
                    title={`Clear ${crewModeLabel(mode)}`}
                    onClick={() => setCrewMode(toggleCrewMode(session?.crewModes, mode))}
                  >
                    <span className={`plus-icon ${mode}`} aria-hidden="true">
                      <CrewModeIcon mode={mode} />
                    </span>
                    {crewModeLabel(mode)}
                    <span aria-hidden="true">×</span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}
        {onToggleSetup && session && (
          <button
            className={`setup-trigger${setupOpen ? " on" : ""}`}
            type="button"
            data-session-setup
            aria-expanded={setupOpen}
            onClick={onToggleSetup}
          >
            {/* On Auto omit the model name (it would promise next-turn
                vendor). Do show last/current thinking level when set. */}
            {session.routingMode === "auto" ? (
              <span className="dot auto" aria-hidden="true" />
            ) : (
              <span className={`dot ${session.provider}`} style={ink ? { background: ink } : undefined} />
            )}
            <span>
              {session.routingMode === "auto"
                ? `Auto${session.effort ? ` · ${effortLabel(session.effort)}` : ""} · ${shortModeLabel(session.mode)}`
                : `${modelName(session.provider, session.model)}${session.effort ? ` · ${effortLabel(session.effort)}` : ""} · ${shortModeLabel(session.mode)}`}
            </span>
            <span className="caret" aria-hidden="true" />
          </button>
        )}
        <span className="composer-tools-spacer" aria-hidden="true" />
        {running && canSend ? (
          <button
            className="send-steer"
            type="button"
            title="Steer this turn · Alt+Enter"
            onClick={() => submit(value, "steer")}
          >
            Steer
          </button>
        ) : null}
        {running && canSend ? (
          <button className="send" type="submit" aria-label="Queue for next turn" title="Queue for next turn">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 12.5V3.5M8 3.5 4.2 7.2M8 3.5l3.8 3.7"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
        {running ? (
          <button className="send stop" type="button" aria-label="Stop" title="Stop" onClick={() => cancelRun()}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="3.4" y="3.4" width="7.2" height="7.2" rx="1.4" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            className="send"
            type="submit"
            aria-label="Send"
            title="Send"
            disabled={!canSend}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 12.5V3.5M8 3.5 4.2 7.2M8 3.5l3.8 3.7"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        </div>
        </form>
      </div>
    </div>
  );
});

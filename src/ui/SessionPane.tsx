import { useEffect, useMemo, useRef, useState } from "react";
import { canPlaceInProject } from "../lib/chats";
import { primaryFolder } from "../lib/project";
import { editListKey, fileFolderFromPath, fileNameFromPath, holdEditStats, markStatsFetched, mergeEdits, projectEdits, sameEditPath, startEditStatsHarvest, type ProjectEdit } from "../lib/project-edits";
import { sessionExecutionCwd } from "../lib/session-environment";
import { peelPlanningPreamble, unsquashSentences } from "../lib/markdown";
import { brainCaption, brainStamp, messageBrain } from "../lib/session";
import { talkingToSummary } from "../lib/tool-labels";
import { displayWorkSteps, groupTranscript, isDeskNotice, lastReplyIndex } from "../lib/turns";
import { clampPaneWidth, FILE_PANE } from "../lib/pane";
import { useActiveSession, useStore } from "../lib/store";
import { Composer } from "./Composer";
import { GoalBar } from "./GoalBar";
import { WatchBanners } from "./WatchNotices";
import { ContextMeter } from "./ContextMeter";
import { EditedList } from "./EditedList";
import { FileOpenProvider } from "./FileOpen";
import { FileViewer } from "./FileViewer";
import { MessageBody } from "./MessageBody";
import { PlaceInProject } from "./PlaceInProject";
import { SessionSetup } from "./SessionSetup";
import { SplitHandle } from "./SplitHandle";
import { copyText } from "../lib/copy-text";
import { TurnActions } from "./TurnActions";
import { UserTurn } from "./UserTurn";
import { WorkPopout } from "./WorkPopout";
import { TerminalPane } from "./TerminalPane";

const SCROLL_SLACK = 96;

function pinnedToBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_SLACK;
}

export function SessionPane() {
  const session = useActiveSession();
  const store = useStore();
  const [setupOpen, setSetupOpen] = useState(false);
  const [open, setOpen] = useState<ProjectEdit | null>(null);
  const [fileOut, setFileOut] = useState(false);
  const [fileWidth, setFileWidth] = useState(() => FILE_PANE.fallback);
  const [extraEdits, setExtraEdits] = useState<ProjectEdit[]>([]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [hiddenByChat, setHiddenByChat] = useState<Record<string, string[]>>({});
  const [stats, setStats] = useState<Record<string, { added: number; deleted: number }>>({});
  const fetchedStats = useRef<Record<string, string>>({});
  const [heldEdits, setHeldEdits] = useState<ProjectEdit[]>([]);
  const [editsBarOpen, setEditsBarOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const pane = useRef<HTMLElement>(null);
  const editsBarExit = useRef<number | undefined>(undefined);
  const editsBarOpenRef = useRef(false);
  const heldEditsRef = useRef<ProjectEdit[]>([]);
  const working = session?.status === "running";
  const project = store.projects.find((item) => item.id === session?.projectId);
  const localCwd = project ? primaryFolder(project)?.path ?? "" : "";
  const cwd = session ? sessionExecutionCwd(session.environment, localCwd) : localCwd;
  const fallbackProject =
    project ?? store.projects.find((item) => item.id === store.activeProjectId) ?? store.projects[0];
  const folderKey = project?.folders.map((folder) => folder.path).join("\n") ?? "";
  const extraFolderKey =
    !project && fallbackProject ? fallbackProject.folders.map((folder) => folder.path).join("\n") : "";
  const roots = useMemo(() => [...new Set([cwd, ...(folderKey ? folderKey.split("\n") : [])].filter(Boolean))], [cwd, folderKey]);
  const fileRootKey = [cwd, folderKey, extraFolderKey].filter(Boolean).join("\n");
  const fileRoots = useMemo(
    () => [...new Set(fileRootKey ? fileRootKey.split("\n") : [])],
    [fileRootKey],
  );
  const edits = useMemo(() => {
    if (!session) return extraEdits;
    return mergeEdits(projectEdits([session], roots), extraEdits);
  }, [session?.id, session?.messages, roots, extraEdits]);
  const hiddenPaths = session ? hiddenByChat[session.id] : undefined;
  const visible = useMemo(
    () => edits.filter((item) => !(hiddenPaths ?? []).some((path) => sameEditPath(path, item.path))),
    [edits, hiddenPaths],
  );
  const displayEdits = visible.length > 0 ? visible : heldEdits;
  const editKey = editListKey(edits);
  const liveOpen = open
    ? (displayEdits.find((item) => sameEditPath(item.path, open.path)) ?? open)
    : null;
  editsBarOpenRef.current = editsBarOpen;
  heldEditsRef.current = heldEdits;

  useEffect(() => {
    setOpen(null);
    setFileOut(false);
    setExtraEdits([]);
    setTerminalOpen(false);
    setHeldEdits([]);
    setEditsBarOpen(false);
    setStats({});
    fetchedStats.current = {};
  }, [session?.id]);

  useEffect(() => {
    fetchedStats.current = {};
  }, [fileRootKey]);

  useEffect(() => {
    if (visible.length > 0) {
      if (editsBarExit.current) window.clearTimeout(editsBarExit.current);
      setHeldEdits(visible);
      if (editsBarOpenRef.current) return;
      const frame = requestAnimationFrame(() => setEditsBarOpen(true));
      return () => cancelAnimationFrame(frame);
    }
    const dismissed = edits.length > 0;
    if (!dismissed && heldEditsRef.current.length === 0) return;
    const hideAfter = dismissed ? 0 : 400;
    const start = window.setTimeout(() => {
      setEditsBarOpen(false);
      editsBarExit.current = window.setTimeout(() => setHeldEdits([]), 200);
    }, hideAfter);
    return () => {
      window.clearTimeout(start);
      window.clearTimeout(editsBarExit.current);
    };
  }, [visible, edits.length]);

  useEffect(() => {
    const api = window.workhorse;
    if (!api?.editStats || edits.length === 0) return;
    const paths = edits.map((item) => item.path);
    return startEditStatsHarvest({
      items: edits,
      getFetched: () => fetchedStats.current,
      rootKey: fileRootKey,
      roots: fileRoots,
      editStats: (files, folders, created) => api.editStats(files, folders, created),
      onChunk: (next, stale) => {
        fetchedStats.current = markStatsFetched(fetchedStats.current, stale, fileRootKey);
        setStats((previous) => holdEditStats(previous, next, paths));
      },
    });
  }, [editKey, fileRootKey, session?.id]);

  useEffect(() => {
    followBottom.current = true;
  }, [session?.id]);

  useEffect(() => {
    const el = scroller.current;
    if (el && followBottom.current) el.scrollTop = el.scrollHeight;
  }, [session?.messages, session?.status]);

  useEffect(() => {
    const thread = scroller.current;
    const wrap = pane.current?.querySelector(".composer-wrap");
    if (!thread || !(wrap instanceof HTMLElement) || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followBottom.current) thread.scrollTop = thread.scrollHeight;
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [session?.id]);

  if (!session) return null;
  const closeFilePane = () => {
    if (!open || fileOut) return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOpen(null);
      setFileOut(false);
      return;
    }
    setFileOut(true);
  };
  const dismissFile = (file: ProjectEdit) => {
    setHiddenByChat((current) => {
      const existing = current[session.id] ?? [];
      if (existing.some((path) => sameEditPath(path, file.path))) return current;
      return { ...current, [session.id]: [...existing, file.path] };
    });
    if (open && sameEditPath(open.path, file.path)) closeFilePane();
  };
  const openFile = (file: ProjectEdit) => {
    if (open && sameEditPath(open.path, file.path)) {
      closeFilePane();
      return;
    }
    setFileOut(false);
    setOpen(file);
  };
  const blocks = groupTranscript(session.messages);
  const liveIndex = working ? lastReplyIndex(blocks) : -1;
  const liveBlock = liveIndex >= 0 ? blocks[liveIndex] : undefined;
  const talking =
    liveBlock && liveBlock.type === "reply" ? talkingToSummary(liveBlock.tools) : "";

  return (
    <FileOpenProvider
      roots={fileRoots}
      provider={session.provider}
      nearby={session.messages.map((message) => message.text).join("\n")}
      onOpen={(file) => {
        const known = edits.find((item) => sameEditPath(item.path, file.path));
        const next = known ? { ...file, kind: file.kind ?? known.kind } : file;
        if (open && sameEditPath(open.path, next.path)) {
          closeFilePane();
          return;
        }
        setFileOut(false);
        setOpen(next);
      }}
    >
    <section
      className={`session${open ? " has-file" : ""}`}
      ref={pane}
      style={open ? { ["--file-pane" as string]: `${fileWidth}px` } : undefined}
    >
      <div className="session-col">
      <header className="session-header slim">
        <div className="session-status">
          {session.status === "needs-input" && <span className="live-pill wait">Needs you</span>}
          {talking ? <span className="peer-live">{talking}</span> : null}
        </div>
        <div className="session-header-tools">
          {project ? (
            <>
              <button
                className="tiny"
                type="button"
                disabled={!cwd}
                onClick={() => {
                  if (!cwd || !window.workhorse?.listGitChanges) return;
                  void window.workhorse.listGitChanges(cwd).then((changes) => {
                    const found = changes.map<ProjectEdit>((change) => ({
                      path: change.path,
                      name: fileNameFromPath(change.path),
                      folder: fileFolderFromPath(change.path, roots),
                      edits: 1,
                      at: Date.now(),
                      provider: session.provider,
                      customBotId: session.customBotId,
                    }));
                    setExtraEdits((current) => mergeEdits(current, found));
                    if (found[0]) {
                      setFileOut(false);
                      setOpen(found[0]);
                    }
                  });
                }}
              >
                Review
              </button>
              <button className={`tiny${terminalOpen ? " active-kind" : ""}`} type="button" disabled={!cwd} onClick={() => setTerminalOpen((value) => !value)}>
                Terminal
              </button>
            </>
          ) : null}
          <ContextMeter />
        </div>
      </header>
      <div
        className="transcript"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (el) followBottom.current = pinnedToBottom(el);
        }}
      >
        {blocks.map((block, index) => {
          if (block.type === "user") {
            return <UserTurn key={block.message.id} message={block.message} />;
          }
          if (block.type === "system") {
            if (isDeskNotice(block.message)) return null;
            return (
              <article key={block.message.id} className="turn system chat">
                <div className="say">
                  <MessageBody text={block.message.text} />
                </div>
              </article>
            );
          }
          const live = working && index === liveIndex;
          const assistantText = block.assistant.text ?? "";
          const peeled = peelPlanningPreamble(assistantText, live);
          const steps = displayWorkSteps(block, { live });
          const body = unsquashSentences(peeled.body);
          const who = brainCaption(
            messageBrain(block.assistant, brainStamp(session)),
            store.settings.customBots,
            store.settings.llms,
          );
          return (
            <article key={block.assistant.id} className={`turn assistant reply${live ? " live" : ""}`}>
              <div className="turn-who">
                <span
                  className={`dot ${who.provider}`}
                  style={who.color ? { background: who.color } : undefined}
                  aria-hidden="true"
                />
                {who.name}
              </div>
              <WorkPopout
                steps={steps}
                sessions={store.sessions}
                startedAt={block.assistant.createdAt}
                workedMs={block.assistant.workedMs}
                live={live}
                onOpenThread={store.selectSession}
              />
              {body ? (
                <div className={`say final${live ? " streaming" : ""}`}>
                  <MessageBody text={body} cwd={cwd} vendorSessionId={session.vendorSessionId} />
                  {!live ? (
                    <TurnActions
                      actions={[
                        { id: "copy", label: "Copy", run: () => copyText(body) },
                        { id: "fork", label: "Fork", run: () => store.forkFrom(block.assistant.id) },
                      ]}
                    />
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      <div className={`session-edits-slot${editsBarOpen ? " open" : ""}`}>
        <div className="session-edits">
          {displayEdits.length > 0 ? (
            <EditedList
              compact
              label="Changes"
              edits={displayEdits}
              stats={stats}
              onOpen={openFile}
              onDismiss={dismissFile}
            />
          ) : null}
        </div>
      </div>
      {canPlaceInProject(session) && <PlaceInProject session={session} />}
      {(session.scheduledRuns ?? []).some((run) => run.status === "pending" || run.status === "queued" || run.status === "running") ? (
        <div className="session-schedules" aria-label="Scheduled runs">
          <span className="section-label">Background</span>
          {(session.scheduledRuns ?? [])
            .filter((run) => run.status === "pending" || run.status === "queued" || run.status === "running")
            .map((run) => (
              <span key={run.id} title={run.prompt}>
                {run.status === "pending" ? new Date(run.dueAt).toLocaleString() : run.status} · {run.prompt}
              </span>
            ))}
        </div>
      ) : null}
      <GoalBar />
      <WatchBanners onSwitchModel={() => setSetupOpen(true)} setupOpen={setupOpen} />
      {setupOpen && <SessionSetup onClose={() => setSetupOpen(false)} />}
      <Composer
        key={session.id}
        dropRoot={pane}
        setupOpen={setupOpen}
        onToggleSetup={() => setSetupOpen((value) => !value)}
      />
      {project && terminalOpen && cwd ? <TerminalPane sessionId={session.id} cwd={cwd} onClose={() => setTerminalOpen(false)} /> : null}
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
          <FileViewer file={liveOpen ?? open} roots={fileRoots} onClose={closeFilePane} />
        </aside>
      ) : null}
    </section>
    </FileOpenProvider>
  );
}

import { memo, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { canPlaceInProject } from "../lib/chats";
import { primaryFolder } from "../lib/project";
import { editListKey, fileFolderFromPath, fileNameFromPath, holdEditStats, markStatsFetched, mergeEdits, projectEdits, projectWritesKey, sameEditPath, startEditStatsHarvest, type ProjectEdit } from "../lib/project-edits";
import { sessionExecutionCwd } from "../lib/session-environment";
import { peelPlanningPreamble, unsquashSentences } from "../lib/markdown";
import { brainCaption, messageBrain } from "../lib/session";
import { talkingToSummary } from "../lib/tool-labels";
import { LINEUP_FINISHED_NOTICE } from "../lib/lineup";
import {
  createTranscriptGrouper,
  isDeskNotice,
  lastReplyIndex,
  recentTranscriptText,
  scheduleAfterPaint,
  startTranscriptFill,
  TRANSCRIPT_FILL_MS,
  transcriptPaintStart,
  type TranscriptBlock,
} from "../lib/turns";
import { clampPaneWidth, FILE_PANE } from "../lib/pane";
import { useActiveSession, useStore } from "../lib/store";
import { Composer } from "./Composer";
import { GoalBar } from "./GoalBar";
import { WatchBanners } from "./WatchNotices";
import { ContextMeter } from "./ContextMeter";
import { EditedList } from "./EditedList";
import { FileOpenProvider } from "./FileOpen";
import { FileViewer } from "./FileViewer";
import { MediaPaintProvider } from "./MediaPaint";
import { MessageBody } from "./MessageBody";
import { PlaceInProject } from "./PlaceInProject";
import { SessionSetup } from "./SessionSetup";
import { SplitHandle } from "./SplitHandle";
import { copyText } from "../lib/copy-text";
import { TurnActions } from "./TurnActions";
import { UserTurn } from "./UserTurn";
import { WorkPopout } from "./WorkPopout";
import { TerminalPane } from "./TerminalPane";
import { pinNoticesDock } from "../lib/session-dock";
import {
  followLatestTurn,
  keepScrollThroughPrepend,
  pinnedToLatest,
  pinToLatest,
} from "../lib/transcript-scroll";
import type { AppState, ProviderId } from "../lib/types";

const SCROLL_SLACK = 96;

const SystemTurn = memo(function SystemTurn({ block }: { block: Extract<TranscriptBlock, { type: "system" }> }) {
  if (isDeskNotice(block.message)) return null;
  if (block.message.text === LINEUP_FINISHED_NOTICE) {
    return (
      <article className="turn crew-done" aria-label={LINEUP_FINISHED_NOTICE}>
        <div className="crew-done-card">
          <strong>{LINEUP_FINISHED_NOTICE}</strong>
        </div>
      </article>
    );
  }
  return (
    <article className="turn system chat">
      <div className="say"><MessageBody text={block.message.text} /></div>
    </article>
  );
});

const AssistantTurn = memo(function AssistantTurn({
  block,
  live,
  provider,
  model,
  customBotId,
  settings,
  cwd,
  vendorSessionId,
  onFork,
  onOpenThread,
}: {
  block: Extract<TranscriptBlock, { type: "reply" }>;
  live: boolean;
  provider: ProviderId;
  model: string;
  customBotId?: string;
  settings: AppState["settings"];
  cwd: string;
  vendorSessionId?: string;
  onFork: (id: string) => void;
  onOpenThread: (id: string) => void;
}) {
  const assistantText = block.assistant.text ?? "";
  const peeled = peelPlanningPreamble(assistantText, live);
  const body = unsquashSentences(peeled.body);
  const who = brainCaption(
    messageBrain(block.assistant, { provider, model, ...(customBotId ? { customBotId } : {}) }),
    settings.customBots,
    settings.llms,
  );
  return (
    <article className={`turn assistant reply${live ? " live" : ""}`}>
      <div className="turn-who">
        <span className={`dot ${who.provider}`} style={who.color ? { background: who.color } : undefined} aria-hidden="true" />
        {who.name}
      </div>
      <WorkPopout
        block={block}
        peeled={peeled}
        startedAt={block.assistant.createdAt}
        workedMs={block.assistant.workedMs}
        live={live}
        onOpenThread={onOpenThread}
      />
      {body ? (
        <div className={`say final${live ? " streaming" : ""}`}>
          <MessageBody text={body} cwd={cwd} vendorSessionId={vendorSessionId} />
          {!live ? (
            <TurnActions actions={[
              { id: "copy", label: "Copy", run: () => copyText(body) },
              { id: "fork", label: "Fork", run: () => onFork(block.assistant.id) },
            ]} />
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

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
  const [editsIdle, setEditsIdle] = useState(false);
  const [paint, setPaint] = useState({ id: "", from: 0 });
  const [openFor, setOpenFor] = useState("");
  const [wantEarlier, setWantEarlier] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const userMoved = useRef(false);
  const lastHeight = useRef(0);
  const pane = useRef<HTMLElement>(null);
  const editsBarExit = useRef<number | undefined>(undefined);
  const editsBarOpenRef = useRef(false);
  const heldEditsRef = useRef<ProjectEdit[]>([]);
  const transcriptGrouper = useRef(createTranscriptGrouper());
  const working = session?.status === "running";
  const project = store.projects.find((item) => item.id === session?.projectId);
  const localCwd = project ? primaryFolder(project)?.path ?? "" : "";
  const cwd = session ? sessionExecutionCwd(session.environment, localCwd) : localCwd;
  const roots = useMemo(() => (cwd ? [cwd] : []), [cwd]);
  const fileRoots = roots;
  const fileRootKey = cwd;
  const writesKey = useMemo(() => (session ? projectWritesKey([session]) : ""), [session?.messages]);
  const edits = useMemo(() => {
    if (!session || !editsIdle) return extraEdits;
    return mergeEdits(projectEdits([session], roots), extraEdits);
  }, [session?.id, writesKey, roots, extraEdits, editsIdle]);
  const sessionId = session?.id ?? "";
  const transcriptOpen = openFor === sessionId;
  const blocks = transcriptOpen && session ? transcriptGrouper.current.group(session.messages) : [];
  const nearby = useMemo(
    () => (transcriptOpen ? recentTranscriptText(session?.messages ?? []) : ""),
    [session?.messages, transcriptOpen],
  );
  const paintFrom = !transcriptOpen
    ? 0
    : paint.id === sessionId
      ? paint.from
      : transcriptPaintStart(blocks.length);
  const shownBlocks = transcriptOpen ? blocks.slice(paintFrom) : [];
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
    setEditsIdle(false);
    const idle = requestAnimationFrame(() => setEditsIdle(true));
    return () => cancelAnimationFrame(idle);
  }, [session?.id]);

  useEffect(() => {
    if (!sessionId) return;
    setWantEarlier(false);
    return scheduleAfterPaint(
      () => startTransition(() => setOpenFor(sessionId)),
      {
        frame: (cb) => requestAnimationFrame(cb),
        cancelFrame: (id) => cancelAnimationFrame(id),
        later: (cb) => window.setTimeout(cb, 0),
        cancelLater: (id) => window.clearTimeout(id),
      },
    );
  }, [sessionId]);

  useEffect(() => {
    if (!transcriptOpen) return;
    const initial = transcriptPaintStart(blocks.length);
    setPaint({ id: sessionId, from: initial });
    if (initial > 0) setWantEarlier(true);
  }, [sessionId, transcriptOpen]);

  useEffect(() => {
    if (!transcriptOpen || !wantEarlier) return;
    const from = paint.id === sessionId ? paint.from : transcriptPaintStart(blocks.length);
    if (!sessionId || from === 0) return;
    return startTranscriptFill(
      from,
      (next) => setPaint({ id: sessionId, from: next }),
      {
        whenIdle: (cb) => window.setTimeout(cb, TRANSCRIPT_FILL_MS),
        cancelIdle: (id) => window.clearTimeout(id),
      },
    );
  }, [sessionId, transcriptOpen, wantEarlier]);

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
    userMoved.current = false;
    lastHeight.current = 0;
  }, [session?.id]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (followBottom.current) pinToLatest(el);
    else keepScrollThroughPrepend(el, lastHeight.current);
    lastHeight.current = el.scrollHeight;
  }, [session?.id, session?.messages, session?.status, paintFrom]);

  useEffect(() => {
    const thread = scroller.current;
    const content = stack.current;
    const wrap = pane.current?.querySelector(".composer-wrap");
    if (!thread || typeof ResizeObserver === "undefined") return;
    let skipPin = false;
    let skipClear = 0;
    const onToggle = (event: Event) => {
      const node = event.target;
      if (!(node instanceof HTMLElement)) return;
      if (!node.classList.contains("work-pop") && !node.classList.contains("work-fold")) return;
      skipPin = true;
      if (skipClear) cancelAnimationFrame(skipClear);
      skipClear = requestAnimationFrame(() => {
        skipClear = requestAnimationFrame(() => {
          skipPin = false;
          skipClear = 0;
        });
      });
    };
    const pin = () => {
      if (skipPin) return;
      if (followBottom.current) pinToLatest(thread);
    };
    const observer = new ResizeObserver(pin);
    thread.addEventListener("toggle", onToggle, true);
    if (content) observer.observe(content);
    if (wrap instanceof HTMLElement) observer.observe(wrap);
    return () => {
      observer.disconnect();
      thread.removeEventListener("toggle", onToggle, true);
      if (skipClear) cancelAnimationFrame(skipClear);
    };
  }, [session?.id]);

  useEffect(() => {
    const col = pane.current?.querySelector(".session-col");
    if (!(col instanceof HTMLElement)) return;
    const notices = col.querySelector(".session-notices");
    const pin = () => {
      pinNoticesDock(col, notices instanceof HTMLElement ? notices : null);
    };
    pin();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(pin);
    observer.observe(col);
    if (notices instanceof HTMLElement) observer.observe(notices);
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
  const liveIndex = working ? lastReplyIndex(blocks) : -1;
  const liveBlock = liveIndex >= 0 ? blocks[liveIndex] : undefined;
  const talking =
    liveBlock && liveBlock.type === "reply" ? talkingToSummary(liveBlock.tools) : "";

  return (
    <FileOpenProvider
      roots={fileRoots}
      provider={session.provider}
      nearby={nearby}
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
    <MediaPaintProvider resetKey={session.id}>
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
        onWheel={() => {
          userMoved.current = true;
        }}
        onTouchMove={() => {
          userMoved.current = true;
        }}
        onScroll={() => {
          const el = scroller.current;
          if (!el) return;
          const atBottom = pinnedToLatest(el, SCROLL_SLACK);
          followBottom.current = followLatestTurn({
            following: followBottom.current,
            atBottom,
            userInitiated: userMoved.current,
          });
          if (followBottom.current) userMoved.current = false;
        }}
      >
        <div className="transcript-stack" ref={stack}>
        {shownBlocks.map((block, offset) => {
          const index = paintFrom + offset;
          if (block.type === "user") {
            return <UserTurn key={block.message.id} message={block.message} />;
          }
          if (block.type === "system") return <SystemTurn key={block.message.id} block={block} />;
          const live = working && index === liveIndex;
          return (
            <AssistantTurn
              key={block.assistant.id}
              block={block}
              live={live}
              provider={session.provider}
              model={session.model}
              customBotId={session.customBotId}
              settings={store.settings}
              cwd={cwd}
              vendorSessionId={session.vendorSessionId}
              onFork={store.forkFrom}
              onOpenThread={store.selectSession}
            />
          );
        })}
        </div>
      </div>
      <div className={`session-edits-slot${editsBarOpen ? " open" : ""}${setupOpen ? " away" : ""}`}>
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
      <div className="session-notices">
        <GoalBar />
        <WatchBanners onSwitchModel={() => setSetupOpen(true)} setupOpen={setupOpen} />
      </div>
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
    </MediaPaintProvider>
    </FileOpenProvider>
  );
}

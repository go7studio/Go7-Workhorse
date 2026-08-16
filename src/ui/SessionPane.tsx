import { useEffect, useMemo, useRef, useState } from "react";
import { canPlaceInProject } from "../lib/chats";
import { primaryFolder } from "../lib/project";
import { fileFolderFromPath, fileNameFromPath, mergeEdits, projectEdits, type ProjectEdit } from "../lib/project-edits";
import { sessionExecutionCwd } from "../lib/session-environment";
import { peelPlanningPreamble, unsquashSentences } from "../lib/markdown";
import { brainCaption, brainStamp, messageBrain } from "../lib/session";
import { talkingToSummary } from "../lib/tool-labels";
import { groupTranscript, isDeskNotice, lastReplyIndex, thoughtForReply } from "../lib/turns";
import { useActiveSession, useStore } from "../lib/store";
import { Composer } from "./Composer";
import { GoalBar } from "./GoalBar";
import { WatchBanners } from "./WatchNotices";
import { ContextMeter } from "./ModelMenu";
import { EditedList } from "./EditedList";
import { FileOpenProvider } from "./FileOpen";
import { FileReview } from "./FileReview";
import { MessageBody } from "./MessageBody";
import { PlaceInProject } from "./PlaceInProject";
import { SessionSetup } from "./SessionSetup";
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
  const [openSource, setOpenSource] = useState(false);
  const [extraEdits, setExtraEdits] = useState<ProjectEdit[]>([]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [stats, setStats] = useState<Record<string, { added: number; deleted: number }>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const pane = useRef<HTMLElement>(null);
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
  }, [session, store.sessions, roots, extraEdits]);
  const editKey = edits.map((item) => item.path).join("\n");

  useEffect(() => {
    if (!window.workhorse?.editStats || edits.length === 0) {
      setStats({});
      return;
    }
    void window.workhorse.editStats(
      edits.map((item) => item.path),
      roots,
    ).then((next) => setStats(next ?? {}));
  }, [editKey, folderKey]);

  useEffect(() => {
    followBottom.current = true;
  }, [session?.id]);

  useEffect(() => {
    const el = scroller.current;
    if (el && followBottom.current) el.scrollTop = el.scrollHeight;
  }, [session?.messages, session?.status]);

  useEffect(() => {
    setOpen(null);
    setOpenSource(false);
    setExtraEdits([]);
    setTerminalOpen(false);
  }, [session?.id]);

  if (!session) return null;
  const reviewFiles = mergeEdits(open ? [open] : [], edits);
  const trackEdit = (file: ProjectEdit) => {
    setExtraEdits((current) => mergeEdits(current, [file]));
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
      onOpen={(file) => {
        setOpenSource(true);
        setOpen(file);
      }}
    >
    <section className="session" ref={pane}>
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
                    }));
                    setExtraEdits((current) => mergeEdits(current, found));
                    if (found[0]) {
                      setOpenSource(false);
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
          const thought = thoughtForReply({
            assistantThought: block.assistant.thought,
            thoughtMessages: block.thoughts,
            assistantText,
            live,
          });
          const body = unsquashSentences(peeled.body || (!live ? assistantText : ""));
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
                thought={thought}
                tools={block.tools}
                compacts={block.compacts}
                subagents={block.subagents}
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
      {edits.length > 0 && (
        <div className="session-edits">
          <EditedList
            compact
            edits={edits}
            stats={stats}
            onOpen={(file) => {
              setOpenSource(false);
              setOpen(file);
            }}
          />
        </div>
      )}
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
      {open ? (
        <FileReview
          file={open}
          files={reviewFiles}
          stats={stats}
          roots={fileRoots}
          preferSource={openSource}
          overlay
          onOpen={(file) => {
            setOpenSource(false);
            setOpen(file);
          }}
          onClose={() => {
            setOpen(null);
            setOpenSource(false);
          }}
          onTracked={trackEdit}
        />
      ) : null}
      </div>
    </section>
    </FileOpenProvider>
  );
}

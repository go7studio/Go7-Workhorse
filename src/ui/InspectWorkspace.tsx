import { useEffect, useState } from "react";
import horseMark from "../../assets/app-icons/go7-workhorse-transparent.png";
import { setInspectOpen } from "../lib/inspect-mode";
import {
  INSPECT_CALL_PAGE,
  INSPECT_MESSAGE_PAGE,
  INSPECT_NAV_PAGE,
  INSPECT_WORKER_PAGE,
  inspectMessageText,
  inspectTranscriptRows,
  inspectTree,
  pageNewest,
  redactInspectText,
  type InspectCallerNode,
  type InspectWorkerNode,
} from "../lib/link-inspect";
import { emptyLinkInspect, linkRetentionNote, normalizeLinkInspect, type LinkInspectFile } from "../lib/link-history";
import {
  activityLabel,
  activityTool,
  callerTrafficStatus,
  presentCallers,
  statusTone,
  trafficStatus,
  trafficWhen,
  type CallerPresentation,
} from "../lib/link-present";
import { useStoreSelector } from "../lib/store";
import type { TranscriptSidecar } from "../lib/transcript-sidecar";
import type { ChatMessage, Session } from "../lib/types";

type Selection =
  | { kind: "caller"; caller: string }
  | { kind: "worker"; caller: string; key: string };

function snapshotFrom(raw: unknown): LinkInspectFile {
  return normalizeLinkInspect(raw);
}

function faceFor(faces: Map<string, CallerPresentation>, caller: string): CallerPresentation {
  return faces.get(caller) ?? { title: "Unknown caller", reliable: false };
}

function workerStatus(worker: InspectWorkerNode): string {
  return trafficStatus({ workerStatus: worker.lastStatus });
}

export function InspectWorkspace() {
  const theme = useStoreSelector((store) => store.theme, (left, right) => left === right);
  const toggleTheme = useStoreSelector((store) => store.toggleWorkhorseTheme, (left, right) => left === right);
  const [snap, setSnap] = useState<LinkInspectFile | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [bridge, setBridge] = useState<boolean | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [callShown, setCallShown] = useState(INSPECT_CALL_PAGE);
  const [callerShown, setCallerShown] = useState(INSPECT_NAV_PAGE);
  const [workerShown, setWorkerShown] = useState<Record<string, number>>({});

  useEffect(() => {
    let stop = false;
    const history = window.workhorse?.linkHistory;
    if (!history) {
      setUnavailable(true);
      setSnap(emptyLinkInspect());
      return;
    }
    const load = () => {
      void history().then((next) => {
        if (!stop) setSnap(snapshotFrom(next));
      }).catch(() => {
        if (!stop) setUnavailable(true);
      });
      const bridgeStatus = window.workhorse?.linkBridge;
      if (!bridgeStatus) return;
      void bridgeStatus().then((next) => {
        if (!stop && next && typeof next.listening === "boolean") setBridge(next.listening);
      }).catch(() => undefined);
    };
    load();
    const off = window.workhorse?.onLinkHistory?.(() => load());
    return () => {
      stop = true;
      off?.();
    };
  }, []);

  const file = snap ?? emptyLinkInspect();
  const callers = inspectTree(file);
  const faces = presentCallers(callers);
  const callerPage = pageNewest(callers, callerShown);
  const selectedCaller = callers.find((item) => item.caller === selection?.caller) ?? callers[0] ?? null;
  const selectedFace = selectedCaller ? faceFor(faces, selectedCaller.caller) : null;
  const selectedWorker = selectedCaller && selection?.kind === "worker"
    ? selectedCaller.workers.find((item) => item.key === selection.key) ?? null
    : null;
  const calls = selectedWorker?.calls ?? selectedCaller?.calls ?? [];
  const callPage = pageNewest(calls, callShown);
  const transcriptWorker = selectedWorker ?? latestLinkedWorker(selectedCaller);
  const remembered = selectedWorker?.callCount ?? selectedCaller?.callCount ?? 0;
  const retention = file.retention.note ? file.retention : { ...file.retention, note: linkRetentionNote() };
  const headlineStatus = selectedWorker
    ? workerStatus(selectedWorker)
    : selectedCaller
      ? callerTrafficStatus(selectedCaller)
      : "No status yet";
  const headlineWhen = trafficWhen(selectedWorker?.lastAt ?? selectedCaller?.calls[0]?.at ?? selectedCaller?.workers[0]?.lastAt ?? 0);
  const listening = unavailable ? "off" : bridge === true ? "on" : snap === null ? "wait" : "off";
  const listeningText = unavailable
    ? "This window cannot read traffic."
    : snap === null
      ? "Reading traffic…"
      : bridge
        ? "Listening. Calls stay off the chat list."
        : "Not listening right now.";

  useEffect(() => {
    setCallShown(INSPECT_CALL_PAGE);
  }, [selectedCaller?.caller, selectedWorker?.key]);

  return (
    <>
      <header className="titlebar">
        <span>Inspect</span>
      </header>
      <div className="workspace" style={{ ["--sidebar" as string]: "300px" }}>
        <aside className="sidebar" aria-label="Inspect">
          <div className="brand">
            <button
              className="brand-mark-btn"
              type="button"
              aria-pressed={theme === "workhorse"}
              aria-label={theme === "workhorse" ? "Leave Workhorse theme" : "Use Workhorse theme"}
              onClick={() => toggleTheme()}
            >
              <img className="brand-mark" src={horseMark} alt="" />
            </button>
            <div className="brand-copy">
              <div className="brand-title">
                <h1>Inspect</h1>
              </div>
              <p>Traffic</p>
            </div>
          </div>
          <button className="inspect-back" type="button" onClick={() => setInspectOpen(false)}>
            Back to desk
          </button>
          <p className="inspect-listen" data-state={listening}>
            <i />
            <span>{listeningText}</span>
          </p>
          <nav className="inspect-nav" aria-label="Callers">
            {snap === null ? <p className="inspect-quiet">Reading traffic…</p> : null}
            {snap && callers.length === 0 ? <p className="inspect-quiet">No calls yet.</p> : null}
            {callerPage.page.map((caller) => {
              const face = faceFor(faces, caller.caller);
              const callerOn = selectedCaller?.caller === caller.caller && !selectedWorker;
              const shownWorkers = workerShown[caller.caller] ?? INSPECT_WORKER_PAGE;
              const workerPage = pageNewest(caller.workers, shownWorkers);
              const summary = callerTrafficStatus(caller);
              return (
                <div className="inspect-caller" key={caller.caller}>
                  <button
                    type="button"
                    aria-current={callerOn ? "true" : undefined}
                    onClick={() => setSelection({ kind: "caller", caller: caller.caller })}
                  >
                    <strong>{face.title}</strong>
                    <span>{caller.callCount} {caller.callCount === 1 ? "call" : "calls"} · {summary}</span>
                  </button>
                  {workerPage.page.map((worker) => {
                    const workerOn = selectedWorker?.key === worker.key && selectedCaller?.caller === caller.caller;
                    return (
                      <button
                        key={worker.key}
                        type="button"
                        className="inspect-worker"
                        aria-current={workerOn ? "true" : undefined}
                        onClick={() => setSelection({ kind: "worker", caller: caller.caller, key: worker.key })}
                      >
                        <strong>{worker.label}</strong>
                        <span>{workerStatus(worker)}</span>
                      </button>
                    );
                  })}
                  {workerPage.earlier > 0 ? (
                    <button
                      type="button"
                      className="tiny inspect-more"
                      onClick={() => setWorkerShown((current) => ({ ...current, [caller.caller]: shownWorkers + INSPECT_WORKER_PAGE }))}
                    >
                      Earlier workers ({workerPage.earlier})
                    </button>
                  ) : null}
                </div>
              );
            })}
            {callerPage.earlier > 0 ? (
              <button type="button" className="tiny inspect-more" onClick={() => setCallerShown((shown) => shown + INSPECT_NAV_PAGE)}>
                Earlier callers ({callerPage.earlier})
              </button>
            ) : null}
          </nav>
        </aside>
        <main className="main inspect-main">
          {snap === null ? (
            <div className="inspect-empty">
              <h2>Reading traffic…</h2>
              <p>Workhorse is opening the latest calls.</p>
            </div>
          ) : null}
          {snap && !selectedCaller ? (
            <div className="inspect-empty">
              <h2>No traffic yet</h2>
              <p>When another app calls Workhorse, it shows up here.</p>
            </div>
          ) : null}
          {selectedCaller && selectedFace ? (
            <>
              <header className="inspect-head">
                <h2>{selectedWorker ? selectedWorker.label : selectedFace.title}</h2>
                <p className={`inspect-state is-${statusTone(headlineStatus)}`}>
                  <i />
                  <span>{headlineStatus}</span>
                  <span>{headlineWhen}</span>
                </p>
                <p className="inspect-lead">
                  {selectedWorker
                    ? `Called by ${selectedFace.title}.`
                    : `${selectedCaller.callCount} ${selectedCaller.callCount === 1 ? "call" : "calls"}${transcriptWorker ? ` · latest worker ${transcriptWorker.label}` : ""}`}
                </p>
                {selectedFace.reportedName || selectedWorker?.sessionId || (selectedWorker && !selectedWorker.sessionId) ? (
                  <details className="inspect-tech">
                    <summary>Details</summary>
                    {selectedFace.reportedName ? <p>Name this client sent: {selectedFace.reportedName}</p> : null}
                    {selectedWorker?.sessionId ? <p>Session {selectedWorker.sessionId}</p> : null}
                    {selectedWorker && !selectedWorker.sessionId ? <p>No session was recorded for this worker.</p> : null}
                  </details>
                ) : null}
              </header>
              <section className="inspect-section" aria-label="Call history">
                <h3>Activity</h3>
                {remembered > calls.length ? (
                  <p className="inspect-quiet">
                    {remembered} {remembered === 1 ? "call" : "calls"} in all. {calls.length} of the latest are listed here.
                  </p>
                ) : null}
                {calls.length === 0 ? <p className="inspect-quiet">No calls are left in the latest list.</p> : null}
                {callPage.page.map((row) => {
                  const label = trafficStatus(row);
                  return (
                    <article className="inspect-call" key={row.id}>
                      <strong>{activityLabel(row.tool)}</strong>
                      <span className={`inspect-state is-${statusTone(label)}`}>
                        <i />
                        {label} · {trafficWhen(row.at)}{row.worker && !selectedWorker ? ` · ${row.worker}` : ""}
                      </span>
                      {row.detail ? <p className="inspect-error">{redactInspectText(row.detail)}</p> : null}
                      <details className="inspect-tech">
                        <summary>Details</summary>
                        <p>Tool {activityTool(row.tool)}</p>
                      </details>
                    </article>
                  );
                })}
                {callPage.earlier > 0 ? (
                  <button type="button" className="tiny inspect-more" onClick={() => setCallShown((shown) => shown + INSPECT_CALL_PAGE)}>
                    Earlier calls ({callPage.earlier})
                  </button>
                ) : null}
              </section>
              <Transcript
                worker={transcriptWorker}
                callerTitle={selectedFace.title}
                showingLatest={!selectedWorker && Boolean(transcriptWorker)}
              />
            </>
          ) : null}
          <details className="inspect-about">
            <summary>About this list</summary>
            <p>{retention.note}</p>
          </details>
        </main>
      </div>
    </>
  );
}

function latestLinkedWorker(caller: InspectCallerNode | null): InspectWorkerNode | null {
  if (!caller) return null;
  return caller.workers.find((worker) => worker.sessionId) ?? null;
}

function messageLabel(message: ChatMessage): string {
  if (message.kind === "thought") return "Thinking";
  if (message.kind === "tool") return "Step";
  if (message.role === "user") return "Request";
  if (message.role === "assistant") return "Result";
  return "Note";
}

function Transcript({ worker, callerTitle, showingLatest }: { worker: InspectWorkerNode | null; callerTitle: string; showingLatest: boolean }) {
  const sessionId = worker?.sessionId;
  // The desk selector returns its cached row while the store object is the
  // same, so a finder closed over the worker id keeps the previous worker.
  // Take the list, then pick this id on each render.
  const sessions = useStoreSelector(
    (store) => store.sessions,
    (left, right) => left === right,
  );
  const session = sessionId ? sessions.find((item) => item.id === sessionId) : undefined;
  const [loaded, setLoaded] = useState<{ id: string; file: TranscriptSidecar | null } | null>(null);
  const sidecar = loaded && sessionId && loaded.id === sessionId ? loaded.file : null;
  const settled = !sessionId || loaded?.id === sessionId;
  const [shown, setShown] = useState(INSPECT_MESSAGE_PAGE);
  const stamp = sessionStamp(session);
  const running = session?.agentRun?.status === "running" || session?.status === "running";
  const liveStatus = trafficStatus({
    workerStatus: session?.agentRun?.status ?? worker?.lastStatus,
    status: session?.agentRun?.status ?? worker?.lastStatus,
  });

  useEffect(() => {
    setShown(INSPECT_MESSAGE_PAGE);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !window.workhorse?.loadTranscript) {
      setLoaded(sessionId ? { id: sessionId, file: null } : null);
      return;
    }
    let stop = false;
    const request = sessionId;
    void window.workhorse.loadTranscript(request).then((next) => {
      if (!stop) setLoaded({ id: request, file: next });
    }).catch(() => {
      if (!stop) setLoaded({ id: request, file: null });
    });
    return () => {
      stop = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !running || !window.workhorse?.loadTranscript) return;
    let stop = false;
    const request = sessionId;
    const timer = setInterval(() => {
      void window.workhorse?.loadTranscript?.(request).then((next) => {
        if (!stop) setLoaded({ id: request, file: next });
      }).catch(() => undefined);
    }, 2000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [sessionId, running]);

  useEffect(() => {
    if (!sessionId || !window.workhorse?.loadTranscript) return;
    let stop = false;
    const request = sessionId;
    const timer = setTimeout(() => {
      void window.workhorse?.loadTranscript?.(request).then((next) => {
        if (!stop) setLoaded({ id: request, file: next });
      }).catch(() => undefined);
    }, running ? 750 : 0);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [sessionId, stamp, running]);

  if (!worker) {
    return (
      <section className="inspect-section" aria-label="Transcript">
        <h3>Transcript</h3>
        <p className="inspect-quiet">No worker transcript for {callerTitle}.</p>
      </section>
    );
  }
  if (!sessionId) {
    return (
      <section className="inspect-section" aria-label="Transcript">
        <h3>Transcript</h3>
        <p className="inspect-quiet">This worker has no transcript to open.</p>
      </section>
    );
  }
  const messages = inspectTranscriptRows(session, sidecar, sessionId);
  const page = pageNewest([...messages].reverse(), shown);
  const visible = [...page.page].reverse();
  const error = redactInspectText(session?.agentRun?.error?.trim() ?? "");
  return (
    <section className="inspect-section" aria-label="Transcript">
      <h3>Transcript</h3>
      <p className={`inspect-state is-${statusTone(liveStatus)}`}>
        <i />
        <span>{liveStatus}{running ? " · updates while this run is open" : ""}</span>
      </p>
      {showingLatest ? <p className="inspect-quiet">Showing {worker.label}, the latest worker. Pick another worker to read that transcript.</p> : null}
      {error ? <p className="inspect-error">{error}</p> : null}
      {!settled ? <p className="inspect-quiet">Reading transcript…</p> : null}
      {settled && messages.length === 0 ? <p className="inspect-quiet">No transcript is stored for this worker.</p> : null}
      {visible.map((message) => {
        const text = redactInspectText(inspectMessageText(message));
        if (!text) return null;
        return (
          <article className={`inspect-line is-${messageLabel(message).toLowerCase()}`} key={message.id}>
            <span>{messageLabel(message)}</span>
            <p>{text}</p>
          </article>
        );
      })}
      {page.earlier > 0 ? (
        <button type="button" className="tiny inspect-more" onClick={() => setShown((value) => value + INSPECT_MESSAGE_PAGE)}>
          Earlier messages ({page.earlier})
        </button>
      ) : null}
    </section>
  );
}

function sessionStamp(session: Session | undefined): string {
  if (!session) return "";
  const tail = session.messages
    .slice(-3)
    .map((message) => `${message.id}:${message.text?.length ?? 0}:${message.thought?.length ?? 0}`)
    .join("|");
  return `${session.id}:${session.messages.length}:${tail}:${session.transcriptSidecar ?? ""}:${session.agentRun?.error ?? ""}:${session.agentRun?.status ?? ""}`;
}

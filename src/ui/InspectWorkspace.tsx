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
import { emptyLinkInspect, linkRetentionNote, normalizeLinkInspect, type LinkCallRecord, type LinkInspectFile } from "../lib/link-history";
import { useStoreSelector } from "../lib/store";
import type { TranscriptSidecar } from "../lib/transcript-sidecar";
import type { ChatMessage, Session } from "../lib/types";

type Selection =
  | { kind: "caller"; caller: string }
  | { kind: "worker"; caller: string; key: string };

function whenLabel(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "Unknown time";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function statusLabel(row: LinkCallRecord): string {
  if (row.status === "forbidden") return "Refused";
  if (row.status === "error") return "Error";
  if (row.workerStatus === "running" || row.workerStatus === "queued") return "Running";
  if (row.workerStatus === "completed") return "Completed";
  if (row.workerStatus === "failed") return "Failed";
  if (row.workerStatus === "cancelled") return "Cancelled";
  if (row.workerStatus === "unknown") return "Unknown";
  return "Ok";
}

function progressLabel(status: string | undefined): string {
  if (!status) return "No status recorded";
  if (status === "running" || status === "queued") return "Running";
  if (status === "completed" || status === "ok") return "Completed";
  if (status === "failed" || status === "error") return "Failed";
  if (status === "cancelled") return "Cancelled";
  if (status === "forbidden") return "Refused";
  return status;
}

function messageLabel(message: ChatMessage): string {
  if (message.kind === "thought") return "Thought";
  if (message.kind === "tool") return "Tool";
  if (message.role === "user") return "Request";
  if (message.role === "assistant") return "Result";
  return "Note";
}

function snapshotFrom(raw: unknown): LinkInspectFile {
  return normalizeLinkInspect(raw);
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
  const callerPage = pageNewest(callers, callerShown);
  const selectedCaller = callers.find((item) => item.caller === selection?.caller) ?? callers[0] ?? null;
  const selectedWorker = selectedCaller && selection?.kind === "worker"
    ? selectedCaller.workers.find((item) => item.key === selection.key) ?? null
    : null;
  const calls = selectedWorker?.calls ?? selectedCaller?.calls ?? [];
  const callPage = pageNewest(calls, callShown);
  const transcriptWorker = selectedWorker ?? latestLinkedWorker(selectedCaller);
  const remembered = selectedWorker?.callCount ?? selectedCaller?.callCount ?? 0;
  const retention = file.retention.note ? file.retention : { ...file.retention, note: linkRetentionNote() };

  useEffect(() => {
    setCallShown(INSPECT_CALL_PAGE);
  }, [selectedCaller?.caller, selectedWorker?.key]);

  return (
    <>
      <header className="titlebar">
        <span>Inspect</span>
      </header>
      <div className="workspace" style={{ ["--sidebar" as string]: "280px" }}>
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
              <p>Link callers</p>
            </div>
          </div>
          <button className="inspect-back" type="button" onClick={() => setInspectOpen(false)}>
            Back to desk
          </button>
          <p className="row-meta inspect-bridge">
            {unavailable
              ? "Link history is unavailable in this window."
              : bridge
                ? "Link bridge is active. Calls stay off the chat list."
                : "Link bridge status is not in yet."}
          </p>
          <nav className="inspect-nav" aria-label="External callers">
            {snap === null ? <p className="row-meta">Reading Link calls…</p> : null}
            {snap && callers.length === 0 ? <p className="row-meta">No Link calls yet.</p> : null}
            {callerPage.page.map((caller) => {
              const callerOn = selectedCaller?.caller === caller.caller && !selectedWorker;
              const shownWorkers = workerShown[caller.caller] ?? INSPECT_WORKER_PAGE;
              const workerPage = pageNewest(caller.workers, shownWorkers);
              return (
                <div className="inspect-caller" key={caller.caller}>
                  <button
                    type="button"
                    aria-current={callerOn ? "true" : undefined}
                    onClick={() => setSelection({ kind: "caller", caller: caller.caller })}
                  >
                    <strong>{caller.caller}</strong>
                    <span>{caller.callCount} {caller.callCount === 1 ? "call" : "calls"}</span>
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
                        {worker.label}
                      </button>
                    );
                  })}
                  {workerPage.earlier > 0 ? (
                    <button
                      type="button"
                      className="tiny"
                      onClick={() => setWorkerShown((current) => ({ ...current, [caller.caller]: shownWorkers + INSPECT_WORKER_PAGE }))}
                    >
                      More workers ({workerPage.earlier})
                    </button>
                  ) : null}
                </div>
              );
            })}
            {callerPage.earlier > 0 ? (
              <button type="button" className="tiny" onClick={() => setCallerShown((shown) => shown + INSPECT_NAV_PAGE)}>
                Earlier callers ({callerPage.earlier})
              </button>
            ) : null}
          </nav>
        </aside>
        <main className="main inspect-main">
          <p className="inspect-note">{retention.note}</p>
          {!selectedCaller ? <p className="row-meta">No Link calls yet.</p> : null}
          {selectedCaller ? (
            <>
              <h2>{selectedWorker ? selectedWorker.label : selectedCaller.caller}</h2>
              <p className="row-meta">
                {selectedWorker
                  ? `Called by ${selectedCaller.caller}. ${selectedWorker.sessionId ? selectedWorker.sessionId : "No session id was recorded, so this name is not tied to a transcript."}`
                  : `${selectedCaller.caller} · ${selectedCaller.callCount} ${selectedCaller.callCount === 1 ? "call" : "calls"}`}
              </p>
              <section aria-label="Call history">
                <h3>Calls</h3>
                {remembered > calls.length ? (
                  <p className="row-meta">
                    {remembered} {remembered === 1 ? "call is" : "calls are"} remembered. {calls.length} still in the latest {retention.calls} call log.
                  </p>
                ) : null}
                {callPage.page.map((row) => (
                  <article className="inspect-call" key={row.id}>
                    <strong>{row.tool}</strong>
                    <span>{statusLabel(row)} · {whenLabel(row.at)}{row.worker && !selectedWorker ? ` · ${row.worker}` : ""}</span>
                    {row.detail ? <p>{redactInspectText(row.detail)}</p> : null}
                  </article>
                ))}
                {callPage.earlier > 0 ? (
                  <button type="button" className="tiny" onClick={() => setCallShown((shown) => shown + INSPECT_CALL_PAGE)}>
                    Earlier calls ({callPage.earlier})
                  </button>
                ) : null}
              </section>
              <Transcript worker={transcriptWorker} callerLabel={selectedCaller.caller} showingLatest={!selectedWorker && Boolean(transcriptWorker)} />
            </>
          ) : null}
        </main>
      </div>
    </>
  );
}

function latestLinkedWorker(caller: InspectCallerNode | null): InspectWorkerNode | null {
  if (!caller) return null;
  return caller.workers.find((worker) => worker.sessionId) ?? null;
}

function Transcript({ worker, callerLabel, showingLatest }: { worker: InspectWorkerNode | null; callerLabel: string; showingLatest: boolean }) {
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
  const liveStatus = session?.agentRun?.status ?? worker?.lastStatus;

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
    return <p className="row-meta">This caller has no linked worker transcript.</p>;
  }
  if (!sessionId) {
    return <p className="row-meta">This worker was named without a session id, so its transcript is not opened.</p>;
  }
  const messages = inspectTranscriptRows(session, sidecar, sessionId);
  const page = pageNewest([...messages].reverse(), shown);
  const visible = [...page.page].reverse();
  const error = redactInspectText(session?.agentRun?.error?.trim() ?? "");
  return (
    <section aria-label="Transcript">
      <h3>Transcript</h3>
      <p className="row-meta">Progress · {progressLabel(liveStatus)}{running ? " · this transcript refreshes while the run is open" : ""}</p>
      {showingLatest ? <p className="row-meta">Latest worker linked by {callerLabel}: {worker.label}. Choose a worker in the sidebar to read another transcript.</p> : null}
      {error ? <p className="inspect-error">Error · {error}</p> : null}
      {!settled ? <p className="row-meta">Reading transcript…</p> : null}
      {settled && messages.length === 0 ? <p className="row-meta">No transcript is stored for this worker.</p> : null}
      {visible.map((message) => {
        const text = redactInspectText(inspectMessageText(message));
        if (!text) return null;
        return (
          <article className="inspect-line" key={message.id}>
            <span>{messageLabel(message)}</span>
            <p>{text}</p>
          </article>
        );
      })}
      {page.earlier > 0 ? (
        <button type="button" className="tiny" onClick={() => setShown((value) => value + INSPECT_MESSAGE_PAGE)}>
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



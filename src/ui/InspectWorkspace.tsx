import { useEffect, useState } from "react";
import horseMark from "../../assets/app-icons/go7-workhorse-transparent.png";
import { setInspectOpen } from "../lib/inspect-mode";
import {
  INSPECT_CALL_PAGE,
  INSPECT_MESSAGE_PAGE,
  inspectCallers,
  pageNewest,
  redactInspectText,
  type InspectCallerNode,
  type InspectWorkerNode,
} from "../lib/link-inspect";
import type { LinkCallRecord } from "../lib/link-history";
import { useStoreSelector } from "../lib/store";
import { sessionMessagesWithSidecar, type TranscriptSidecar } from "../lib/transcript-sidecar";
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

function messageLabel(message: ChatMessage): string {
  if (message.kind === "thought") return "Thought";
  if (message.kind === "tool") return "Tool";
  if (message.role === "user") return "Request";
  if (message.role === "assistant") return "Result";
  return "Note";
}

function messageText(message: ChatMessage): string {
  const parts = [message.text, message.thought].map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  return parts.join("\n\n");
}

export function InspectWorkspace() {
  const theme = useStoreSelector((store) => store.theme, (left, right) => left === right);
  const toggleTheme = useStoreSelector((store) => store.toggleWorkhorseTheme, (left, right) => left === right);
  const [rows, setRows] = useState<LinkCallRecord[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [bridge, setBridge] = useState<boolean | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [callShown, setCallShown] = useState(INSPECT_CALL_PAGE);

  useEffect(() => {
    let stop = false;
    const history = window.workhorse?.linkHistory;
    if (!history) {
      setUnavailable(true);
      setRows([]);
      return;
    }
    const load = () => {
      void history().then((next) => {
        if (!stop) setRows(Array.isArray(next) ? next : []);
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

  const callers = inspectCallers(rows ?? []);
  const selectedCaller = callers.find((item) => item.caller === selection?.caller) ?? callers[0] ?? null;
  const selectedWorker = selectedCaller && selection?.kind === "worker"
    ? selectedCaller.workers.find((item) => item.key === selection.key) ?? null
    : null;
  const calls = selectedWorker?.calls ?? selectedCaller?.calls ?? [];
  const callPage = pageNewest(calls, callShown);
  const transcriptWorker = selectedWorker ?? latestLinkedWorker(selectedCaller);

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
            {rows === null ? <p className="row-meta">Reading Link calls…</p> : null}
            {rows && callers.length === 0 ? <p className="row-meta">No Link calls yet.</p> : null}
            {callers.map((caller) => {
              const callerOn = selectedCaller?.caller === caller.caller && !selectedWorker;
              return (
                <div className="inspect-caller" key={caller.caller}>
                  <button
                    type="button"
                    aria-current={callerOn ? "true" : undefined}
                    onClick={() => setSelection({ kind: "caller", caller: caller.caller })}
                  >
                    <strong>{caller.caller}</strong>
                    <span>{caller.calls.length} {caller.calls.length === 1 ? "call" : "calls"}</span>
                  </button>
                  {caller.workers.map((worker) => {
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
                </div>
              );
            })}
          </nav>
        </aside>
        <main className="main inspect-main">
          {!selectedCaller ? <p className="row-meta">No Link calls yet.</p> : null}
          {selectedCaller ? (
            <>
              <h2>{selectedWorker ? selectedWorker.label : selectedCaller.caller}</h2>
              <p className="row-meta">
                {selectedWorker
                  ? `Called by ${selectedCaller.caller}. ${selectedWorker.sessionId ? selectedWorker.sessionId : "No session id was recorded, so this name is not tied to a transcript."}`
                  : `${selectedCaller.caller} · ${selectedCaller.calls.length} ${selectedCaller.calls.length === 1 ? "call" : "calls"}`}
              </p>
              <section aria-label="Call history">
                <h3>Calls</h3>
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
  const session = useStoreSelector(
    (store) => (sessionId ? store.sessions.find((item) => item.id === sessionId) : undefined),
    (left, right) => sessionStamp(left) === sessionStamp(right),
  );
  const [sidecar, setSidecar] = useState<TranscriptSidecar | null>(null);
  const [shown, setShown] = useState(INSPECT_MESSAGE_PAGE);

  useEffect(() => {
    setShown(INSPECT_MESSAGE_PAGE);
    setSidecar(null);
    if (!sessionId || !window.workhorse?.loadTranscript) return;
    let stop = false;
    void window.workhorse.loadTranscript(sessionId).then((next) => {
      if (!stop) setSidecar(next);
    }).catch(() => {
      if (!stop) setSidecar(null);
    });
    return () => {
      stop = true;
    };
  }, [sessionId]);

  if (!worker) {
    return <p className="row-meta">This caller has no linked worker transcript.</p>;
  }
  if (!sessionId) {
    return <p className="row-meta">This worker was named without a session id, so its transcript is not opened.</p>;
  }
  const messages = transcriptMessages(session, sidecar);
  const page = pageNewest([...messages].reverse(), shown);
  const visible = [...page.page].reverse();
  const error = redactInspectText(session?.agentRun?.error?.trim() ?? "");
  return (
    <section aria-label="Transcript">
      <h3>Transcript</h3>
      {showingLatest ? <p className="row-meta">Latest worker linked by {callerLabel}: {worker.label}. Choose a worker in the sidebar to read another transcript.</p> : null}
      {error ? <p className="inspect-error">Error · {error}</p> : null}
      {messages.length === 0 ? <p className="row-meta">No transcript is stored for this worker.</p> : null}
      {visible.map((message) => {
        const text = redactInspectText(messageText(message));
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
  const last = session.messages[session.messages.length - 1];
  return `${session.id}:${session.messages.length}:${last?.id ?? ""}:${session.transcriptSidecar ?? ""}:${session.agentRun?.error ?? ""}:${session.agentRun?.status ?? ""}`;
}

function transcriptMessages(session: Session | undefined, sidecar: TranscriptSidecar | null): ChatMessage[] {
  if (session) return sessionMessagesWithSidecar(session, () => sidecar).filter((message) => messageText(message));
  if (!sidecar) return [];
  return [...sidecar.rows].sort((left, right) => left.index - right.index).map((row) => row.message).filter((message) => messageText(message));
}

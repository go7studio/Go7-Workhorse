import { useEffect, useRef, useState } from "react";
import { crewActivity, crewIsLive, crewWorkers } from "../lib/crew-tray";
import { effortLabel, modelName } from "../lib/models";
import { deskInk } from "../lib/settings";
import { useStoreSelector, type Store } from "../lib/store";
import type { Session } from "../lib/types";
import { crewDotKind } from "./ChatRow";
import { HorseStatus } from "./HorseStatus";
import { MessageBody } from "./MessageBody";

function selectCrew(store: Store) {
  const parentId = store.activeSessionId;
  return { parentId, workers: parentId ? crewWorkers(store.sessions, parentId) : [],
    settings: store.settings, send: store.send, cancelRun: store.cancelRun, selectSession: store.selectSession };
}
function sameCrew(a: ReturnType<typeof selectCrew>, b: ReturnType<typeof selectCrew>) {
  return a.parentId === b.parentId && a.settings === b.settings && a.send === b.send &&
    a.cancelRun === b.cancelRun && a.selectSession === b.selectSession &&
    a.workers.length === b.workers.length && a.workers.every((worker, i) => worker === b.workers[i]);
}

export function CrewTray() {
  const desk = useStoreSelector(selectCrew, sameCrew);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const dialog = useRef<HTMLDialogElement>(null);
  const worker = desk.workers.find((item) => item.id === selected);
  const live = desk.workers.filter(crewIsLive);
  useEffect(() => { setSelected(null); setOpen(false); }, [desk.parentId]);
  useEffect(() => {
    const element = dialog.current;
    if (worker && element && !element.open) {
      element.showModal();
      // The conversation first mounts inside a closed dialog with no layout.
      const scroll = element.querySelector<HTMLElement>(".crew-conversation-scroll");
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    }
    return () => { if (element?.open) element.close(); };
  }, [worker?.id]);
  if (!desk.workers.length) return null;
  const draft = worker ? drafts[worker.id] || "" : "";
  const brain = (item: Session) => [modelName(item.provider, item.model), effortLabel(item.effort)].filter(Boolean).join(" · ");
  const horse = (item: Session) => <HorseStatus kind={crewDotKind(item)} ink={deskInk(item, desk.settings) || `var(--${item.provider})`} />;
  return <section className={`crew-tray${open ? " open" : ""}`} aria-label="Orchestrator crew">
    <div className="crew-tray-head">
      <button type="button" className="crew-tray-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <HorseStatus kind={live.length ? "working" : "idle"} />
        <strong>{live.length ? `Working ${live.length}` : `Crew ${desk.workers.length}`}</strong>
        <span>{live.length ? `${desk.workers.length} workers` : "View workers"}</span><span aria-hidden="true">{open ? "⌄" : "›"}</span>
      </button>
      {open && live.length > 0 ? <button type="button" className="tiny" onClick={() => live.forEach((item) => desk.cancelRun(item.id))}>Stop all workers</button> : null}
    </div>
    {open ? <div className="crew-tray-list">
      {desk.workers.map((item) => <div className="crew-tray-row" key={item.id}>
        <button type="button" className="crew-tray-worker" onClick={() => setSelected(item.id)}>
          {horse(item)}<span className="crew-tray-copy"><strong>{item.title}</strong><span>{brain(item)}</span><span className="crew-tray-activity">{crewActivity(item)}</span></span>
        </button>
        {crewIsLive(item) ? <button type="button" className="tiny" aria-label={`Stop ${item.title}`} onClick={() => desk.cancelRun(item.id)}>Stop</button> : null}
      </div>)}
    </div> : null}
    {worker ? <dialog ref={dialog} className="crew-conversation" aria-label={worker.title} onCancel={() => setSelected(null)} onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <div className="crew-conversation-inner">
        <header><button className="tiny" type="button" onClick={() => setSelected(null)} aria-label="Back to crew">←</button>{horse(worker)}
          <div className="crew-tray-copy"><strong>{worker.title}</strong><span>{brain(worker)}</span></div>
          <button type="button" className="tiny" onClick={() => { setSelected(null); desk.selectSession(worker.id); }}>Open chat ↗</button>
          <button type="button" className="tiny" aria-label="Close worker preview" onClick={() => setSelected(null)}>×</button>
        </header>
        <CrewConversation key={worker.id} worker={worker} />
        <form onSubmit={(event) => { event.preventDefault(); if (!draft.trim() || draft.trimStart().startsWith("/")) return;
          const result = desk.send(draft, { sessionId: worker.id });
          if (result !== false) setDrafts((current) => ({ ...current, [worker.id]: "" })); }}>
          <label htmlFor="crew-followup">Follow up with {worker.workerName || worker.title}</label>
          <div className="crew-followup"><textarea id="crew-followup" rows={2} value={draft} placeholder="Give this worker a follow-up…"
            onChange={(event) => setDrafts((current) => ({ ...current, [worker.id]: event.target.value }))} />
            <button type="submit" disabled={!draft.trim() || draft.trimStart().startsWith("/")}>{crewIsLive(worker) ? "Queue" : "Send"}</button></div>
          {draft.trimStart().startsWith("/") ? <small>Open this worker’s chat to use slash commands.</small> : null}
        </form>
      </div>
    </dialog> : null}
  </section>;
}

function CrewConversation({ worker }: { worker: Session }) {
  const [limit, setLimit] = useState(80);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [worker.messages]);
  return <div className="crew-conversation-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
    {worker.messages.length > limit ? <button className="tiny" type="button" onClick={() => { follow.current = false; setLimit(limit + 80); }}>Load earlier messages</button> : null}
    {worker.messages.slice(-limit).map((message) => <article key={message.id} className={`crew-message ${message.role}${message.kind ? " activity" : ""}`}>
      <span className="crew-message-label">{message.kind === "tool" ? "Tool activity" : message.kind === "thought" ? "Thinking" : message.role === "user" ? "Brief / follow-up" : message.role === "assistant" ? worker.workerName || "Worker" : "Status"}</span>
      <MessageBody text={message.text || message.thought || "Working…"} vendorSessionId={worker.vendorSessionId} />
    </article>)}
    {!worker.messages.length ? <p className="crew-empty">Waiting for this worker’s first activity.</p> : null}
    {worker.status === "needs-input" ? <p className="crew-empty">This worker needs you. Open its chat to review the request.</p> : null}
  </div>;
}

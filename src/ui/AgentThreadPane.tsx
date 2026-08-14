import { useEffect, useRef } from "react";
import { unsquashSentences } from "../lib/markdown";
import type { AgentThread } from "../lib/agent-thread";
import { THREAD_PANE } from "../lib/pane";
import { useStore } from "../lib/store";
import { MessageBody } from "./MessageBody";
import { SplitHandle } from "./SplitHandle";

export function AgentThreadPane({
  thread,
  threads,
  onSelect,
  onClose,
}: {
  thread: AgentThread;
  threads: AgentThread[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const store = useStore();
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.id, thread.turns.length, thread.turns.at(-1)?.text, thread.live]);

  return (
    <aside
      className="agent-thread"
      aria-label={`Conversation with ${thread.title}`}
      style={{
        flexBasis: store.threadWidth,
        width: store.threadWidth,
        maxWidth: THREAD_PANE.max,
        minWidth: THREAD_PANE.min,
      }}
    >
      <SplitHandle
        value={store.threadWidth}
        onChange={store.setThreadWidth}
        min={THREAD_PANE.min}
        max={THREAD_PANE.max}
        reset={THREAD_PANE.fallback}
        invert
        label="Resize conversation pane"
      />
      <header className="agent-thread-head">
        <div className="agent-thread-who">
          <div className="agent-thread-name">
            <span className={`dot ${thread.provider ?? "grok"}`} aria-hidden="true" />
            <strong>{thread.title}</strong>
          </div>
          <em>{thread.live ? "Talking now" : "Earlier this chat"}</em>
        </div>
        <button type="button" className="tiny" aria-label="Close agent conversation" onClick={onClose}>
          ×
        </button>
      </header>
      {threads.length > 1 ? (
        <div className="agent-thread-tabs" role="tablist">
          {threads.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={item.id === thread.id}
              className={item.id === thread.id ? "on" : undefined}
              onClick={() => onSelect(item.id)}
            >
              <span className={`dot ${item.provider ?? "grok"}${item.live ? " pulse" : ""}`} aria-hidden="true" />
              {item.title}
            </button>
          ))}
        </div>
      ) : null}
      <div className="agent-thread-scroll" ref={scroller}>
        {thread.run ? (
          <div className={`agent-thread-review${thread.run.conflictFiles?.length ? " conflict" : ""}`}>
            <strong>{thread.run.status} / {thread.run.isolation}</strong>
            <span>
              {thread.run.usedTokens !== undefined ? `${thread.run.usedTokens.toLocaleString()} tokens` : "No token total"}
              {thread.run.changedFiles?.length ? ` / ${thread.run.changedFiles.length} changed files` : ""}
            </span>
            {thread.run.conflictFiles?.length ? <em>{thread.run.conflictFiles.length} overlapping files need review</em> : null}
          </div>
        ) : null}
        {thread.error ? (
          <div className="agent-thread-warn" role="alert">
            <strong>Watch safety</strong>
            <span>{thread.error}</span>
          </div>
        ) : null}
        {thread.turns.length === 0 && !thread.error ? (
          <p className="agent-thread-wait">{thread.live ? `Waiting for ${thread.toLabel}…` : "No messages yet."}</p>
        ) : thread.turns.length === 0 ? null : (
          thread.turns.map((turn) =>
            turn.role === "user" ? (
              <article key={turn.id} className="agent-bubble from">
                <span className="agent-bubble-who">{turn.fromTitle || thread.fromLabel}</span>
                {turn.text.trim() ? <MessageBody text={turn.text} /> : null}
              </article>
            ) : (
              <article key={turn.id} className={`agent-bubble to${thread.live && !turn.text.trim() ? " live" : ""}`}>
                <span className="agent-bubble-who">{thread.toLabel}</span>
                {turn.text.trim() ? (
                  <MessageBody text={unsquashSentences(turn.text)} />
                ) : (
                  <p className="agent-thread-wait">Still working</p>
                )}
              </article>
            ),
          )
        )}
      </div>
    </aside>
  );
}

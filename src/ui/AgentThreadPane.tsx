import { useEffect, useMemo, useRef } from "react";
import { peelPlanningPreamble, unsquashSentences } from "../lib/markdown";
import type { AgentThread } from "../lib/agent-thread";
import { deskInk } from "../lib/settings";
import { brainCaption, brainStamp, messageBrain } from "../lib/session";
import { groupTranscript, isDeskNotice, lastReplyIndex, thoughtForReply } from "../lib/turns";
import { useStore } from "../lib/store";
import { copyText } from "../lib/copy-text";
import { ContextMeter } from "./ModelMenu";
import { MessageBody } from "./MessageBody";
import { TurnActions } from "./TurnActions";
import { UserTurn } from "./UserTurn";
import { WorkPopout } from "./WorkPopout";

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
  const followBottom = useRef(true);
  const threadInk = (item: AgentThread) => {
    const child = store.sessions.find((session) => session.id === item.childId);
    return child ? deskInk(child, store.settings) : undefined;
  };
  const openInk = threadInk(thread);
  const child = store.sessions.find((session) => session.id === thread.childId);
  const childBrain = child
    ? brainCaption(brainStamp(child), store.settings.customBots, store.settings.llms)
    : undefined;
  const blocks = useMemo(() => (child ? groupTranscript(child.messages) : []), [child]);
  const working = child?.status === "running";
  const liveIndex = working ? lastReplyIndex(blocks) : -1;

  useEffect(() => {
    followBottom.current = true;
  }, [thread.id]);

  useEffect(() => {
    const el = scroller.current;
    if (el && followBottom.current) el.scrollTop = el.scrollHeight;
  }, [thread.id, child?.messages, child?.status, thread.live]);

  return (
    <aside
      className="agent-thread compact-thread overlay"
      aria-label={`Conversation with ${thread.title}`}
    >
      <header className="agent-thread-head">
        <div className="agent-thread-who">
          <div className="agent-thread-name">
            <span
              className={`dot ${thread.provider ?? "grok"}`}
              style={openInk ? { background: openInk, color: openInk } : undefined}
              aria-hidden="true"
            />
            <strong>{thread.title}</strong>
          </div>
          <em>{[childBrain?.name, child?.effort, thread.live ? "Talking now" : "Earlier this chat"].filter(Boolean).join(" · ")}</em>
        </div>
        <div className="agent-thread-tools">
          {child ? <ContextMeter session={child} compact /> : null}
          <button type="button" className="tiny" aria-label="Close agent conversation" onClick={onClose}>
            ×
          </button>
        </div>
      </header>
      {threads.length > 1 ? (
        <div className="agent-thread-tabs" role="tablist">
          {threads.map((item) => (
            (() => {
              const tabChild = store.sessions.find((session) => session.id === item.childId);
              const tabBrain = tabChild
                ? brainCaption(brainStamp(tabChild), store.settings.customBots, store.settings.llms)
                : undefined;
              return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={item.id === thread.id}
              className={item.id === thread.id ? "on" : undefined}
              onClick={() => onSelect(item.id)}
            >
              <span
                className={`dot ${item.provider ?? "grok"}${item.live ? " pulse" : ""}`}
                style={threadInk(item) ? { background: threadInk(item), color: threadInk(item) } : undefined}
                aria-hidden="true"
              />
              <span>{item.title}</span>
              {tabBrain ? <em>{[tabBrain.name, tabChild?.effort].filter(Boolean).join(" · ")}</em> : null}
            </button>
              );
            })()
          ))}
        </div>
      ) : null}
      <div
        className="agent-thread-scroll"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (!el) return;
          followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 96;
        }}
      >
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
        {!child && !thread.error ? (
          <p className="agent-thread-wait">{thread.live ? `Waiting for ${thread.toLabel}…` : "No messages yet."}</p>
        ) : !child ? null : blocks.length === 0 ? (
          <p className="agent-thread-wait">{thread.live ? `Waiting for ${thread.toLabel}…` : "No messages yet."}</p>
        ) : (
          blocks.map((block, index) => {
            if (block.type === "user") {
              return <UserTurn key={block.message.id} message={block.message} readOnly />;
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
              messageBrain(block.assistant, brainStamp(child)),
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
                  startedAt={block.assistant.createdAt}
                  workedMs={block.assistant.workedMs}
                  live={live}
                />
                {body ? (
                  <div className={`say final${live ? " streaming" : ""}`}>
                    <MessageBody text={body} vendorSessionId={child.vendorSessionId} />
                    {!live ? (
                      <TurnActions actions={[{ id: "copy", label: "Copy", run: async () => { await copyText(body); } }]} />
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>
    </aside>
  );
}

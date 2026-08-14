import { useEffect, useState } from "react";
import { collapseToolText, splitToolLine, toolIsFinished } from "../lib/grok-events";
import { unsquashSentences } from "../lib/markdown";
import { subagentTurns } from "../lib/subagents";
import { describePeerTool, prettyToolStatus, prettyToolTitle, talkingToSummary, toolNameKey } from "../lib/tool-labels";
import { formatWorked } from "../lib/turns";
import type { ChatMessage, Session } from "../lib/types";
import { MessageBody } from "./MessageBody";

function ToolLine({ tool, peer }: { tool: ChatMessage; peer?: boolean }) {
  const line = splitToolLine(collapseToolText(tool.text, tool.toolStatus));
  const info = describePeerTool(line.title, line.detail);
  const title = info?.title || prettyToolTitle(line.title);
  const rawStatus = line.status || tool.toolStatus || "";
  const status = rawStatus ? prettyToolStatus(rawStatus) : "";
  const detail = info ? "" : line.detail;
  const live = !toolIsFinished(tool.toolStatus);
  return (
    <p className={`tool-line${live ? " live" : " done"}${peer || info ? " peer" : ""}`}>
      <span className="tool-name">{title}</span>
      {status && <span className="tool-status">{status}</span>}
      {detail && <span className="tool-loc">{detail}</span>}
    </p>
  );
}

export function WorkPopout({
  thought,
  tools,
  compacts,
  subagents,
  sessions,
  startedAt,
  workedMs,
  live,
  onOpenThread,
}: {
  thought?: string;
  tools: ChatMessage[];
  compacts: ChatMessage[];
  subagents?: ChatMessage[];
  sessions?: Session[];
  startedAt: number;
  workedMs?: number;
  live: boolean;
  onOpenThread?: (id: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [live]);

  const threads = subagents ?? [];
  const workTools = threads.length
    ? tools.filter((tool) => {
        const key = toolNameKey(splitToolLine(tool.text).title);
        return key !== "spawn_agent" && key !== "request_vendor";
      })
    : tools;
  const hasInner = Boolean(thought?.trim() || workTools.length || compacts.length || threads.length);
  const hasWork = hasInner || live;
  if (!hasWork) return null;

  const elapsed = live ? now - startedAt : workedMs;
  const label = live
    ? `Working · ${formatWorked(elapsed ?? 0)}`
    : elapsed != null
      ? `Worked ${formatWorked(elapsed)}`
      : "Work";
  const peerTools = workTools.filter((tool) => {
    const line = splitToolLine(tool.text);
    const info = describePeerTool(line.title, line.detail);
    if (!info) return false;
    if (threads.length && (info.kind === "call" || info.kind === "ask")) return false;
    return true;
  });
  const otherTools = workTools.filter((tool) => !peerTools.some((item) => item.id === tool.id));
  const talking = talkingToSummary(peerTools);
  const summary = [
    label,
    talking,
    otherTools.length > 0
      ? `${otherTools.length} ${talking ? "other " : ""}${otherTools.length === 1 ? "tool" : "tools"}`
      : !talking && tools.length > 0
        ? `${tools.length} ${tools.length === 1 ? "tool" : "tools"}`
        : "",
    threads.length > 0 ? `${threads.length} ${threads.length === 1 ? "subagent" : "subagents"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const active = otherTools.filter((tool) => !toolIsFinished(tool.toolStatus));
  const finished = otherTools.filter((tool) => toolIsFinished(tool.toolStatus));
  const doneCount = finished.length + compacts.length;

  return (
    <details className="work-pop" open={live}>
      <summary>{summary}</summary>
      {hasInner ? (
        <div className="work-body">
          {thought?.trim() ? (
            live ? (
              <div className="thought-live">
                <span className="thought-live-label">Thinking</span>
                <div className="thought">
                  <MessageBody text={unsquashSentences(thought)} />
                </div>
              </div>
            ) : (
              <details className="work-fold">
                <summary>Thought</summary>
                <div className="thought">
                  <MessageBody text={unsquashSentences(thought)} />
                </div>
              </details>
            )
          ) : null}
          {peerTools.length > 0 ? (
            <div className="peer-work">
              <span className="peer-work-label">Other chats</span>
              {peerTools.map((tool) => (
                <ToolLine key={tool.id} tool={tool} peer />
              ))}
              {onOpenThread && threads[0]?.subagentSessionId ? (
                <button type="button" className="peer-open" onClick={() => onOpenThread(threads[0]!.subagentSessionId!)}>
                  Open conversation
                </button>
              ) : onOpenThread &&
                peerTools.some((tool) => {
                  const line = splitToolLine(tool.text);
                  const info = describePeerTool(line.title, line.detail);
                  return info?.kind === "ask" || info?.kind === "call";
                }) ? (
                <button type="button" className="peer-open" onClick={() => onOpenThread(`pending:${peerTools[0]!.id}`)}>
                  Open conversation
                </button>
              ) : null}
            </div>
          ) : null}
          {threads.map((marker) => {
            const child = sessions?.find((item) => item.id === marker.subagentSessionId);
            const turns = subagentTurns(child, marker.createdAt);
            const childLive = child?.status === "running" || child?.status === "needs-input" || marker.toolStatus === "running";
            const title = marker.fromTitle || marker.text || child?.title || "Subagent";
            return (
              <details key={marker.id} className="work-fold subagent">
                <summary
                  onClick={(event) => {
                    if (!onOpenThread || !marker.subagentSessionId) return;
                    event.preventDefault();
                    onOpenThread(marker.subagentSessionId);
                  }}
                >
                  {title}
                  <span className="tool-status">{childLive ? "working" : marker.toolStatus === "failed" ? "failed" : "done"}</span>
                </summary>
                <div className="subagent-thread">
                  {turns.length === 0 ? (
                    <p className="tool-line live">
                      <span className="tool-name">Waiting for the other agent</span>
                    </p>
                  ) : (
                    turns.map((turn) =>
                      turn.role === "user" ? (
                        <article key={turn.id} className="turn user chat peer subagent-turn">
                          <div className="say">
                            <span className="peer-from">From {turn.fromTitle || "another agent"}</span>
                            {turn.text.trim() ? (
                              <MessageBody
                                text={turn.text}
                                vendorSessionId={child?.vendorSessionId}
                              />
                            ) : null}
                          </div>
                        </article>
                      ) : (
                        <article key={turn.id} className="turn assistant reply subagent-turn">
                          <div className="say final">
                            {turn.text.trim() ? (
                              <MessageBody
                                text={unsquashSentences(turn.text)}
                                vendorSessionId={child?.vendorSessionId}
                              />
                            ) : (
                              <p className="work-draft-text">Still working</p>
                            )}
                          </div>
                        </article>
                      ),
                    )
                  )}
                </div>
              </details>
            );
          })}
          {active.map((tool) => (
            <ToolLine key={tool.id} tool={tool} />
          ))}
          {doneCount > 0 ? (
            <details className="work-fold">
              <summary>
                {doneCount} finished
              </summary>
              {finished.map((tool) => (
                <ToolLine key={tool.id} tool={tool} />
              ))}
              {compacts.map((item) => (
                <p key={item.id} className="tool-line done">
                  <span className="tool-name">Compact</span>
                  <span className="tool-loc">{item.text}</span>
                </p>
              ))}
            </details>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

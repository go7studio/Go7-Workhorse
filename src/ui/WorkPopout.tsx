import { useEffect, useState } from "react";
import { collapseToolText, splitToolLine, toolIsFinished } from "../lib/grok-events";
import { unsquashSentences } from "../lib/markdown";
import { deskInk } from "../lib/settings";
import { brainCaption, brainStamp } from "../lib/session";
import { useStore } from "../lib/store";
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
  const store = useStore();
  const [now, setNow] = useState(Date.now());
  const threads = subagents ?? [];
  const anyChildLive = threads.some((marker) => {
    const child = sessions?.find((item) => item.id === marker.subagentSessionId);
    return child?.status === "running" || child?.status === "needs-input" || marker.toolStatus === "running";
  });
  useEffect(() => {
    if (!live && !anyChildLive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [live, anyChildLive]);
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
            const childLive = child?.status === "running" || child?.status === "needs-input" || marker.toolStatus === "running";
            const title = marker.fromTitle || marker.text || child?.title || "Subagent";
            const ink = child ? deskInk(child, store.settings) : undefined;
            const brain = child
              ? brainCaption(brainStamp(child), store.settings.customBots, store.settings.llms)
              : undefined;
            const stepId = child?.agentRun?.planStepId;
            const planStep = stepId
              ? store.sessions.flatMap((session) => session.planRun?.steps ?? []).find((step) => step.id === stepId)
              : undefined;
            const childMs = childLive ? now - marker.createdAt : undefined;
            return (
              <p key={marker.id} className="tool-line subagent-preview">
                <button
                  type="button"
                  className="subagent-open"
                  onClick={() => {
                    const id = marker.subagentSessionId;
                    if (!id) return;
                    if (onOpenThread) onOpenThread(id);
                    store.selectSession(id);
                  }}
                >
                  <span
                    className={`dot ${child?.provider ?? "custom"}`}
                    style={ink ? { background: ink, color: ink } : undefined}
                    aria-hidden="true"
                  />
                  <span className="tool-name">{title}</span>
                  {brain ? <span className="subagent-model">{[brain.name, child?.effort].filter(Boolean).join(" · ")}</span> : null}
                  {child?.agentRun?.constraints?.length ? (
                    <span className="subagent-scope">{child.agentRun.constraints.join(" · ")}</span>
                  ) : null}
                  {planStep ? <span className="subagent-task">{planStep.title}</span> : null}
                  <span className="tool-status">
                    {childLive
                      ? `working · ${formatWorked(childMs ?? 0)}`
                      : marker.toolStatus === "failed"
                        ? "failed"
                        : "done"}
                  </span>
                </button>
              </p>
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

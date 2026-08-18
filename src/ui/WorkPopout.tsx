import { useEffect, useState } from "react";
import { collapseToolText, splitToolLine, toolIsFinished } from "../lib/grok-events";
import { unsquashSentences } from "../lib/markdown";
import { deskInk } from "../lib/settings";
import { brainCaption, brainStamp } from "../lib/session";
import { useStore } from "../lib/store";
import { describePeerTool, prettyToolStatus, prettyToolTitle, talkingToSummary, toolNameKey } from "../lib/tool-labels";
import { formatWorked, groupWorkRows, isActiveWorkRow, resolveWorkedMs, type DisplayWorkStep } from "../lib/turns";
import type { ChatMessage, Session } from "../lib/types";
import { MessageBody } from "./MessageBody";
import { TimeStamp } from "./TimeStamp";

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

function foldOpen(active: boolean): { open?: true } {
  return active ? { open: true } : {};
}

function ThoughtBlock({ text, live, id }: { text: string; live: boolean; id: string }) {
  return (
    <details key={`${id}-${live ? "live" : "idle"}`} className={`work-fold${live ? " thought-live" : ""}`} {...foldOpen(live)}>
      <summary className={live ? "thought-live-label" : undefined}>{live ? "Thinking" : "Thought"}</summary>
      <div className="thought">
        <MessageBody text={unsquashSentences(text)} />
      </div>
    </details>
  );
}

function isSpawnTool(tool: ChatMessage): boolean {
  const key = toolNameKey(splitToolLine(tool.text).title);
  return key === "spawn_agent" || key === "request_vendor";
}

function isPeerTool(tool: ChatMessage): boolean {
  const line = splitToolLine(tool.text);
  return Boolean(describePeerTool(line.title, line.detail));
}

export function WorkPopout({
  steps,
  sessions,
  startedAt,
  workedMs,
  live,
  onOpenThread,
}: {
  steps: DisplayWorkStep[];
  sessions?: Session[];
  startedAt: number;
  workedMs?: number;
  live: boolean;
  onOpenThread?: (id: string) => void;
}) {
  const store = useStore();
  const [now, setNow] = useState(Date.now());
  const threads = steps.filter((step) => step.type === "subagent").map((step) => step.message);
  const tools = steps.filter((step) => step.type === "tool").map((step) => step.message);
  const anyChildLive = threads.some((marker) => {
    const child = sessions?.find((item) => item.id === marker.subagentSessionId);
    return child?.status === "running" || child?.status === "needs-input" || marker.toolStatus === "running";
  });
  useEffect(() => {
    if (!live && !anyChildLive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [live, anyChildLive]);
  const workTools = threads.length ? tools.filter((tool) => !isSpawnTool(tool)) : tools;
  const visible = steps.filter((step) => {
    if (step.type === "tool" && threads.length && isSpawnTool(step.message)) return false;
    if (step.type === "tool" && threads.length) {
      const info = describePeerTool(splitToolLine(step.message.text).title, splitToolLine(step.message.text).detail);
      if (info?.kind === "call" || info?.kind === "ask") return false;
    }
    return true;
  });
  const hasInner = visible.length > 0;
  const hasWork = hasInner || live;
  const stamp = <TimeStamp at={startedAt} />;
  if (!hasWork) return stamp;

  const elapsed = live
    ? now - startedAt
    : resolveWorkedMs(
        startedAt,
        workedMs,
        visible.flatMap((step) => (step.type === "thought" ? [] : [step.message.createdAt])),
      );
  const label = live
    ? `Working · ${formatWorked(elapsed ?? 0)}`
    : elapsed != null
    ? `Worked ${formatWorked(elapsed)}`
    : "Work";
  const peerTools = workTools.filter((tool) => isPeerTool(tool));
  const otherTools = workTools.filter((tool) => !peerTools.some((item) => item.id === tool.id));
  const talking = talkingToSummary(peerTools);
  const summary = [
    label,
    talking,
    otherTools.length > 0
      ? `${otherTools.length} ${talking ? "other " : ""}${otherTools.length === 1 ? "tool" : "tools"}`
      : !talking && workTools.length > 0
        ? `${workTools.length} ${workTools.length === 1 ? "tool" : "tools"}`
        : "",
    threads.length > 0 ? `${threads.length} ${threads.length === 1 ? "subagent" : "subagents"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const rows = groupWorkRows(visible);

  return (
    <details className="work-pop">
      <summary>
        {summary}
        {stamp}
      </summary>
      {hasInner ? (
        <div className="work-body">
          {rows.map((row, rowIndex) => {
            const active = isActiveWorkRow(rows, rowIndex, live);
            if (row.type === "thought") {
              return (
                <div key={row.step.id} className="work-step" data-kind="thought">
                  <ThoughtBlock text={row.step.text} live={active} id={row.step.id} />
                </div>
              );
            }
            if (row.type === "compact") {
              return (
                <p key={row.step.message.id} className="tool-line done work-step" data-kind="compact">
                  <span className="tool-name">Compact</span>
                  <span className="tool-loc">{row.step.message.text}</span>
                </p>
              );
            }
            if (row.type === "subagent") {
              const marker = row.step.message;
              const child = sessions?.find((item) => item.id === marker.subagentSessionId);
              const childLive =
                child?.status === "running" || child?.status === "needs-input" || marker.toolStatus === "running";
              const title = marker.fromTitle || marker.text || child?.title || "Subagent";
              const ink = child ? deskInk(child, store.settings) : undefined;
              const brain = child
                ? brainCaption(brainStamp(child), store.settings.customBots, store.settings.llms)
                : undefined;
              const stepId = child?.agentRun?.planStepId;
              const planStep = stepId
                ? store.sessions.flatMap((session) => session.planRun?.steps ?? []).find((item) => item.id === stepId)
                : undefined;
              const childMs = childLive ? now - marker.createdAt : undefined;
              return (
                <p key={marker.id} className="tool-line subagent-preview work-step" data-kind="subagent">
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
                        : child?.agentRun?.status === "interrupted"
                          ? "interrupted"
                          : marker.toolStatus === "failed"
                            ? "failed"
                            : "done"}
                    </span>
                  </button>
                  {/* The desk stopped this worker, so the desk offers it back.
                      Its brief, its transcript and its folder are all still
                      here; without a way to press, they were just lost. */}
                  {child?.agentRun?.status === "interrupted" ? (
                    <button
                      type="button"
                      className="tiny subagent-resume"
                      title="Send this worker's brief again and carry on from what it already did"
                      onClick={() => store.resumeAgentRun(child.id)}
                    >
                      Resume
                    </button>
                  ) : null}
                </p>
              );
            }
            const count = row.items.length;
            const firstId = row.items[0]?.step.message.id ?? `tools-${rowIndex}`;
            return (
              <details
                key={`${firstId}-${active ? "live" : "idle"}`}
                className="work-fold work-step"
                data-kind="tool"
                {...foldOpen(active)}
              >
                <summary>
                  {count} {count === 1 ? "tool" : "tools"}
                </summary>
                <div className="work-fold-body">
                  {row.items.map((item) => {
                    const step = item.step;
                    const index = item.index;
                    const peer = isPeerTool(step.message);
                    const line = splitToolLine(step.message.text);
                    const info = describePeerTool(line.title, line.detail);
                    const showOpen =
                      Boolean(onOpenThread) &&
                      (info?.kind === "ask" || info?.kind === "call") &&
                      !visible.slice(0, index).some((prev) => {
                        if (prev.type !== "tool") return false;
                        const earlier = describePeerTool(
                          splitToolLine(prev.message.text).title,
                          splitToolLine(prev.message.text).detail,
                        );
                        return earlier?.kind === "ask" || earlier?.kind === "call";
                      });
                    return (
                      <div key={step.message.id}>
                        {peer &&
                        !visible.slice(0, index).some((prev) => prev.type === "tool" && isPeerTool(prev.message)) ? (
                          <div className="peer-work">
                            <span className="peer-work-label">Other chats</span>
                            <ToolLine tool={step.message} peer />
                          </div>
                        ) : (
                          <ToolLine tool={step.message} peer={peer} />
                        )}
                        {showOpen && threads[0]?.subagentSessionId ? (
                          <button
                            type="button"
                            className="peer-open"
                            onClick={() => onOpenThread?.(threads[0]!.subagentSessionId!)}
                          >
                            Open conversation
                          </button>
                        ) : showOpen ? (
                          <button
                            type="button"
                            className="peer-open"
                            onClick={() => onOpenThread?.(`pending:${step.message.id}`)}
                          >
                            Open conversation
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </details>
            );
          })}
        </div>
      ) : null}
    </details>
  );
}

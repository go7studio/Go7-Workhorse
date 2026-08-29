import { memo, useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";
import { collapseToolText, splitToolLine, toolIsFinished } from "../lib/grok-events";
import { unsquashSentences } from "../lib/markdown";
import { deskInk } from "../lib/settings";
import { brainCaption, brainStamp } from "../lib/session";
import { useStore } from "../lib/store";
import { subagentTurns, workerTaskTitle } from "../lib/subagents";
import { describePeerTool, prettyToolStatus, prettyToolTitle, talkingToSummary, toolNameKey } from "../lib/tool-labels";
import { displayWorkSteps, formatWorked, groupWorkRows, isActiveWorkRow, packWorkRows, earlierWorkLabel, resolveWorkedMs, type DisplayWorkStep, type GroupedWorkRow, type TranscriptBlock } from "../lib/turns";
import type { ChatMessage } from "../lib/types";
import { MessageBody } from "./MessageBody";
import { TimeStamp } from "./TimeStamp";

function toolStatusFailed(status: string | undefined): boolean {
  return prettyToolStatus(status) === "failed" || status === "failed";
}

/** Same identity the nested sidebar shows: `Name · slice`, never a slice fragment. */
export function workerFoldLabel(
  marker: { fromTitle?: string; text?: string },
  child?: { title?: string; workerName?: string } | null,
): string {
  const stored = child?.title?.trim();
  if (stored) return stored;
  const slice = (marker.fromTitle || marker.text || "").trim();
  const name = child?.workerName?.trim();
  if (name && slice && slice !== name) return workerTaskTitle(name, slice);
  return slice || name || "Subagent";
}

function ToolLine({ tool, peer }: { tool: ChatMessage; peer?: boolean }) {
  const line = splitToolLine(collapseToolText(tool.text, tool.toolStatus));
  const info = describePeerTool(line.title, line.detail);
  const title = info?.title || prettyToolTitle(line.title);
  const rawStatus = line.status || tool.toolStatus || "";
  const status = rawStatus ? prettyToolStatus(rawStatus) : "";
  const detail = info ? "" : line.detail;
  const live = !toolIsFinished(tool.toolStatus);
  const failed = toolStatusFailed(rawStatus) || toolStatusFailed(tool.toolStatus);
  return (
    <p className={`tool-line${live ? " live" : " done"}${peer || info ? " peer" : ""}${failed ? " failed" : ""}`}>
      <span className="tool-name" title={title}>
        {title}
      </span>
      {status && <span className={`tool-status${failed ? " failed" : ""}`}>{status}</span>}
      {detail && <span className="tool-loc">{detail}</span>}
    </p>
  );
}

function foldOpen(active: boolean): { open?: true } {
  return active ? { open: true } : {};
}

function useFoldOpen(initial = false) {
  const [open, setOpen] = useState(initial);
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(event.currentTarget.open);
  };
  return { open, onToggle };
}

function useStartOpen(start: boolean) {
  const fold = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    if (start && fold.current) fold.current.open = true;
  }, [start]);
  return fold;
}

function ThoughtBlock({ text, live, id, reveal = false }: { text: string; live: boolean; id: string; reveal?: boolean }) {
  const { open, onToggle } = useFoldOpen(live || reveal);
  const fold = useStartOpen(live || reveal);
  return (
    <details
      key={`${id}-${live ? "live" : "idle"}`}
      ref={fold}
      className={`work-fold${live ? " thought-live" : ""}`}
      {...foldOpen(live)}
      onToggle={onToggle}
    >
      <summary className={live ? "thought-live-label" : undefined}>{live ? "Thinking" : "Thought"}</summary>
      {open || live ? (
        <div className="thought">
          <MessageBody text={unsquashSentences(text)} />
        </div>
      ) : null}
    </details>
  );
}

function workRowKey(row: GroupedWorkRow, index: number): string {
  if (row.type === "thought") return row.step.id;
  if (row.type === "tools") return row.items[0]?.step.message.id ?? `tools-${index}`;
  return row.step.message.id;
}

function SubagentRow({
  marker,
  now,
  onOpenThread,
}: {
  marker: ChatMessage;
  now: number;
  onOpenThread?: (id: string) => void;
}) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const child = store.sessions.find((item) => item.id === marker.subagentSessionId);
  const childLive =
    child?.status === "running" || child?.status === "needs-input" || marker.toolStatus === "running";
  const title = workerFoldLabel(marker, child);
  const failed =
    !childLive &&
    child?.agentRun?.executionOwner !== "parent" &&
    child?.agentRun?.status !== "interrupted" &&
    (marker.toolStatus === "failed" || child?.agentRun?.status === "failed");
  const ink = child ? deskInk(child, store.settings) : undefined;
  const brain = child
    ? brainCaption(brainStamp(child), store.settings.customBots, store.settings.llms)
    : undefined;
  const stepId = child?.agentRun?.planStepId;
  const planStep = stepId
    ? store.sessions.find((session) => session.planRun?.steps?.some((item) => item.id === stepId))?.planRun?.steps?.find((item) => item.id === stepId)
    : undefined;
  const childMs = childLive ? now - marker.createdAt : undefined;
  const turns = subagentTurns(child, marker.createdAt);
  return (
    <div className={`subagent-preview work-step${failed ? " failed" : ""}${open ? " open" : ""}`} data-kind="subagent">
      <div className="tool-line subagent-head">
        <button
          type="button"
          className="subagent-open"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
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
          {child?.agentRun?.paths?.length ? (
            <span className="subagent-scope">Paths: {child.agentRun.paths.join(" · ")}</span>
          ) : null}
          {planStep ? <span className="subagent-task">{planStep.title}</span> : null}
          <span className={`tool-status${failed ? " failed" : ""}`}>
            {childLive
              ? `working · ${formatWorked(childMs ?? 0)}`
              : child?.agentRun?.executionOwner === "parent"
                ? "parent took over"
                : child?.agentRun?.status === "interrupted"
                  ? "interrupted"
                  : failed
                    ? "failed"
                    : "done"}
          </span>
        </button>
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
      </div>
      <div className="subagent-thread-slot" aria-hidden={!open}>
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
                    {turn.text.trim() ? <MessageBody text={turn.text} vendorSessionId={child?.vendorSessionId} /> : null}
                  </div>
                </article>
              ) : (
                <article key={turn.id} className="turn assistant reply subagent-turn">
                  <div className="say final">
                    {turn.text.trim() ? (
                      <MessageBody text={unsquashSentences(turn.text)} vendorSessionId={child?.vendorSessionId} />
                    ) : (
                      <p className="work-draft-text">Still working</p>
                    )}
                  </div>
                </article>
              ),
            )
          )}
          {onOpenThread && marker.subagentSessionId ? (
            <button type="button" className="peer-open" onClick={() => onOpenThread(marker.subagentSessionId!)}>
              Open conversation
            </button>
          ) : null}
        </div>
      </div>
    </div>
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

function WorkRow({
  row,
  rowIndex,
  active,
  reveal = false,
  visible,
  threads,
  onOpenThread,
  now,
}: {
  row: GroupedWorkRow;
  rowIndex: number;
  active: boolean;
  reveal?: boolean;
  visible: DisplayWorkStep[];
  threads: ChatMessage[];
  onOpenThread?: (id: string) => void;
  now: number;
}) {
  const toolsFold = useStartOpen(active || reveal);
  if (row.type === "thought") {
    return (
      <div key={row.step.id} className="work-step" data-kind="thought">
        <ThoughtBlock text={row.step.text} live={active} id={row.step.id} reveal={reveal} />
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
    return <SubagentRow marker={row.step.message} now={now} onOpenThread={onOpenThread} />;
  }
  const count = row.items.length;
  const firstId = row.items[0]?.step.message.id ?? `tools-${rowIndex}`;
  if (count === 1) {
    const only = row.items[0]!.step.message;
    return (
      <div key={`${firstId}-${active ? "live" : "idle"}`} className="work-step" data-kind="tool">
        <ToolLine tool={only} peer={isPeerTool(only)} />
      </div>
    );
  }
  return (
    <details
      key={`${firstId}-${active ? "live" : "idle"}`}
      ref={toolsFold}
      className="work-fold work-step"
      data-kind="tool"
      {...foldOpen(active)}
    >
      <summary>
        {count} tools
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
}

function hideSpawnTool(message: ChatMessage, hasThreads: boolean): boolean {
  if (!hasThreads) return false;
  if (isSpawnTool(message)) return true;
  const info = describePeerTool(splitToolLine(message.text).title, splitToolLine(message.text).detail);
  return info?.kind === "call" || info?.kind === "ask";
}

export const WorkPopout = memo(function WorkPopout({
  block,
  peeled,
  startedAt,
  workedMs,
  live,
  onOpenThread,
}: {
  block: Extract<TranscriptBlock, { type: "reply" }>;
  peeled?: { thought: string; body: string };
  startedAt: number;
  workedMs?: number;
  live: boolean;
  onOpenThread?: (id: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const { open: bodyOpen, onToggle: onBodyToggle } = useFoldOpen(false);
  const { open: earlierOpen, onToggle: onEarlierToggle } = useFoldOpen(false);
  const threads = block.subagents;
  const tools = block.tools;
  const anyChildLive = threads.some((marker) => marker.toolStatus === "running");
  useEffect(() => {
    if (!live && !anyChildLive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [live, anyChildLive]);
  const workTools = threads.length ? tools.filter((tool) => !isSpawnTool(tool)) : tools;
  const hasInner = block.steps.some((step) => step.type !== "tool" || !hideSpawnTool(step.message, threads.length > 0));
  const steps = bodyOpen && hasInner ? displayWorkSteps(block, { live, peeled }) : [];
  const visible = steps.filter((step) => {
    if (step.type === "tool" && hideSpawnTool(step.message, threads.length > 0)) return false;
    return true;
  });
  const hasWork = hasInner || live;
  const stamp = <TimeStamp at={startedAt} />;
  if (!hasWork) return stamp;

  const elapsed = live
    ? now - startedAt
    : resolveWorkedMs(
        startedAt,
        workedMs,
        [...tools, ...block.compacts, ...threads].map((message) => message.createdAt),
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
  const packed = packWorkRows(rows);

  return (
    <details className="work-pop" onToggle={onBodyToggle}>
      <summary>
        {summary}
        {stamp}
      </summary>
      {bodyOpen && hasInner ? (
        <div className="work-body">
          {packed.earlier.length > 0 ? (
            <details className="work-fold work-step" data-kind="earlier" onToggle={onEarlierToggle}>
              <summary>{earlierWorkLabel(packed.earlier)}</summary>
              {earlierOpen ? (
              <div className="work-fold-body">
                {packed.earlier.map((row, rowIndex) => (
                  <WorkRow
                    key={workRowKey(row, rowIndex)}
                    row={row}
                    rowIndex={rowIndex}
                    active={false}
                    visible={visible}
                    threads={threads}
                    onOpenThread={onOpenThread}
                    now={now}
                  />
                ))}
              </div>
              ) : null}
            </details>
          ) : null}
          {packed.tail.map((row, tailIndex) => {
            const rowIndex = packed.earlier.length + tailIndex;
            return (
              <WorkRow
                key={workRowKey(row, rowIndex)}
                row={row}
                rowIndex={rowIndex}
                active={isActiveWorkRow(rows, rowIndex, live)}
                reveal={tailIndex === packed.tail.length - 1}
                visible={visible}
                threads={threads}
                onOpenThread={onOpenThread}
                now={now}
              />
            );
          })}
        </div>
      ) : null}
    </details>
  );
});

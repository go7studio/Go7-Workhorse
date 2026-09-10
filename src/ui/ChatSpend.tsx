import { useEffect, useMemo, useRef, useState } from "react";
import { useStoreSelector } from "../lib/store";
import { sameChatSpendDesk, selectChatSpendDesk } from "../lib/store-select";
import { workerNameFromTitle } from "../lib/subagents";
import { crewSpendRows, crewSpendTotal, formatIoLine, formatTokens } from "../lib/usage";
import { placeContextPop } from "./ContextMeter";

export function spendWorkerLabel(title: string): string {
  const named = workerNameFromTitle(title);
  if (named) return named;
  const head = title.split(/\s[·]\s/, 1)[0]?.trim() ?? title;
  const dashed = head.split(/\s-\s/, 1)[0]?.trim() ?? head;
  return dashed || title;
}

/** Grey line under this chat's spend. Named workers on this chat. */
export function crewSpendCaption(tokens: number): string {
  return `Crew ${formatTokens(tokens)}`;
}

export function ChatSpend() {
  const desk = useStoreSelector(selectChatSpendDesk, sameChatSpendDesk);
  const session = desk.session;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () =>
      crewSpendRows(
        desk.usage,
        session?.id,
        desk.workers.map((worker) => ({ id: worker.id, label: spendWorkerLabel(worker.title) })),
      ),
    [desk.usage, desk.workers, session?.id],
  );
  const chat = rows.find((row) => row.kind === "chat");
  const workers = rows.filter((row) => row.kind === "worker");
  const billedWorkers = workers.filter((row) => row.totals.totalTokens > 0 || row.totals.events > 0);
  const crew = crewSpendTotal(rows);
  const spentTokens = chat?.totals.totalTokens ?? 0;

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const box = root.current?.getBoundingClientRect();
      if (!box) return;
      const popBox = pop.current?.getBoundingClientRect();
      setAnchor(
        placeContextPop({
          meter: box,
          pop: { width: popBox?.width || 320, height: popBox?.height || 220 },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      );
    };
    place();
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const timer = window.setTimeout(() => document.addEventListener("mousedown", onPointer), 0);
    window.addEventListener("resize", place);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open, rows.length]);

  useEffect(() => {
    setOpen(false);
  }, [session?.id]);

  if (!session || (spentTokens <= 0 && billedWorkers.length === 0)) return null;
  const botsTotal = crewSpendTotal(billedWorkers).totalTokens;
  const title =
    billedWorkers.length > 0
      ? `${spentTokens.toLocaleString()} billed on this chat · click for each bot`
      : `${spentTokens.toLocaleString()} billed on this chat`;

  return (
    <div className="chat-spend-wrap" ref={root}>
      <button
        type="button"
        className="chat-spend"
        title={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {spentTokens > 0 ? <strong>{formatTokens(spentTokens)} spent</strong> : null}
        {botsTotal > 0 ? <em>{crewSpendCaption(botsTotal)}</em> : null}
      </button>
      {open && (
        <div
          ref={pop}
          className="context-pop chat-spend-pop"
          role="dialog"
          aria-label="Spend on this chat"
          style={anchor ? { top: anchor.top, left: anchor.left } : { top: 56, left: 12 }}
        >
          <header>
            <strong>Spent</strong>
            <span>
              {formatTokens(crew.totalTokens)} billed
              {workers.length > 0 ? " on this chat and crew" : " on this chat"}
            </span>
          </header>
          <ul className="context-rows">
            {rows.map((row) => (
              <li key={row.sessionId}>
                <span>
                  {row.label}
                  {row.totals.events > 0 ? <em>{formatIoLine(row.totals)}</em> : <em>No token data</em>}
                </span>
                <strong>{formatTokens(row.totals.totalTokens)}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

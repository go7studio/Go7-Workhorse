import { useEffect, useState } from "react";
import { formatLastTalked, formatLastTalkedFull } from "../lib/chats";

export function TimeStamp({
  at,
  className = "turn-stamp",
}: {
  at?: number;
  className?: string;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const label = formatLastTalked(at);
  if (!label || typeof at !== "number") return null;
  return (
    <time className={className} dateTime={new Date(at).toISOString()} title={formatLastTalkedFull(at)}>
      {label}
    </time>
  );
}

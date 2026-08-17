import { formatLastTalked, formatLastTalkedFull } from "../lib/chats";

export function TimeStamp({
  at,
  className = "turn-stamp",
}: {
  at?: number;
  className?: string;
}) {
  const label = formatLastTalked(at);
  if (!label || typeof at !== "number") return null;
  return (
    <time className={className} dateTime={new Date(at).toISOString()} title={formatLastTalkedFull(at)}>
      {label}
    </time>
  );
}

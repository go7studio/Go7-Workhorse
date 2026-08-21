import { useState } from "react";
import { crewDotClass, type CrewDotKind } from "./ChatRow";

const SAMPLES: Array<{
  kind: CrewDotKind;
  provider: "grok" | "codex" | "claude" | "cursor" | "custom";
  title: string;
  meta: string;
}> = [
  { kind: "working", provider: "grok", title: "Working", meta: "Grok 4.6 · High" },
  { kind: "idle", provider: "codex", title: "Done", meta: "GPT-5.6-Terra · Medium" },
  { kind: "failed", provider: "claude", title: "Failed", meta: "Sonnet 4.6 · High" },
  { kind: "stopped", provider: "cursor", title: "Cancelled", meta: "Composer 2.5 · Medium" },
  { kind: "needs-you", provider: "custom", title: "Needs you", meta: "MiniMax · High" },
];

/** Sidebar gallery so every crew-dot treatment is on screen at once. */
export function CrewDotPreview() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div className="crew-dot-preview">
      <div className="section-label">
        Crew dots
        <button className="tiny" type="button" onClick={() => setOpen(false)}>
          Hide
        </button>
      </div>
      {SAMPLES.map((sample) => (
        <div key={sample.kind} className="chat-row nested-worker">
          <div className="row chat-open">
            <span className={`dot ${sample.provider}${crewDotClass(sample.kind)}`} />
            <span>
              <span className="row-title">{sample.title}</span>
              <span className="row-meta">{sample.meta}</span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  EFFORTS,
  MODEL_CATALOG,
  contextWindowFor,
  findModel,
  formatWindow,
  modelName,
} from "../lib/models";
import { PROVIDERS } from "../lib/providers";
import { useActiveSession, useStore } from "../lib/store";
import type { EffortLevel } from "../lib/types";

function ContextMeter() {
  const session = useActiveSession();
  const customWindow = useStore().settings?.llms.custom.contextWindow;
  if (!session) return null;
  const windowSize = contextWindowFor(session.provider, session.model, customWindow);
  const used = session.contextUsed ?? 0;
  const ratio = Math.min(1, used / Math.max(windowSize, 1));

  return (
    <div className="context-meter" title={`${used.toLocaleString()} of ${windowSize.toLocaleString()} tokens`}>
      <span className="brain-label">Context</span>
      <span className="context-track" aria-hidden="true">
        <i style={{ width: `${Math.max(ratio * 100, used > 0 ? 4 : 0)}%` }} />
      </span>
      <span className="brain-value">
        {used > 0 ? `${formatWindow(used)} / ` : ""}
        {formatWindow(windowSize)}
      </span>
    </div>
  );
}

function BrainSlider() {
  const session = useActiveSession();
  const { setSessionEffort } = useStore();
  if (!session) return null;
  if (!findModel(session.provider, session.model)?.effort) return null;

  const index = Math.max(0, EFFORTS.findIndex((item) => item.id === session.effort));

  return (
    <div className="brain">
      <span className="brain-label">Brain</span>
      <label className="brain-track">
        <span className="brain-dots" aria-hidden="true">
          {EFFORTS.map((item) => (
            <i key={item.id} className={item.id === session.effort ? "on" : undefined} />
          ))}
        </span>
        <input
          type="range"
          min={0}
          max={EFFORTS.length - 1}
          step={1}
          value={index}
          aria-label="Brain level"
          onChange={(event) => {
            const next = EFFORTS[Number(event.target.value)]?.id as EffortLevel | undefined;
            if (next) setSessionEffort(next);
          }}
        />
      </label>
      <span className="brain-value">{EFFORTS[index]?.label ?? "Medium"}</span>
    </div>
  );
}

export function ModelMenu() {
  const session = useActiveSession();
  const { setSessionModel } = useStore();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  if (!session) return null;

  return (
    <div className="chat-bar-ai">
      <div className="model-menu" ref={root}>
        <button
          className="model-trigger"
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => setOpen((value) => !value)}
        >
          <span className={`dot ${session.provider}`} />
          <strong>{modelName(session.provider, session.model)}</strong>
          <span className="caret" aria-hidden="true" />
        </button>
        {open && (
          <div className="model-pop" role="listbox">
            {PROVIDERS.map((provider) => (
              <div key={provider.id} className="model-group">
                <div className="section-label">{provider.name}</div>
                {MODEL_CATALOG[provider.id].map((model) => {
                  const active = session.provider === provider.id && session.model === model.id;
                  return (
                    <button
                      key={model.id}
                      className={active ? "active" : undefined}
                      type="button"
                      onClick={() => {
                        setSessionModel(provider.id, model.id);
                        setOpen(false);
                      }}
                    >
                      <span className={`dot ${provider.id}`} />
                      <span className="model-line">
                        {model.name}
                        <em>{formatWindow(model.contextWindow)}</em>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      <BrainSlider />
      <ContextMeter />
    </div>
  );
}

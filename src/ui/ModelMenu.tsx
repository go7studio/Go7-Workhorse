import { useEffect, useRef, useState } from "react";
import { EFFORTS, MODEL_CATALOG, findModel, modelName } from "../lib/models";
import { PROVIDERS } from "../lib/providers";
import { useActiveSession, useStore } from "../lib/store";
import type { EffortLevel } from "../lib/types";

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
                      {model.name}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      <BrainSlider />
    </div>
  );
}

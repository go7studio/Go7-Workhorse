import { useEffect, useRef, useState } from "react";
import {
  choiceLabel,
  EFFORTS,
  MODEL_CATALOG,
  modelName,
} from "../lib/models";
import { PROVIDERS } from "../lib/providers";
import { useActiveSession, useStore } from "../lib/store";

export function ModelMenu() {
  const session = useActiveSession();
  const { setSessionModel, setSessionEffort } = useStore();
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

  const supportsEffort = MODEL_CATALOG[session.provider].some(
    (item) => item.id === session.model && item.effort,
  );

  return (
    <div className="model-menu" ref={root}>
      <button className="tiny model-trigger" type="button" onClick={() => setOpen((value) => !value)}>
        <span className={`dot ${session.provider}`} />
        {choiceLabel(session)}
      </button>
      {open && (
        <div className="model-pop">
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
                    onClick={() => setSessionModel(provider.id, model.id)}
                  >
                    <span className={`dot ${provider.id}`} />
                    {model.name}
                    {active ? " ·" : ""}
                  </button>
                );
              })}
            </div>
          ))}
          {supportsEffort && (
            <div className="model-group">
              <div className="section-label">Brain</div>
              <div className="effort-scale">
                {EFFORTS.map((item) => (
                  <button
                    key={item.id}
                    className={session.effort === item.id ? "tiny active-kind" : "tiny"}
                    type="button"
                    onClick={() => setSessionEffort(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <span className="visually-hidden">
        {modelName(session.provider, session.model)}
      </span>
    </div>
  );
}

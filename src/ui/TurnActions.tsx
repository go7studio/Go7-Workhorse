import { useState, type ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {children}
    </svg>
  );
}

function ActionGlyph({ id, done }: { id: string; done: boolean }) {
  if (id === "copy" && done) {
    return (
      <Icon>
        <path d="M3.6 8.4 6.4 11.2 12.4 4.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </Icon>
    );
  }
  if (id === "copy") {
    return (
      <Icon>
        <rect x="5.4" y="5.4" width="7.4" height="7.4" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
        <path d="M10.6 5.2V4.6A1.6 1.6 0 0 0 9 3H4.6A1.6 1.6 0 0 0 3 4.6V9a1.6 1.6 0 0 0 1.6 1.6h.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </Icon>
    );
  }
  if (id === "fork") {
    return (
      <Icon>
        <path d="M5 3.2v9.6M11 3.2v3.4c0 1.5-1.2 2.6-2.6 2.6H5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="5" cy="3.2" r="1.45" fill="currentColor" />
        <circle cx="11" cy="3.2" r="1.45" fill="currentColor" />
        <circle cx="5" cy="12.8" r="1.45" fill="currentColor" />
      </Icon>
    );
  }
  if (id === "edit") {
    return (
      <Icon>
        <path
          d="M10.6 3.3 12.7 5.4 5.8 12.3H3.7v-2.1L10.6 3.3Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path d="M9.4 4.5 11.5 6.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </Icon>
    );
  }
  return null;
}

export function TurnActions({
  actions,
}: {
  actions: { id: string; label: string; run: () => void | Promise<void> }[];
}) {
  const [done, setDone] = useState<string | null>(null);
  if (actions.length === 0) return null;
  return (
    <div className="turn-actions">
      {actions.map((action) => {
        const copied = done === action.id && action.id === "copy";
        const glyph = <ActionGlyph id={action.id} done={copied} />;
        return (
          <button
            key={action.id}
            type="button"
            className={glyph ? "icon" : undefined}
            title={copied ? "Copied" : action.label}
            aria-label={copied ? "Copied" : action.label}
            onClick={() => {
              void Promise.resolve(action.run()).then(() => {
                setDone(action.id);
                window.setTimeout(() => setDone((current) => (current === action.id ? null : current)), 1200);
              });
            }}
          >
            {glyph ?? (copied ? "Copied" : action.label)}
          </button>
        );
      })}
    </div>
  );
}

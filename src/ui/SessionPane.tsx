import { modelName } from "../lib/models";
import { providerById } from "../lib/providers";
import { useActiveProject, useActiveSession, useStore } from "../lib/store";
import type { PermissionMode } from "../lib/types";
import { Composer } from "./Composer";
import { ModelMenu } from "./ModelMenu";

const MODES: { id: PermissionMode; label: string }[] = [
  { id: "ask", label: "Ask" },
  { id: "accept-edits", label: "Accept edits" },
  { id: "always-approve", label: "Always" },
];

export function SessionPane() {
  const session = useActiveSession();
  const project = useActiveProject();
  const { setMode } = useStore();
  if (!session || !project) return null;

  const provider = providerById(session.provider);

  return (
    <section className="session">
      <header className="session-header">
        <ModelMenu />
        <div className="mode-seg" role="tablist" aria-label="Permission mode">
          {MODES.map((item) => (
            <button
              key={item.id}
              className={session.mode === item.id ? "mode-pill on" : "mode-pill"}
              type="button"
              onClick={() => setMode(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>
      <div className="transcript">
        {session.messages.map((message) => (
          <article key={message.id} className={`bubble ${message.role}`}>
            <div className="who">
              {message.role === "user"
                ? "You"
                : message.role === "system"
                  ? "Workhorse"
                  : `${provider.name} · ${modelName(session.provider, session.model)}`}
            </div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>
      <Composer />
    </section>
  );
}

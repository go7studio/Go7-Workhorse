import { modeLabel } from "../lib/commands";
import { providerById } from "../lib/providers";
import { useActiveProject, useActiveSession, useStore } from "../lib/store";
import { Composer } from "./Composer";

export function SessionPane() {
  const session = useActiveSession();
  const project = useActiveProject();
  const { setMode } = useStore();
  if (!session || !project) return null;

  const provider = providerById(session.provider);

  return (
    <section className="session">
      <div className="transcript">
        {session.messages.map((message) => (
          <article key={message.id} className={`bubble ${message.role}`}>
            <div className="who">
              {message.role === "user"
                ? "You"
                : message.role === "system"
                  ? "Workhorse"
                  : provider.name}
            </div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>
      <div className="actions" style={{ justifyContent: "center", paddingBottom: 4 }}>
        <button className="tiny" type="button" onClick={() => setMode("ask")}>
          {session.mode === "ask" ? "Ask · on" : "Ask"}
        </button>
        <button className="tiny" type="button" onClick={() => setMode("accept-edits")}>
          {session.mode === "accept-edits" ? "Accept edits · on" : "Accept edits"}
        </button>
        <button className="tiny" type="button" onClick={() => setMode("always-approve")}>
          {session.mode === "always-approve" ? "Always approve · on" : "Always approve"}
        </button>
        <span className="row-meta">{modeLabel(session.mode)} in {project.name}</span>
      </div>
      <Composer />
    </section>
  );
}

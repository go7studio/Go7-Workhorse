import { useStore } from "../lib/store";

export function Welcome() {
  const { openSheet, createProject, startSession } = useStore();

  return (
    <section className="welcome">
      <div className="mark" aria-hidden="true">
        7
      </div>
      <h2>Workhorse</h2>
      <p>Create a project — a name is enough. Chat from there. Link folders when you need them.</p>
      <div className="actions">
        <button className="primary" type="button" onClick={() => openSheet("project")}>
          New project
        </button>
        <button
          className="ghost"
          type="button"
          onClick={() => {
            startSession(createProject("Untitled"));
          }}
        >
          New chat
        </button>
      </div>
      <p className="welcome-hint">Type / for commands</p>
    </section>
  );
}

import { useStore } from "../lib/store";

export function Welcome() {
  const { openSheet, createProject, startSession } = useStore();

  return (
    <section className="welcome">
      <h2>Go7 Workhorse</h2>
      <p>
        Create a project — a name is enough. Chat from there.
        Link folders and other references when you need them.
      </p>
      <div className="actions">
        <button className="primary" type="button" onClick={() => openSheet("project")}>
          New project
        </button>
        <button
          className="ghost"
          type="button"
          onClick={() => {
            const id = createProject("Untitled");
            startSession("grok", id);
          }}
        >
          New chat
        </button>
      </div>
    </section>
  );
}

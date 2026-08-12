import { useStore } from "../lib/store";

export function Welcome() {
  const { openProject } = useStore();

  return (
    <section className="welcome">
      <h2>Go7 Workhorse</h2>
      <p>
        Open a project folder, then start a Grok, Claude, Codex, or custom session.
        Each brain stays itself. This window is the shell.
      </p>
      <div className="actions">
        <button className="primary" type="button" onClick={() => void openProject()}>
          Open a project
        </button>
      </div>
    </section>
  );
}

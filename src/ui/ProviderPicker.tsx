import { PROVIDERS } from "../lib/providers";
import { useActiveProject, useStore } from "../lib/store";

export function ProviderPicker() {
  const project = useActiveProject();
  const { startSession, openProject } = useStore();
  if (!project) return null;

  return (
    <section className="picker">
      <h2>{project.name}</h2>
      <p>
        Work happens in this folder.
        <br />
        <span className="path">{project.path}</span>
      </p>
      <div className="provider-grid">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            className="card"
            type="button"
            onClick={() => startSession(provider.id)}
          >
            <span className={`dot ${provider.id}`} />
            <strong>{provider.name}</strong>
            <span>{provider.tagline}</span>
            <span>{provider.statusNote}</span>
          </button>
        ))}
      </div>
      <div className="actions" style={{ marginTop: 20 }}>
        <button className="ghost" type="button" onClick={() => void openProject()}>
          Choose another folder
        </button>
      </div>
    </section>
  );
}

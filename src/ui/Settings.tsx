import { PROVIDERS } from "../lib/providers";
import { useStore } from "../lib/store";
import type { ProviderId, SettingsSection, Theme } from "../lib/types";
import { UsagePane } from "./UsagePane";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "llms", label: "LLMs" },
  { id: "usage", label: "Usage" },
];

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const STOCK: Exclude<ProviderId, "custom">[] = ["grok", "claude", "codex"];

export function Settings() {
  const store = useStore();
  const settings = store.settings;
  const section = store.settingsSection;

  return (
    <section className="picker project-home settings">
      <div className="link-head">
        <h2>Settings</h2>
        <button className="tiny" type="button" onClick={store.closeSettings}>
          Back
        </button>
      </div>

      <div className="actions" style={{ marginBottom: 20 }}>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            className={section === item.id ? "tiny active-kind" : "tiny"}
            type="button"
            onClick={() => store.setSettingsSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {section === "profile" && (
        <>
          <p>A name is enough. This is local to Workhorse — not a vendor account.</p>
          <label className="field">
            <span>Display name</span>
            <input
              value={settings.profile.name}
              placeholder="Your name"
              onChange={(event) => store.updateProfile({ name: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Handle</span>
            <input
              value={settings.profile.handle}
              placeholder="@you"
              onChange={(event) => store.updateProfile({ handle: event.target.value })}
            />
          </label>
          <div className="field">
            <span>Appearance</span>
            <div className="actions">
              {THEMES.map((item) => (
                <button
                  key={item.id}
                  className={store.theme === item.id ? "tiny active-kind" : "tiny"}
                  type="button"
                  onClick={() => store.setTheme(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {section === "llms" && (
        <>
          <p>
            Mark the logins this machine already has. Adapters will use them.
            Custom is an OpenAI-compatible URL for anything else.
          </p>
          <ul className="chip-list">
            {STOCK.map((id) => {
              const provider = PROVIDERS.find((item) => item.id === id)!;
              const linked = settings.llms[id].connected;
              return (
                <li key={id} className="chip llm-row">
                  <span>
                    <strong>
                      <span className={`dot ${id}`} /> {provider.name}
                    </strong>
                    <span className="row-meta">
                      {linked ? "Using the local login on this machine" : "Not connected"}
                    </span>
                  </span>
                  <button
                    className="tiny"
                    type="button"
                    onClick={() => store.setLlmConnected(id, !linked)}
                  >
                    {linked ? "Disconnect" : "Use local login"}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="link-block" style={{ marginTop: 18 }}>
            <div className="link-head">
              <span className="section-label" style={{ margin: 0 }}>
                Custom API
              </span>
              <span className="row-meta">
                {settings.llms.custom.connected ? "Ready" : "Not set"}
              </span>
            </div>
            <label className="field">
              <span>Base URL</span>
              <input
                value={settings.llms.custom.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) => store.updateCustomLlm({ baseUrl: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Model id</span>
              <input
                value={settings.llms.custom.model}
                placeholder="my-model"
                onChange={(event) => store.updateCustomLlm({ model: event.target.value })}
              />
            </label>
            <label className="field">
              <span>API key</span>
              <input
                type="password"
                value={settings.llms.custom.apiKey}
                placeholder="Stored only on this computer"
                autoComplete="off"
                onChange={(event) => store.updateCustomLlm({ apiKey: event.target.value })}
              />
            </label>
          </div>
        </>
      )}

      {section === "usage" && <UsagePane embedded />}
    </section>
  );
}

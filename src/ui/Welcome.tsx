import horseMark from "../../assets/app-icons/go7-workhorse-transparent.png";
import { APP_VERSION } from "../lib/app-info";
import { useStore } from "../lib/store";
import type { ProviderId } from "../lib/types";

const STOCK: Exclude<ProviderId, "custom">[] = ["grok", "codex", "claude"];

export function Welcome() {
  const { openSheet, createProject, openSettings, startSession, settings } = useStore();

  const connected =
    STOCK.filter((id) => settings.llms[id].connected).length + settings.customBots.filter((bot) => bot.enabled !== false).length;
  const harnesses = [
    ...STOCK.map((id) => ({
      id,
      name: id === "grok" ? "Grok" : id === "codex" ? "Codex" : "Claude",
      status: settings.llms[id].available
        ? settings.llms[id].connected
          ? "Ready"
          : "Recognized"
        : settings.llms[id].needsAuth
          ? "Sign in needed"
          : settings.llms[id].connected
            ? "Unavailable"
            : "Not found",
    })),
    ...settings.customBots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      status: bot.enabled === false ? "Off desk" : "Ready",
    })),
  ];

  /** A folder is a project here, so pick one and name the project after it. */
  const openFolder = async () => {
    const picked = window.workhorse ? await window.workhorse.pickFolder() : null;
    if (!picked) return;
    const name = picked.split(/[\\/]/).filter(Boolean).pop() ?? "Project";
    createProject(name, [picked]);
  };

  return (
    <section className="welcome">
      <img className="welcome-mark" src={horseMark} alt="" />
      <h2>Workhorse</h2>
      <p className="welcome-ver">v{APP_VERSION}</p>
      <p>One desk for Grok, Codex, Claude, and API harnesses.</p>
      <div className="welcome-harnesses" aria-label="Recognized harnesses">
        <div className="welcome-harness-head">
          <strong>Getting started</strong>
          <button className="tiny" type="button" onClick={() => openSettings("llms")}>
            Manage harnesses
          </button>
        </div>
        <p>Workhorse keeps each provider in its own session. These are the harnesses currently recognized on this Mac.</p>
        <ul>
          {harnesses.map((harness) => (
            <li key={harness.id}>
              <span>{harness.name}</span>
              <em>{harness.status}</em>
            </li>
          ))}
          {harnesses.length === 0 ? <li>No harnesses recognized yet.</li> : null}
        </ul>
      </div>
      <div className="welcome-steps">
        <button className="primary" type="button" onClick={() => openSheet("project")}>
          Create a project
        </button>
        <button className="ghost" type="button" onClick={() => void openFolder()}>
          Link an existing folder
        </button>
        {connected > 0 ? (
          <button className="ghost" type="button" onClick={() => startSession(null)}>
            Start a chat
          </button>
        ) : (
          <button className="ghost" type="button" onClick={() => openSettings("llms")}>
            Connect an agent
          </button>
        )}
      </div>
    </section>
  );
}

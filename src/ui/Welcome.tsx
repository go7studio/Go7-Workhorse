import horseMark from "../../assets/app-icons/go7-workhorse-transparent.png";
import { APP_VERSION } from "../lib/app-info";
import { useStore } from "../lib/store";
import type { ProviderId } from "../lib/types";

const STOCK: Exclude<ProviderId, "custom">[] = ["grok", "codex", "claude"];

export function Welcome() {
  const { openSheet, createProject, openSettings, startSession, settings } = useStore();

  const connected =
    STOCK.filter((id) => settings.llms[id].connected).length + (settings.llms.custom.connected ? 1 : 0);

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
      <p>One desk for Grok, Codex, and Claude.</p>
      <div className="welcome-steps">
        <div className="welcome-step">
          <button className="primary" type="button" onClick={() => openSheet("project")}>
            Create a project
          </button>
          <span>A name is enough.</span>
        </div>
        <div className="welcome-step">
          <button className="ghost" type="button" onClick={() => void openFolder()}>
            Link an existing folder
          </button>
          <span>Opens it as a project, named after the folder.</span>
        </div>
        <div className="welcome-step">
          {connected > 0 ? (
            <>
              <button className="ghost" type="button" onClick={() => startSession(null)}>
                Start a chat
              </button>
              <span>{connected === 1 ? "1 agent connected." : `${connected} agents connected.`}</span>
            </>
          ) : (
            <>
              <button className="ghost" type="button" onClick={() => openSettings("llms")}>
                Connect an agent
              </button>
              <span>A chat cannot answer until one is connected.</span>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

import horseMark from "../../assets/app-icons/go7-workhorse-transparent.png";
import { APP_VERSION } from "../lib/app-info";
import { useStore } from "../lib/store";

export function Welcome() {
  const { openSheet, startSession } = useStore();

  return (
    <section className="welcome">
      <img className="welcome-mark" src={horseMark} alt="" />
      <h2>Workhorse</h2>
      <p className="welcome-ver">v{APP_VERSION}</p>
      <p>Create a project. A name is enough. Chat from there. Link folders when you need them.</p>
      <div className="actions">
        <button className="primary" type="button" onClick={() => openSheet("project")}>
          New project
        </button>
        <button className="ghost" type="button" onClick={() => startSession(null)}>
          New chat
        </button>
      </div>
    </section>
  );
}

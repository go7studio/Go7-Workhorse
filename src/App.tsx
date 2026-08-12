import { useEffect } from "react";
import { useActiveProject, useActiveSession, useStore } from "./lib/store";
import { selectSurface, titlebarLabel } from "./lib/surface";
import { NewProjectSheet } from "./ui/NewProjectSheet";
import { PermissionCard } from "./ui/PermissionBar";
import { ProjectHome } from "./ui/ProjectHome";
import { ReferenceSheet } from "./ui/ReferenceSheet";
import { SessionPane } from "./ui/SessionPane";
import { Sidebar } from "./ui/Sidebar";
import { Settings } from "./ui/Settings";
import { Welcome } from "./ui/Welcome";

function resolvedTheme(theme: "system" | "light" | "dark") {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function App() {
  const store = useStore();
  const project = useActiveProject();
  const session = useActiveSession();

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolvedTheme(store.theme);
    };
    apply();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [store.theme]);

  const surface = selectSurface({
    panel: store.panel,
    hasProject: Boolean(project),
    hasSession: Boolean(session),
  });
  const title = titlebarLabel(project?.name, session?.title, store.panel);

  return (
    <div className="app">
      <header className="titlebar">
        <span>{title}</span>
      </header>
      <div className="workspace">
        <Sidebar />
        <main className="main">
          {surface === "settings" && <Settings />}
          {surface === "welcome" && <Welcome />}
          {surface === "project-home" && <ProjectHome />}
          {surface === "session" && <SessionPane />}
        </main>
      </div>
      <PermissionCard />
      <NewProjectSheet />
      <ReferenceSheet />
    </div>
  );
}

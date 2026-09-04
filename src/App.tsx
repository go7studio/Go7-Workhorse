import { useEffect } from "react";
import { useStoreSelector, type Store } from "./lib/store";
import { resolvedTheme } from "./lib/theme";
import { selectSurface, titlebarLabel } from "./lib/surface";
import { EditContextMenu } from "./ui/EditContextMenu";
import { NewProjectSheet } from "./ui/NewProjectSheet";
import { PermissionCard } from "./ui/PermissionBar";
import { ProjectHome } from "./ui/ProjectHome";
import { ReferenceSheet } from "./ui/ReferenceSheet";
import { SessionPane } from "./ui/SessionPane";
import { Sidebar } from "./ui/Sidebar";
import { AddBot } from "./ui/AddBot";
import { Settings } from "./ui/Settings";
import { WatchNotices } from "./ui/WatchNotices";
import { Welcome } from "./ui/Welcome";
import { WorkshopBreakout } from "./ui/WorkshopBreakout";
import { WorkshopRail } from "./ui/WorkshopRail";
import { isWorkshopSurface } from "./lib/workshop";

type AppView = {
  theme: Store["theme"];
  panel: Store["panel"];
  sidebarWidth: number;
  projectName?: string;
  sessionTitle?: string;
  hasProject: boolean;
  hasSession: boolean;
};

function selectAppView(store: Store): AppView {
  const project = store.projects.find((item) => item.id === store.activeProjectId);
  const session = store.sessions.find((item) => item.id === store.activeSessionId);
  return {
    theme: store.theme,
    panel: store.panel,
    sidebarWidth: store.sidebarWidth,
    projectName: project?.name,
    sessionTitle: session?.title,
    hasProject: Boolean(project),
    hasSession: Boolean(session),
  };
}

function sameAppView(left: AppView, right: AppView): boolean {
  return (
    left.theme === right.theme &&
    left.panel === right.panel &&
    left.sidebarWidth === right.sidebarWidth &&
    left.projectName === right.projectName &&
    left.sessionTitle === right.sessionTitle &&
    left.hasProject === right.hasProject &&
    left.hasSession === right.hasSession
  );
}

export function App() {
  const view = useStoreSelector(selectAppView, sameAppView);

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolvedTheme(
        view.theme,
        window.matchMedia("(prefers-color-scheme: dark)").matches,
      );
    };
    apply();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [view.theme]);

  if (isWorkshopSurface()) return <WorkshopBreakout />;

  const surface = selectSurface({
    panel: view.panel,
    hasProject: view.hasProject,
    hasSession: view.hasSession,
  });
  const title = titlebarLabel(view.projectName, view.sessionTitle, view.panel);

  return (
    <div className="app">
      <header className="titlebar">
        <span>{title}</span>
      </header>
      <div className="workspace" style={{ ["--sidebar" as string]: `${view.sidebarWidth}px` }}>
        <Sidebar />
        <main className="main">
          {surface === "settings" && <Settings />}
          {surface === "add-bot" && <AddBot />}
          {surface === "welcome" && <Welcome />}
          {surface === "session" && <SessionPane />}
          {surface === "project-home" && <ProjectHome />}
        </main>
        <WorkshopRail />
      </div>
      <PermissionCard />
      <WatchNotices hidden={surface === "project-home"} />
      <NewProjectSheet />
      <ReferenceSheet />
      <EditContextMenu />
    </div>
  );
}

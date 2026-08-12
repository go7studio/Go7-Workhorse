import { useEffect } from "react";
import { useActiveProject, useActiveSession, useStore } from "./lib/store";
import { PermissionBar } from "./ui/PermissionBar";
import { ProviderPicker } from "./ui/ProviderPicker";
import { SessionPane } from "./ui/SessionPane";
import { Sidebar } from "./ui/Sidebar";
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

  return (
    <div className="app">
      <header className="titlebar">
        <span>
          <strong>Go7 Workhorse</strong>
          {project ? `  ·  ${project.name}` : ""}
          {session ? `  ·  ${session.title}` : ""}
        </span>
      </header>
      <div className="workspace">
        <Sidebar />
        <main className="main">
          {!project && <Welcome />}
          {project && !session && <ProviderPicker />}
          {project && session && <SessionPane />}
        </main>
      </div>
      <PermissionBar />
    </div>
  );
}

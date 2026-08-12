import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { COMMANDS } from "./commands";
import { uid, folderName } from "./id";
import { providerById } from "./providers";
import type {
  AppState,
  PermissionMode,
  PermissionRequest,
  Project,
  ProviderId,
  Session,
  Theme,
} from "./types";

const EMPTY: AppState = {
  theme: "system",
  projects: [],
  sessions: [],
  activeProjectId: null,
  activeSessionId: null,
  pending: [],
};

type Store = AppState & {
  ready: boolean;
  openProject: (path?: string) => Promise<void>;
  selectProject: (id: string) => void;
  startSession: (provider: ProviderId) => void;
  selectSession: (id: string) => void;
  send: (text: string) => void;
  setMode: (mode: PermissionMode) => void;
  cycleTheme: () => void;
  answerPermission: (id: string, answer: "once" | "session" | "deny") => void;
  demoPermission: () => void;
  quit: () => void;
};

const StoreContext = createContext<Store | null>(null);

function isState(value: unknown): value is AppState {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AppState>;
  return Array.isArray(record.projects) && Array.isArray(record.sessions);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(EMPTY);
  const [ready, setReady] = useState(false);
  const persistTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const saved = window.workhorse ? await window.workhorse.loadState() : null;
      if (!cancelled && isState(saved)) setState({ ...EMPTY, ...saved });
      if (!cancelled) setReady(true);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready || !window.workhorse) return;
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      void window.workhorse?.saveState(state);
    }, 200);
  }, [ready, state]);

  const openProject = useCallback(async (path?: string) => {
    const folder = path ?? (window.workhorse ? await window.workhorse.pickProject() : null);
    if (!folder) return;
    setState((current) => {
      const existing = current.projects.find((project) => project.path === folder);
      const project: Project = existing
        ? { ...existing, openedAt: Date.now() }
        : { id: uid("proj"), name: folderName(folder), path: folder, openedAt: Date.now() };
      const projects = [project, ...current.projects.filter((item) => item.id !== project.id)];
      return {
        ...current,
        projects,
        activeProjectId: project.id,
        activeSessionId: null,
      };
    });
  }, []);

  const selectProject = useCallback((id: string) => {
    setState((current) => ({ ...current, activeProjectId: id, activeSessionId: null }));
  }, []);

  const startSession = useCallback((provider: ProviderId) => {
    setState((current) => {
      if (!current.activeProjectId) return current;
      const session: Session = {
        id: uid("sess"),
        projectId: current.activeProjectId,
        provider,
        title: `New ${providerById(provider).name} session`,
        mode: "ask",
        status: "idle",
        messages: [
          {
            id: uid("msg"),
            role: "system",
            text: `${providerById(provider).name} is not connected yet. This tab is a local preview so you can learn the shell. The adapter will spawn the real CLI in this project folder.`,
            createdAt: Date.now(),
          },
        ],
      };
      return {
        ...current,
        sessions: [session, ...current.sessions],
        activeSessionId: session.id,
      };
    });
  }, []);

  const selectSession = useCallback((id: string) => {
    setState((current) => ({ ...current, activeSessionId: id }));
  }, []);

  const setMode = useCallback((mode: PermissionMode) => {
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((session) =>
        session.id === current.activeSessionId ? { ...session, mode } : session,
      ),
    }));
  }, []);

  const cycleTheme = useCallback(() => {
    setState((current) => {
      const order: Theme[] = ["system", "light", "dark"];
      const next = order[(order.indexOf(current.theme) + 1) % order.length];
      return { ...current, theme: next };
    });
  }, []);

  const answerPermission = useCallback((id: string, answer: "once" | "session" | "deny") => {
    setState((current) => {
      const request = current.pending.find((item) => item.id === id);
      if (!request) return current;
      const label =
        answer === "deny" ? "Denied" : answer === "session" ? "Allowed for this session" : "Allowed once";
      return {
        ...current,
        pending: current.pending.filter((item) => item.id !== id),
        sessions: current.sessions.map((session) =>
          session.id === request.sessionId
            ? {
                ...session,
                status: "idle",
                messages: [
                  ...session.messages,
                  {
                    id: uid("msg"),
                    role: "system",
                    text: `${label}: ${request.tool} — ${request.detail}`,
                    createdAt: Date.now(),
                  },
                ],
              }
            : session,
        ),
      };
    });
  }, []);

  const demoPermission = useCallback(() => {
    setState((current) => {
      const session = current.sessions.find((item) => item.id === current.activeSessionId);
      if (!session) return current;
      const request: PermissionRequest = {
        id: uid("perm"),
        sessionId: session.id,
        provider: session.provider,
        tool: "run command",
        detail: "git status",
        path: current.projects.find((project) => project.id === session.projectId)?.path,
      };
      return {
        ...current,
        pending: [request, ...current.pending.filter((item) => item.sessionId !== session.id)],
        sessions: current.sessions.map((item) =>
          item.id === session.id ? { ...item, status: "needs-input" } : item,
        ),
      };
    });
  }, []);

  const send = useCallback((raw: string) => {
    const text = raw.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      const match = COMMANDS.find((command) => text === command.name || text.startsWith(`${command.name} `));
      if (match?.run === "new") {
        setState((current) => ({ ...current, activeSessionId: null }));
        return;
      }
      if (match?.run === "project") {
        void openProject();
        return;
      }
      if (match?.run === "providers") {
        setState((current) => ({ ...current, activeSessionId: null }));
        return;
      }
      if (match?.run.startsWith("mode:")) {
        setMode(match.run.slice(5) as PermissionMode);
        return;
      }
      if (match?.run === "demo-permission") {
        demoPermission();
        return;
      }
      if (match?.run === "theme") {
        cycleTheme();
        return;
      }
      if (match?.run === "quit") {
        void window.workhorse?.quit();
        return;
      }
    }

    setState((current) => {
      const session = current.sessions.find((item) => item.id === current.activeSessionId);
      if (!session) return current;
      const project = current.projects.find((item) => item.id === session.projectId);
      const reply = [
        `Preview only. ${providerById(session.provider).name} would work in:`,
        project?.path ?? "(no folder)",
        "",
        `You said: ${text}`,
        "",
        "When the adapter is live, this prompt goes to that vendor’s process. Workhorse stays the window.",
      ].join("\n");
      return {
        ...current,
        sessions: current.sessions.map((item) =>
          item.id === session.id
            ? {
                ...item,
                title: item.messages.some((message) => message.role === "user")
                  ? item.title
                  : text.slice(0, 42),
                messages: [
                  ...item.messages,
                  { id: uid("msg"), role: "user", text, createdAt: Date.now() },
                  { id: uid("msg"), role: "assistant", text: reply, createdAt: Date.now() },
                ],
              }
            : item,
        ),
      };
    });
  }, [cycleTheme, demoPermission, openProject, setMode]);

  const quit = useCallback(() => {
    void window.workhorse?.quit();
  }, []);

  const value = useMemo<Store>(
    () => ({
      ...state,
      ready,
      openProject,
      selectProject,
      startSession,
      selectSession,
      send,
      setMode,
      cycleTheme,
      answerPermission,
      demoPermission,
      quit,
    }),
    [
      state,
      ready,
      openProject,
      selectProject,
      startSession,
      selectSession,
      send,
      setMode,
      cycleTheme,
      answerPermission,
      demoPermission,
      quit,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const value = useContext(StoreContext);
  if (!value) throw new Error("useStore must be used inside StoreProvider");
  return value;
}

export function useActiveProject() {
  const store = useStore();
  return store.projects.find((project) => project.id === store.activeProjectId) ?? null;
}

export function useActiveSession() {
  const store = useStore();
  return store.sessions.find((session) => session.id === store.activeSessionId) ?? null;
}

export function useProjectSessions(projectId: string | null) {
  const store = useStore();
  if (!projectId) return [];
  return store.sessions.filter((session) => session.projectId === projectId);
}



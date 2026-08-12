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
import { uid } from "./id";
import { applyPermissionAnswer } from "./permissions";
import { DEFAULT_CHOICE, defaultModel, findChoice, modelName, parseEffort, withEffort } from "./models";
import { emptyProject, folderFromPath, normalizeProject, primaryFolder } from "./project";
import { providerById } from "./providers";
import { normalizeUsage } from "./usage";
import type {
  AppState,
  EffortLevel,
  LinkedReference,
  PermissionMode,
  PermissionRequest,
  Project,
  ProviderId,
  ReferenceKind,
  Session,
  Sheet,
  Theme,
  UsageDraft,
  UsageRange,
} from "./types";

const EMPTY: AppState = {
  theme: "system",
  projects: [],
  sessions: [],
  activeProjectId: null,
  activeSessionId: null,
  pending: [],
  sheet: null,
  panel: null,
  usage: [],
  usageRange: "month",
  lastModel: DEFAULT_CHOICE,
};

type Store = AppState & {
  ready: boolean;
  createProject: (name: string) => string;
  openSheet: (sheet: Sheet) => void;
  closeSheet: () => void;
  selectProject: (id: string) => void;
  linkFolder: (path?: string) => Promise<void>;
  unlinkFolder: (folderId: string) => void;
  addReference: (kind: ReferenceKind, value: string, label?: string) => void;
  removeReference: (referenceId: string) => void;
  startSession: (projectId?: string) => void;
  setSessionModel: (provider: ProviderId, model: string) => void;
  setSessionEffort: (effort: EffortLevel) => void;
  selectSession: (id: string) => void;
  send: (text: string) => void;
  setMode: (mode: PermissionMode) => void;
  cycleTheme: () => void;
  answerPermission: (id: string, answer: "once" | "session" | "deny") => void;
  demoPermission: () => void;
  recordUsage: (draft: UsageDraft) => void;
  openUsage: () => void;
  closeUsage: () => void;
  setUsageRange: (range: UsageRange) => void;
  quit: () => void;
};

const StoreContext = createContext<Store | null>(null);

function hydrate(value: unknown): AppState {
  if (!value || typeof value !== "object") return EMPTY;
  const record = value as Partial<AppState> & { projects?: unknown[] };
  const projects = Array.isArray(record.projects)
    ? record.projects.map(normalizeProject).filter((item): item is Project => item !== null)
    : [];
  return {
    ...EMPTY,
    ...record,
    projects,
    sessions: Array.isArray(record.sessions)
      ? record.sessions.map(normalizeSession).filter((item): item is Session => item !== null)
      : [],
    pending: Array.isArray(record.pending) ? record.pending : [],
    sheet: null,
    panel: null,
    usage: normalizeUsage(record.usage),
    usageRange:
      record.usageRange === "today" || record.usageRange === "week" || record.usageRange === "all"
        ? record.usageRange
        : "month",
    lastModel: normalizeChoice(record.lastModel),
  };
}

function normalizeChoice(raw: unknown): AppState["lastModel"] {
  if (!raw || typeof raw !== "object") return DEFAULT_CHOICE;
  const record = raw as Partial<AppState["lastModel"]>;
  const provider =
    record.provider === "grok" ||
    record.provider === "claude" ||
    record.provider === "codex" ||
    record.provider === "custom"
      ? record.provider
      : DEFAULT_CHOICE.provider;
  const model = typeof record.model === "string" && record.model ? record.model : DEFAULT_CHOICE.model;
  return {
    provider,
    model,
    effort: withEffort(provider, model, record.effort ?? DEFAULT_CHOICE.effort),
  };
}

function normalizeSession(raw: unknown): Session | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<Session>;
  if (typeof record.id !== "string" || typeof record.projectId !== "string") return null;
  const provider =
    record.provider === "grok" ||
    record.provider === "claude" ||
    record.provider === "codex" ||
    record.provider === "custom"
      ? record.provider
      : "grok";
  const model = typeof record.model === "string" && record.model ? record.model : defaultModel(provider).id;
  return {
    id: record.id,
    projectId: record.projectId,
    provider,
    model,
    effort: withEffort(provider, model, record.effort ?? "medium"),
    title: typeof record.title === "string" ? record.title : "New chat",
    mode: record.mode === "accept-edits" || record.mode === "always-approve" ? record.mode : "ask",
    status: record.status === "running" || record.status === "needs-input" ? record.status : "idle",
    messages: Array.isArray(record.messages) ? record.messages : [],
  };
}

function chatIntro(session: Pick<Session, "provider" | "model">, project: Project): string {
  const label = `${providerById(session.provider).name} · ${modelName(session.provider, session.model)}`;
  if (project.folders.length === 0) {
    return `${label} is not connected yet. This is a basic chat in “${project.name}”. Switch models from the menu on the composer.`;
  }
  const paths = project.folders.map((folder) => folder.path).join("\n");
  return `${label} is not connected yet. This chat belongs to “${project.name}” and can see:\n${paths}`;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(EMPTY);
  const [ready, setReady] = useState(false);
  const persistTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const saved = window.workhorse ? await window.workhorse.loadState() : null;
      if (!cancelled) setState(hydrate(saved));
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

  const createProject = useCallback((name: string) => {
    const project = emptyProject(name);
    setState((current) => ({
      ...current,
      projects: [project, ...current.projects],
      activeProjectId: project.id,
      activeSessionId: null,
      panel: null,
    }));
    return project.id;
  }, []);

  const openSheet = useCallback((sheet: Sheet) => {
    setState((current) => ({ ...current, sheet }));
  }, []);

  const closeSheet = useCallback(() => {
    setState((current) => ({ ...current, sheet: null }));
  }, []);

  const selectProject = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      panel: null,
      activeProjectId: id,
      activeSessionId: null,
      projects: current.projects.map((project) =>
        project.id === id ? { ...project, openedAt: Date.now() } : project,
      ),
    }));
  }, []);

  const linkFolder = useCallback(async (path?: string) => {
    const folderPath = path ?? (window.workhorse ? await window.workhorse.pickFolder() : null);
    if (!folderPath) return;
    setState((current) => {
      const projectId = current.activeProjectId;
      if (!projectId) return current;
      return {
        ...current,
        projects: current.projects.map((project) => {
          if (project.id !== projectId) return project;
          if (project.folders.some((folder) => folder.path === folderPath)) return project;
          return { ...project, folders: [...project.folders, folderFromPath(folderPath)] };
        }),
      };
    });
  }, []);

  const unlinkFolder = useCallback((folderId: string) => {
    setState((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === current.activeProjectId
          ? { ...project, folders: project.folders.filter((folder) => folder.id !== folderId) }
          : project,
      ),
    }));
  }, []);

  const addReference = useCallback((kind: ReferenceKind, value: string, label?: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const reference: LinkedReference = {
      id: uid("ref"),
      kind,
      value: trimmed,
      label: (label ?? trimmed).trim(),
    };
    setState((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === current.activeProjectId
          ? { ...project, references: [...project.references, reference] }
          : project,
      ),
    }));
  }, []);

  const removeReference = useCallback((referenceId: string) => {
    setState((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === current.activeProjectId
          ? { ...project, references: project.references.filter((item) => item.id !== referenceId) }
          : project,
      ),
    }));
  }, []);

  const startSession = useCallback((projectId?: string) => {
    setState((current) => {
      const targetId = projectId ?? current.activeProjectId;
      if (!targetId) return current;
      const project = current.projects.find((item) => item.id === targetId);
      if (!project) return current;
      const choice = current.lastModel ?? DEFAULT_CHOICE;
      const session: Session = {
        id: uid("sess"),
        projectId: project.id,
        provider: choice.provider,
        model: choice.model,
        effort: withEffort(choice.provider, choice.model, choice.effort),
        title: "New chat",
        mode: "ask",
        status: "idle",
        messages: [
          {
            id: uid("msg"),
            role: "system",
            text: chatIntro(choice, project),
            createdAt: Date.now(),
          },
        ],
      };
      return {
        ...current,
        sessions: [session, ...current.sessions],
        activeProjectId: project.id,
        activeSessionId: session.id,
      };
    });
  }, []);

  const setSessionModel = useCallback((provider: ProviderId, model: string) => {
    setState((current) => {
      const session = current.sessions.find((item) => item.id === current.activeSessionId);
      if (!session) return current;
      const effort = withEffort(provider, model, session.effort);
      const lastModel = { provider, model, effort };
      return {
        ...current,
        lastModel,
        sessions: current.sessions.map((item) =>
          item.id === session.id ? { ...item, provider, model, effort } : item,
        ),
      };
    });
  }, []);

  const setSessionEffort = useCallback((effort: EffortLevel) => {
    setState((current) => {
      const session = current.sessions.find((item) => item.id === current.activeSessionId);
      if (!session || !withEffort(session.provider, session.model, effort)) return current;
      return {
        ...current,
        lastModel: { provider: session.provider, model: session.model, effort },
        sessions: current.sessions.map((item) =>
          item.id === session.id ? { ...item, effort } : item,
        ),
      };
    });
  }, []);

  const selectSession = useCallback((id: string) => {
    setState((current) => {
      const session = current.sessions.find((item) => item.id === id);
      return {
        ...current,
        panel: null,
        activeSessionId: id,
        activeProjectId: session?.projectId ?? current.activeProjectId,
      };
    });
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
      const next = applyPermissionAnswer(current, id, answer);
      return next ? { ...current, ...next } : current;
    });
  }, []);

  const demoPermission = useCallback(() => {
    setState((current) => {
      const session = current.sessions.find((item) => item.id === current.activeSessionId);
      if (!session) return current;
      const project = current.projects.find((item) => item.id === session.projectId);
      const request: PermissionRequest = {
        id: uid("perm"),
        sessionId: session.id,
        provider: session.provider,
        tool: "run command",
        detail: "git status",
        path: project ? primaryFolder(project)?.path : undefined,
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
        setState((current) => ({ ...current, sheet: "project" }));
        return;
      }
      if (match?.run === "link") {
        void linkFolder();
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
      if (match?.run === "usage") {
        setState((current) => ({ ...current, panel: "usage" }));
        return;
      }
      if (match?.run === "model") {
        const query = text.replace(/^\/m(odel)?\s*/i, "");
        const choice = findChoice(query);
        if (choice) setSessionModel(choice.provider, choice.model);
        return;
      }
      if (match?.run === "effort") {
        const level = parseEffort(text.replace(/^\/effort\s*/i, ""));
        if (level) setSessionEffort(level);
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
      const where = project && project.folders.length > 0
        ? project.folders.map((folder) => folder.path).join("\n")
        : "(no folder linked — basic chat)";
      const reply = [
        `Preview only. ${providerById(session.provider).name} would answer in “${project?.name ?? "this project"}”.`,
        where,
        "",
        `You said: ${text}`,
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
  }, [cycleTheme, demoPermission, linkFolder, setMode, setSessionEffort, setSessionModel]);

  const recordUsage = useCallback((draft: UsageDraft) => {
    setState((current) => ({
      ...current,
      usage: [
        {
          id: uid("use"),
          at: Date.now(),
          provider: draft.provider,
          model: draft.model,
          projectId: draft.projectId ?? current.activeProjectId ?? undefined,
          sessionId: draft.sessionId ?? current.activeSessionId ?? undefined,
          inputTokens: Math.max(0, Math.round(draft.inputTokens)),
          outputTokens: Math.max(0, Math.round(draft.outputTokens)),
          cacheReadTokens: Math.max(0, Math.round(draft.cacheReadTokens ?? 0)),
          cacheWriteTokens: Math.max(0, Math.round(draft.cacheWriteTokens ?? 0)),
          costUsd: draft.costUsd,
        },
        ...current.usage,
      ],
    }));
  }, []);

  const openUsage = useCallback(() => {
    setState((current) => ({ ...current, panel: "usage" }));
  }, []);

  const closeUsage = useCallback(() => {
    setState((current) => ({ ...current, panel: null }));
  }, []);

  const setUsageRange = useCallback((range: UsageRange) => {
    setState((current) => ({ ...current, usageRange: range }));
  }, []);

  const quit = useCallback(() => {
    void window.workhorse?.quit();
  }, []);

  const value = useMemo<Store>(
    () => ({
      ...state,
      ready,
      createProject,
      openSheet,
      closeSheet,
      selectProject,
      linkFolder,
      unlinkFolder,
      addReference,
      removeReference,
      startSession,
      setSessionModel,
      setSessionEffort,
      selectSession,
      send,
      setMode,
      cycleTheme,
      answerPermission,
      demoPermission,
      recordUsage,
      openUsage,
      closeUsage,
      setUsageRange,
      quit,
    }),
    [
      state,
      ready,
      createProject,
      openSheet,
      closeSheet,
      selectProject,
      linkFolder,
      unlinkFolder,
      addReference,
      removeReference,
      startSession,
      setSessionModel,
      setSessionEffort,
      selectSession,
      send,
      setMode,
      cycleTheme,
      answerPermission,
      demoPermission,
      recordUsage,
      openUsage,
      closeUsage,
      setUsageRange,
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

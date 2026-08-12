export type ProviderId = "grok" | "claude" | "codex" | "custom";

export type PermissionMode = "ask" | "accept-edits" | "always-approve";

export type SessionStatus = "idle" | "running" | "needs-input";

export type Theme = "system" | "light" | "dark";

export type Provider = {
  id: ProviderId;
  name: string;
  short: string;
  tagline: string;
  connected: boolean;
  statusNote: string;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  openedAt: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
};

export type Session = {
  id: string;
  projectId: string;
  provider: ProviderId;
  title: string;
  mode: PermissionMode;
  status: SessionStatus;
  messages: ChatMessage[];
};

export type PermissionRequest = {
  id: string;
  sessionId: string;
  provider: ProviderId;
  tool: string;
  detail: string;
  path?: string;
};

export type AppState = {
  theme: Theme;
  projects: Project[];
  sessions: Session[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  pending: PermissionRequest[];
};

export type Command = {
  id: string;
  name: string;
  hint: string;
  run: string;
};

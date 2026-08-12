export type ProviderId = "grok" | "claude" | "codex" | "custom";

export type PermissionMode = "ask" | "accept-edits" | "always-approve";

export type SessionStatus = "idle" | "running" | "needs-input";

export type Theme = "system" | "light" | "dark";

export type ReferenceKind = "file" | "url" | "note";

export type Provider = {
  id: ProviderId;
  name: string;
  short: string;
  tagline: string;
  connected: boolean;
  statusNote: string;
};

export type LinkedFolder = {
  id: string;
  path: string;
  label: string;
};

export type LinkedReference = {
  id: string;
  kind: ReferenceKind;
  value: string;
  label: string;
};

export type Project = {
  id: string;
  name: string;
  createdAt: number;
  openedAt: number;
  folders: LinkedFolder[];
  references: LinkedReference[];
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

export type Sheet = "project" | "reference" | null;

export type AppState = {
  theme: Theme;
  projects: Project[];
  sessions: Session[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  pending: PermissionRequest[];
  sheet: Sheet;
};

export type Command = {
  id: string;
  name: string;
  hint: string;
  run: string;
};

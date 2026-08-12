export type ProviderId = "grok" | "claude" | "codex" | "custom";

export type PermissionMode = "ask" | "accept-edits" | "always-approve";

export type SessionStatus = "idle" | "running" | "needs-input";

export type EffortLevel = "low" | "medium" | "high" | "xhigh";

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
  model: string;
  effort: EffortLevel | null;
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

export type Panel = "usage" | null;

export type UsageRange = "today" | "week" | "month" | "all";

export type UsageEvent = {
  id: string;
  at: number;
  provider: ProviderId;
  model: string;
  projectId?: string;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
};

export type UsageDraft = {
  provider: ProviderId;
  model: string;
  projectId?: string;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
};

export type AppState = {
  theme: Theme;
  projects: Project[];
  sessions: Session[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  pending: PermissionRequest[];
  sheet: Sheet;
  panel: Panel;
  usage: UsageEvent[];
  usageRange: UsageRange;
  lastModel: {
    provider: ProviderId;
    model: string;
    effort: EffortLevel | null;
  };
};

export type Command = {
  id: string;
  name: string;
  hint: string;
  run: string;
};

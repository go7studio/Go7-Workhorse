export type ProviderId = "grok" | "claude" | "codex" | "custom";

export type PermissionMode = "ask" | "accept-edits" | "always-approve" | "plan";

export type SandboxProfile = "off" | "workspace" | "read-only" | "strict";

export type SessionSecurityPolicy = {
  network: "blocked" | "allowed";
  root: "ask" | "blocked" | "allowed";
};

export type McpServerConfig = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type SessionStatus = "idle" | "running" | "needs-input";

export type SessionEnvironment =
  | { kind: "local" }
  | { kind: "worktree"; path: string; gitRoot: string; head?: string }
  | { kind: "cloud"; environmentId: string; cwd?: string };

export type EffortLevel = "off" | "adaptive" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type Theme = "system" | "light" | "dark" | "workhorse";

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
  archivedAt?: number | null;
  folders: LinkedFolder[];
  references: LinkedReference[];
};

export type ChatMessageKind = "tool" | "compact" | "thought" | "peer" | "subagent";

export type ChatImage = {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  kind?: "image" | "file";
  text?: string;
  folder?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
  images?: ChatImage[];
  kind?: ChatMessageKind;
  fromTitle?: string;
  toolCallId?: string;
  toolStatus?: string;
  thought?: string;
  workedMs?: number;
  subagentSessionId?: string;
  provider?: ProviderId;
  model?: string;
  customBotId?: string;
};

export type CommandSource = "workhorse" | "grok" | "codex" | "claude" | "skill";

export type Command = {
  id: string;
  name: string;
  hint: string;
  run: string;
  source?: CommandSource;
  inputHint?: string;
  aliases?: string[];
};

export type QueuedPrompt = {
  id: string;
  text: string;
  images?: ChatImage[];
  createdAt: number;
  scheduledRunId?: string;
  hideUser?: boolean;
};

export type ScheduledRun = {
  id: string;
  prompt: string;
  dueAt: number;
  createdAt: number;
  status: "pending" | "queued" | "running" | "completed" | "failed";
  /** Workhorse-owned recurrence. Each occurrence remains an independently auditable run. */
  repeatEveryMs?: number;
  occurrence?: number;
};

export type PortableCheckpoint = {
  createdAt: number;
  throughMessageId: string;
  omittedMessages: number;
  summary: string;
};

export type AgentRun = {
  status: "running" | "completed" | "failed" | "cancelled" | "timed-out" | "budget-exceeded";
  startedAt: number;
  finishedAt?: number;
  timeoutMs?: number;
  tokenBudget?: number;
  usedTokens?: number;
  isolation: "worktree" | "shared";
  changedFiles?: string[];
  conflictFiles?: string[];
  error?: string;
};

export type Session = {
  id: string;
  projectId: string | null;
  parentId?: string;
  hidden?: boolean;
  provider: ProviderId;
  model: string;
  customBotId?: string;
  effort: EffortLevel | null;
  title: string;
  titleLocked?: boolean;
  mode: PermissionMode;
  sandbox: SandboxProfile;
  /** Controls that are independent from the filesystem sandbox. */
  securityPolicy?: SessionSecurityPolicy;
  /** Where this chat executes. Missing on older saves means the project's local folder. */
  environment?: SessionEnvironment;
  vendorSessionId?: string;
  /** Provider that owns vendorSessionId. Cleared when This-chat vendor changes. */
  vendorProvider?: ProviderId;
  status: SessionStatus;
  messages: ChatMessage[];
  queue?: QueuedPrompt[];
  /** Persisted background runs. Electron main dispatches pending entries and recovers interrupted work. */
  scheduledRuns?: ScheduledRun[];
  /** Workhorse-owned context checkpoint used when a provider has no native compaction. */
  contextCheckpoint?: PortableCheckpoint;
  /** Unsent composer text. Kept when leaving this chat. */
  composerDraft?: string;
  /** Unsent composer attachments. Kept with composerDraft. */
  composerImages?: ChatImage[];
  contextUsed: number;
  archivedAt?: number | null;
  grokCommands?: Command[];
  /** Thread-scoped Codex/Grok Goal lifecycle. */
  goal?: { status: "active" | "paused"; objective: string };
  /** Workhorse-owned lifecycle and review record for hidden cross-provider children. */
  agentRun?: AgentRun;
  /** Tool families allowed for the rest of this vendor session. */
  permissionGrants?: string[];
};

export type PermissionRequest = {
  id: string;
  sessionId: string;
  provider: ProviderId;
  tool: string;
  detail: string;
  path?: string;
  kind?: "tool" | "elevate" | "vendor";
  elevate?: { mode?: PermissionMode; sandbox?: SandboxProfile };
  vendor?: {
    provider: ProviderId;
    name: string;
    status: "day_bank" | "spent" | "disabled" | "ok";
  };
};

export type Sheet = "project" | "reference" | null;

export type Panel = "settings" | "add-bot" | null;

export type SettingsSection = "profile" | "llms" | "skills" | "usage" | "watch";

export type SkillOrigin = "grok" | "codex" | "claude" | "workhorse";

export type DeskSkill = {
  name: string;
  description: string;
  origin: SkillOrigin;
  dir: string;
  skillFile: string;
};

export type DeskExportKind = "skills" | "chats";

export type DeskExportResult = {
  ok: boolean;
  canceled?: boolean;
  dest?: string;
  skills?: number;
  chats?: number;
  message?: string;
};

export type Profile = {
  name: string;
  handle: string;
};

export type LlmLink = {
  connected: boolean;
  enabled?: boolean;
  available?: boolean;
  name?: string;
  color?: string;
};

export type CustomLlm = {
  connected: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Reference to an OS-encrypted secret; apiKey is hydrated only in memory. */
  credentialId?: string;
  contextWindow: number;
  api?: "anthropic-messages" | "openai-completions";
  source?: "openclaw" | "env" | "manual";
  name?: string;
  color?: string;
  tested?: boolean;
};

export type CustomBot = {
  id: string;
  name: string;
  color: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Reference to an OS-encrypted secret; apiKey is hydrated only in memory. */
  credentialId?: string;
  api: "anthropic-messages" | "openai-completions";
  contextWindow: number;
  createdAt: number;
  enabled?: boolean;
};

export type WatchSettings = {
  dailyLimitPercent: number;
  lockDaily: boolean;
  desktopNotify: boolean;
  /** Bots on the daily bank. Missing means every bot (older saves). */
  lockKeys?: string[];
};

export type WatchPermit = {
  untilReset?: boolean;
  day?: string;
  /** Session ids allowed to keep going, stamped with the local day. */
  sessions?: Record<string, string>;
};

export type WatchPermits = Record<string, WatchPermit>;

export type WatchDismissed = Record<string, string>;

export type WatchDayMark = {
  day: string;
  leftover: number;
};

export type WatchDayMarks = Record<string, WatchDayMark>;

export type Settings = {
  profile: Profile;
  llms: {
    grok: LlmLink;
    claude: LlmLink;
    codex: LlmLink;
    custom: CustomLlm;
  };
  customBots: CustomBot[];
  mcpServers: McpServerConfig[];
  usageBudgets: Partial<Record<ProviderId, number>>;
  watch: WatchSettings;
};

export type UsageRange = "today" | "week" | "month" | "all";

export type GrokPlanProduct = {
  product: string;
  label: string;
  usagePercent: number;
  resetsAt?: string;
};

export type GrokPlanUsage = {
  usedPercent: number;
  leftPercent: number;
  period: "weekly" | "monthly" | "unknown";
  resetsAt?: string;
  prepaidBalance: number;
  products: GrokPlanProduct[];
};

export type UsageEvent = {
  id: string;
  at: number;
  provider: ProviderId;
  model: string;
  projectId?: string;
  sessionId?: string;
  customBotId?: string;
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
  customBotId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  contextUsed?: number;
};

export type AppState = {
  theme: Theme;
  /** Look to restore when leaving Workhorse theme via the horse mark. */
  themeReturn?: Exclude<Theme, "workhorse">;
  projects: Project[];
  sessions: Session[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  pending: PermissionRequest[];
  /** Stable ids dismissed from the derived attention inbox. */
  dismissedAttention?: string[];
  sheet: Sheet;
  panel: Panel;
  settingsSection: SettingsSection;
  settings: Settings;
  watchPermits: WatchPermits;
  watchDismissed: WatchDismissed;
  watchDayMarks: WatchDayMarks;
  usage: UsageEvent[];
  usageRange: UsageRange;
  deskPlans?: {
    grok?: GrokPlanUsage;
    codex?: GrokPlanUsage;
    claude?: GrokPlanUsage;
    custom?: Record<string, GrokPlanUsage | undefined>;
  };
  sidebarWidth: number;
  threadWidth: number;
  lastModel: {
    provider: ProviderId;
    model: string;
    effort: EffortLevel | null;
    sandbox: SandboxProfile;
    mode?: PermissionMode;
    customBotId?: string;
  };
  dismissedUpdateVersion?: string;
};

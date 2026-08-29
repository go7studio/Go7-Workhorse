export type ProviderId = "grok" | "claude" | "codex" | "cursor" | "custom";

export type PermissionMode = "ask" | "accept-edits" | "always-approve" | "plan";

export type SandboxProfile = "off" | "workspace" | "read-only" | "strict";

export type BotAccessDefaults = {
  mode?: PermissionMode;
  sandbox?: SandboxProfile;
};

export type SessionSecurityPolicy = {
  network: "blocked" | "allowed";
  root: "ask" | "blocked" | "allowed";
};

export type McpServerConfig = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** References to OS-encrypted environment values; hydrated into `env` only in memory. */
  envCredentialIds?: Record<string, string>;
  /** Missing keeps older saved servers enabled. */
  enabled?: boolean;
  /** Missing means every runtime for backward compatibility; an empty list means none. */
  runtimeIds?: McpRuntimeId[];
  /** Missing means every tool reported by the server; an empty list means none. */
  includeTools?: string[];
};

export type McpRuntimeId = ProviderId | `custom:${string}`;

export type McpProbeResult = {
  ok: boolean;
  message: string;
  tools: string[];
};

export type SessionStatus = "idle" | "running" | "needs-input";

export type SessionEnvironment =
  | { kind: "local" }
  | { kind: "worktree"; path: string; gitRoot: string; head?: string }
  | { kind: "cloud"; environmentId: string; cwd?: string };

export type EffortLevel = "off" | "adaptive" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** Pinned on a chat from the composer + menu. Orchestrate spawns; Mission loops. */
export type CrewMode = "orchestrate" | "mission";

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
  /** macOS security-scoped bookmark so a later launch can reopen this folder. */
  bookmark?: string;
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

export type AttachmentKind = "image" | "file" | "document" | "audio" | "video";

/** Legacy name retained for saved-chat compatibility. Represents every composer attachment. */
export type ChatImage = {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  kind?: AttachmentKind;
  text?: string;
  folder?: string;
  sourcePath?: string;
  size?: number;
  durationMs?: number;
  /** Representative video frames prepared for vision-only models. */
  derivedImages?: ChatImage[];
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
  peerFromSessionId?: string;
  correlationId?: string;
  memoryIds?: string[];
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
  /** Model payload when it differs from the visible player text (e.g. /goal). */
  vendorText?: string;
  /** Leftover from older builds that inserted the bubble while queued. Flush strips it. */
  userMessageId?: string;
  /** Do not flush this queued send until this time. Used to cool a rate-limited key before join. */
  notBefore?: number;
  joinAttempt?: number;
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

export type DeskLineupRowStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed-out"
  /** The orchestrator or person stopped this worker. Not a failure. */
  | "cancelled"
  /** The desk exited mid-run. The slice is unfinished but the worker can be resumed. */
  | "interrupted"
  /** External runtime task could not be reconciled after restart. */
  | "unknown";

export type AgentRuntimeId = "openclaw" | "hermes";

export type ExternalAgentRef = {
  runtimeId: AgentRuntimeId;
  agentId: string;
};

export type AgentGrant = {
  id: string;
  waveId: string;
  runtimeId?: AgentRuntimeId;
  agentId?: string;
  createdAt: number;
  consumedAt?: number;
};

export type CorrelationOrigin = "workhorse" | "openclaw" | "hermes";

export type CorrelationEnvelope = {
  traceId: string;
  idempotencyKey: string;
  origin: CorrelationOrigin;
  visitedSystems: CorrelationOrigin[];
  hopCount: number;
};

export type ExternalTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export type ExternalTask = {
  id: string;
  ref: ExternalAgentRef;
  status: ExternalTaskStatus;
  startedAt: number;
  finishedAt?: number;
  workspace?: string;
  result?: string;
  evidence?: string;
  envelope: CorrelationEnvelope;
  grantId: string;
};

export type ExternalAgentRun = {
  kind: "external";
  taskId: string;
  runtimeId: AgentRuntimeId;
  agentId: string;
  status: ExternalTaskStatus;
  startedAt: number;
  finishedAt?: number;
  workspace?: string;
  result?: string;
  correlationId: string;
};

export type McpExposureProfile = "desk" | "worker" | "auditor" | "external-runtime";

export type DeskLineupRow = {
  childId: string;
  title: string;
  slice: string;
  folder: string;
  vendor: string;
  status: DeskLineupRowStatus;
  startedAt: number;
  finishedAt?: number;
  report?: string;
  findings?: WorkerFinding[];
  planStepId?: string;
  rationale?: string;
  constraints?: string[];
  /** Repo-relative files this worker is allowed to change. Attachments remain `files`. */
  paths?: string[];
  kind?: "workhorse" | "external";
  /**
   * Which harness asked for this work, when one did. `runtimeId` below is the
   * runtime a task was sent OUT to; this is the caller that came IN. A wave
   * with no caller is the desk's own, and shows no attribution.
   */
  caller?: CorrelationOrigin;
  runtimeId?: AgentRuntimeId;
  agentId?: string;
  workspace?: string;
  correlationId?: string;
  missionId?: string;
  iteration?: number;
};

export type DeskLineup = {
  id: string;
  folder: string;
  startedAt: number;
  rows: DeskLineupRow[];
  notifiedAt?: number;
  /** External harnesses join their own reports; the desk must not start a second orchestration turn. */
  joinOwner?: "desk" | "external-runtime";
  /** Original user sentence that started this wave. Desk-owned; not a model paraphrase. */
  userText?: string;
  /** Desk-owned campaign state for the current adaptive pass. */
  mission?: MissionIteration;
};

export type WorkerSeed = "inherit" | "fresh";

export type WorkerHandoff = {
  status: string;
  summary: string;
  evidence?: string;
  nextSteps?: string;
  blocker?: string;
};

export type WorkerFindingSeverity = "critical" | "high" | "medium" | "low";

/** A fixed review receipt parsed from a worker's terminal prose. */
export type WorkerFinding = {
  severity: WorkerFindingSeverity;
  title: string;
  file: string;
  evidence: string;
};

export type ExecutionOwner = "workhorse" | "parent";

export type BudgetPhase = "produce" | "verify" | "handoff" | "exhausted";

export type AgentRunEvent = {
  at: number;
  type: "budget-warn" | "budget-verify" | "budget-handoff" | "budget-exceeded" | "takeover";
  detail: string;
};

export type AgentRun = {
  /**
   * `interrupted` is the desk stopping, not the worker failing — Workhorse
   * exited while this run was going. The brief, the transcript and the folder
   * all survive, so it can be picked up again; `failed` cannot.
   */
  status: "running" | "completed" | "failed" | "cancelled" | "timed-out" | "budget-exceeded" | "interrupted";
  startedAt: number;
  finishedAt?: number;
  timeoutMs?: number;
  /** This pass’s ceiling. Unset means unbounded. */
  tokenBudget?: number;
  /** Mission-level ceiling when this pass is one of several. */
  missionTokenBudget?: number;
  /** Current assignment spend. Resets when a reused worker takes a new slice. */
  usedTokens?: number;
  /** Sum of prior assignments on this worker. Not a ceiling. */
  lifetimeUsedTokens?: number;
  /** Fresh input at the first meter this slice. Later input growth is new work. */
  budgetBaseline?: number;
  /** Output summed across this slice's turns. Per-turn, so it accumulates. */
  outputTokensTotal?: number;
  /** Cached reads summed across this slice's turns. Discounted, never free. */
  cacheTokensTotal?: number;
  budgetPhase?: BudgetPhase;
  budgetWarnedAt?: number;
  budgetHandoffAt?: number;
  /** Who actually executed the work. Parent takeover is a recorded fact, not a lock. */
  executionOwner?: ExecutionOwner;
  takeoverReason?: string;
  takeoverAt?: number;
  events?: AgentRunEvent[];
  isolation: "worktree" | "shared";
  /** inherit keeps prior conversation. fresh starts cold with only a handoff. */
  seed?: WorkerSeed;
  /** Sibling that admits a plan step. Not a builder and not a grandchild. */
  role?: "auditor";
  changedFiles?: string[];
  conflictFiles?: string[];
  error?: string;
  planStepId?: string;
  rationale?: string;
  skills?: string[];
  skillFiles?: string[];
  capabilities?: string[];
  tools?: string[];
  constraints?: string[];
  /** Repo-relative files this worker is allowed to change. */
  paths?: string[];
  /** Structured review receipts parsed from the worker's terminal output. */
  findings?: WorkerFinding[];
  /** Structured routing policy inherited by every nested worker. */
  exclusions?: string[];
  correlationId?: string;
  mission?: MissionIteration;
};

export type CampaignPhase = "scout" | "review" | "approve" | "build";

export type CampaignClearance = {
  phase: "scout" | "review" | "approve";
  clearedAt: number;
  clearedBy: "human";
};

export type MissionIteration = {
  id: string;
  mode: "adaptive";
  objective: string;
  acceptanceCriteria: string[];
  iteration: number;
  maxIterations: number;
  previousWorkerIds: string[];
  phase: CampaignPhase;
  /** Written by the permission inbox only. A worker-supplied marker is never trusted. */
  clearance?: CampaignClearance;
  /** Mission-level token ceiling. One pass cannot spend this whole amount. */
  tokenBudget?: number;
};

export type FileLease = {
  sessionId: string;
  path: string;
  fingerprint: string;
  claimedAt: number;
};

export type WorkhorseWorkerRun = AgentRun & { kind?: "workhorse" };

export type DeskRun = WorkhorseWorkerRun | ExternalAgentRun;

export type PlanRunStatus =
  | "draft"
  | "approved"
  | "running"
  | "paused"
  | "completed"
  | "blocked"
  | "cancelled";

export type PlanStepStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export type PlanEvidenceKind = "note" | "file" | "test" | "screenshot" | "runtime";

export type PlanEvidence = {
  id: string;
  kind: PlanEvidenceKind;
  label: string;
  value: string;
  recordedAt: number;
  sessionId?: string;
  /** Auditor-only: 40-char worktree HEAD. */
  head?: string;
  /** Auditor-only: named gate command. */
  gate?: string;
  /** Auditor-only: the gate’s literal last line. */
  lastLine?: string;
  role?: "auditor";
  status?: "pass" | "fail";
};

export type PlanAssignment = {
  sessionId: string;
  assignedAt: number;
  provider: ProviderId;
  model: string;
  effort?: EffortLevel;
  customBotId?: string;
  rationale: string;
  skills: string[];
  tools: string[];
  constraints: string[];
  requested?: string;
};

export type PlanEvent = {
  id: string;
  at: number;
  type: string;
  stepId?: string;
  sessionId?: string;
  correlationId?: string;
  detail?: string;
};

export type PlanStep = {
  id: string;
  title: string;
  details?: string;
  status: PlanStepStatus;
  dependsOn: string[];
  evidenceRequired: boolean;
  evidence: PlanEvidence[];
  assignedSessionId?: string;
  assignment?: PlanAssignment;
  startedAt?: number;
  finishedAt?: number;
  reopenedAt?: number;
  error?: string;
};

export type PlanSource = {
  kind: "markdown" | "generated" | "manual";
  label?: string;
  path?: string;
  contentHash?: string;
  importedAt?: number;
};

export type PlanConstraints = {
  tokenBudget?: number;
  timeoutMs?: number;
  maxConcurrency?: number;
};

export type PlanRun = {
  id: string;
  objective: string;
  status: PlanRunStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  source?: PlanSource;
  constraints?: PlanConstraints;
  /** Named test command the auditor must re-run, e.g. `npm test`. */
  gate?: string;
  steps: PlanStep[];
  events?: PlanEvent[];
  approvedAt?: number;
  startedAt?: number;
  pausedAt?: number;
  completedAt?: number;
  blockedReason?: string;
  externalGrant?: AgentGrant;
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
  /** Claude Code's Fast mode. Applied as a session config option. */
  fastMode?: boolean;
  /** Claude Code main-thread agent persona, or null for the standard one. */
  agentName?: string | null;
  /**
   * This worker's name on the desk — Wren, Dexter, Marlow. Set once when the
   * worker is first started and kept for its life, so a later slice can be
   * handed back to the worker that already did the last one instead of
   * starting an identical bot from cold.
   */
  workerName?: string;
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
  goal?: {
    status: "active" | "paused";
    objective: string;
    mode?: "goal" | "loop";
    startedAt?: number;
    budgetMs?: number;
    deadlineAt?: number;
    terminal?: "completed" | "timed-out" | "cancelled";
    rounds?: number;
    roundCap?: number;
    lastRoundAt?: number;
    lastHandoff?: WorkerHandoff;
    lastIdleAssistantId?: string;
  };
  /** Reconstructable turn/step log. Model history projects from this when present. */
  ledger?: import("./session-ledger").SessionLedger;
  /** Workhorse-owned lifecycle and review record for hidden cross-provider children. */
  agentRun?: AgentRun;
  /** Active worker crew for this orchestrator chat. */
  lineup?: DeskLineup;
  /** Workhorse-owned executable plan for this orchestrator chat. */
  planRun?: PlanRun;
  /** Exact operations allowed for the live vendor session. */
  permissionGrants?: PermissionGrant[];
  /** Manual preserves the selected model. Auto may route before a new turn. */
  routingMode?: "auto" | "manual";
  routingDecision?: RoutingDecision;
  /** Composer + pins. Orchestrate and Mission can be on together. */
  crewModes?: CrewMode[];
};

export type PermissionRequest = {
  id: string;
  sessionId: string;
  provider: ProviderId;
  tool: string;
  detail: string;
  path?: string;
  kind?: "tool" | "elevate" | "vendor" | "campaign";
  elevate?: { mode?: PermissionMode; sandbox?: SandboxProfile };
  vendor?: {
    provider: ProviderId;
    name: string;
    status: "day_bank" | "spent" | "disabled" | "ok";
  };
  campaign?: {
    missionId: string;
    phase: "scout" | "review" | "approve";
  };
};

export type PermissionGrant = {
  id: string;
  /** Exact normalized scope. Broad legacy shell/write grants are discarded on load. */
  key: string;
  tool: string;
  detail: string;
  path?: string;
  createdAt: number;
  expiresAt: number;
};

export type Sheet = "project" | "reference" | null;

export type Panel = "settings" | "add-bot" | null;

export type SettingsSection = "profile" | "llms" | "skills" | "routing" | "learning" | "usage" | "watch";

export type SkillOrigin = "grok" | "codex" | "claude" | "cursor" | "workhorse";

export type DeskSkill = {
  name: string;
  description: string;
  origin: SkillOrigin;
  dir: string;
  skillFile: string;
  /** True only for copies stored in Workhorse's own skills home. */
  managed?: boolean;
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
  /** Installed, but the login is missing or expired. */
  needsAuth?: boolean;
  name?: string;
  color?: string;
  /** Native vendor defaults used only when seeding a new chat. */
  accessDefaults?: BotAccessDefaults;
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
  /** Models the user approved for this bot. `model` is always among them. */
  models?: string[];
  /**
   * Everything the provider's own /models endpoint offered. The offer, not the
   * choice: Synthetic lists dozens, and a chat should only ever reach one its
   * owner ticked. Never saved on the bot.
   */
  discovered?: string[];
};

export type CustomBot = {
  id: string;
  name: string;
  color: string;
  baseUrl: string;
  /** The model a new chat on this bot starts with. Always one of `models`. */
  model: string;
  /**
   * The models approved for this connection. A provider like Synthetic sells
   * many behind a single key and a single quota, so they belong to one bot
   * rather than one bot each: two bots on one account would draw two leftover
   * rings from the same pool and report it twice.
   *
   * Approved, not offered — the provider's list is shown when the connection
   * is tested and the owner ticks what they want. Absent means just `model`.
   */
  models?: string[];
  /**
   * What the provider's /models last offered. Cached so more models can be
   * approved later without testing the connection again. The offer, never the
   * permission — only `models` decides what a chat may reach.
   */
  discovered?: string[];
  apiKey: string;
  /** Reference to an OS-encrypted secret; apiKey is hydrated only in memory. */
  credentialId?: string;
  api: "anthropic-messages" | "openai-completions";
  contextWindow: number;
  createdAt: number;
  enabled?: boolean;
  /** Override for the bot's default `model` only. Other approved ids use the family table. */
  routingProfile?: Partial<ModelRoutingProfile>;
  /** Per-model overrides. Keyed by approved model id. */
  routingProfiles?: Record<string, Partial<ModelRoutingProfile>>;
};

export type RoutingTaskTier = "quick" | "balanced" | "deep";

export type ModelInputCapabilities = {
  text: boolean;
  images: boolean;
  documents: boolean;
  audio: boolean;
  video: boolean;
};

/** What a prompt is mostly about. Routing tie-breaks toward models strong there. */
export type TaskDomain = "coding" | "writing" | "visual" | "data" | "general";

export type ModelRoutingProfile = {
  /** 1 is lightweight; 5 is frontier reasoning. */
  intelligence: number;
  /** 1 is slow; 5 is optimized for latency. */
  speed: number;
  /** 1 is inexpensive; 5 is expensive. */
  cost: number;
  local: boolean;
  inputs: ModelInputCapabilities;
  /** Domains this family is notably strong in. Absent means no tilt either way. */
  strengths?: readonly TaskDomain[];
};

export type RoutingSettings = {
  enabled: boolean;
  capacityAware: boolean;
  preferExcess: boolean;
  allowLocal: boolean;
  /** Keep this percentage of a weekly allowance in reserve. */
  reservePercent: number;
  /** Opt-in. Off never auto-picks OpenClaw or Hermes. */
  includeExternalAgents?: boolean;
};

export type AgentSystemsSettings = {
  inboundSessionId?: string;
  inboundProjectId?: string;
  /** Harness agents the owner permits Auto routing to consider. */
  allowedAgents?: string[];
};

/** Execution callers that may be explicitly granted a local capability. */
export type LocalComputeCallerRole = "desk" | "external-runtime" | "worker" | "auditor";

/** Exact continuation adapter identity; capability alone is not authority. */
export type LocalComputeContinuationGrant = {
  capability: string;
  tool: string;
};

/**
 * Safe, persisted connection metadata for one local execution host. Tokens
 * stay in a mode-restricted file owned by the operating system user.
 */
export type LocalComputeHostSettings = {
  id: string;
  label: string;
  baseUrl: string;
  tokenFile: string;
  enabled: boolean;
  allowedCallerRoles: LocalComputeCallerRole[];
  /** Empty means no capability is authorized. It is never a wildcard. */
  allowedCapabilities: string[];
  /** Source capability grants never imply continuation authority. */
  allowedContinuations: LocalComputeContinuationGrant[];
};

export type LocalComputeSettings = {
  version: 1;
  hosts: LocalComputeHostSettings[];
  /** Migration bridge; any explicit Local Compute edit permanently disables it. */
  legacyEnvironmentFallback: boolean;
};

export type RoutingDecision = {
  at: number;
  taskTier: RoutingTaskTier;
  provider: ProviderId;
  model: string;
  effort?: EffortLevel | null;
  customBotId?: string;
  score: number;
  reason: string;
  usedPercent?: number;
  expectedUsedPercent?: number;
};

export type WatchSettings = {
  dailyLimitPercent: number;
  lockDaily: boolean;
  desktopNotify: boolean;
  /** Bots on the daily bank. Missing means every bot (older saves). */
  lockKeys?: string[];
  /**
   * Hide a vendor with no plan leftover from spawn targets, whether or not the
   * daily bank covers it. Running out is the vendor's own fact, not a bank
   * policy — a worker spawned onto a spent vendor fails at the CLI. Off lets
   * one through for overage or prepaid credit.
   */
  blockSpentSpawns?: boolean;
  /** Leftover percent at or below which a vendor counts as spent. */
  spentPercent?: number;
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
    cursor: LlmLink;
    custom: CustomLlm;
  };
  customBots: CustomBot[];
  mcpServers: McpServerConfig[];
  usageBudgets: Partial<Record<ProviderId, number>>;
  watch: WatchSettings;
  routing: RoutingSettings;
  learning: import("./learning-types").LearningSettings;
  agentSystems?: AgentSystemsSettings;
  localCompute: LocalComputeSettings;
};

export type UsageRange = "today" | "week" | "month" | "all";

export type GrokPlanProduct = {
  product: string;
  label: string;
  usagePercent: number;
  resetsAt?: string;
  /** No cap on this window (MiniMax weekly on some seats). Do not turn this into 100%. */
  unlimited?: boolean;
};

export type GrokPlanUsage = {
  usedPercent: number;
  leftPercent: number;
  period: "weekly" | "monthly" | "unknown";
  resetsAt?: string;
  observedAt?: string;
  prepaidBalance: number;
  products: GrokPlanProduct[];
};

/**
 * Where a usage number came from. The source decides how numbers combine, so
 * it travels with them instead of being guessed from their size afterwards.
 *
 * - `turn`     — one authoritative total for the whole turn (ACP
 *                PromptResponse.usage, Codex turn end). Replaces anything
 *                collected mid-turn; never summed with it.
 * - `request`  — one HTTP request's own bill. A turn made of many requests
 *                (tool loops) sums these, and only these.
 * - `gauge`    — a context meter (ACP usage_update `used`/`size`, Codex
 *                token_count). Carries contextUsed and cost. Never tokens.
 * - `estimate` — characters / 4 because the vendor reported nothing.
 */
/**
 * How the numbers were obtained.
 *
 * `subagent` is a vendor's own child reporting what it already spent. It is
 * booked on its own rather than folded, because several can finish inside one
 * parent turn and the fold keeps only one draft.
 */
export type UsageSource = "turn" | "request" | "gauge" | "estimate" | "subagent" | "compact";

export type UsageEvent = {
  id: string;
  at: number;
  provider: ProviderId;
  model: string;
  projectId?: string;
  sessionId?: string;
  customBotId?: string;
  /** Fresh prompt tokens the model read for the first time. Excludes cache reads. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from cache. Context replayed, not new work. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  /** Context retained by the model for the final request in this turn. */
  contextUsed?: number;
  /** How the numbers were obtained. Absent on events written before it was recorded. */
  source?: UsageSource;
  /** Cursor two-pool lane. Required on new Cursor events. */
  lane?: import("./cursor-lane").CursorUsageLane;
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
  source?: UsageSource;
  lane?: import("./cursor-lane").CursorUsageLane;
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
  /** Active path claims. Released when their worker reaches a terminal state. */
  leases?: FileLease[];
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
  externalTasks?: { byId: Record<string, ExternalTask>; byKey: Record<string, string> };
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

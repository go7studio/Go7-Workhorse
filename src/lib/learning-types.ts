import type { EffortLevel, ProviderId } from "./types";

export const LEARNING_SCHEMA_VERSION = 3;
export const LEARNING_REDACTION_VERSION = 1;
export const LEARNING_DIR_NAME = "learning";
export const LEARNING_DB_FILE = "learning.sqlite";
export const LEARNING_INBOUND_FILE = "inbound.jsonl";

export type LearningMode = "off" | "capture" | "review" | "automatic";

export type MemoryClass = "intent" | "operations";

export type MemoryScope = "project" | "global-user";

export type MemoryStatus = "proposed" | "approved" | "active" | "superseded" | "deleted";

export type ActorClass = "human" | "agent" | "system";

export type IntelligenceLane =
  | "human-intent"
  | "agent-performance"
  | "intent-performance-mismatch"
  | "legacy-unclassified";

export type SensitivityLabel = "normal" | "sensitive" | "secret";

export type LearningEventKind =
  | "human-prompt"
  | "human-edit"
  | "human-correction"
  | "routing"
  | "execution"
  | "usage"
  | "outcome"
  | "skill"
  | "tool"
  | "compiler";

export type CompilerRunStatus = "pending" | "running" | "completed" | "failed" | "interrupted";

export type VerificationState = "unverified" | "accepted" | "rejected" | "tested" | "artifact" | "adapter";

export type LearningSettings = {
  mode: LearningMode;
  compilerProvider?: ProviderId;
  compilerModel?: string;
  compilerEffort?: EffortLevel | null;
  compilerCustomBotId?: string;
  /** Automatic prompt injection. Off until the eval baseline passes. */
  autoRetrieve: boolean;
  projectModes?: Record<string, LearningMode>;
};

export type LearningEvent = {
  id: string;
  createdAt: number;
  localDay: string;
  kind: LearningEventKind;
  schemaVersion: number;
  userId?: string;
  projectId?: string;
  sessionId?: string;
  planStepId?: string;
  agentRunId?: string;
  correlationId?: string;
  actorClass: ActorClass;
  provider?: ProviderId;
  model?: string;
  effort?: EffortLevel | null;
  skillIds?: string[];
  toolIds?: string[];
  payload: Record<string, unknown>;
  redactionVersion: number;
  sensitivity: SensitivityLabel;
  sourceHash: string;
  tombstone?: boolean;
  purged?: boolean;
};

export type MemoryItem = {
  id: string;
  intelligenceLane: IntelligenceLane;
  memoryClass: MemoryClass;
  scope: MemoryScope;
  projectId?: string;
  providerScope?: ProviderId;
  statement: string;
  tags?: string[];
  sourceEventIds: string[];
  sourceMemoryIds?: string[];
  correlationIds?: string[];
  compilerRunId?: string;
  confidence?: number;
  verification: VerificationState;
  createdAt: number;
  lastConfirmedAt?: number;
  supersededAt?: number;
  expiresAt?: number;
  deletedAt?: number;
  supersedesId?: string;
  contradictsId?: string;
  status: MemoryStatus;
};

export type CompilerRun = {
  id: string;
  intelligenceLane: IntelligenceLane;
  inputFrom?: number;
  inputTo?: number;
  eventWatermark?: string;
  memoryWatermark?: string;
  inputMemoryIds?: string[];
  provider?: ProviderId;
  model?: string;
  effort?: EffortLevel | null;
  rationale?: string;
  status: CompilerRunStatus;
  attempt: number;
  startedAt?: number;
  endedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  errorClass?: string;
  outputMemoryIds?: string[];
  inputHash: string;
};

export type RetrievalAudit = {
  id: string;
  createdAt: number;
  sessionId?: string;
  projectId?: string;
  provider?: ProviderId;
  queryScope: string;
  candidateIds: string[];
  selectedIds: string[];
  excludedIds: string[];
  scores: Record<string, number>;
  tokenBudget: number;
};

export type ForgetTarget = {
  all?: boolean;
  projectId?: string;
  provider?: ProviderId;
  memoryId?: string;
  eventId?: string;
};

export type PurgeResult = {
  ok: boolean;
  closed: boolean;
  eventsRemoved: number;
  memoriesRemoved: number;
  ftsRemoved: number;
  walRemoved: boolean;
  verifiedAbsent: boolean;
  message?: string;
};

export type LearningProbeResult = {
  nodeSqlite: boolean;
  fts5: boolean;
  writable: boolean;
  schemaVersion: number;
  integrity: boolean;
  path: string;
  sqliteVersion?: string;
  fallback: "none" | "lexical";
};

export type RetrievalQuery = {
  projectId?: string;
  sessionId?: string;
  provider?: ProviderId;
  intelligenceLane?: Exclude<IntelligenceLane, "legacy-unclassified">;
  text?: string;
  taskClass?: string;
  skillIds?: string[];
  goal?: string;
  now?: number;
  itemCap?: number;
  tokenCap?: number;
  allowGlobal?: boolean;
};

export type RankedMemory = MemoryItem & { score: number };

export type LearningBriefProposal = {
  action: "add" | "confirm" | "contradict" | "supersede";
  memoryClass: MemoryClass;
  scope: MemoryScope;
  projectId?: string;
  providerScope?: ProviderId;
  statement: string;
  tags?: string[];
  sourceEventIds: string[];
  sourceMemoryIds?: string[];
  confidence?: number;
  supersedesId?: string;
  contradictsId?: string;
};

export type LearningBrief = {
  intent: LearningBriefProposal[];
  operations: LearningBriefProposal[];
};

export type LearningIndexStats = {
  indexedEvents: number;
  indexedHumanEvents: number;
  indexedAgentEvents: number;
  compiledEvents: number;
  compiledAgentEvents: number;
  memories: number;
  agentMemories: number;
  mismatchMemories: number;
  completedRuns: number;
  latestEventAt?: number;
  latestCompileAt?: number;
};

export type AdaptiveSelection = {
  provider?: ProviderId;
  model?: string;
  effort?: EffortLevel | null;
  customBotId?: string;
  score: number;
  reason: string;
  candidates: Array<{
    provider: ProviderId;
    model: string;
    customBotId?: string;
    score: number;
    excluded?: string;
  }>;
};

export type OutcomeMetric = {
  provider: ProviderId;
  model: string;
  effort?: EffortLevel | null;
  customBotId?: string;
  taskClass: string;
  verifiedSuccesses: number;
  verifiedFailures: number;
  avgDurationMs?: number;
  avgCostUsd?: number;
};

export type AuxiliaryCallRequest = {
  provider: ProviderId;
  model: string;
  effort?: EffortLevel | null;
  customBotId?: string;
  prompt: string;
};

export type AuxiliaryCallResult = {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  createdWorkhorseChat: false;
  leftoverVendorThread: false;
};

export type AuxiliaryCaller = (request: AuxiliaryCallRequest) => Promise<AuxiliaryCallResult>;

export type CompileResult = {
  ran: boolean;
  skipped?: string;
  runId?: string;
  memories?: number;
  provider?: ProviderId;
  model?: string;
  customBotId?: string;
  intelligenceLane?: Exclude<IntelligenceLane, "legacy-unclassified">;
};

export type CompilerPolicy = {
  minEligibleEvents: number;
  quietMs: number;
  maxEventsPerRun: number;
  maxPayloadChars: number;
  /** Ceiling on the existing-memory block a compile prompt may carry. */
  maxMemoryChars: number;
  maxAttempts: number;
  /** Ceiling on the backoff between attempts at one input. */
  maxBackoffMs: number;
};

export type EventFilter = {
  projectId?: string;
  provider?: ProviderId;
  actorClass?: ActorClass;
  includeTombstones?: boolean;
  afterWatermark?: string;
  kinds?: LearningEventKind[];
  limit?: number;
};

export type MemoryFilter = {
  projectId?: string;
  provider?: ProviderId;
  intelligenceLane?: IntelligenceLane;
  memoryClass?: MemoryClass;
  statuses?: MemoryStatus[];
  includeDeleted?: boolean;
};

export type LearningExportPayload = {
  exportedAt: number;
  schemaVersion: number;
  events: LearningEvent[];
  memories: MemoryItem[];
  compilerRuns: CompilerRun[];
  audits: RetrievalAudit[];
};

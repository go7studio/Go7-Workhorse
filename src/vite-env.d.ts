/// <reference types="vite/client" />

type GrokPromptBridgeInput = {
  sessionId: string;
  projectId?: string;
  text: string;
  visibleText?: string;
  images?: import("./lib/types").ChatImage[];
  model: string;
  effort: import("./lib/types").EffortLevel | null;
  mode: import("./lib/types").PermissionMode;
  cwd: string;
  vendorSessionId?: string;
  sandbox?: import("./lib/types").SandboxProfile;
  mcpServers?: import("./lib/types").McpServerConfig[];
  preface?: string;
  crewModes?: import("./lib/types").CrewMode[];
};

type GrokBridgeEvent =
  | { type: "chunk"; sessionId: string; text: string }
  | { type: "thought"; sessionId: string; text: string }
  | { type: "done"; sessionId: string; stopReason?: string }
  | { type: "error"; sessionId: string; message: string }
  | {
      type: "permission";
      sessionId: string;
      requestId: string;
      tool: string;
      detail: string;
      path?: string;
      elevate?: { mode?: import("./lib/types").PermissionMode; sandbox?: import("./lib/types").SandboxProfile };
      vendor?: { provider: import("./lib/types").ProviderId; name: string; status?: string };
    }
  | { type: "tool"; sessionId: string; toolCallId: string; title: string; status: string; detail: string }
  | {
      type: "compact";
      sessionId: string;
      trigger: "manual" | "auto";
      note?: string;
      contextUsed?: number;
      tokensBefore?: number;
      tokensAfter?: number;
    }
  | {
      type: "usage";
      sessionId: string;
      model: string;
      projectId?: string;
      provider?: import("./lib/types").ProviderId;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd?: number;
      contextUsed?: number;
      source?: import("./lib/types").UsageSource;
    }
  | {
      type: "vendor-session";
      sessionId: string;
      vendorSessionId: string;
      opened: "session/new" | "session/load";
    }
  | { type: "title"; sessionId: string; title: string }
  | { type: "commands"; sessionId: string; commands: import("./lib/types").Command[] };

type WorkhorseBridge = {
  pickFolder: () => Promise<import("./lib/project").PickedFolder | null>;
  pickExportFolder: () => Promise<import("./lib/project").PickedFolder | null>;
  listDeskSkills: (projectFolders?: string[]) => Promise<import("./lib/types").DeskSkill[]>;
  exportVendor: (input: {
    provider: string;
    dest?: string;
    kind: import("./lib/types").DeskExportKind;
    sessions?: import("./lib/types").Session[];
    projects?: import("./lib/types").Project[];
    projectFolders?: string[];
    customBotId?: string;
    botName?: string;
  }) => Promise<import("./lib/types").DeskExportResult>;
  exportChat: (input: {
    dest?: string;
    session: import("./lib/types").Session;
    projectName?: string;
  }) => Promise<import("./lib/types").DeskExportResult>;
  importSkill: (from: string) => Promise<import("./lib/types").DeskExportResult>;
  readDeskSkill: (
    query: string,
    projectFolders?: string[],
  ) => Promise<{
    ok: boolean;
    skill?: { name: string; origin: import("./lib/types").SkillOrigin; dir: string; text: string };
    message?: string;
  }>;
  deleteSkill: (dir: string) => Promise<import("./lib/types").DeskExportResult>;
  pushSkill: (input: {
    dir: string;
    name?: string;
    target: "grok" | "codex" | "claude" | "cursor";
  }) => Promise<import("./lib/types").DeskExportResult>;
  pickFile: () => Promise<string | null>;
  pickAttach?: () => Promise<string[]>;
  pickLocalComputeTokenFile?: () => Promise<string | null>;
  mediaSrc: (href: string, cwd?: string, vendorSessionId?: string) => Promise<string | null>;
  pathForFile: (file: File) => string;
  listDropFiles: (paths: string[]) => Promise<
    {
      name: string;
      mimeType: string;
      kind: import("./lib/types").AttachmentKind;
      text?: string;
      data?: string;
      sourcePath?: string;
      size?: number;
    }[]
  >;
  revealProject: (folder: string) => Promise<void>;
  missingFolders: (folders: string[]) => Promise<string[]>;
  openExternal?: (href: string) => Promise<boolean>;
  fileDiff: (
    filePath: string,
    roots?: string[],
    created?: boolean,
  ) => Promise<import("./lib/file-diff").FileDiff | null>;
  recordFileWrite?: (filePath: string, roots?: string[]) => Promise<string>;
  readSourceFile?: (
    filePath: string,
    roots?: string[],
  ) => Promise<import("../electron/project-diff").SourceRead | null>;
  gitHead?: (cwd: string) => Promise<string>;
  listGitChanges?: (cwd: string, baseRef?: string) => Promise<import("../electron/project-diff").GitChange[]>;
  resolveFile?: (filePath: string, roots?: string[]) => Promise<string | null>;
  editStats: (
    paths: string[],
    roots?: string[],
    createdPaths?: string[],
  ) => Promise<Record<string, { added: number; deleted: number }>>;
  ensureWorktree: (
    input: import("../electron/worktree-host").EnsureWorktreeInput,
  ) => Promise<import("../electron/worktree-host").EnsureWorktreeResult>;
  terminalStart?: (sessionId: string, cwd: string) => Promise<{ ok: boolean; message?: string }>;
  terminalWrite?: (sessionId: string, text: string) => Promise<{ ok: boolean; message?: string }>;
  terminalStop?: (sessionId: string) => Promise<void>;
  onTerminalEvent?: (handler: (event: import("../electron/terminal-host").TerminalEvent) => void) => () => void;
  loadState: () => Promise<Record<string, unknown>>;
  saveState: (state: Record<string, unknown>) => Promise<void>;
  /** Optional, like every other bridge method: an older shell simply shows the prose. */
  loadTranscript?: (sessionId: string) => Promise<import("./lib/transcript-sidecar").TranscriptSidecar | null>;
  saveComposerDrafts?: (drafts: Record<string, { text?: string; images?: import("./lib/types").ChatImage[] }>) => Promise<void>;
  syncJobs?: (sessions: import("./lib/types").Session[]) => Promise<import("../electron/job-engine").DurableJobEvent[]>;
  onJobDue?: (handler: (events: import("../electron/job-engine").DurableJobEvent[]) => void) => () => void;
  onGrokBotLateAnswer?: (handler: (answers: import("../electron/grok-bot-late").GrokBotLateAnswer[]) => void) => () => void;
  lateGrokBotAnswers?: () => Promise<import("../electron/grok-bot-late").GrokBotLateAnswer[]>;
  ackGrokBotLateAnswer?: (reqId: string) => Promise<void>;
  quit: () => Promise<void>;
  notifyDesktop?: (input: { title: string; body?: string }) => Promise<boolean>;
  collectDiagnostics?: () => Promise<import("../electron/diagnostics").SupportReport>;
  exportDiagnostics?: () => Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
  grokPrompt: (input: GrokPromptBridgeInput) => Promise<{
    text?: string;
    stopReason?: string;
    vendorSessionId?: string;
    opened?: "session/new" | "session/load";
  }>;
  detectGrokLogin: () => Promise<import("../electron/grok-login").GrokLoginDetectResult>;
  detectCodexLogin: () => Promise<import("../electron/codex-login").CodexLoginDetectResult>;
  detectCodexRuntime?: () => Promise<import("../electron/codex-app-server").CodexRuntimeInfo>;
  listCodexNativeThreads?: (limit?: number) => Promise<import("../electron/codex-app-server").CodexNativeThread[]>;
  codexCapabilities?: (projectRoot?: string) => Promise<ReturnType<typeof import("../electron/codex-capabilities").codexCapabilitySummary>>;
  detectClaudeLogin: () => Promise<import("../electron/claude-login").ClaudeLoginDetectResult>;
  claudeSetupToken: () => Promise<{ ok: boolean; message?: string }>;
  claudePrompt: (input: GrokPromptBridgeInput) => Promise<{
    text?: string;
    stopReason?: string;
    vendorSessionId?: string;
    opened?: "session/new" | "session/load";
  }>;
  claudeAnswerPermission: (requestId: string, answer: import("./lib/permissions").PermissionAnswer) => Promise<boolean>;
  claudeCancel: (sessionId: string) => Promise<void>;
  onClaudeEvent: (handler: (event: GrokBridgeEvent) => void) => () => void;
  detectCursorLogin?: () => Promise<{ connected: boolean; needsAuth?: boolean; binary: string | null; accessDefaults?: import("./lib/types").BotAccessDefaults }>;
  cursorPrompt?: (input: GrokPromptBridgeInput) => Promise<{
    text?: string;
    stopReason?: string;
    vendorSessionId?: string;
    opened?: "session/new" | "session/load";
  }>;
  cursorAnswerPermission?: (requestId: string, answer: import("./lib/permissions").PermissionAnswer) => Promise<boolean>;
  cursorCancel?: (sessionId: string) => Promise<void>;
  onCursorEvent?: (handler: (event: GrokBridgeEvent) => void) => () => void;
  cursorPlanUsage?: () => Promise<import("./lib/types").GrokPlanUsage | null | undefined>;
  detectCustomLogin: () => Promise<{
    connected: boolean;
    source: "openclaw" | "env" | "none";
    config: import("./lib/types").CustomLlm;
    models: import("./lib/models").ModelInfo[];
  }>;
  /** Models the provider itself lists. Empty when it publishes none. */
  customModels?: (config: { baseUrl: string; apiKey: string }) => Promise<string[]>;
  probeCustom: (config: {
    baseUrl: string;
    apiKey: string;
    model: string;
    api?: "anthropic-messages" | "openai-completions";
  }) => Promise<{ ok: boolean; message: string; contextWindow?: number; model?: string; api?: "anthropic-messages" | "openai-completions" }>;
  customAnswerPermission: (requestId: string, answer: import("./lib/permissions").PermissionAnswer) => Promise<boolean>;
  customPrompt: (input: {
    sessionId: string;
    projectId?: string;
    text: string;
    images?: import("./lib/types").ChatImage[];
    model: string;
    effort: import("./lib/types").EffortLevel | null;
    cwd: string;
    mode?: import("./lib/types").PermissionMode;
    sandbox?: import("./lib/types").SandboxProfile;
    preface?: string;
    history?: { role: "user" | "assistant"; text: string }[];
    mcpServers?: import("./lib/types").McpServerConfig[];
    securityPolicy?: import("./lib/types").SessionSecurityPolicy;
    permissionGrants?: import("./lib/types").PermissionGrant[];
    folders?: string[];
    parentId?: string;
    hidden?: boolean;
    role?: import("./lib/workhorse-rules").DeskRole;
    crewModes?: import("./lib/types").CrewMode[];
    customBotId?: string;
    config: {
      baseUrl: string;
      apiKey: string;
      model: string;
      api?: "anthropic-messages" | "openai-completions";
      inputs?: Partial<import("./lib/types").ModelInputCapabilities>;
    };
  }) => Promise<{ text?: string; stopReason?: string }>;
  probeMcpServer?: (serverName: string) => Promise<import("./lib/types").McpProbeResult>;
  customCancel: (sessionId: string) => Promise<void>;
  onCustomEvent: (handler: (event: GrokBridgeEvent) => void) => () => void;
  listVendorModels: () => Promise<Record<import("./lib/types").ProviderId, import("./lib/models").ModelInfo[]>>;
  codexPrompt: (input: GrokPromptBridgeInput) => Promise<{
    text?: string;
    stopReason?: string;
    vendorSessionId?: string;
    opened?: "session/new" | "session/load";
    nativeSessionArchived?: boolean;
  }>;
  codexAnswerPermission: (requestId: string, answer: import("./lib/permissions").PermissionAnswer) => Promise<boolean>;
  codexCancel: (sessionId: string) => Promise<void>;
  onCodexEvent: (handler: (event: GrokBridgeEvent) => void) => () => void;
  grokPlanUsage: () => Promise<import("./lib/types").GrokPlanUsage | undefined>;
  codexPlanUsage: () => Promise<import("./lib/types").GrokPlanUsage | undefined>;
  claudePlanUsage: () => Promise<import("./lib/types").GrokPlanUsage | undefined>;
  customPlanUsage: (input: {
    baseUrl: string;
    apiKey: string;
    model?: string;
    credentialId?: string;
  }) => Promise<import("./lib/types").GrokPlanUsage | undefined>;
  grokAnswerPermission: (requestId: string, answer: import("./lib/permissions").PermissionAnswer) => Promise<boolean>;
  grokCancel: (sessionId: string) => Promise<void>;
  grokCompact: (input: GrokPromptBridgeInput & { note?: string }) => Promise<{
    trigger?: "manual" | "auto";
    note?: string;
    contextUsed?: number;
    tokensBefore?: number;
    tokensAfter?: number;
  }>;
  grokSessionInfo: (sessionId: string) => Promise<import("./lib/context-stats").ChatContextStats | null>;
  grokRewind: (input: GrokPromptBridgeInput & { keepUserIndex: number }) => Promise<{
    reset?: boolean;
    rewound?: boolean;
  }>;
  grokFork: (input: GrokPromptBridgeInput) => Promise<{ vendorSessionId?: string }>;
  onPeerAsk: (
    handler: (payload: { id: string; childSessionId?: string } & import("../electron/peer-inbox").PeerAsk) => void,
  ) => () => void;
  replyPeerAsk: (payload: { id: string; text?: string; error?: string }) => Promise<boolean>;
  onPeerCancel?: (handler: (payload: { childSessionId: string; reason: "timed-out" | "cancelled" }) => void) => () => void;
  onGrokEvent: (handler: (event: GrokBridgeEvent) => void) => () => void;
  checkAppUpdate: () => Promise<import("./lib/app-update").AppUpdateCheckResult>;
  applyAppUpdate: (version: string) => Promise<import("./lib/app-update").AppUpdateApplyResult>;
  learningConfigure?: (settings: import("./lib/types").Settings) => Promise<boolean>;
  learningProbe?: () => Promise<import("./lib/learning-types").LearningProbeResult>;
  learningRecord?: (event: unknown) => Promise<{ inserted: boolean }>;
  learningRetrieve?: (query: import("./lib/learning-types").RetrievalQuery) => Promise<{
    items: import("./lib/learning-types").RankedMemory[];
    frame: string;
    auditId?: string;
  }>;
  learningCompile?: () => Promise<import("./lib/learning-types").CompileResult>;
  learningMemories?: () => Promise<import("./lib/learning-types").MemoryItem[]>;
  learningStats?: () => Promise<import("./lib/learning-types").LearningIndexStats>;
  learningApprove?: (id: string) => Promise<import("./lib/learning-types").MemoryItem | undefined>;
  learningForget?: (target: import("./lib/learning-types").ForgetTarget) => Promise<{ tombstoned: number }>;
  learningPurge?: (target: import("./lib/learning-types").ForgetTarget) => Promise<import("./lib/learning-types").PurgeResult>;
  learningExport?: (dest: string) => Promise<{ ok: boolean; dest?: string; message?: string }>;
  probeLocalCompute?: (
    hosts: import("./lib/types").LocalComputeHostSettings[],
  ) => Promise<import("./lib/local-compute").LocalComputeHostProbe[]>;
  detectAgentRuntimes?: () => Promise<{
    statuses: import("./lib/external-catalog").AgentRuntimeStatus[];
    agents: import("./lib/external-catalog").ExternalAgent[];
  }>;
  installExternalMcp?: (hosts?: string[]) => Promise<{ ok: boolean; message?: string }>;
  linkConfig?: () => Promise<string>;
  linkGrokBotOneshot?: () => Promise<string>;
  grokBotWakeStatus?: () => Promise<import("./lib/grok-bot-wake").GrokBotWakeStatus>;
  saveGrokBotWake?: (input: import("./lib/grok-bot-wake").GrokBotWakeInput) => Promise<import("./lib/grok-bot-wake").GrokBotWakeStatus>;
  installLinkCommand?: () => Promise<{ ok: boolean; message?: string }>;
  startExternalRuntimeTask?: (
    request: import("./lib/external-task").RuntimeStartRequest,
  ) => Promise<import("./lib/types").ExternalTask | null>;
  cancelExternalRuntimeTask?: (taskId: string) => Promise<boolean>;
};

interface Window {
  workhorse?: WorkhorseBridge;
}

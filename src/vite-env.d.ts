/// <reference types="vite/client" />

type GrokPromptBridgeInput = {
  sessionId: string;
  projectId?: string;
  text: string;
  images?: import("./lib/types").ChatImage[];
  model: string;
  effort: import("./lib/types").EffortLevel | null;
  mode: import("./lib/types").PermissionMode;
  cwd: string;
  vendorSessionId?: string;
  sandbox?: import("./lib/types").SandboxProfile;
  mcpServers?: import("./lib/types").McpServerConfig[];
  preface?: string;
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
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd?: number;
      contextUsed?: number;
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
  pickFolder: () => Promise<string | null>;
  pickExportFolder: () => Promise<string | null>;
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
    target: "grok" | "codex" | "claude";
  }) => Promise<import("./lib/types").DeskExportResult>;
  pickFile: () => Promise<string | null>;
  mediaSrc: (href: string, cwd?: string, vendorSessionId?: string) => Promise<string | null>;
  pathForFile: (file: File) => string;
  listDropFiles: (paths: string[]) => Promise<
    {
      name: string;
      mimeType: string;
      kind: "image" | "file";
      text?: string;
      data?: string;
    }[]
  >;
  revealProject: (folder: string) => Promise<void>;
  openExternal?: (href: string) => Promise<boolean>;
  fileDiff: (filePath: string, roots?: string[]) => Promise<import("./lib/file-diff").FileDiff | null>;
  listGitChanges?: (cwd: string) => Promise<import("../electron/project-diff").GitChange[]>;
  resolveFile?: (filePath: string, roots?: string[]) => Promise<string | null>;
  editStats: (
    paths: string[],
    roots?: string[],
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
  syncJobs?: (sessions: import("./lib/types").Session[]) => Promise<import("../electron/job-engine").DurableJobEvent[]>;
  onJobDue?: (handler: (events: import("../electron/job-engine").DurableJobEvent[]) => void) => () => void;
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
  detectGrokLogin: () => Promise<{ connected: boolean; binary: string | null }>;
  detectCodexLogin: () => Promise<{ connected: boolean; binary: string | null }>;
  detectCodexRuntime?: () => Promise<import("../electron/codex-app-server").CodexRuntimeInfo>;
  listCodexNativeThreads?: (limit?: number) => Promise<import("../electron/codex-app-server").CodexNativeThread[]>;
  codexCapabilities?: (projectRoot?: string) => Promise<ReturnType<typeof import("../electron/codex-capabilities").codexCapabilitySummary>>;
  detectClaudeLogin: () => Promise<{ connected: boolean; needsAuth?: boolean; binary: string | null }>;
  claudeAuthCommand: () => Promise<{ command: string; cwd: string }>;
  claudePrompt: (input: GrokPromptBridgeInput) => Promise<{
    text?: string;
    stopReason?: string;
    vendorSessionId?: string;
    opened?: "session/new" | "session/load";
  }>;
  claudeAnswerPermission: (requestId: string, answer: import("./lib/permissions").PermissionAnswer) => Promise<boolean>;
  claudeCancel: (sessionId: string) => Promise<void>;
  onClaudeEvent: (handler: (event: GrokBridgeEvent) => void) => () => void;
  detectCustomLogin: () => Promise<{
    connected: boolean;
    source: "openclaw" | "env" | "none";
    config: import("./lib/types").CustomLlm;
    models: import("./lib/models").ModelInfo[];
  }>;
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
    folders?: string[];
    config: { baseUrl: string; apiKey: string; model: string; api?: "anthropic-messages" | "openai-completions" };
  }) => Promise<{ text?: string; stopReason?: string }>;
  customCancel: (sessionId: string) => Promise<void>;
  onCustomEvent: (handler: (event: GrokBridgeEvent) => void) => () => void;
  listVendorModels: () => Promise<Record<import("./lib/types").ProviderId, import("./lib/models").ModelInfo[]>>;
  codexPrompt: (input: GrokPromptBridgeInput) => Promise<{
    text?: string;
    stopReason?: string;
    vendorSessionId?: string;
    opened?: "session/new" | "session/load";
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
    handler: (payload: {
      id: string;
      fromSessionId: string;
      toSessionId: string;
      message: string;
      mode?: "ask" | "spawn" | "bots";
      provider?: string;
      model?: string;
      description?: string;
      chat?: string;
      effort?: string;
      timeoutSeconds?: number;
      tokenBudget?: number;
      isolation?: "worktree" | "shared";
      childSessionId?: string;
      action?: import("../electron/peer-inbox").PeerAction;
      folder?: string;
      name?: string;
      color?: string;
      baseUrl?: string;
      apiKey?: string;
      api?: string;
      contextWindow?: number;
      bot?: string;
    }) => void,
  ) => () => void;
  replyPeerAsk: (payload: { id: string; text?: string; error?: string }) => Promise<boolean>;
  onPeerCancel?: (handler: (payload: { childSessionId: string; reason: "timed-out" | "cancelled" }) => void) => () => void;
  onGrokEvent: (handler: (event: GrokBridgeEvent) => void) => () => void;
  checkAppUpdate: () => Promise<import("./lib/app-update").AppUpdateOffer | null>;
  applyAppUpdate: (version: string) => Promise<import("./lib/app-update").AppUpdateApplyResult>;
};

interface Window {
  workhorse?: WorkhorseBridge;
}

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { PermissionAnswer } from "../src/lib/permissions";
import type { GrokCompactInput, GrokIpcEvent, GrokPromptInput } from "./grok-host";
import type { CodexPromptInput } from "./codex-host";

contextBridge.exposeInMainWorld("workhorse", {
  pickFolder: () => ipcRenderer.invoke("folder:pick") as Promise<string | null>,
  pickExportFolder: () => ipcRenderer.invoke("folder:pick-export") as Promise<string | null>,
  listDeskSkills: (projectFolders: string[] = []) =>
    ipcRenderer.invoke("desk:list-skills", projectFolders) as Promise<import("../src/lib/types").DeskSkill[]>,
  exportVendor: (input: {
    provider: string;
    dest?: string;
    kind: import("../src/lib/types").DeskExportKind;
    sessions?: import("../src/lib/types").Session[];
    projects?: import("../src/lib/types").Project[];
    projectFolders?: string[];
    customBotId?: string;
    botName?: string;
  }) => ipcRenderer.invoke("desk:export-vendor", input) as Promise<import("../src/lib/types").DeskExportResult>,
  exportChat: (input: {
    dest?: string;
    session: import("../src/lib/types").Session;
    projectName?: string;
  }) => ipcRenderer.invoke("desk:export-chat", input) as Promise<import("../src/lib/types").DeskExportResult>,
  importSkill: (from: string) =>
    ipcRenderer.invoke("desk:import-skill", from) as Promise<import("../src/lib/types").DeskExportResult>,
  readDeskSkill: (query: string, projectFolders: string[] = []) =>
    ipcRenderer.invoke("desk:read-skill", query, projectFolders) as Promise<{
      ok: boolean;
      skill?: { name: string; origin: import("../src/lib/types").SkillOrigin; dir: string; text: string };
      message?: string;
    }>,
  deleteSkill: (dir: string) =>
    ipcRenderer.invoke("desk:delete-skill", dir) as Promise<import("../src/lib/types").DeskExportResult>,
  pushSkill: (input: { dir: string; name?: string; target: "grok" | "codex" | "claude" }) =>
    ipcRenderer.invoke("desk:push-skill", input) as Promise<import("../src/lib/types").DeskExportResult>,
  pickFile: () => ipcRenderer.invoke("file:pick") as Promise<string | null>,
  mediaSrc: (href: string, cwd?: string, vendorSessionId?: string) =>
    ipcRenderer.invoke("media:src", href, cwd, vendorSessionId) as Promise<string | null>,
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  listDropFiles: (paths: string[]) => ipcRenderer.invoke("drop:list", paths) as Promise<import("./drop-files").ListedDropFile[]>,
  revealProject: (folder: string) => ipcRenderer.invoke("project:reveal", folder),
  openExternal: (href: string) => ipcRenderer.invoke("shell:open", href) as Promise<boolean>,
  fileDiff: (filePath: string, roots: string[] = []) => ipcRenderer.invoke("project:file-diff", filePath, roots),
  listGitChanges: (cwd: string) =>
    ipcRenderer.invoke("project:git-changes", cwd) as Promise<import("./project-diff").GitChange[]>,
  resolveFile: (filePath: string, roots: string[] = []) =>
    ipcRenderer.invoke("project:resolve-file", filePath, roots) as Promise<string | null>,
  editStats: (paths: string[], roots: string[] = []) => ipcRenderer.invoke("project:edit-stats", paths, roots),
  ensureWorktree: (input: import("./worktree-host").EnsureWorktreeInput) =>
    ipcRenderer.invoke("project:ensure-worktree", input) as Promise<import("./worktree-host").EnsureWorktreeResult>,
  terminalStart: (sessionId: string, cwd: string) => ipcRenderer.invoke("terminal:start", { sessionId, cwd }),
  terminalWrite: (sessionId: string, text: string) => ipcRenderer.invoke("terminal:write", { sessionId, text }),
  terminalStop: (sessionId: string) => ipcRenderer.invoke("terminal:stop", sessionId),
  onTerminalEvent: (handler: (event: import("./terminal-host").TerminalEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: import("./terminal-host").TerminalEvent) => handler(payload);
    ipcRenderer.on("terminal:event", listener);
    return () => ipcRenderer.removeListener("terminal:event", listener);
  },
  loadState: () => ipcRenderer.invoke("state:load") as Promise<Record<string, unknown>>,
  saveState: (state: Record<string, unknown>) => ipcRenderer.invoke("state:save", state),
  syncJobs: (sessions: import("../src/lib/types").Session[]) =>
    ipcRenderer.invoke("jobs:sync", sessions) as Promise<import("./job-engine").DurableJobEvent[]>,
  onJobDue: (handler: (events: import("./job-engine").DurableJobEvent[]) => void) => {
    const listener = (_event: IpcRendererEvent, events: import("./job-engine").DurableJobEvent[]) => handler(events);
    ipcRenderer.on("jobs:due", listener);
    return () => ipcRenderer.removeListener("jobs:due", listener);
  },
  quit: () => ipcRenderer.invoke("app:quit"),
  checkAppUpdate: () =>
    ipcRenderer.invoke("app:check-update") as Promise<import("../src/lib/app-update").AppUpdateOffer | null>,
  applyAppUpdate: (version: string) =>
    ipcRenderer.invoke("app:apply-update", version) as Promise<import("../src/lib/app-update").AppUpdateApplyResult>,
  notifyDesktop: (input: { title: string; body?: string }) =>
    ipcRenderer.invoke("notify:desktop", input) as Promise<boolean>,
  collectDiagnostics: () => ipcRenderer.invoke("diagnostics:collect") as Promise<import("./diagnostics").SupportReport>,
  exportDiagnostics: () => ipcRenderer.invoke("diagnostics:export") as Promise<{ ok: boolean; canceled?: boolean; path?: string }>,
  grokPrompt: (input: GrokPromptInput) => ipcRenderer.invoke("grok:prompt", input),
  grokAnswerPermission: (requestId: string, answer: PermissionAnswer) =>
    ipcRenderer.invoke("grok:answer-permission", { requestId, answer }),
  grokCancel: (sessionId: string) => ipcRenderer.invoke("grok:cancel", sessionId),
  codexPrompt: (input: CodexPromptInput) => ipcRenderer.invoke("codex:prompt", input),
  codexAnswerPermission: (requestId: string, answer: PermissionAnswer) =>
    ipcRenderer.invoke("codex:answer-permission", { requestId, answer }),
  codexCancel: (sessionId: string) => ipcRenderer.invoke("codex:cancel", sessionId),
  detectCodexLogin: () =>
    ipcRenderer.invoke("codex:detect-login") as Promise<import("./codex-login").CodexLoginDetectResult>,
  detectCodexRuntime: () =>
    ipcRenderer.invoke("codex:detect-runtime") as Promise<import("./codex-app-server").CodexRuntimeInfo>,
  listCodexNativeThreads: (limit = 12) =>
    ipcRenderer.invoke("codex:list-native-threads", limit) as Promise<import("./codex-app-server").CodexNativeThread[]>,
  codexCapabilities: (projectRoot?: string) =>
    ipcRenderer.invoke("codex:capabilities", projectRoot) as Promise<ReturnType<typeof import("./codex-capabilities").codexCapabilitySummary>>,
  detectClaudeLogin: () =>
    ipcRenderer.invoke("claude:detect-login") as Promise<{ connected: boolean; binary: string | null }>,
  claudeSetupToken: () =>
    ipcRenderer.invoke("claude:setup-token") as Promise<{ ok: boolean; message?: string }>,
  claudePrompt: (input: GrokPromptInput) => ipcRenderer.invoke("claude:prompt", input),
  claudeAnswerPermission: (requestId: string, answer: PermissionAnswer) =>
    ipcRenderer.invoke("claude:answer-permission", { requestId, answer }),
  claudeCancel: (sessionId: string) => ipcRenderer.invoke("claude:cancel", sessionId),
  onClaudeEvent: (handler: (event: GrokIpcEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: GrokIpcEvent) => handler(payload);
    ipcRenderer.on("claude:event", listener);
    return () => {
      ipcRenderer.removeListener("claude:event", listener);
    };
  },
  detectCustomLogin: () => ipcRenderer.invoke("custom:detect"),
  probeCustom: (config: { baseUrl: string; apiKey: string; model: string; api?: "anthropic-messages" | "openai-completions" }) =>
    ipcRenderer.invoke("custom:probe", config),
  customPrompt: (input: import("./custom-host").CustomPromptInput) => ipcRenderer.invoke("custom:prompt", input),
  customAnswerPermission: (requestId: string, answer: PermissionAnswer) =>
    ipcRenderer.invoke("custom:answer-permission", { requestId, answer }),
  customCancel: (sessionId: string) => ipcRenderer.invoke("custom:cancel", sessionId),
  onCustomEvent: (handler: (event: GrokIpcEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: GrokIpcEvent) => handler(payload);
    ipcRenderer.on("custom:event", listener);
    return () => {
      ipcRenderer.removeListener("custom:event", listener);
    };
  },
  listVendorModels: () => ipcRenderer.invoke("models:list"),
  onCodexEvent: (handler: (event: GrokIpcEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: GrokIpcEvent) => handler(payload);
    ipcRenderer.on("codex:event", listener);
    return () => {
      ipcRenderer.removeListener("codex:event", listener);
    };
  },
  grokCompact: (input: GrokCompactInput) => ipcRenderer.invoke("grok:compact", input),
  grokSessionInfo: (sessionId: string) => ipcRenderer.invoke("grok:session-info", sessionId),
  grokRewind: (input: GrokPromptInput & { keepUserIndex: number }) => ipcRenderer.invoke("grok:rewind", input),
  grokFork: (input: GrokPromptInput) => ipcRenderer.invoke("grok:fork", input),
  detectGrokLogin: () =>
    ipcRenderer.invoke("grok:detect-login") as Promise<{ connected: boolean; binary: string | null }>,
  grokPlanUsage: () => ipcRenderer.invoke("grok:plan-usage"),
  codexPlanUsage: () => ipcRenderer.invoke("codex:plan-usage"),
  claudePlanUsage: () => ipcRenderer.invoke("claude:plan-usage"),
  customPlanUsage: (input: { baseUrl: string; apiKey: string; model?: string }) =>
    ipcRenderer.invoke("custom:plan-usage", input),
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
      action?: import("./peer-inbox").PeerAction;
      folder?: string;
      name?: string;
      color?: string;
      baseUrl?: string;
      apiKey?: string;
      api?: string;
      contextWindow?: number;
      bot?: string;
      chats?: "keep" | "remove";
      onlyThis?: boolean;
      scope?: string;
      wait?: boolean;
    }) => void,
  ) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: {
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
        action?: import("./peer-inbox").PeerAction;
        folder?: string;
        name?: string;
        color?: string;
        baseUrl?: string;
        apiKey?: string;
        api?: string;
        contextWindow?: number;
        bot?: string;
        chats?: "keep" | "remove";
        onlyThis?: boolean;
        scope?: string;
        wait?: boolean;
      },
    ) => handler(payload);
    ipcRenderer.on("grok:peer-ask", listener);
    return () => {
      ipcRenderer.removeListener("grok:peer-ask", listener);
    };
  },
  replyPeerAsk: (payload: { id: string; text?: string; error?: string }) =>
    ipcRenderer.invoke("grok:peer-result", payload),
  onPeerCancel: (handler: (payload: { childSessionId: string; reason: "timed-out" | "cancelled" }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { childSessionId: string; reason: "timed-out" | "cancelled" }) => handler(payload);
    ipcRenderer.on("grok:peer-cancel", listener);
    return () => ipcRenderer.removeListener("grok:peer-cancel", listener);
  },
  onGrokEvent: (handler: (event: GrokIpcEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: GrokIpcEvent) => handler(payload);
    ipcRenderer.on("grok:event", listener);
    return () => {
      ipcRenderer.removeListener("grok:event", listener);
    };
  },
});

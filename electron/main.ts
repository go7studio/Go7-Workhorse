import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, safeStorage, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GrokSessionHost, resolveOrBaseSessionCwd, resolveSessionCwd, type GrokCompactInput, type GrokPromptInput } from "./grok-host";
import { CodexSessionHost, type CodexPromptInput } from "./codex-host";
import { ClaudeSessionHost, type ClaudePromptInput } from "./claude-host";
import { CursorSessionHost, type CursorPromptInput } from "./cursor-host";
import { CustomSessionHost, type CustomPromptInput } from "./custom-host";
import { guardIpcSender } from "./ipc-sender";
import { detectGrokLogin } from "./grok-login";
import { detectCodexLogin } from "./codex-login";
import { archiveWorkhorseWorkerThreads, detectCodexRuntime, listCodexNativeThreads } from "./codex-app-server";
import { codexCapabilitySummary } from "./codex-capabilities";
import { detectClaudeLogin, resolveClaudeCliBinary } from "./claude-login";
import { detectCursorLogin } from "./cursor-login";
import { runClaudeSetupToken } from "./claude-auth";
import { detectCustomLogin, fillEmptyCustomBotKeys, hydrateDetectedCustomCredentials, openClawKeyForBaseUrl } from "./custom-login";
import { probeCustomHttp } from "./custom-http";
import { listVendorModels } from "./vendor-models";
import { fetchGrokPlanUsage } from "./grok-plan";
import { fetchCodexPlanUsage } from "./codex-plan";
import { fetchClaudePlanUsage } from "./claude-plan";
import { fetchCursorPlanUsage } from "./cursor-plan";
import { fetchCustomPlanUsage } from "./custom-plan";
import { fetchCustomModels } from "./custom-models";
import type { PermissionAnswer } from "../src/lib/permissions";
import { safeExternalUrl } from "../src/lib/open-external";
import { startWorkhorseBridge, type PeerAskResult } from "./workhorse-bridge";
import { setInboundLearningSink, setWorkhorseDeskAsk } from "./workhorse-mcp";
import { drainInboundJsonl } from "../src/lib/learning-inbound";
import { learningInboundPath } from "../src/lib/learning-paths";
import { peerAskTimeoutMs, watchPeerInbox, writeBridgeRecord, type PeerAsk } from "./peer-inbox";
import { existingPeerReply } from "../src/lib/session-bridge";
import { listDropFiles } from "./drop-files";

import { displaySrcForHref, resolveMediaProtocolFile } from "./media-src";
import { findSourceFile, listGitChanges, readEditStatsAsync, readFileDiff, readSourceText, recordFileInstance } from "./project-diff";
import { TerminalHost, type TerminalEvent } from "./terminal-host";
import {
  deleteDeskSkill,
  exportChatToFolder,
  exportVendorBundle,
  importSkillFromPath,
  listDeskSkills,
  pushSkillToVendor,
  readDeskSkill,
} from "./desk-export-host";
import { showDesktopNotice } from "./notify";
import { applyAppUpdate, checkAppUpdate } from "./app-update";
import { ensureDeskRipgrep } from "./desk-path";
import { ensureManagedWorktree, pruneOrphanWorktrees, type EnsureWorktreeInput } from "./worktree-host";
import { CredentialStore, hydrateStateCredentials, protectStateCredentials } from "./credential-store";
import { DurableJobEngine } from "./job-engine";
import { execFile, spawnSync, type ChildProcess } from "node:child_process";
import { detectRuntimesOnHost, startRuntimeTask } from "./agent-runtime-host";
import { installLinkCommand, installReportMessage, installWorkhorseLink, workhorseExternalMcpLaunch, workhorseLinkGenericConfig } from "./mcp-install";
import { LINK_HOSTS, type LinkHost } from "../src/lib/workhorse-link";
import { buildSupportReport } from "./diagnostics";
import { APP_VERSION } from "../src/lib/app-info";
import { sweepStaleUserData } from "./user-data-hygiene";
import { applyComposerDrafts, type ComposerDraftSnap } from "../src/lib/chats";
import { readComposerDraftFile, readStringMapFile, readVersionedState, writeComposerDraftFile, writeStringMapFile, writeVersionedState } from "./state-persistence";
import { workhorseUserDataOverride, workhorseVolatileCredentials } from "../src/lib/user-data";
import {
  bookmarksFromProjects,
  claimFolderBookmarks,
  loadFolderBookmarks,
  mergeFolderBookmarks,
  rememberFolderBookmark,
} from "./folder-access";
import { normalizeSettings } from "../src/lib/settings";
import { customBotModels } from "../src/lib/custom-bots";
import { routingProfileForModel } from "../src/lib/routing";
import type { AdaptiveCandidate } from "../src/lib/learning-policy";
import { LearningService } from "./learning-service";
import { SqliteMemoryStore } from "./learning-sqlite";
import { attachLearningIpc } from "./learning-ipc";
import { runLearningSmoke } from "./learning-smoke";
import { ephemeralCustomAuxiliary, providerAllowsEphemeralAuxiliary, resolveCompilerBotConfig } from "./learning-aux";
import type { Settings } from "../src/lib/types";
import {
  WORKHORSE_APP_ID,
  WORKHORSE_BUILD_MARKER,
  WORKHORSE_DEV_USER_DATA_DIR,
  WORKHORSE_USER_DATA_DIR,
  parseWorkhorseBuildChannel,
  workhorseRuntimeIdentity,
} from "../src/lib/app-identity";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const debugStartup = (stage: string) => {
  if (process.env.WORKHORSE_DEBUG_STARTUP) console.error(`[workhorse startup] ${stage}`);
};
debugStartup("main loaded");

/** Workhorse's own Claude token, so signing in here never touches the shared login. */
export const CLAUDE_TOKEN_ID = "claude-oauth-token";
const CLAUDE_AUTH_SESSION = "auth:claude";

export { WORKHORSE_DEV_USER_DATA_DIR, WORKHORSE_USER_DATA_DIR };

/** Union of written file versions for the review. Survives later deletes of created lines. */
let fileInstances = new Map<string, string>();
const externalRuntimeProcesses = new Map<string, ChildProcess>();

function runExternalRuntimeProcess(taskId: string, file: string, args: string[]) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      file,
      args,
      { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (externalRuntimeProcesses.get(taskId) === child) externalRuntimeProcesses.delete(taskId);
        const rawCode = (error as { code?: string | number } | null)?.code;
        const code = typeof rawCode === "number"
          ? rawCode
          : error
            ? 1
            : 0;
        resolve({ status: code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
    externalRuntimeProcesses.set(taskId, child);
  });
}

function cancelExternalRuntimeProcess(taskId: string): boolean {
  const child = externalRuntimeProcesses.get(taskId);
  if (!child) return false;
  externalRuntimeProcesses.delete(taskId);
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
  return true;
}

function requireSessionCwd(value?: string | null): string {
  const cwd = resolveOrBaseSessionCwd(value, app.getPath("userData"));
  if (!cwd) throw new Error("This chat has no execution folder. Link a folder before running it.");
  return cwd;
}

function packagedBuildChannel() {
  if (!app.isPackaged || process.platform !== "darwin") return app.isPackaged ? "release" : "development";
  try {
    return parseWorkhorseBuildChannel(
      fs.readFileSync(path.join(process.resourcesPath, WORKHORSE_BUILD_MARKER), "utf8"),
    );
  } catch {
    // Releases before the marker shipped are production builds. Defaulting to
    // release preserves their existing user data and Safe Storage item.
    return "release";
  }
}

// Development shells and ad-hoc packages must never request Keychain access.
// The name keeps their other app data separate, while memory-only credentials
// make agent-driven tests independent of each local build's code requirement.
const runtimeIdentity = workhorseRuntimeIdentity(app.isPackaged, packagedBuildChannel());
app.setName(runtimeIdentity.name);

function useVolatileCredentials() {
  return runtimeIdentity.volatileCredentials || workhorseVolatileCredentials();
}

function pinUserData() {
  const isolated = workhorseUserDataOverride();
  const dest = isolated ? path.resolve(isolated) : path.join(app.getPath("appData"), runtimeIdentity.userDataDirectory);
  try {
    fs.mkdirSync(dest, { recursive: true });
    app.setPath("userData", dest);
  } catch {
    /* keep Electron default */
  }
}
pinUserData();
try {
  app.commandLine.appendSwitch("disk-cache-size", String(64 * 1024 * 1024));
  const swept = sweepStaleUserData(app.getPath("userData"), {
    appVersion: APP_VERSION,
    tmpDir: os.tmpdir(),
  });
  if (swept.removed.length) {
    console.info(`Cleared leftover desk cache (${swept.removed.join(", ")}).`);
  }
} catch {
  /* Chromium cache may already be open */
}

// Custom schemes must be registered before the ready event.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "workhorse-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

const isMcpHelper = Boolean(process.env.ELECTRON_RUN_AS_NODE);
const isPrimaryInstance = isMcpHelper || app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else if (!isMcpHelper) {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

function appIconPath() {
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const name =
    process.platform === "darwin"
      ? "go7-workhorse.icns"
      : process.platform === "linux"
        ? "go7-workhorse-clean.png"
        : "go7-workhorse.ico";
  return path.join(root, "assets", "app-icons", name);
}

type Persistable = Record<string, unknown>;

function statePath() {
  return path.join(app.getPath("userData"), "workhorse-state.json");
}

function fileInstancesPath() {
  return path.join(app.getPath("userData"), "file-instances.json");
}

let credentials: CredentialStore | null = null;
let jobEngine: DurableJobEngine | null = null;
let learningCloser: { pause: () => void; close: () => void } | null = null;
function credentialStore(): CredentialStore {
  credentials ??= new CredentialStore(
    path.join(app.getPath("userData"), "credentials.json"),
    safeStorage,
    useVolatileCredentials(),
  );
  return credentials;
}

/**
 * Put Workhorse's own Claude token on the environment the vendor child
 * inherits. Detection counts it as a login and the launch spec prefers it, so
 * the desk stops depending on the shared Claude Code login entirely.
 */
function applyStoredClaudeToken(): boolean {
  try {
    const token = credentialStore().get(CLAUDE_TOKEN_ID);
    if (!token) return false;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    return true;
  } catch {
    return false;
  }
}

function folderAccessIo() {
  return {
    userData: app.getPath("userData"),
    startAccessing: (bookmark: string) => {
      try {
        return Boolean(app.startAccessingSecurityScopedResource(bookmark));
      } catch {
        return false;
      }
    },
  };
}

function claimLinkedFolders(state?: Persistable): void {
  if (process.platform !== "darwin") return;
  const io = folderAccessIo();
  const remembered = loadFolderBookmarks(io);
  const fromState = bookmarksFromProjects(state);
  claimFolderBookmarks(mergeFolderBookmarks(remembered, fromState), io.startAccessing);
}

function pickLinkedFolder(title: string, buttonLabel: string, extra: Array<"createDirectory"> = []) {
  return dialog
    .showOpenDialog({
      title,
      buttonLabel,
      properties: ["openDirectory", ...extra],
      securityScopedBookmarks: process.platform === "darwin",
    })
    .then((result) => {
      if (result.canceled || !result.filePaths[0]) return null;
      const folderPath = result.filePaths[0];
      const bookmark = result.bookmarks?.[0];
      rememberFolderBookmark(folderPath, bookmark, folderAccessIo());
      if (bookmark) {
        try {
          app.startAccessingSecurityScopedResource(bookmark);
        } catch {
          /* picker grant is still valid for this session */
        }
      }
      return bookmark ? { path: folderPath, bookmark } : { path: folderPath };
    });
}

function readState(): Persistable {
  const result = readVersionedState(statePath());
  const { state } = result;
  try {
    const protectedState = protectStateCredentials(state, credentialStore());
    if (result.recovered || JSON.stringify(protectedState) !== JSON.stringify(state)) {
      writeVersionedState(statePath(), protectedState, (snapshot) => protectStateCredentials(snapshot, credentialStore()));
    }
  } catch {
    // The credential vault may be unavailable while the OS is locked. Keep the
    // recovered state in memory, but never persist a plaintext replacement.
  }
  const hydrated = hydrateStateCredentials(state, credentialStore());
  const detected = useVolatileCredentials()
    ? hydrateDetectedCustomCredentials(hydrated, detectCustomLogin())
    : hydrated;
  const ready = fillEmptyCustomBotKeys(detected);
  claimLinkedFolders(ready);
  const drafts = readComposerDraftFile(statePath()) as Record<string, ComposerDraftSnap>;
  if (Array.isArray(ready.sessions) && Object.keys(drafts).length > 0) {
    return { ...ready, sessions: applyComposerDrafts(ready.sessions, drafts) };
  }
  return ready;
}

function readMediaSrc(href: string, cwd?: string, vendorSessionId?: string): string | null {
  const src = displaySrcForHref(href, { cwd, vendorSessionId });
  return src || null;
}

function handleMediaProtocol(request: Request): Promise<Response> | Response {
  const file = resolveMediaProtocolFile(request.url);
  if (!file) return new Response(null, { status: 404 });
  try {
    return net.fetch(pathToFileURL(file).href);
  } catch {
    return new Response(null, { status: 404 });
  }
}

let lastStateBackupAt = 0;

function writeState(state: Persistable) {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    const file = statePath();
    const sessions = Array.isArray(state.sessions) ? state.sessions.length : 0;
    const usage = Array.isArray(state.usage) ? state.usage.length : 0;
    // Never clobber a richer file with an empty snapshot.
    if (sessions === 0 && usage === 0 && fs.existsSync(file)) {
      try {
        const previous = JSON.parse(fs.readFileSync(file, "utf8")) as Persistable;
        const prevSessions = Array.isArray(previous.sessions) ? previous.sessions.length : 0;
        const prevUsage = Array.isArray(previous.usage) ? previous.usage.length : 0;
        if (prevSessions > 0 || prevUsage > 0) {
          console.error("workhorse refused to overwrite saved chats with an empty state");
          return;
        }
      } catch {
        // existing file unreadable — write through
      }
    }
    const now = Date.now();
    const rotateBackups = lastStateBackupAt === 0 || now - lastStateBackupAt >= 60_000;
    writeVersionedState(
      file,
      state,
      (snapshot) => protectStateCredentials(snapshot, credentialStore()),
      { rotateBackups },
    );
    if (rotateBackups) lastStateBackupAt = now;
    const io = folderAccessIo();
    for (const [folder, bookmark] of Object.entries(bookmarksFromProjects(state))) {
      rememberFolderBookmark(folder, bookmark, io);
    }
    jobEngine?.sync(state.sessions);
  } catch (error) {
    console.error("workhorse state save failed", error);
  }
}

function isDeskAppUrl(url: string): boolean {
  const dev = process.env.VITE_DEV_SERVER_URL?.replace(/\/$/, "");
  if (dev && (url === dev || url.startsWith(`${dev}/`))) return true;
  return url.startsWith("file:");
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: dark ? "#1d1d1f" : "#f5f5f7",
    icon: appIconPath(),
    title: "Workhorse",
    show: false,
    frame: false,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: dark ? "#1d1d1f" : "#f5f5f7",
      symbolColor: dark ? "#f5f5f7" : "#1d1d1f",
      height: 48,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isDeskAppUrl(url)) return;
    event.preventDefault();
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
  });
  win.once("ready-to-show", () => {
    win.show();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
  return win;
}

const grokHost = new GrokSessionHost();
const codexHost = new CodexSessionHost();
const terminalHost = new TerminalHost();
const peerWaiters = new Map<string, (result: PeerAskResult) => void>();

process.on("uncaughtException", (error) => {
  console.error("workhorse uncaughtException", error);
});
process.on("unhandledRejection", (error) => {
  console.error("workhorse unhandledRejection", error);
});

app.whenReady().then(async () => {
  debugStartup(`ready primary=${isPrimaryInstance}`);
  if (!isPrimaryInstance) return;
  protocol.handle("workhorse-media", handleMediaProtocol);
  claimLinkedFolders();
  fileInstances = readStringMapFile(fileInstancesPath());
  void archiveWorkhorseWorkerThreads()
    .then((result) => {
      if (result.archived > 0) console.info(`Archived ${result.archived} Workhorse Codex worker logs.`);
    })
    .catch((error) => console.warn("Workhorse Codex worker cleanup failed", error));
  if (process.platform === "win32") {
    app.setAppUserModelId(WORKHORSE_APP_ID);
  }
  applyStoredClaudeToken();
  debugStartup("credentials ready");
  try {
    ensureDeskRipgrep();
  } catch {
    /* rg copy is best-effort */
  }
  debugStartup("ripgrep ready");

  process.env.WORKHORSE_STATE_PATH = statePath();
  jobEngine = new DurableJobEngine(path.join(app.getPath("userData"), "workhorse-jobs.json"), (events) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send("jobs:due", events);
    }
  });
  jobEngine.start();
  debugStartup("job engine ready");

  const learningSmoke = process.argv.includes("--workhorse-learning-smoke");
  if (learningSmoke) {
    const result = await runLearningSmoke(app.getPath("userData"));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    app.quit();
    return;
  }

  let liveSettings: Settings = normalizeSettings({});
  const inboundFile = learningInboundPath(app.getPath("userData"));
  const inboundIo = {
    mkdirSync: (dir: string, opts: { recursive: true }) => {
      fs.mkdirSync(dir, opts);
    },
    appendFileSync: (dest: string, data: string, encoding: "utf8") => {
      fs.appendFileSync(dest, data, encoding);
    },
    renameSync: (from: string, to: string) => {
      fs.renameSync(from, to);
    },
    readFileSync: (dest: string, encoding: "utf8") => fs.readFileSync(dest, encoding),
    unlinkSync: (dest: string) => {
      fs.unlinkSync(dest);
    },
  };
  const learningStore = new SqliteMemoryStore(app.getPath("userData"));
  const learningService = new LearningService({
    store: learningStore,
    settings: () => liveSettings.learning,
    drainInbound: () => drainInboundJsonl(inboundFile, inboundIo),
    allowStub: false,
    candidates: () => {
      const rows: AdaptiveCandidate[] = [];
      for (const provider of ["grok", "codex", "claude", "cursor"] as const) {
        if (!liveSettings.llms[provider].connected) continue;
        rows.push({
          provider,
          model: liveSettings.learning.compilerModel ?? provider,
          connected: true,
          ephemeral: providerAllowsEphemeralAuxiliary(provider),
          ...routingProfileForModel(provider, liveSettings.learning.compilerModel ?? provider),
        });
      }
      for (const bot of liveSettings.customBots) {
        if (bot.enabled === false) continue;
        for (const model of customBotModels(bot)) {
          rows.push({
            provider: "custom" as const,
            model,
            customBotId: bot.id,
            connected: Boolean(bot.apiKey?.trim() || bot.credentialId),
            ephemeral: providerAllowsEphemeralAuxiliary("custom"),
            ...routingProfileForModel("custom", model, bot.routingProfile),
          });
        }
      }
      return rows;
    },
    caller: async (request) => {
      if (request.provider !== "custom" || !providerAllowsEphemeralAuxiliary("custom")) {
        throw new Error("no-ephemeral-provider");
      }
      const config = resolveCompilerBotConfig(liveSettings.customBots, request, (credentialId) =>
        credentialStore().get(credentialId),
      );
      if (!config) throw new Error("no-ephemeral-provider");
      return ephemeralCustomAuxiliary(config, request);
    },
    idle: { setTimeout, clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout) },
  });
  attachLearningIpc(ipcMain, learningService, (settings) => {
    liveSettings = settings;
  });
  setInboundLearningSink((draft) => {
    learningService.record(draft);
  });
  learningCloser = learningService;
  try {
    fs.mkdirSync(path.dirname(inboundFile), { recursive: true });
    fs.watch(path.dirname(inboundFile), (_event, filename) => {
      if (filename && filename !== "inbound.jsonl") return;
      if (learningService.ingestInbound() > 0) learningService.schedule();
    });
  } catch (error) {
    console.warn("Learning inbound watch failed", error);
  }
  void learningService.recover().catch((error) => console.warn("Learning recover failed", error));
  debugStartup("learning ready");
  const peerBusy = new Set<string>();
  const handlePeerAsk = async (ask: PeerAsk) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.webContents.isDestroyed()) return { error: "Workhorse window is closed" };
    const bots = ask.mode === "bots";
    const spawn = !bots && ask.mode === "spawn";
    if (!bots && !spawn && ask.fromSessionId && ask.fromSessionId === ask.toSessionId) {
      return { error: "a chat cannot ask itself" };
    }
    if (!bots && !spawn) {
      const already = existingPeerReply(readState().sessions, ask.toSessionId, ask.message, ask.fromSessionId);
      if (already) return { text: already };
      if (peerBusy.has(ask.toSessionId) || (ask.fromSessionId && peerBusy.has(ask.fromSessionId))) {
        return { error: "that chat is already answering another Workhorse chat" };
      }
      peerBusy.add(ask.toSessionId);
      if (ask.fromSessionId) peerBusy.add(ask.fromSessionId);
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const childSessionId = spawn ? `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : "";
    try {
      return await new Promise<PeerAskResult>((resolve) => {
        const timer = setTimeout(() => {
          peerWaiters.delete(id);
          if (spawn && childSessionId && !win.webContents.isDestroyed()) {
            win.webContents.send("grok:peer-cancel", { childSessionId, reason: "timed-out" });
          }
          resolve({
            error: peerAskTimeoutMs(ask).timeoutError,
          });
        }, peerAskTimeoutMs(ask).timeoutMs);
        peerWaiters.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        win.webContents.send("grok:peer-ask", {
          id,
          ...ask,
          mode: bots ? "bots" : spawn ? "spawn" : ask.mode ?? "ask",
          childSessionId: childSessionId || undefined,
        });
      });
    } finally {
      if (!bots && !spawn) {
        peerBusy.delete(ask.toSessionId);
        if (ask.fromSessionId) peerBusy.delete(ask.fromSessionId);
      }
    }
  };
  void startWorkhorseBridge(handlePeerAsk)
    .then((bridge) => {
      const record = writeBridgeRecord(statePath(), { url: bridge.url, token: bridge.token });
      watchPeerInbox(record.inbox, handlePeerAsk);
      process.env.WORKHORSE_BRIDGE_URL = bridge.url;
      process.env.WORKHORSE_BRIDGE_TOKEN = bridge.token;
      debugStartup("desk bridge ready");
    })
    .catch((error) => {
      console.error("workhorse desk bridge failed", error);
    });
  setWorkhorseDeskAsk(handlePeerAsk);
  debugStartup("desk hooks ready");
  process.env.WORKHORSE_MCP_COMMAND = process.execPath;
  process.env.WORKHORSE_MCP_SCRIPT = path.join(__dirname, "workhorse-mcp.js");

  // Before any channel is registered, so every one of them is covered — and so
  // is a channel written next month.
  guardIpcSender(ipcMain, process.env.VITE_DEV_SERVER_URL);

  const detectAgentRuntimes = () => {
    const home = app.getPath("home");
    const platform = process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : "darwin";
    return detectRuntimesOnHost(
      { home, pathEnv: process.env.PATH, platform },
      {
        existsSync: (file) => fs.existsSync(file),
        execFile: (file, args) => {
          const result = spawnSync(file, args, { encoding: "utf8", timeout: 8_000, windowsHide: true });
          return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
        },
      },
    );
  };
  ipcMain.handle("agentRuntime:detect", detectAgentRuntimes);

  const linkLaunch = () => ({
    command: process.env.WORKHORSE_MCP_COMMAND || process.execPath,
    script: process.env.WORKHORSE_MCP_SCRIPT || path.join(__dirname, "workhorse-mcp.js"),
    statePath: statePath(),
  });

  // The generic MCP configuration — for a client Link has no writer for.
  ipcMain.handle("agentRuntime:linkConfig", () => workhorseLinkGenericConfig(linkLaunch()));

  // The `workhorse` command: a launcher with this install's exact paths.
  // PATH links are operator-owned; the app only writes under userData/bin.
  ipcMain.handle("agentRuntime:installLinkCommand", () => {
    const platform = process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : "darwin";
    const launch = workhorseExternalMcpLaunch(linkLaunch());
    const report = installLinkCommand({
      platform,
      dataDir: app.getPath("userData"),
      launch,
      io: {
        existsSync: (file) => fs.existsSync(file),
        readFile: (file) => fs.readFileSync(file, "utf8"),
        writeFile: (file, text) => {
          fs.writeFileSync(file, text, { mode: 0o755 });
        },
        mkdirp: (dir) => {
          fs.mkdirSync(dir, { recursive: true });
        },
      },
    });
    return { ok: report.ok, message: report.message };
  });

  ipcMain.handle("agentRuntime:installMcp", (_event, hosts?: unknown) => {
    const home = app.getPath("home");
    const platform = process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : "darwin";
    const wanted = Array.isArray(hosts)
      ? hosts.filter((host): host is LinkHost => (LINK_HOSTS as string[]).includes(String(host)))
      : undefined;
    const report = installWorkhorseLink({
      home,
      platform,
      ...linkLaunch(),
      ...(wanted?.length ? { hosts: wanted } : {}),
      io: {
        existsSync: (file) => fs.existsSync(file),
        readFile: (file) => fs.readFileSync(file, "utf8"),
        writeFile: (file, text) => {
          fs.writeFileSync(file, text);
        },
        mkdirp: (dir) => {
          fs.mkdirSync(dir, { recursive: true });
        },
        exec: (file, args) => {
          const result = spawnSync(file, args, { encoding: "utf8", timeout: 15_000, windowsHide: true });
          // A missing binary is status null + ENOENT, not a failed run. Say
          // which, so "not installed" is not reported as "exit 1".
          const missing = result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT";
          return { status: missing ? 127 : result.status ?? 1, stdout: result.stdout ?? "", stderr: missing ? "ENOENT" : result.stderr ?? "" };
        },
      },
    });
    return { ok: report.ok, message: installReportMessage(report) };
  });

  ipcMain.handle(
    "agentRuntime:start",
    async (
      _event,
      request: import("../src/lib/external-task").RuntimeStartRequest,
    ) => {
      const io = {
        exec: (file: string, args: string[]) => runExternalRuntimeProcess(request.taskId, file, args),
      };
      return startRuntimeTask(io, request);
    },
  );
  ipcMain.handle("agentRuntime:cancel", (_event, taskId: unknown) =>
    typeof taskId === "string" ? cancelExternalRuntimeProcess(taskId) : false,
  );

  ipcMain.handle("grok:peer-result", (_event, payload: { id: string } & PeerAskResult) => {
    const waiter = peerWaiters.get(payload.id);
    if (!waiter) return false;
    peerWaiters.delete(payload.id);
    waiter("error" in payload && payload.error ? { error: payload.error } : { text: "text" in payload ? payload.text : "" });
    return true;
  });

  ipcMain.handle("folder:pick", () => pickLinkedFolder("Link a folder", "Link"));

  ipcMain.handle("folder:pick-export", () => pickLinkedFolder("Send here", "Send", ["createDirectory"]));

  ipcMain.handle("desk:list-skills", (_event, projectFolders: unknown) => {
    const folders = Array.isArray(projectFolders)
      ? projectFolders.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    return listDeskSkills(folders);
  });

  ipcMain.handle("desk:export-vendor", (_event, payload: unknown) => {
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const kind = record.kind === "chats" ? "chats" : record.kind === "skills" ? "skills" : null;
    if (!kind || typeof record.provider !== "string") {
      return { ok: false, message: "Mass send needs a vendor and a kind." };
    }
    return exportVendorBundle({
      provider: record.provider,
      dest: typeof record.dest === "string" ? record.dest : undefined,
      kind,
      sessions: Array.isArray(record.sessions) ? (record.sessions as never) : [],
      projects: Array.isArray(record.projects) ? (record.projects as never) : [],
      projectFolders: Array.isArray(record.projectFolders)
        ? record.projectFolders.filter((item): item is string => typeof item === "string")
        : [],
      customBotId: typeof record.customBotId === "string" ? record.customBotId : undefined,
      botName: typeof record.botName === "string" ? record.botName : undefined,
    });
  });

  ipcMain.handle("desk:export-chat", (_event, payload: unknown) => {
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    if (!record.session || typeof record.session !== "object") {
      return { ok: false, message: "Export needs a chat." };
    }
    return exportChatToFolder({
      dest: typeof record.dest === "string" ? record.dest : undefined,
      session: record.session as never,
      projectName: typeof record.projectName === "string" ? record.projectName : undefined,
    });
  });

  ipcMain.handle("desk:import-skill", (_event, from: unknown) => {
    if (typeof from !== "string" || !from.trim()) return { ok: false, message: "Pick a skill folder." };
    return importSkillFromPath(from);
  });

  ipcMain.handle("desk:read-skill", (_event, query: unknown, projectFolders: unknown) => {
    if (typeof query !== "string" || !query.trim()) return { ok: false, message: "Skill name is required." };
    const folders = Array.isArray(projectFolders)
      ? projectFolders.filter((item): item is string => typeof item === "string")
      : [];
    try {
      return { ok: true, skill: readDeskSkill(query, folders) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("desk:delete-skill", (_event, dir: unknown) => {
    if (typeof dir !== "string" || !dir.trim()) return { ok: false, message: "Skill folder is required." };
    return deleteDeskSkill(dir);
  });

  ipcMain.handle("desk:push-skill", (_event, payload: unknown) => {
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    if (
      typeof record.dir !== "string" ||
      (record.target !== "grok" && record.target !== "codex" && record.target !== "claude" && record.target !== "cursor")
    ) {
      return { ok: false, message: "Push needs a skill folder and Grok, Codex, Claude, or Cursor." };
    }
    return pushSkillToVendor({
      dir: record.dir,
      name: typeof record.name === "string" ? record.name : undefined,
      target: record.target,
    });
  });

  ipcMain.handle("drop:list", (_event, paths: unknown) => listDropFiles(paths));

  ipcMain.handle("file:pick", async () => {
    const result = await dialog.showOpenDialog({
      title: "Link a file",
      buttonLabel: "Link",
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("media:src", async (_event, href: string, cwd?: string, vendorSessionId?: string) =>
    readMediaSrc(href, cwd, vendorSessionId),
  );

  ipcMain.handle("project:reveal", async (_event, folder: string) => {
    if (typeof folder === "string" && fs.existsSync(folder)) {
      shell.openPath(folder);
    }
  });

  ipcMain.handle("shell:open", async (_event, href: unknown) => {
    const url = typeof href === "string" ? safeExternalUrl(href) : null;
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle("project:file-diff", (_event, filePath: string, roots: string[] = [], created = false) => {
    if (typeof filePath !== "string" || !filePath.trim()) return null;
    return readFileDiff(filePath, Array.isArray(roots) ? roots.filter((item) => typeof item === "string") : [], {
      created: created === true,
      instances: fileInstances,
      recordInstance: false,
    });
  });

  ipcMain.handle("project:record-write", (_event, filePath: string, roots: string[] = []) => {
    if (typeof filePath !== "string" || !filePath.trim()) return "";
    const recorded = recordFileInstance(
      filePath,
      Array.isArray(roots) ? roots.filter((item) => typeof item === "string") : [],
      { instances: fileInstances },
    );
    if (recorded) writeStringMapFile(fileInstancesPath(), fileInstances);
    return recorded;
  });

  ipcMain.handle("project:read-file", (_event, filePath: string, roots: string[] = []) => {
    if (typeof filePath !== "string" || !filePath.trim()) return null;
    return readSourceText(filePath, Array.isArray(roots) ? roots.filter((item) => typeof item === "string") : []);
  });

  ipcMain.handle("project:git-changes", (_event, cwd: unknown) =>
    listGitChanges(typeof cwd === "string" ? resolveSessionCwd(cwd) : ""),
  );

  ipcMain.handle("terminal:start", (event, raw: { sessionId?: string; cwd?: string }) =>
    terminalHost.start(
      typeof raw?.sessionId === "string" ? raw.sessionId : "",
      resolveSessionCwd(typeof raw?.cwd === "string" ? raw.cwd : ""),
      (payload: TerminalEvent) => {
        if (!event.sender.isDestroyed()) event.sender.send("terminal:event", payload);
      },
    ),
  );
  ipcMain.handle("terminal:write", (_event, raw: { sessionId?: string; text?: string }) =>
    terminalHost.write(
      typeof raw?.sessionId === "string" ? raw.sessionId : "",
      typeof raw?.text === "string" ? raw.text : "",
    ),
  );
  ipcMain.handle("terminal:stop", (_event, sessionId: unknown) => {
    if (typeof sessionId === "string") terminalHost.stop(sessionId);
  });

  ipcMain.handle("project:resolve-file", (_event, filePath: unknown, roots: unknown) => {
    if (typeof filePath !== "string" || !filePath.trim()) return null;
    const folders = Array.isArray(roots) ? roots.filter((item): item is string => typeof item === "string") : [];
    return findSourceFile(filePath, folders);
  });

  ipcMain.handle("project:edit-stats", (_event, paths: string[] = [], roots: string[] = [], createdPaths: string[] = []) => {
    const files = Array.isArray(paths) ? paths.filter((item) => typeof item === "string") : [];
    const folders = Array.isArray(roots) ? roots.filter((item) => typeof item === "string") : [];
    const created = Array.isArray(createdPaths) ? createdPaths.filter((item) => typeof item === "string") : [];
    return readEditStatsAsync(files, folders, { instances: fileInstances }, created);
  });

  ipcMain.handle("project:ensure-worktree", (_event, raw: unknown) => {
    if (!raw || typeof raw !== "object") {
      return { ok: false, message: "Invalid worktree request." };
    }
    const record = raw as Partial<EnsureWorktreeInput>;
    return ensureManagedWorktree(
      {
        sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
        root: typeof record.root === "string" ? record.root : "",
      },
      path.join(app.getPath("userData"), "worktrees"),
    );
  });

  ipcMain.handle("state:load", () => {
    const loaded = readState();
    const sessions = Array.isArray(loaded.sessions) ? loaded.sessions : [];
    pruneOrphanWorktrees(
      path.join(app.getPath("userData"), "worktrees"),
      sessions.map((session) => (session && typeof session === "object" && typeof (session as { id?: unknown }).id === "string" ? (session as { id: string }).id : "")).filter(Boolean),
    );
    return loaded;
  });
  ipcMain.handle("state:save", (_event, state: Persistable) => {
    if (state && typeof state === "object") writeState(state);
  });
  ipcMain.handle("state:save-drafts", (_event, drafts: unknown) => {
    if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) return;
    writeComposerDraftFile(statePath(), drafts);
  });
  ipcMain.handle("jobs:sync", (_event, sessions: unknown) => jobEngine?.sync(sessions) ?? []);

  ipcMain.handle("app:quit", () => app.quit());
  ipcMain.handle("app:check-update", () => checkAppUpdate());
  ipcMain.handle("app:apply-update", (_event, version: unknown) =>
    applyAppUpdate(typeof version === "string" ? version : ""),
  );
  ipcMain.handle("notify:desktop", (_event, payload: { title?: string; body?: string }) =>
    showDesktopNotice({
      title: typeof payload?.title === "string" ? payload.title : "",
      body: typeof payload?.body === "string" ? payload.body : "",
    }),
  );
  const collectDiagnostics = async () => {
    const runtimes = detectAgentRuntimes().statuses;
    return buildSupportReport({
    state: readState(),
    version: APP_VERSION,
    userData: app.getPath("userData"),
    encryptionAvailable: !useVolatileCredentials() && safeStorage.isEncryptionAvailable(),
    detections: {
      grok: await detectGrokLogin(),
      codex: await detectCodexLogin(),
      claude: await detectClaudeLogin(),
      cursor: await detectCursorLogin(),
      openclaw: { connected: runtimes.some((item) => item.runtimeId === "openclaw" && item.reachable), binary: runtimes.find((item) => item.runtimeId === "openclaw")?.binaryPath },
      hermes: { connected: runtimes.some((item) => item.runtimeId === "hermes" && item.reachable), binary: runtimes.find((item) => item.runtimeId === "hermes")?.binaryPath },
    },
    });
  };
  ipcMain.handle("diagnostics:collect", () => collectDiagnostics());
  ipcMain.handle("diagnostics:export", async () => {
    const result = await dialog.showSaveDialog({
      title: "Export Workhorse support information",
      defaultPath: `workhorse-support-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(await collectDiagnostics(), null, 2), "utf8");
    return { ok: true, path: result.filePath };
  });
  ipcMain.handle("grok:detect-login", () => detectGrokLogin());
  ipcMain.handle("codex:detect-login", () => detectCodexLogin());
  ipcMain.handle("codex:detect-runtime", () => detectCodexRuntime());
  ipcMain.handle("codex:list-native-threads", (_event, limit: unknown) =>
    listCodexNativeThreads(typeof limit === "number" ? limit : 12),
  );
  ipcMain.handle("codex:capabilities", (_event, projectRoot: unknown) =>
    codexCapabilitySummary(typeof projectRoot === "string" ? projectRoot : undefined),
  );
  ipcMain.handle("claude:detect-login", () => detectClaudeLogin());
  ipcMain.handle("claude:setup-token", async (event) => {
    const cli = resolveClaudeCliBinary();
    if (!cli) return { ok: false, message: "Claude Code CLI not found." };
    const result = await runClaudeSetupToken({
      cli,
      onOutput: (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("terminal:event", { type: "output", sessionId: CLAUDE_AUTH_SESSION, data });
        }
      },
    });
    if (!result.ok || !result.token) return { ok: false, message: result.message ?? "Sign-in failed." };
    try {
      credentialStore().put(result.token, CLAUDE_TOKEN_ID);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Could not store the token." };
    }
    applyStoredClaudeToken();
    return { ok: true };
  });
  ipcMain.handle("custom:detect", () => detectCustomLogin());
  ipcMain.handle("custom:models", async (_event, config: { baseUrl: string; apiKey: string }) => {
    return fetchCustomModels(config);
  });
  ipcMain.handle("custom:probe", async (_event, config: { baseUrl: string; apiKey: string; model: string; api?: "anthropic-messages" | "openai-completions" }) => {
    return probeCustomHttp(config);
  });
  ipcMain.handle("models:list", () => listVendorModels());
  ipcMain.removeHandler("grok:plan-usage");
  ipcMain.handle("grok:plan-usage", async () => {
    try {
      return (await fetchGrokPlanUsage()) ?? null;
    } catch {
      return null;
    }
  });
  ipcMain.removeHandler("codex:plan-usage");
  ipcMain.handle("codex:plan-usage", async () => {
    try {
      return (await fetchCodexPlanUsage()) ?? null;
    } catch {
      return null;
    }
  });
  ipcMain.removeHandler("claude:plan-usage");
  ipcMain.handle("claude:plan-usage", async () => {
    try {
      return (await fetchClaudePlanUsage()) ?? null;
    } catch {
      return null;
    }
  });
  ipcMain.removeHandler("cursor:plan-usage");
  ipcMain.handle("cursor:plan-usage", async () => {
    try {
      return (await fetchCursorPlanUsage()) ?? null;
    } catch {
      return null;
    }
  });
  ipcMain.removeHandler("custom:plan-usage");
  ipcMain.handle("custom:plan-usage", async (_event, raw: { baseUrl?: string; apiKey?: string; model?: string; credentialId?: string }) => {
    try {
      let apiKey = typeof raw?.apiKey === "string" ? raw.apiKey : "";
      const credentialId = typeof raw?.credentialId === "string" ? raw.credentialId.trim() : "";
      if (!apiKey.trim() && credentialId) {
        try {
          apiKey = credentialStore().get(credentialId);
        } catch {
          apiKey = "";
        }
      }
      const baseUrl = typeof raw?.baseUrl === "string" ? raw.baseUrl : "";
      if (!apiKey.trim() && baseUrl) {
        try {
          apiKey = openClawKeyForBaseUrl(baseUrl);
        } catch {
          apiKey = "";
        }
      }
      return (
        (await fetchCustomPlanUsage({
          baseUrl,
          apiKey,
          model: typeof raw?.model === "string" ? raw.model : undefined,
        })) ?? null
      );
    } catch {
      return null;
    }
  });

  ipcMain.handle("codex:prompt", async (event, raw: CodexPromptInput) => {
    const input: CodexPromptInput = {
      ...raw,
      cwd: requireSessionCwd(raw.cwd),
    };
    const result = await codexHost.prompt(input, (payload) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send("codex:event", payload);
      } catch (error) {
        console.error("workhorse codex event send failed", error);
      }
    });
    return result;
  });

  ipcMain.handle("codex:answer-permission", (_event, payload: { requestId: string; answer: PermissionAnswer }) => {
    return codexHost.answerPermission(payload.requestId, payload.answer);
  });

  ipcMain.handle("codex:cancel", (_event, sessionId: string) => {
    codexHost.cancel(sessionId);
  });

  const claudeHost = new ClaudeSessionHost();
  ipcMain.handle("claude:prompt", async (event, raw: ClaudePromptInput) => {
    const input: ClaudePromptInput = {
      ...raw,
      cwd: requireSessionCwd(raw.cwd),
    };
    const result = await claudeHost.prompt(input, (payload) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send("claude:event", payload);
      } catch (error) {
        console.error("workhorse claude event send failed", error);
      }
    });
    return result;
  });
  ipcMain.handle("claude:answer-permission", (_event, payload: { requestId: string; answer: PermissionAnswer }) => {
    return claudeHost.answerPermission(payload.requestId, payload.answer);
  });
  ipcMain.handle("claude:cancel", (_event, sessionId: string) => {
    claudeHost.cancel(sessionId);
  });

  ipcMain.handle("cursor:detect-login", () => detectCursorLogin());
  const cursorHost = new CursorSessionHost();
  ipcMain.handle("cursor:prompt", async (event, raw: CursorPromptInput) => {
    const input: CursorPromptInput = {
      ...raw,
      cwd: requireSessionCwd(raw.cwd),
    };
    const result = await cursorHost.prompt(input, (payload) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send("cursor:event", payload);
      } catch (error) {
        console.error("workhorse cursor event send failed", error);
      }
    });
    return result;
  });
  ipcMain.handle("cursor:answer-permission", (_event, payload: { requestId: string; answer: PermissionAnswer }) => {
    return cursorHost.answerPermission(payload.requestId, payload.answer);
  });
  ipcMain.handle("cursor:cancel", (_event, sessionId: string) => {
    cursorHost.cancel(sessionId);
  });

  const customHost = new CustomSessionHost();
  ipcMain.handle("custom:prompt", async (event, raw: CustomPromptInput) => {
    const input = { ...raw, cwd: requireSessionCwd(raw.cwd) };
    const result = await customHost.prompt(input, (payload) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send("custom:event", payload);
      } catch (error) {
        console.error("workhorse custom event send failed", error);
      }
    });
    return result;
  });
  ipcMain.handle("custom:cancel", (_event, sessionId: string) => {
    customHost.cancel(sessionId);
  });
  ipcMain.handle("custom:answer-permission", (_event, payload: { requestId: string; answer: PermissionAnswer }) => {
    return customHost.answerPermission(payload.requestId, payload.answer);
  });

  ipcMain.handle("grok:prompt", async (event, raw: GrokPromptInput) => {
    const input: GrokPromptInput = {
      ...raw,
      cwd: requireSessionCwd(raw.cwd),
    };
    const result = await grokHost.prompt(input, (payload) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send("grok:event", payload);
      } catch (error) {
        console.error("workhorse grok event send failed", error);
      }
    });
    return result;
  });

  ipcMain.handle("grok:answer-permission", (_event, payload: { requestId: string; answer: PermissionAnswer }) => {
    return grokHost.answerPermission(payload.requestId, payload.answer);
  });

  ipcMain.handle("grok:cancel", (_event, sessionId: string) => {
    grokHost.cancel(sessionId);
  });

  ipcMain.handle("grok:compact", async (event, raw: GrokCompactInput) => {
    const input: GrokCompactInput = {
      ...raw,
      cwd: requireSessionCwd(raw.cwd),
    };
    return grokHost.compact(input, (payload) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send("grok:event", payload);
      } catch (error) {
        console.error("workhorse grok event send failed", error);
      }
    });
  });

  ipcMain.handle("grok:session-info", async (_event, sessionId: string) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) return null;
    try {
      return await grokHost.sessionInfo(sessionId);
    } catch {
      return null;
    }
  });

  ipcMain.handle("grok:fork", async (event, raw: GrokPromptInput) => {
    const input = { ...raw, cwd: requireSessionCwd(raw.cwd) };
    try {
      return await grokHost.fork(input, (payload) => {
        try {
          if (!event.sender.isDestroyed()) event.sender.send("grok:event", payload);
        } catch (error) {
          console.error("workhorse grok event send failed", error);
        }
      });
    } catch {
      return {};
    }
  });

  ipcMain.handle("grok:rewind", async (event, raw: GrokPromptInput & { keepUserIndex: number }) => {
    const input = {
      ...raw,
      cwd: requireSessionCwd(raw.cwd),
    };
    try {
      return await grokHost.rewind(input, (payload) => {
        try {
          if (!event.sender.isDestroyed()) event.sender.send("grok:event", payload);
        } catch (error) {
          console.error("workhorse grok event send failed", error);
        }
      });
    } catch {
      return { reset: false, rewound: false };
    }
  });

  debugStartup("creating window");
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  learningCloser?.pause();
  learningCloser?.close();
  grokHost.disposeAll();
  codexHost.disposeAll();
  terminalHost.disposeAll();
  jobEngine?.dispose();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

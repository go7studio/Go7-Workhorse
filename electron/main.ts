import { app, BrowserWindow, crashReporter, dialog, ipcMain, nativeImage, nativeTheme, net, protocol, safeStorage, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GrokSessionHost, resolveOrBaseSessionCwd, resolveSessionCwd, type GrokCompactInput, type GrokPromptInput } from "./grok-host";
import { CodexSessionHost, type CodexPromptInput } from "./codex-host";
import { ClaudeSessionHost, type ClaudePromptInput } from "./claude-host";
import { CursorSessionHost, type CursorPromptInput } from "./cursor-host";
import { CustomSessionHost, type CustomPromptInput } from "./custom-host";
import { probeMcpServer } from "./mcp-tool-bridge";
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
import { fetchCustomPlanUsage, grokBotLeftoverPath } from "./custom-plan";
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
import { findSourceFile, listGitChanges, readEditStatsAsync, readFileDiff, readGitHead, readSourceText, recordFileInstance } from "./project-diff";
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
import { offloadStateAttachments } from "./attachment-store";
import {
  CredentialStore,
  hydrateStateCredentials,
  protectStateCredentials,
  protectStateCredentialsForSave,
} from "./credential-store";
import { DurableJobEngine } from "./job-engine";
import { execFile, spawnSync, type ChildProcess } from "node:child_process";
import { detectRuntimesOnHost, startRuntimeTask } from "./agent-runtime-host";
import { installLinkCommand, installReportMessage, installWorkhorseLink, workhorseExternalMcpLaunch, workhorseLinkGenericConfig, workhorseLinkGrokBotOneshot } from "./mcp-install";
import { ensureGrokBotShim } from "./grok-bot-shim-host";
import { clearGrokBotLateAnswer, listGrokBotLateAnswers, watchGrokBotLateAnswers } from "./grok-bot-late";
import { grokBotInboxDir } from "../src/lib/grok-bot-shim";
import { grokBotWakePath, inspectGrokBotWake, saveGrokBotWake } from "./grok-bot-wake";
import { LINK_HOSTS, type LinkHost } from "../src/lib/workhorse-link";
import { buildSupportReport } from "./diagnostics";
import { APP_VERSION } from "../src/lib/app-info";
import { measureWorktreeStore, sweepAgedStateBackups, sweepStaleUserData } from "./user-data-hygiene";
import { faultDetail, memoryDetail, nullMainLog, openMainLog, startMemoryLog } from "./main-log";
import { clearPerfCause, setPerfCause, stallThresholdMs, startPerfHeartbeat } from "./perf-heartbeat";
import { offloadStateTranscripts, rehydrateSessionTranscript } from "./transcript-store";
import { applyComposerDrafts, type ComposerDraftSnap } from "../src/lib/chats";
import { dueByInterval, readComposerDraftFile, readStringMapFile, readVersionedState, sameJsonValue, STATE_BACKUP_INTERVAL_MS, STATE_FSYNC_INTERVAL_MS, syncFileInPlace, worktreeKeepSet, worktreePruneDecision, writeComposerDraftFile, writeStringMapFile, writeVersionedState, writeVersionedStateAsync } from "./state-persistence";
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
import { probeLocalComputeHosts } from "./local-compute-registry";
import { ephemeralCustomAuxiliary, providerAllowsEphemeralAuxiliary, resolveCompilerBotConfig } from "./learning-aux";
import type { Settings } from "../src/lib/types";
import {
  WORKHORSE_APP_ID,
  WORKHORSE_BUILD_MARKER,
  WORKHORSE_DEV_APP_ID,
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
  /*
   * The resolved command, and only the resolved command. "Workhorse cannot run
   * Codex" and "Workhorse ran a Codex that is not the one on your PATH" look
   * identical from the surface and are fixed differently, so the log carries
   * what was actually launched — never the arguments, which are the prompt.
   */
  mainLog.record("vendor:spawn", `command=${file} argc=${args.length}`);
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
        if (error) mainLog.record("vendor:spawn", `failed command=${file} ${faultDetail(error, 1)}`);
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
  if (!app.isPackaged) return "development";
  const files = [
    path.join(process.resourcesPath, WORKHORSE_BUILD_MARKER),
    path.join(path.dirname(process.execPath), "resources", WORKHORSE_BUILD_MARKER),
  ];
  for (const file of files) {
    try {
      return parseWorkhorseBuildChannel(fs.readFileSync(file, "utf8"));
    } catch {
      /* try the next packaged marker location */
    }
  }
  // Releases before the marker shipped are production builds. Defaulting to
  // release preserves their existing user data and Safe Storage item.
  return "release";
}

// Development shells and ad-hoc packages must never request Keychain access.
// The name keeps their other app data separate, while memory-only credentials
// make agent-driven tests independent of each local build's code requirement.
const runtimeIdentity = workhorseRuntimeIdentity(app.isPackaged, packagedBuildChannel());
app.setName(runtimeIdentity.name);
const windowsAppUserModelId =
  runtimeIdentity.userDataDirectory === WORKHORSE_DEV_USER_DATA_DIR ? WORKHORSE_DEV_APP_ID : WORKHORSE_APP_ID;
if (process.platform === "win32") app.setAppUserModelId(windowsAppUserModelId);

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

const isMcpHelper = Boolean(process.env.ELECTRON_RUN_AS_NODE);

/*
 * The stall recorder runs on every launch now, not only when someone remembers
 * a flag. `userData/perf` had never once existed on the live desk: the gate was
 * an environment variable and a command-line switch, and a person opening the
 * app from Finder sets neither, so the instrument built to explain felt jank had
 * measured nothing at all. The flag now moves the threshold (250ms by default,
 * 80ms when hunting) rather than deciding whether to look. The helper process
 * stays out — one writer per file.
 */
if (!isMcpHelper) startPerfHeartbeat(app.getPath("userData"), { thresholdMs: stallThresholdMs() });

/**
 * The desk died during an audit and left nothing to read: no crash report, no
 * main-process log, no way to tell a wedged save from a killed process. This is
 * that log. The helper process writes nothing — one writer keeps rotation from
 * racing itself.
 */
const mainLog = isMcpHelper ? nullMainLog() : openMainLog(app.getPath("userData"));

/*
 * Keep the operating system's own crash record.
 *
 * `uploadToServer: false` is the whole point: nothing leaves the machine, and
 * macOS writes a DiagnosticReports entry for a native crash the way it does for
 * every other app. A JavaScript throw reaches the handlers below; a segfault in
 * the renderer or in a native module reaches neither, and that was the shape of
 * the death this log was built after.
 */
if (!isMcpHelper) {
  try {
    crashReporter.start({ uploadToServer: false });
  } catch {
    /* a desk that cannot register a crash handler still has to run */
  }
}

/**
 * The one line worth having when a launch goes wrong.
 *
 * Everything here is a timing, a count, a size or an identifier. The resolved
 * PATH is in because "the vendor binary is not there" and "the vendor binary is
 * not on the PATH this process inherited" look identical from the outside and
 * are fixed differently — a Finder launch and a terminal launch do not get the
 * same PATH, and that has cost real hours. Never content, never titles, never a
 * person's project paths.
 */
function bootDetail(): string {
  const stateFile = path.join(app.getPath("userData"), "workhorse-state.json");
  let stateBytes = 0;
  let sessions = -1;
  try {
    stateBytes = fs.statSync(stateFile).size;
  } catch {
    /* first launch */
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { sessions?: unknown };
    sessions = Array.isArray(parsed.sessions) ? parsed.sessions.length : -1;
  } catch {
    /* unreadable or absent; -1 says "could not tell", which is itself the news */
  }
  const worktrees = measureWorktreeStore(path.join(app.getPath("userData"), "worktrees"));
  return [
    `version=${APP_VERSION}`,
    `platform=${process.platform}`,
    `pid=${process.pid}`,
    `electron=${process.versions.electron ?? "none"}`,
    `userData=${app.getPath("userData")}`,
    `state_bytes=${stateBytes}`,
    `sessions=${sessions}`,
    `worktrees=${worktrees.trees}`,
    memoryDetail(),
    `path=${process.env.PATH ?? ""}`,
  ].join(" ");
}

mainLog.record("startup", isMcpHelper ? `version=${APP_VERSION} pid=${process.pid} role=mcp-helper` : bootDetail());

try {
  app.commandLine.appendSwitch("disk-cache-size", String(64 * 1024 * 1024));
} catch {
  /* Chromium may already have taken its switches */
}

// Custom schemes must be registered before the ready event.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "workhorse-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

const isPrimaryInstance = isMcpHelper || app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  mainLog.record("shutdown", "reason=second-instance");
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

/*
 * Hygiene deletes files out of the same folder a running desk saves into, so it
 * may only run once this process owns the lock. Sweeping first meant a second
 * launch could reach in and delete the first desk's in-flight replacement file
 * — the one standing in for the live state while a save was mid-rename.
 */
if (isPrimaryInstance && !isMcpHelper) {
  try {
    const swept = sweepStaleUserData(app.getPath("userData"), {
      appVersion: APP_VERSION,
      tmpDir: os.tmpdir(),
    });
    if (swept.removed.length) {
      console.info(`Cleared leftover desk cache (${swept.removed.join(", ")}).`);
      mainLog.record("hygiene", `removed=${swept.removed.length} bytes=${swept.bytes}`);
    }
  } catch {
    /* Chromium cache may already be open */
  }
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

function setDockIcon() {
  if (process.platform !== "darwin" || !app.dock) return;
  const icon = appIconPath();
  if (!fs.existsSync(icon)) return;
  try {
    const image = nativeImage.createFromPath(icon);
    if (image.isEmpty()) return;
    app.dock.setIcon(image);
  } catch (error) {
    console.warn("Workhorse could not set its Dock icon", error);
  }
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

/**
 * What the read found, not just what it returned.
 *
 * `readVersionedState` already knows whether the live file answered, whether a
 * backup stood in for it, or whether nothing parsed at all — and the last case
 * is the dangerous one, because it reports `recovered: false` while handing
 * back an empty desk. Dropping that on the way out left the load handler unable
 * to tell an empty desk from a desk it failed to read, and it pruned worktrees
 * on the strength of the difference.
 */
type StateLoad = {
  state: Persistable;
  /** The file that actually parsed, or null when every candidate failed. */
  source: string | null;
  /** True when a backup stood in for the live file. */
  recovered: boolean;
  /** True only when the live state file itself parsed. */
  primary: boolean;
};

function readState(): Persistable {
  return readStateWithSource().state;
}

function readStateWithSource(): StateLoad {
  setPerfCause("state:read");
  try {
    return readStateInner();
  } finally {
    clearPerfCause();
  }
}

function readStateInner(): StateLoad {
  const result = readVersionedState(statePath());
  const { state } = result;
  const origin = { source: result.source, recovered: result.recovered, primary: result.source === statePath() };
  if (!origin.primary) {
    mainLog.record(
      "state:read",
      origin.source ? `recovered from ${path.basename(origin.source)}` : "no candidate parsed; empty desk in memory",
    );
  }
  let migrated: Persistable = state;
  try {
    const protectedState = offloadStateAttachments(
      protectStateCredentials(state, credentialStore()),
      app.getPath("userData"),
    );
    /*
     * `sameJsonValue`, not two `JSON.stringify` calls. The old compare
     * serialised the whole desk twice to decide whether anything needed
     * writing — 155 ms on the live 46 MB file, on the main process, before
     * first paint, and the answer is almost always "nothing did". The walk
     * stops at the first difference and allocates nothing, so the launch that
     * has no work to do pays a traversal instead of two 46 MB strings, and the
     * launch that does have work pays a few nodes.
     */
    if (result.recovered || !sameJsonValue(protectedState, state)) {
      /*
       * A recovery write must not rotate. Rotation copies the live file onto
       * `.bak` — and on a recovery the live file is the torn one we just
       * refused to read, so the good snapshot is demoted a rung. Two bad
       * launches in a row walked it off the end of `.bak.2` and the desk was
       * gone. Keep the backups exactly as they are and flush the repair,
       * because a repair that does not survive the next power cut is not one.
       */
      writeVersionedState(
        statePath(),
        protectedState,
        (snapshot) =>
          offloadStateAttachments(protectStateCredentials(snapshot, credentialStore()), app.getPath("userData")),
        result.recovered ? { rotateBackups: false, fsync: true } : {},
      );
    }
    // Hand back the offloaded copy, not the one we read. Returning the original
    // left the window holding every picture it had just written to disk, so the
    // relief only arrived on the next launch — which is the launch after the
    // one where someone ran out of memory.
    migrated = protectedState;
  } catch (error) {
    // The credential vault may be unavailable while the OS is locked. Keep the
    // recovered state in memory, but never persist a plaintext replacement.
    console.warn("state protect/offload skipped", error);
  }
  const hydrated = hydrateStateCredentials(migrated, credentialStore());
  const detected = useVolatileCredentials()
    ? hydrateDetectedCustomCredentials(hydrated, detectCustomLogin())
    : hydrated;
  const ready = fillEmptyCustomBotKeys(detected);
  claimLinkedFolders(ready);
  const drafts = readComposerDraftFile(statePath()) as Record<string, ComposerDraftSnap>;
  if (Array.isArray(ready.sessions) && Object.keys(drafts).length > 0) {
    return { ...origin, state: { ...ready, sessions: applyComposerDrafts(ready.sessions, drafts) } };
  }
  return { ...origin, state: ready };
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
/*
 * The flush keeps its own clock now that rotation runs on a slower one.
 *
 * Rotation used to be what forced the periodic fsync, so stretching the backup
 * cadence from one minute to ten would have quietly stretched the durability
 * window with it — a disk-traffic saving paid for out of somebody else's
 * unflushed work. The two decisions are separate: backups every ten minutes,
 * bytes on the platter every minute, exactly as before.
 */
let lastStateFsyncAt = 0;

/*
 * Saves are serialized: an overlapping save must not let an older snapshot's
 * rename land after a newer one. The chain keeps last-writer-wins ordering
 * without holding the IPC handler.
 */
let stateSaveChain: Promise<void> = Promise.resolve();

/*
 * Hot saves skip fsync on purpose — flushing a 46MB file sixty times a minute
 * would stall the window, and the whole reason the save moved off the main
 * thread was to stop doing that. The cost of skipping is a window, up to the
 * OS flush interval, where the rename is durable and the bytes are not.
 *
 * Three things close that window without paying for it every save:
 *
 *  - the rotate save, at most once a minute, still flushes;
 *  - growth flushes. A desk that has put on `STATE_FSYNC_GROWTH_BYTES` since
 *    the last flush is holding that much new work in the window, so it pays
 *    once. A desk that is merely being rewritten at the same size pays nothing;
 *  - quit flushes, because there is no next save to catch it.
 *
 * The rotation itself now flushes the live file before copying it to `.bak`,
 * so an unflushed write can never become the backup either.
 */
const STATE_FSYNC_GROWTH_BYTES = 4 * 1024 * 1024;
let stateBytesAtLastFsync = 0;

function stateFileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

async function writeState(state: Persistable) {
  try {
    /*
     * The tag covers the clones and the stringify — the stretch that actually
     * holds the loop. It clears before the disk await: an instrument that kept
     * "state:save" set across the off-thread wait blamed the save for every
     * unrelated stall in that window, and an instrument that leans toward the
     * hypothesis it was built to test is worse than none. The stringify runs
     * before the first await inside the write, so clearing on the next
     * microtask leaves only genuinely-off-thread time untagged.
     */
    setPerfCause("state:save");
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
          mainLog.record("state:save", `refused empty overwrite prev_sessions=${prevSessions} prev_usage=${prevUsage}`);
          return;
        }
      } catch {
        // existing file unreadable — write through
      }
    }
    const now = Date.now();
    const sizeBefore = stateFileSize(file);
    // The size the trace carries. It is the file going in, not the payload
    // going out — free to read, and within a save's own growth of the truth. A
    // gap and a cause say the save held the loop; the size is what tells you
    // whether it held it because the desk is big or because something else went
    // wrong, which is the difference between a fix and a guess.
    setPerfCause("state:save", sizeBefore);
    /*
     * Rotation on its own, slower clock. Copying the whole live file every
     * minute was 60 copies an hour of a 46 MB file — 2.7 GB of writes an hour
     * to hold three snapshots minutes apart. Ten minutes keeps the same three
     * generations for a tenth of the traffic; the flush below still runs every
     * minute, so nothing about durability moves.
     */
    const rotateBackups = dueByInterval(lastStateBackupAt, now, STATE_BACKUP_INTERVAL_MS);
    const dueForFlush = dueByInterval(lastStateFsyncAt, now, STATE_FSYNC_INTERVAL_MS);
    const grew = sizeBefore - stateBytesAtLastFsync >= STATE_FSYNC_GROWTH_BYTES;
    const fsync = rotateBackups || dueForFlush || grew;
    const pending = writeVersionedStateAsync(
      file,
      state,
      (snapshot) =>
        offloadStateTranscripts(
          offloadStateAttachments(protectStateCredentialsForSave(snapshot, credentialStore()), app.getPath("userData")),
          app.getPath("userData"),
        ),
      { rotateBackups, fsync },
    );
    queueMicrotask(clearPerfCause);
    await pending;
    // The tail is save work too — the bookmark walk and jobEngine.sync run on
    // the loop over every session. Untagged, a stall here reads "unknown" and
    // the instrument grows a blind spot exactly where it used to over-blame.
    setPerfCause("state:save", sizeBefore);
    if (rotateBackups) lastStateBackupAt = now;
    if (fsync) {
      lastStateFsyncAt = now;
      stateBytesAtLastFsync = stateFileSize(file);
      if (grew) mainLog.record("state:save", `flushed on growth bytes=${stateBytesAtLastFsync}`);
    }
    const io = folderAccessIo();
    for (const [folder, bookmark] of Object.entries(bookmarksFromProjects(state))) {
      rememberFolderBookmark(folder, bookmark, io);
    }
    jobEngine?.sync(state.sessions);
  } catch (error) {
    console.error("workhorse state save failed", error);
    mainLog.record("state:save", `failed ${faultDetail(error)}`);
  } finally {
    clearPerfCause();
  }
}

/**
 * How long the sweeps wait after the desk has loaded.
 *
 * The prune used to run inside `state:load`, between the read and the reply, so
 * every `git` call it made was a call the window waited on before it could
 * paint. Nothing about it needs to happen then. Half a minute puts it well clear
 * of the first frames and still well inside a session anybody would call short.
 */
const HOUSEKEEPING_DELAY_MS = 30_000;
let housekeepingScheduled = false;

/**
 * The slow, destructive half of launch, off the path a person is watching.
 *
 * Two sweeps run here. The worktree prune, which the `state:load` guard has
 * already agreed is safe to run at all, and the aged hand-named state backups —
 * files that can be hundreds of megabytes and are being judged on a month of
 * age, which is not a question that needs answering before somebody sees their
 * chats.
 */
function scheduleHousekeeping(sessions: readonly unknown[]) {
  if (housekeepingScheduled) return;
  housekeepingScheduled = true;
  const timer = setTimeout(() => {
    try {
      runHousekeeping(sessions);
    } catch (error) {
      mainLog.record("housekeeping", `failed ${faultDetail(error)}`);
    }
  }, HOUSEKEEPING_DELAY_MS);
  timer.unref?.();
}

function runHousekeeping(sessions: readonly unknown[]) {
  const userData = app.getPath("userData");
  const root = path.join(userData, "worktrees");

  /*
   * The live set, and the reason the reaper collected nothing.
   *
   * `state:load` handed the sweep every session id in the desk. Hidden workers
   * are sessions, so every worker's tree named a chat that still existed and
   * the sweep skipped all of them: 626 hidden rows, 624 of them finished, 137
   * trees, 59 GB — 98% of userData — and a prune that had never removed
   * anything. `worktreeKeepSet` is the same list minus the finished workers
   * whose age floor has passed; every one of `worktree-host`'s refusals still
   * has to agree before a single folder goes.
   */
  const keep = worktreeKeepSet(sessions);
  const before = measureWorktreeStore(root);
  const pruned = pruneOrphanWorktrees(root, keep);
  const after = measureWorktreeStore(root);
  mainLog.record(
    "prune:run",
    `sessions=${sessions.length} keep=${keep.length} trees_before=${before.trees} removed=${pruned.removed.length} kept=${pruned.kept.length} trees_after=${after.trees} over_ceiling=${after.overTrees}`,
  );
  for (const held of pruned.kept) {
    console.info(`Kept the worktree for ${held.name}: ${held.reason}.`);
    mainLog.record("prune:kept", `${held.name}: ${held.reason}`);
  }

  const backups = sweepAgedStateBackups(userData);
  if (backups.removed.length) {
    mainLog.record("hygiene", `aged state backups removed=${backups.removed.length} bytes=${backups.bytes}`);
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

  /*
   * A renderer or a helper dying takes the desk's surface with it and leaves
   * nothing behind — no throw reaches this process, so neither handler below
   * fires. These two lines are the only record that it happened, and the reason
   * plus the exit code is what separates "killed for memory" from "crashed".
   */
  win.webContents.on("render-process-gone", (_event, details) => {
    mainLog.record("render-process-gone", `reason=${details.reason} exit_code=${details.exitCode ?? "none"}`);
  });
  win.on("closed", () => {
    mainLog.record("window", "destroyed");
  });
  mainLog.record("window", `created id=${win.id}`);

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
  mainLog.record("uncaughtException", faultDetail(error));
});
process.on("unhandledRejection", (error) => {
  console.error("workhorse unhandledRejection", error);
  mainLog.record("unhandledRejection", faultDetail(error));
});
process.on("exit", (code) => {
  mainLog.record("exit", `code=${code}`);
});

app.whenReady().then(async () => {
  debugStartup(`ready primary=${isPrimaryInstance}`);
  mainLog.record("ready", `primary=${isPrimaryInstance} uptime_ms=${Math.round(process.uptime() * 1000)}`);
  if (!isPrimaryInstance) return;
  app.on("child-process-gone", (_event, details) => {
    mainLog.record(
      "child-process-gone",
      `type=${details.type} reason=${details.reason} exit_code=${details.exitCode ?? "none"}`,
    );
  });
  startMemoryLog(mainLog);
  protocol.handle("workhorse-media", handleMediaProtocol);
  claimLinkedFolders();
  fileInstances = readStringMapFile(fileInstancesPath());
  void archiveWorkhorseWorkerThreads()
    .then((result) => {
      if (result.archived > 0) console.info(`Archived ${result.archived} Workhorse Codex worker logs.`);
    })
    .catch((error) => console.warn("Workhorse Codex worker cleanup failed", error));
  if (process.platform === "win32") {
    app.setAppUserModelId(windowsAppUserModelId);
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
  void ensureGrokBotShim({
    userData: app.getPath("userData"),
    home: app.getPath("home"),
    platform: process.platform,
    command: process.execPath,
    script: path.join(__dirname, "grok-bot-shim-host.js"),
    // A desk pinned to an isolated profile is a test or a dev build. It can use
    // whatever shim is already up, but it must not rewrite the launch agent the
    // installed desk depends on.
    manageKeepalive: !workhorseUserDataOverride(),
  }).then((result) => {
    if (!result.ok) console.warn("Grok Bot shim failed to start. Desk POSTs to 127.0.0.1:8787 still fail closed.");
    else debugStartup(`Grok Bot shim ${result.mode}`);
  }).catch((error) => console.warn("Grok Bot shim", error));

  // Before any channel is registered, so every one of them is covered — and so
  // is a channel written next month.
  guardIpcSender(ipcMain, process.env.VITE_DEV_SERVER_URL);

  // Grok Bot answers that outlive the shim's wait land here later. Deliver each
  // one into the chat that asked; the renderer confirms, then the files go.
  const grokBotInbox = grokBotInboxDir(app.getPath("userData"), path.sep);
  try {
    fs.mkdirSync(grokBotInbox, { recursive: true, mode: 0o700 });
  } catch {
    /* the shim creates it too */
  }
  watchGrokBotLateAnswers(grokBotInbox, (answers) => {
    // One window holds the state of record; a broadcast would append twice.
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.isDestroyed());
    win?.webContents.send("grok-bot:late-answer", answers);
  });
  ipcMain.handle("grokBot:lateAnswers", () => listGrokBotLateAnswers(grokBotInbox));
  ipcMain.handle("grokBot:ackLateAnswer", (_event, reqId: unknown) => {
    if (typeof reqId === "string") clearGrokBotLateAnswer(grokBotInbox, reqId);
  });

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
  ipcMain.handle("agentRuntime:linkGrokBotOneshot", () => {
    const platform = process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : "darwin";
    return workhorseLinkGrokBotOneshot({
      ...linkLaunch(),
      cliPath: platform === "win32" ? "workhorse.cmd" : "workhorse",
      platform,
      userData: app.getPath("userData"),
    });
  });
  ipcMain.handle("grokBotWake:status", () => inspectGrokBotWake(grokBotWakePath(app.getPath("userData"))));
  ipcMain.handle("grokBotWake:save", (_event, input: import("../src/lib/grok-bot-wake").GrokBotWakeInput) =>
    saveGrokBotWake(grokBotWakePath(app.getPath("userData")), input));

  // The `workhorse` command: a launcher with this install's exact paths, and
  // a symlink onto PATH where one can be made without a privilege prompt.
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
        writable: (dir) => {
          try {
            fs.accessSync(dir, fs.constants.W_OK);
            return true;
          } catch {
            return false;
          }
        },
        unlink: (file) => fs.unlinkSync(file),
        symlink: (target, linkPath) => fs.symlinkSync(target, linkPath),
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

  ipcMain.handle("attach:pick", async () => {
    const result = await dialog.showOpenDialog({
      title: "Attach files or folders",
      buttonLabel: "Attach",
      properties:
        process.platform === "win32"
          ? ["openFile", "multiSelections"]
          : ["openFile", "openDirectory", "multiSelections"],
    });
    if (result.canceled) return [];
    return result.filePaths.filter((item) => typeof item === "string" && item.trim());
  });

  ipcMain.handle("localCompute:pickTokenFile", async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose local host token file",
      buttonLabel: "Choose",
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

  // Which linked folders are gone. The renderer picks the folder a chat runs in
  // and cannot stat, so without this it keeps choosing a path that has moved.
  ipcMain.handle("project:missing-folders", async (_event, folders: unknown) => {
    if (!Array.isArray(folders)) return [];
    return folders.filter(
      (folder): folder is string => typeof folder === "string" && folder.trim().length > 0 && !fs.existsSync(folder),
    );
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

  ipcMain.handle("project:git-head", (_event, cwd: unknown) =>
    readGitHead(typeof cwd === "string" ? resolveSessionCwd(cwd) : ""),
  );

  ipcMain.handle("project:git-changes", (_event, cwd: unknown, baseRef: unknown) =>
    listGitChanges(
      typeof cwd === "string" ? resolveSessionCwd(cwd) : "",
      typeof baseRef === "string" ? baseRef : undefined,
    ),
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

  /*
   * One finished worker's steps, read back when somebody opens its chat.
   *
   * `readVersionedState`, not `readStateWithSource`: that one protects,
   * offloads and can rewrite the file, which is launch work and has no business
   * running because a person clicked a chat. Only the messages go back — the
   * chat the renderer already holds is not being replaced, only filled in.
   */
  ipcMain.handle("transcript:load", (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) return null;
    const { state } = readVersionedState(statePath());
    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    const session = sessions.find(
      (row) => row && typeof row === "object" && (row as { id?: unknown }).id === sessionId,
    );
    if (!session) return null;
    const filled = rehydrateSessionTranscript(session) as { messages?: unknown };
    return { id: sessionId, messages: Array.isArray(filled.messages) ? filled.messages : [] };
  });

  ipcMain.handle("state:load", () => {
    const load = readStateWithSource();
    const loaded = load.state;
    const sessions = Array.isArray(loaded.sessions) ? loaded.sessions : [];
    const liveSessionIds = sessions
      .map((session) =>
        session && typeof session === "object" && typeof (session as { id?: unknown }).id === "string"
          ? (session as { id: string }).id
          : "",
      )
      .filter(Boolean);

    /*
     * The prune deletes folders on the strength of this list, so the list has to
     * be the truth and not a guess. Two ways it was not:
     *
     * A backup answered instead of the live file, so every chat started since
     * that snapshot is missing from the list and its worktree reads as an
     * orphan. And when nothing parsed at all, `readVersionedState` hands back an
     * empty desk while reporting `recovered: false` — every worktree on disk is
     * then an orphan, and a sweep that trusted it would take all of them.
     *
     * The save path has refused an empty overwrite for a while. The prune,
     * which destroys more than a save ever could, had no such guard. It runs
     * only when the live file itself parsed and named at least one chat.
     */
    const decision = worktreePruneDecision(load, statePath(), liveSessionIds);
    if (!decision.prune) {
      console.info(`Workhorse skipped the worktree sweep: ${decision.reason}.`);
      mainLog.record("prune:skip", decision.reason);
    } else {
      scheduleHousekeeping(sessions);
    }

    /*
     * A silent recovery is how someone loses a day without knowing it: the desk
     * opens on last week's snapshot, they carry on, and the newer chats are
     * simply not there. Say it out loud on the surface the desk already has.
     */
    if (!load.primary) {
      showDesktopNotice({
        title: load.source ? "Workhorse opened an earlier save" : "Workhorse could not read your saved desk",
        body: load.source
          ? "The main save file could not be read, so a backup was used. Anything added after that backup is not here — check before you carry on."
          : "No save file could be read, so this desk started empty. Your chats may still be on disk — quit without saving over them and ask for help.",
      });
    }
    return loaded;
  });
  ipcMain.handle("state:save", (_event, state: Persistable) => {
    if (!state || typeof state !== "object") return;
    // The catch keeps the chain alive: writeState guards its own body, but a
    // future edit that throws before its try would otherwise poison the chain
    // and silently end every save after it.
    stateSaveChain = stateSaveChain.then(() => writeState(state)).catch(() => {});
    return stateSaveChain;
  });
  ipcMain.handle("state:save-drafts", (_event, drafts: unknown) => {
    if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) return;
    writeComposerDraftFile(statePath(), drafts);
  });
  ipcMain.handle("localCompute:probe", (_event, hosts: unknown) =>
    probeLocalComputeHosts(
      Array.isArray(hosts) ? hosts as import("../src/lib/types").LocalComputeHostSettings[] : [],
    ),
  );
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
  ipcMain.handle("mcp:probe", async (_event, serverName: unknown) => {
    const name = typeof serverName === "string" ? serverName.trim() : "";
    if (!name) return { ok: false, message: "Choose a saved MCP server.", tools: [] };
    const saved = normalizeSettings(readState().settings).mcpServers.find((server) => server.name === name);
    if (!saved) return { ok: false, message: "Save this MCP server before testing it.", tools: [] };
    return probeMcpServer(saved);
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
          grokBotLeftoverPath: grokBotLeftoverPath(app.getPath("userData")),
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
  setDockIcon();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    setDockIcon();
  });
});

/**
 * How long quit will wait for the save chain. Long enough for a 46MB write on a
 * slow disk, short enough that a wedged one cannot hold the app open.
 */
const QUIT_DRAIN_MS = 5_000;
let quitDrained = false;

/**
 * `state:save` returns as soon as the write is *queued*, not written. Quitting
 * without waiting threw away every save still on the chain — accepted by the
 * desk, acknowledged to the person, never on disk. Wait for it, then flush the
 * file, because the last save before a quit is a hot save and hot saves skip
 * the flush by design: nothing comes after it to catch the bytes.
 *
 * Bounded on purpose. A save that will not finish must not become a desk that
 * will not close.
 */
async function drainStateForQuit(): Promise<void> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      stateSaveChain.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, QUIT_DRAIN_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const drained = Date.now() - started;
  try {
    await syncFileInPlace(statePath());
  } catch {
    /* nothing left to do about it at quit */
  }
  mainLog.record("shutdown", `reason=quit drained_ms=${drained} timed_out=${drained >= QUIT_DRAIN_MS}`);
}

app.on("before-quit", (event) => {
  // The drain calls `app.quit()` again, so this handler runs twice. Everything
  // below it disposes something once; the second pass has to fall straight
  // through, and so does a second Cmd-Q while the first drain is still going.
  if (quitDrained) return;
  quitDrained = true;
  learningCloser?.pause();
  learningCloser?.close();
  grokHost.disposeAll();
  codexHost.disposeAll();
  terminalHost.disposeAll();
  jobEngine?.dispose();
  // After the disposals, so Lane 0's guard keeps every one of them behind the
  // second-pass return, and once per quit rather than once per handler run.
  mainLog.record("before-quit", memoryDetail());
  event.preventDefault();
  void drainStateForQuit().finally(() => app.quit());
});

app.on("will-quit", () => {
  mainLog.record("will-quit", `uptime_ms=${Math.round(process.uptime() * 1000)}`);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

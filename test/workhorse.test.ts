import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  applyCompactUsage,
  classifyAcpUpdate,
  consumeAcpMessages,
  extractAvailableCommands,
  extractCompactEvent,
  extractSessionTitle,
  extractToolEvent,
  extractUpdateText,
  isAcpSessionUpdateMethod,
  parseGrokUsage,
  parseRewindPoints,
  pickPermissionOptionId,
  textFromContent,
  updateKind,
} from "../electron/grok-agent";
import { GrokSessionHost, shouldLoadVendorSession } from "../electron/grok-host";
import { parseGrokPlanUsage } from "../electron/grok-plan";
import { parseCodexPlanUsage } from "../electron/codex-plan";
import { detectGrokLogin } from "../electron/grok-login";
import { listDropFiles } from "../electron/drop-files";
import {
  deskPath,
  discoverRipgrepDirs,
  ensureDeskRipgrep,
  extraDeskDirs,
  parseRegPathValue,
  readWindowsPersistedPath,
  resolveDeskBinary,
  resolveRipgrep,
  withDeskToolEnv,
  workhorseToolBin,
} from "../electron/desk-path";
import {
  GROK_EFFORT_GATES,
  GROK_EFFORT_INPUTS,
  GROK_MODELS,
  WORKHORSE_CLIENT_CAPABILITIES,
  WORKHORSE_SESSION_RULES,
  buildGrokLaunchSpec,
  grokSpawnArgs,
  mergeMcpServers,
  resolveGrokEffort,
  resolveGrokPermissionMode,
  toAcpMcpEnv,
  workhorseMcpScript,
  workhorseMcpServer,
  isElectronAppCommand,
} from "../electron/grok-launch";
import { handleWorkhorseRpc, parseCreateProjectLive, parseRenameProjectLive, setWorkhorseDeskAsk } from "../electron/workhorse-mcp";
import { startWorkhorseBridge } from "../electron/workhorse-bridge";
import { mediaFileCandidates } from "../electron/media-src";
import { estimateChatContext, parseSessionContext } from "../src/lib/context-stats";
import { buildSessionPreface, buildVendorPreface, composeVendorPrompt, withVendorPreface } from "../src/lib/context-preface";
import { CREW_STATUS_HINT, CUSTOM_HTTP_SESSION_RULES, DESK_BOT_TURN_HINT, LOOSE_DELETE_HINT, SPAWN_TURN_HINT, WORKER_SESSION_RULES, looksLikeCrewImpatience, looksLikeDeskBotRequest, looksLikeGoalCommand, looksLikeLooseDeleteRequest, looksLikePermissionQuestion, looksLikePreviewQuestion, looksLikeSpawnRequest, looksLikeWorkerBrief, PERMISSION_TURN_HINT, PREVIEW_TURN_HINT, withCrewStatusHint, withDeskBotHint, withLooseDeleteHint, withPermissionHint, withSpawnHint, withCustomPeerHint, CUSTOM_HTTP_PEER_HINT, CUSTOM_HTTP_WORKER_RULES } from "../src/lib/workhorse-rules";
import { applySessionElevation, applySessionModelChange, applySessionPolicyChange, brainCaption, brainStamp, formatChatSidebar, isSessionIntro, messageBrain, normalizeMessage, normalizeSession, stampUnstampedMessages, vendorSessionForSend } from "../src/lib/session";
import { workerSidebarLabel } from "../src/ui/ChatRow";
import { buildAcpPrompt, groupAttachments, imageMime, normalizeImages, shouldSkipDropDir } from "../src/lib/images";
import { agentThreadsForSession, liveAgentThreadId } from "../src/lib/agent-thread";
import { catalogSessions, existingPeerReply, findSession, findSessionForLink, formatPeerPrompt, peerPromptParts, sameSessionCrew, sessionTranscript } from "../src/lib/session-bridge";
import {
  admitSpawn,
  collectChildAgentReports,
  deskRoleOf,
  formatSubagentPrompt,
  formatWorkerPrompt,
  descendantSessionIds,
  isHiddenSession,
  isSpawnOnlyPrompt,
  nestedSpawnError,
  normalizeAgentRun,
  overlappingAgentFiles,
  parentHasRunningChildren,
  rootSpawnError,
  resolveModelHint,
  resolveSpawnSpec,
  shouldSpawnInsteadOfAsk,
  SPAWN_ONLY_PROMPT_ERROR,
  spawnWaitsForReply,
  shouldAutoRouteSpawn,
  subagentTurns,
  toolsForDeskRole,
  UNBOUND_SPAWN_ERROR,
  withSubagentStatus,
  WORKER_SPAWN_ERROR,
} from "../src/lib/subagents";
import { addLineupRow, applyChildIdleSync, applyJoinRateLimitRetry, applyLineupChildFinish, applyLineupTurnBreak, awaitAgentsWaits, emptyLineup, formatAwaitAgentsSnapshot, JOIN_MAX_ATTEMPTS, joinDelayMs, LINEUP_FINISHED_NOTICE, lineupIsTerminal, lineupJoinFallback, lineupJoinPrompt, lineupSnapshot, lineupSynthesizePrompt, maybeEnqueueLineupJoin, nestProjectChats, normalizeLineup, reconcileIdleChildren, reconcilePersistedLineups, setLineupRowStatus, stampLineupUserText } from "../src/lib/lineup";
import { looksLikeDispatchCheckBack, looksLikeUnfinishedDeskTurn as looksLikeUnfinishedCustomTurn, shouldEndDispatchTurn } from "../electron/custom-host";
import { askViaInbox, interpretPeerAskHttp, isRetryablePeerAskTransport, peerAskTimeoutMs, readBridgeRecord, watchPeerInbox, writeBridgeRecord } from "../electron/peer-inbox";
import {
  COMMANDS,
  CODEX_SHELL_COMMANDS,
  GROK_SHELL_COMMANDS,
  commandContinuesToVendor,
  commandNeedsInput,
  commandsForSession,
  commandsFromSkills,
  filterCommands,
  invokeSkillPrompt,
  matchCommand,
  mergeCommands,
  splitGoalCommand,
} from "../src/lib/commands";
import { applyGoalCommand, goalCommandForAction, goalDisplay, goalDisplayForSession, goalHaltsVendor, goalVendorPrompt, grokGoalAfterTurnIdle, parseGoalInput, parseGrokGoalLine } from "../src/lib/goal";
import { nextGoalForSend, planHaltForward, prepareVendorSend, vendorTerminalAction } from "../src/lib/vendor-send";
import { advertisedClaudeWindow, advertisedCodexWindow, applyVendorCatalog, contextWindowFor, defaultModel, effortStopAt, effortStopPos, effortsFor, parseEffort, resetVendorCatalog, shortModelName, usageToneForModel } from "../src/lib/models";
import { safeExternalUrl } from "../src/lib/open-external";
import { workhorseUserDataOverride, workhorseVolatileCredentials } from "../src/lib/user-data";
import { applyWorkhorseToggle, isTheme, nextTheme, resolvedTheme, SETTINGS_THEME_CHOICES } from "../src/lib/theme";
import { listVendorModels, parseCodexModelsCache, parseGrokModelsCache } from "../electron/vendor-models";
import { applyFailedPeerAsk, collapseThoughtDisplay, collapseToolText, failPeerAskMessages, finishOpenToolMessages, formatToolLine, mergeThoughtText, shortDisplayPath, toolIsFinished, upsertCompactMessage, upsertThoughtMessage, upsertToolMessage } from "../src/lib/grok-events";
import {
  joinChatText,
  parseChatMarkdown,
  parseFactLine,
  parseInline,
  mergeStreamedText,
  unsquashSentences,
  parseMarkdownTable,
  peelAskMarkup,
  peelPlanningPreamble,
  peelThinkTags,
  splitThoughtFromOutput,
  stripOutputFromThought,
  wrapMarkdown,
} from "../src/lib/markdown";
import { applyPermissionAnswer, autoAllowPermission, classifyElevation, describeElevation, elevationForBlock, enqueuePermission, looksLikeSearchOnly, looksLikeWriteTool, parseElevationInput, permissionAnswerLabel, permissionGrantKey, permissionPolicyAnswer } from "../src/lib/permissions";
import { appendUserMessage, applyDeleteDeskChat, applyDeleteLooseDeskChats, applyRenameDeskChat, archiveChat, autoRenameChat, canPlaceInProject, deleteChat, deleteChatGuard, deleteWorkerChats, dropDrafts, dropQueuedPrompt, enqueuePrompt, findListedChat, forkChat, forkTitle, hasComposerDraft, hiddenProjectChatCount, isDraftChat, isLooseDeleteScope, lastUserMessage, listedChats, messagesThrough, moveChat, openDraft, PROJECT_CHAT_LIMIT, renameChat, resolveListedChat, rewindToUserMessage, shiftQueuedPrompt, visibleProjectChats } from "../src/lib/chats";
import { applyArchiveProject, applyCreateWorkhorseProject, applyDeleteProject, applyProjectChatFate, applyRenameDeskProject, emptyProject, findProjectByQuery, renameTookOnDesk, visibleProjectNames } from "../src/lib/project";
import { applyUpdateStockBot, deskInk, firstAttachedChoice, hasAttachedLlm, normalizeSettings, vendorAttachedForSession, vendorEnabled, vendorLabel, vendorTint } from "../src/lib/settings";
import { customBotEnabled } from "../src/lib/custom-bots";
import { buildFileDiff, countLineChanges, formatDiffStat, lineDiff } from "../src/lib/file-diff";
import { findSourceFile, isAbsolutePath, readFileDiff } from "../electron/project-diff";
import { fileFolderFromPath, formatEditWhen, isWriteToolTitle, looksLikeSourceFile, mergeEdits, pathFromWriteTool, projectEdits, sameEditPath } from "../src/lib/project-edits";
import { autoTitleForSend, suggestedTitleForSession, titleFromPrompt } from "../src/lib/titles";
import { isVendorRateLimitError, vendorFailedMessage } from "../src/lib/vendor-bridge";
import { clampPaneWidth, SIDEBAR_PANE, THREAD_PANE } from "../src/lib/pane";
import { selectSurface, titlebarLabel } from "../src/lib/surface";
import {
  applyCut,
  applyPaste,
  applySelectAll,
  canCopy,
  canCut,
  canPaste,
  canSelectAll,
  clampMenuPosition,
  EDIT_MENU_ITEMS,
  selectedText,
} from "../src/lib/edit-menu";
import {
  chatLinksFromSessions,
  describePeerTool,
  formatPermissionDetail,
  permissionActionLabel,
  prettyToolStatus,
  prettyToolTitle,
  talkingToSummary,
} from "../src/lib/tool-labels";
import { formatWorked, groupTranscript, lastReplyIndex, resolveWorkedMs, thoughtForReply } from "../src/lib/turns";
import type { ChatMessage, PermissionMode, PermissionRequest, Session } from "../src/lib/types";
import {
  addUsageDraft,
  applyUsageContext,
  collapseInflatedUsage,
  finalizeTurnUsage,
  mergeUsageDraft,
  repairInflatedTurn,
  contextFromEvent,
  occupancyFromUsage,
  eventTotal,
  modelsForProvider,
  customBotUsageEvents,
  deskUsageCards,
  leftoverForCard,
  byModel,
  rehomeCustomUsage,
  usageProviderForSession,
  tideNeedsDarkInk,
  vendorTidePercent,
  deskPulseLines,
  vendorUsedPercent,
  planRingView,
  pickClaudeWindow,
  pickPlanWindow,
  claudeWindowTabs,
  planWindowChip,
  weeklyPlanLeftover,
  formatPlanReset,
  normalizeUsage,
  rollup,
  heatLevel,
  cellDotBackground,
  stretchBuckets,
  stretchHeatmap,
  weekDays,
} from "../src/lib/usage";
import { colorFromWheel, hexToHsv, hsvToHex, parseHex } from "../src/lib/color";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The desktop launches agent processes with its live desk bridge in the
// environment. Keep this test module hermetic: bridge-specific tests opt in by
// setting these variables explicitly, while ordinary launch-spec tests should
// exercise the no-bridge baseline regardless of where `npm test` was started.
for (const key of [
  "WORKHORSE_BRIDGE_URL",
  "WORKHORSE_BRIDGE_TOKEN",
  "WORKHORSE_STATE_PATH",
  "WORKHORSE_MCP_SCRIPT",
  "WORKHORSE_MCP_COMMAND",
]) {
  delete process.env[key];
}

test("isolated user data accepts an env or explicit launch flag", () => {
  assert.equal(workhorseUserDataOverride([], { WORKHORSE_USER_DATA_PATH: "/tmp/env-profile" }), "/tmp/env-profile");
  assert.equal(
    workhorseUserDataOverride(["electron", ".", "--workhorse-user-data=/tmp/flag-profile"], {}),
    "/tmp/flag-profile",
  );
  assert.equal(workhorseUserDataOverride([], {}), undefined);
  assert.equal(workhorseVolatileCredentials(["electron", ".", "--workhorse-volatile-credentials"], {}), true);
  assert.equal(workhorseVolatileCredentials([], { WORKHORSE_VOLATILE_CREDENTIALS: "true" }), true);
  assert.equal(workhorseVolatileCredentials([], {}), false);
});

test("filterCommands returns the shipped command list and filters it", () => {
  const all = filterCommands("/");
  assert.equal(all, COMMANDS);
  assert.ok(COMMANDS.length > 0);

  const asked = filterCommands("/ask");
  assert.ok(asked.length > 0);
  assert.ok(asked.every((command) => COMMANDS.includes(command)));
  assert.ok(asked.some((command) => command.run === "mode:ask"));

  const byHint = filterCommands("token usage");
  assert.ok(byHint.every((command) => COMMANDS.includes(command)));
  assert.ok(byHint.some((command) => command.run === "usage"));

  assert.deepEqual(filterCommands("/no-such-command"), []);
});

test("applyPermissionAnswer updates the real pending queue and session", () => {
  const session: Session = {
    id: "sess_1",
    projectId: "proj_1",
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "New chat",
    mode: "ask",
    sandbox: "off",
    status: "needs-input",
    messages: [{ id: "m1", role: "system", text: "preview", createdAt: 1 }],
    contextUsed: 0,
  };
  const request: PermissionRequest = {
    id: "perm_1",
    sessionId: session.id,
    provider: "grok",
    tool: "run command",
    detail: "git status",
  };
  const start = { pending: [request], sessions: [session] };

  assert.equal(applyPermissionAnswer(start, "missing", "deny"), null);

  const denied = applyPermissionAnswer(start, request.id, "deny");
  assert.ok(denied);
  assert.equal(denied.pending.length, 0);
  assert.equal(denied.sessions[0].status, "idle");
  assert.equal(denied.sessions[0].messages.length, session.messages.length + 1);
  assert.equal(denied.sessions[0].messages.at(-1)?.kind, "tool");
  assert.equal(denied.sessions[0].messages.at(-1)?.toolStatus, "failed");
  assert.match(denied.sessions[0].messages.at(-1)?.text ?? "", /^Denied:/);

  const once = applyPermissionAnswer(start, request.id, "once");
  const sessionGrant = applyPermissionAnswer(start, request.id, "session");
  assert.ok(once && sessionGrant);
  assert.equal(once.sessions[0].status, "running");
  assert.equal(sessionGrant.sessions[0].status, "running");
  assert.notEqual(once.sessions[0].messages.at(-1)?.text, sessionGrant.sessions[0].messages.at(-1)?.text);
  assert.equal(once.sessions[0].messages.at(-1)?.kind, "tool");
  assert.match(once.sessions[0].messages.at(-1)?.text ?? "", /Allowed once/);
  assert.match(sessionGrant.sessions[0].messages.at(-1)?.text ?? "", /Allowed for this session/);
  assert.deepEqual(sessionGrant.sessions[0].permissionGrants, ["shell"]);
  assert.equal(autoAllowPermission({ tool: "workhorse_workhorse_list_chats" }), "once");
  assert.equal(autoAllowPermission({ tool: "workhorse_ask_chat" }), "once");
  assert.equal(autoAllowPermission({ tool: "workhorse_spawn_agent" }), "once");
  assert.equal(autoAllowPermission({ tool: "workhorse_ask_chat", grants: ["workhorse"] }), "once");
  assert.equal(permissionGrantKey("workhorse_list_references"), "workhorse");
  const queued = enqueuePermission(
    [{ id: "perm_1", sessionId: "sess_1", provider: "grok", tool: "a", detail: "a" }],
    { id: "perm_2", sessionId: "sess_1", provider: "grok", tool: "b", detail: "b" },
  );
  assert.deepEqual(queued.map((item) => item.id), ["perm_1", "perm_2"]);
  const stacked = applyPermissionAnswer(
    {
      pending: [
        request,
        { id: "perm_2", sessionId: session.id, provider: "grok", tool: "shell", detail: "ls" },
      ],
      sessions: [session],
    },
    request.id,
    "once",
  );
  assert.equal(stacked?.pending.length, 1);
  assert.equal(stacked?.sessions[0].status, "needs-input");
  assert.equal(looksLikeWriteTool("Write", "notes.md", "notes.md"), true);
  assert.equal(looksLikeWriteTool("run command", "powershell -c echo hi"), true);
  assert.equal(looksLikeWriteTool("read_file", "notes.md", "notes.md"), false);
  assert.equal(looksLikeWriteTool("rg", "rg -n leftover src"), false);
  assert.equal(looksLikeWriteTool("shell", "rg --files"), false);
  assert.equal(looksLikeSearchOnly("rg", "rg -n leftover src"), true);
  assert.equal(looksLikeSearchOnly("shell", "rg --files"), true);
  assert.equal(
    looksLikeSearchOnly(
      "shell",
      "powershell.exe -NoProfile -Command try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\nrg --files -g !node_modules",
    ),
    true,
  );
  assert.equal(looksLikeSearchOnly("shell", "rg foo && rm notes.md"), false);
  assert.equal(permissionPolicyAnswer({ mode: "ask", sandbox: "off", tool: "shell", detail: "rg --files" }), "once");
  assert.equal(permissionPolicyAnswer({ mode: "plan", sandbox: "read-only", tool: "rg", detail: "rg -n leftover src" }), "once");
  assert.equal(permissionPolicyAnswer({ mode: "ask", sandbox: "read-only", tool: "Write", detail: "notes.md", path: "notes.md" }), "deny");
  assert.equal(permissionPolicyAnswer({ mode: "plan", sandbox: "off", tool: "Write", detail: "src/app.ts", path: "src/app.ts" }), "deny");
  assert.equal(permissionPolicyAnswer({ mode: "plan", sandbox: "off", tool: "Write", detail: "plan.md", path: "plan.md" }), null);
  assert.equal(permissionPolicyAnswer({ mode: "ask", sandbox: "off", tool: "Write", detail: "notes.md" }), null);
  assert.equal(permissionPolicyAnswer({ mode: "always-approve", sandbox: "off", tool: "shell", detail: "ls docs" }), "session");
  assert.equal(permissionPolicyAnswer({ mode: "always-approve", sandbox: "workspace", tool: "Write", detail: "src/app.ts", path: "src/app.ts" }), "session");
  assert.equal(permissionPolicyAnswer({ mode: "always-approve", sandbox: "read-only", tool: "Write", detail: "src/app.ts", path: "src/app.ts" }), "deny");
  assert.equal(permissionGrantKey('cd /tmp/worktree && ls docs && echo "copy"'), "shell");
  assert.equal(permissionGrantKey("Read src/app.ts"), "read");
  assert.deepEqual(
    elevationForBlock({ mode: "ask", sandbox: "read-only", tool: "Write", detail: "notes.md", path: "notes.md" }),
    { sandbox: "off" },
  );
  assert.deepEqual(
    elevationForBlock({ mode: "plan", sandbox: "off", tool: "Write", detail: "src/app.ts", path: "src/app.ts" }),
    { mode: "ask" },
  );
  assert.equal(elevationForBlock({ mode: "ask", sandbox: "off", tool: "Write", detail: "notes.md" }), null);
  assert.deepEqual(parseElevationInput({ permission: "always-approve", sandbox: "off" }, { mode: "plan", sandbox: "read-only" }), {
    mode: "always-approve",
    sandbox: "off",
  });
  assert.equal(parseElevationInput({ permission: "ask" }, { mode: "always-approve", sandbox: "off" }), null);
  assert.equal(classifyElevation({ mode: "always-approve", sandbox: "off" }, { mode: "ask" }).kind, "downgrade");
  assert.equal(classifyElevation({ mode: "always-approve", sandbox: "off" }, { sandbox: "workspace" }).kind, "downgrade");
  assert.equal(classifyElevation({ mode: "always-approve", sandbox: "off" }, {}).kind, "noop");
  assert.equal(classifyElevation({ mode: "plan", sandbox: "read-only" }, { mode: "ask", sandbox: "off" }).kind, "raise");
  assert.match(describeElevation({ mode: "plan", sandbox: "read-only" }, { mode: "ask", sandbox: "off" }), /Permission/);
  const elevated = applyPermissionAnswer(
    {
      pending: [
        {
          id: "perm_el",
          sessionId: session.id,
          provider: "custom",
          tool: "workhorse_request_permission",
          detail: "write the app",
          kind: "elevate",
          elevate: { mode: "ask", sandbox: "off" },
        },
      ],
      sessions: [{ ...session, provider: "custom", mode: "plan", sandbox: "read-only" }],
    },
    "perm_el",
    "session",
  );
  assert.equal(elevated?.sessions[0].mode, "ask");
  assert.equal(elevated?.sessions[0].sandbox, "off");
  assert.equal(elevated?.sessions[0].status, "running");
  assert.match(elevated?.sessions[0].messages.at(-1)?.text ?? "", /Elevated/);
  const keptVendor = applySessionElevation(
    { ...session, vendorSessionId: "keep-me", mode: "plan", sandbox: "read-only" },
    { mode: "ask", sandbox: "off" },
  );
  assert.equal(keptVendor.vendorSessionId, "keep-me");
  assert.equal(keptVendor.mode, "ask");
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "PermissionBar.tsx"), "utf8"), /needs more access/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "PermissionBar.tsx"), "utf8"), /Elevate/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "WatchNotices.tsx"), "utf8"), /watch-hold-bar hold/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "WatchNotices.tsx"), "utf8"), /Allow \$\{vendorAsk\.vendor\.name\} this chat/);
  assert.match(readFileSync(path.join(ROOT, "electron", "custom-host.ts"), "utf8"), /vendor: \{ provider: spawnTarget/);
  assert.match(readFileSync(path.join(ROOT, "electron", "custom-tools.ts"), "utf8"), /workhorse_request_permission/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8"), /request-permission/);
  assert.equal(looksLikePermissionQuestion("what permissions do you have?"), true);
  assert.equal(looksLikePermissionQuestion("list the folder"), false);
  assert.equal(looksLikePermissionQuestion("ROLE: worker\nFOLDER: D:\\Godot\\Projects\\spaceship-battle\nPermission / Sandbox are workspace facts."), false);
  assert.equal(
    looksLikePermissionQuestion(
      "This chat’s live desk limits for THIS turn (already enforced — do not probe them).\n- Permission: Ask\n- Sandbox: Off",
    ),
    false,
  );
  assert.equal(withPermissionHint("what permissions do you have?").startsWith(PERMISSION_TURN_HINT), true);
  assert.equal(
    withPermissionHint("ROLE: worker\nFOLDER: D:\\x\nRead src.", "worker"),
    "ROLE: worker\nFOLDER: D:\\x\nRead src.",
  );
  assert.equal(resolveGrokPermissionMode("ask"), "default");
  assert.equal(resolveGrokPermissionMode("accept-edits"), "acceptEdits");
  assert.equal(resolveGrokPermissionMode("always-approve"), "bypassPermissions");
  assert.equal(resolveGrokPermissionMode("plan"), "plan");
  assert.equal(resolveGrokPermissionMode("always-approve", "read-only"), "dontAsk");
  assert.equal(resolveGrokPermissionMode("accept-edits", "strict"), "dontAsk");
});

test("selectSurface and titlebarLabel follow the draft chrome rules", () => {
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /frame:\s*false/);
  assert.match(main, /titleBarStyle:\s*"hidden"/);
  assert.match(main, /titleBarOverlay/);
  assert.match(main, /setMenu\(null\)/);
  assert.match(main, /WORKHORSE_USER_DATA_DIR = "Go7 Workhorse"/);
  assert.match(main, /WORKHORSE_DEV_USER_DATA_DIR = "Go7 Workhorse Dev"/);
  assert.match(main, /app\.isPackaged \? WORKHORSE_USER_DATA_DIR : WORKHORSE_DEV_USER_DATA_DIR/);
  assert.match(main, /app\.setPath\("userData"/);
  assert.equal(selectSurface({ panel: "settings", hasProject: true, hasSession: true }), "settings");
  assert.equal(selectSurface({ panel: "add-bot", hasProject: true, hasSession: true }), "add-bot");
  assert.equal(titlebarLabel(null, null, "add-bot"), "Add a bot");
  assert.equal(selectSurface({ panel: null, hasProject: false, hasSession: false }), "welcome");
  assert.equal(selectSurface({ panel: null, hasProject: true, hasSession: false }), "project-home");
  assert.equal(selectSurface({ panel: null, hasProject: true, hasSession: true }), "session");
  assert.equal(selectSurface({ panel: null, hasProject: false, hasSession: true }), "session");

  assert.equal(titlebarLabel(null, null), "");
  assert.equal(titlebarLabel(null, "Loose chat"), "Loose chat");
  assert.equal(titlebarLabel("Alpha"), "Alpha");
  const titled = titlebarLabel("Alpha", "New chat");
  assert.equal(titled, "Alpha");
  assert.ok(!titled.includes("Go7 Workhorse"));
});

test("forkChat copies history through a turn into a new listed chat", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "first", createdAt: 1 },
    { id: "a1", role: "assistant", text: "one", createdAt: 2 },
    { id: "t1", role: "system", kind: "tool", text: "Read · completed", createdAt: 3 },
    { id: "u2", role: "user", text: "second", createdAt: 4 },
    { id: "a2", role: "assistant", text: "two", createdAt: 5 },
  ];
  assert.deepEqual(messagesThrough(messages, "u1")?.map((item) => item.id), ["u1"]);
  assert.deepEqual(messagesThrough(messages, "a1")?.map((item) => item.id), ["u1", "a1", "t1"]);
  const source: Session = {
    id: "sess_src",
    projectId: "proj_1",
    provider: "grok",
    model: "grok-4.6",
    effort: "high",
    title: "Login Fix",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    vendorSessionId: "keep-original",
    messages,
    contextUsed: 12000,
  };
  const forked = forkChat([source], "sess_src", "a1", "sess_fork");
  assert.ok(forked);
  assert.equal(forked.session.id, "sess_fork");
  assert.equal(forked.session.title, "Fork of Login Fix");
  assert.equal(forked.session.vendorSessionId, undefined);
  assert.equal(forked.session.messages.length, 3);
  assert.notEqual(forked.session.messages[0]?.id, "u1");
  assert.equal(forked.session.messages[0]?.text, "first");
  assert.equal(source.vendorSessionId, "keep-original");
  assert.equal(forkTitle("Fork of Login Fix"), "Fork of Login Fix");
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  assert.match(pane, /Copy/);
  assert.match(pane, /Fork/);
  const row = readFileSync(path.join(ROOT, "src", "ui", "ChatRow.tsx"), "utf8");
  assert.match(row, /Fork chat/);
});

test("rewindToUserMessage keeps earlier turns and drops everything after the edit", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "first", createdAt: 1 },
    { id: "a1", role: "assistant", text: "one", createdAt: 2 },
    { id: "u2", role: "user", text: "second", createdAt: 3 },
    { id: "a2", role: "assistant", text: "two", createdAt: 4 },
  ];
  const next = rewindToUserMessage(messages, "u2", "second edited");
  assert.ok(next);
  assert.equal(next.length, 3);
  assert.equal(next[0]?.text, "first");
  assert.equal(next[2]?.text, "second edited");
  assert.equal(rewindToUserMessage(messages, "a1", "nope"), null);
  assert.equal(rewindToUserMessage(messages, "u2", "   "), null);
  const session: Session = {
    id: "s",
    projectId: null,
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "t",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages,
    contextUsed: 0,
  };
  assert.equal(lastUserMessage(session)?.id, "u2");
  const points = parseRewindPoints({
    points: [
      { id: "p0", index: 0 },
      { id: "p1", turnIndex: 1 },
    ],
  });
  assert.deepEqual(points, [
    { id: "p0", index: 0 },
    { id: "p1", index: 1 },
  ]);
  const row = readFileSync(path.join(ROOT, "src", "ui", "ChatRow.tsx"), "utf8");
  assert.doesNotMatch(row, /Edit last prompt/);
  const turn = readFileSync(path.join(ROOT, "src", "ui", "UserTurn.tsx"), "utf8");
  assert.match(turn, /resendFrom/);
  const meter = readFileSync(path.join(ROOT, "src", "ui", "ModelMenu.tsx"), "utf8");
  assert.match(meter, /context-pop/);
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  assert.match(css, /\.context-pop\s*\{[\s\S]*position:\s*fixed/);
});

test("dropped images become ACP image blocks and stay on the user turn", () => {
  assert.equal(imageMime({ type: "image/png", name: "shot.png" }), "image/png");
  assert.equal(imageMime({ type: "text/plain", name: "note.txt" }), null);
  const images = normalizeImages([
    { id: "img1", name: "shot.png", mimeType: "image/png", data: "data:image/png;base64,abc123" },
  ]);
  assert.equal(images[0]?.data, "abc123");
  assert.deepEqual(buildAcpPrompt("what is this", images), [
    { type: "text", text: "what is this" },
    { type: "image", mimeType: "image/png", data: "abc123" },
  ]);
  assert.deepEqual(buildAcpPrompt("", images)[0], { type: "image", mimeType: "image/png", data: "abc123" });
  const files = normalizeImages([
    { id: "f1", name: "note.md", mimeType: "text/markdown", kind: "file", text: "# hello", data: "" },
  ]);
  assert.equal(files[0]?.kind, "file");
  assert.match(buildAcpPrompt("read this", files)[1]?.text ?? "", /note\.md/);
  assert.match(buildAcpPrompt("read this", files)[1]?.text ?? "", /# hello/);

  const message = normalizeMessage({
    id: "u",
    role: "user",
    text: "",
    images,
    createdAt: 1,
  });
  assert.equal(message?.text, "");
  assert.equal(message?.images?.[0]?.name, "shot.png");

  const composer = readFileSync(path.join(ROOT, "src", "ui", "Composer.tsx"), "utf8");
  assert.match(composer, /collectDroppedFiles/);
  assert.match(composer, /filesFromClipboard/);
  assert.match(composer, /readChatAttachment/);
  assert.match(composer, /collectDroppedFiles/);
  assert.match(composer, /Drop files or folders/);
  assert.equal(shouldSkipDropDir("node_modules"), true);
  assert.equal(shouldSkipDropDir(".git"), true);
  assert.equal(shouldSkipDropDir("src"), false);
  const grouped = groupAttachments([
    { id: "a", name: "SpaceProject/a.ts", mimeType: "text/plain", data: "", kind: "file", text: "a", folder: "SpaceProject" },
    { id: "b", name: "SpaceProject/b.ts", mimeType: "text/plain", data: "", kind: "file", text: "b", folder: "SpaceProject" },
    { id: "c", name: "solo.md", mimeType: "text/plain", data: "", kind: "file", text: "c" },
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0]?.type, "folder");
  if (grouped[0]?.type === "folder") {
    assert.equal(grouped[0].name, "SpaceProject");
    assert.equal(grouped[0].files.length, 2);
  }
  const dropRoot = mkdtempSync(path.join(os.tmpdir(), "workhorse-drop-"));
  try {
    mkdirSync(path.join(dropRoot, "src"));
    mkdirSync(path.join(dropRoot, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(dropRoot, "src", "note.md"), "# hi");
    writeFileSync(path.join(dropRoot, "node_modules", "pkg", "skip.js"), "nope");
    const listed = listDropFiles([dropRoot]);
    assert.ok(listed.some((item) => item.name.endsWith("src/note.md") && item.text?.includes("# hi")));
    assert.ok(!listed.some((item) => item.name.includes("node_modules")));
  } finally {
    rmSync(dropRoot, { recursive: true, force: true });
  }
  const turn = readFileSync(path.join(ROOT, "src", "ui", "UserTurn.tsx"), "utf8");
  assert.match(turn, /say-images/);
  assert.match(turn, /say-file/);
  const agent = readFileSync(path.join(ROOT, "electron", "grok-agent.ts"), "utf8");
  assert.match(agent, /buildAcpPrompt\(text, images\)/);
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /images,/);
  assert.match(store, /from "\.\/store-context"/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store-context.ts"), "utf8"), /createContext/);
  assert.match(readFileSync(path.join(ROOT, "src", "main.tsx"), "utf8"), /StoreProvider[\s\S]*ErrorBoundary/);
});

test("chat rename, move, archive, and delete", () => {
  const one: Session = {
    id: "sess_1",
    projectId: "proj_1",
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "New chat",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [],
    contextUsed: 0,
  };
  const two = { ...one, id: "sess_2", title: "Other" };
  const sessions = [one, two];

  const renamed = renameChat(sessions, "sess_1", "Login fix");
  assert.equal(renamed?.[0].title, "Login fix");
  assert.equal(renamed?.[0].titleLocked, true);
  assert.equal(renameChat(sessions, "sess_1", "  "), null);
  assert.equal(autoRenameChat(renamed!, "sess_1", "Should not win"), null);
  const autotitled = autoRenameChat(sessions, "sess_1", "Loaded.com Prices");
  assert.equal(autotitled?.[0].title, "Loaded.com Prices");
  assert.equal(autotitled?.[0].titleLocked, false);

  const moved = moveChat(sessions, "sess_1", "proj_2");
  assert.equal(moved?.[0].projectId, "proj_2");
  assert.equal(moveChat(sessions, "sess_1", "proj_1"), null);
  const loose: Session = { ...one, id: "sess_loose", projectId: null };
  assert.equal(canPlaceInProject(loose), true);
  assert.equal(canPlaceInProject({ ...loose, messages: [{ id: "u", role: "user", text: "hi", createdAt: 1 }] }), false);
  assert.equal(moveChat([loose], "sess_loose", "proj_1")?.[0].projectId, "proj_1");

  const archived = archiveChat(sessions, "sess_1", true, 99);
  assert.equal(archived?.[0].archivedAt, 99);
  const open = archiveChat(archived!, "sess_1", false);
  assert.equal(open?.[0].archivedAt, null);

  const deleted = deleteChat(sessions, "sess_2");
  assert.equal(deleted?.length, 1);
  assert.equal(deleted?.[0].id, "sess_1");
  assert.equal(deleteChat(sessions, "missing"), null);
  const parent: Session = { ...one, id: "sess_parent" };
  const child: Session = { ...one, id: "sess_child", parentId: "sess_parent", hidden: true };
  const removed = deleteChat([parent, child, sessions[1]], "sess_parent");
  assert.deepEqual(removed?.map((item) => item.id), ["sess_2"]);
  const crewParent: Session = {
    ...parent,
    messages: [
      {
        id: "sub",
        role: "system",
        kind: "subagent",
        text: "Worker",
        subagentSessionId: "sess_child",
        toolStatus: "completed",
        createdAt: 1,
      },
    ],
    lineup: {
      id: "lineup_x",
      folder: "D:\\x",
      startedAt: 1,
      rows: [{ childId: "sess_child", title: "Worker", slice: "Worker", folder: "D:\\x", vendor: "MiniMax", status: "completed", startedAt: 1 }],
    },
  };
  const workersGone = deleteWorkerChats([crewParent, child, sessions[1]], "sess_parent");
  assert.ok(workersGone);
  assert.ok(!workersGone.some((item) => item.id === "sess_child"));
  assert.ok(workersGone.some((item) => item.id === "sess_parent"));
  assert.equal(workersGone.find((item) => item.id === "sess_parent")?.lineup?.rows.length, 0);
  assert.equal(
    workersGone.find((item) => item.id === "sess_parent")?.messages.find((message) => message.id === "sub")?.toolStatus,
    "cancelled",
  );
  assert.equal(deleteWorkerChats([sessions[0], sessions[1]], "sess_parent"), null);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "ChatRow.tsx"), "utf8"), /Delete workers/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /deleteWorkers/);
});

test("in-chat subagents resolve vendors and keep a nested transcript", () => {
  assert.equal(resolveModelHint("OpenAI Terra")?.model, "gpt-5.6-terra");
  assert.equal(resolveModelHint("codex")?.provider, "codex");
  assert.equal(shouldSpawnInsteadOfAsk("Terra", []), true);
  assert.equal(shouldSpawnInsteadOfAsk("Test", [{ id: "t", title: "Test", projectId: null, projectName: null, provider: "codex", model: "gpt-5.6-sol", status: "idle", archived: false, preview: "", messageCount: 1 }]), false);
  const archivedSpawn = resolveSpawnSpec(
    { fromSessionId: "p", prompt: "ping", chat: "Old login notes" },
    [{ id: "sess_archived", title: "Old login notes", provider: "claude", model: "claude-opus-5", effort: "medium", archivedAt: 99 }],
    { provider: "grok", effort: "high" },
  );
  assert.notEqual(archivedSpawn.provider, "claude");
  assert.notEqual(archivedSpawn.title, "Old login notes");
  const selfMini = resolveSpawnSpec(
    { fromSessionId: "sess_mini", prompt: "review the campaign layer" },
    [],
    { provider: "custom", effort: "high", customBotId: "bot_minimax", model: "MiniMax-M3" },
    [{ id: "bot_minimax", name: "MiniMax", model: "MiniMax-M3" }],
  );
  assert.equal(selfMini.provider, "custom");
  assert.equal(selfMini.customBotId, "bot_minimax");
  assert.equal(selfMini.model, "MiniMax-M3");
  const spawned = resolveSpawnSpec(
    { fromSessionId: "p", prompt: "ping", chat: "OpenAI Terra", description: "Ask Terra" },
    [],
    { provider: "grok", effort: "high" },
  );
  assert.equal(spawned.provider, "codex");
  assert.equal(spawned.model, "gpt-5.6-terra");
  assert.equal(spawned.title, "Ask Terra");
  assert.match(formatSubagentPrompt("Grok chat", "hello"), /Grok chat/);
  const hidden = normalizeSession({
    id: "child",
    parentId: "parent",
    hidden: true,
    provider: "codex",
    model: "gpt-5.6-terra",
    messages: [
      { id: "u", role: "user", kind: "peer", fromTitle: "Grok chat", text: "hello", createdAt: 1 },
      { id: "a", role: "assistant", text: "pong", createdAt: 2 },
      { id: "mark", role: "system", kind: "subagent", text: "Codex", subagentSessionId: "child", createdAt: 1 },
    ],
  });
  assert.equal(hidden?.parentId, "parent");
  assert.equal(hidden?.hidden, true);
  assert.equal(hidden?.messages[2]?.kind, "subagent");
  assert.equal(isHiddenSession(hidden!), true);
  const listed = catalogSessions({
    sessions: [
      { id: "parent", title: "Main", provider: "grok", model: "grok-4.6", messages: [{ role: "user", text: "go" }] },
      { id: "child", title: "Ask Terra", parentId: "parent", hidden: true, provider: "codex", model: "gpt-5.6-terra", messages: [{ role: "user", text: "hello" }] },
    ],
  });
  assert.deepEqual(listed.map((item) => item.id), ["parent"]);
  const turns = subagentTurns(hidden, 0);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.fromTitle, "Grok chat");
  const marked = withSubagentStatus(
    [
      {
        ...hidden!,
        id: "parent",
        parentId: undefined,
        hidden: undefined,
        messages: [{ id: "mark", role: "system", kind: "subagent", text: "Codex", subagentSessionId: "child", createdAt: 1 }],
      },
    ],
    "child",
    "completed",
  );
  assert.equal(marked[0]?.messages[0]?.toolStatus, "completed");
  assert.deepEqual(descendantSessionIds([
    { id: "parent" },
    { id: "child", parentId: "parent" },
    { id: "grandchild", parentId: "child" },
    { id: "other" },
  ], "parent"), ["child", "grandchild"]);
  const interrupted = normalizeAgentRun({ status: "running", startedAt: 1, isolation: "worktree", tokenBudget: 500 });
  assert.equal(interrupted?.tokenBudget, 500);
  assert.equal(interrupted?.status, "failed");
  assert.match(interrupted?.error ?? "", /interrupted/);
  assert.deepEqual(overlappingAgentFiles([
    { id: "parent" },
    { id: "a", parentId: "parent", agentRun: { status: "completed", startedAt: 1, isolation: "shared", changedFiles: ["C:\\repo\\a.ts"] } },
    { id: "b", parentId: "parent", agentRun: { status: "running", startedAt: 2, isolation: "shared" } },
  ], "b", ["C:/repo/a.ts"]), ["C:\\repo\\a.ts"]);
});

test("Workhorse chat tools read as talking to another chat", () => {
  assert.equal(prettyToolTitle("workhorse_workhorse_ask_chat"), "Ask chat");
  assert.equal(prettyToolTitle("workhorse_read_chat"), "Read chat");
  assert.equal(permissionActionLabel("workhorse_workhorse_list_chats"), "list chats");
  assert.equal(
    formatPermissionDetail(
      '{"variant":"UseTool","tool_name":"workhorse_workhorse_list_chats","tool_input":{}}',
    ),
    "",
  );
  assert.equal(
    formatPermissionDetail(
      '{"variant":"UseTool","tool_name":"workhorse_ask_chat","tool_input":{"chat":"Walk Test","message":"ping"}}',
    ),
    "Walk Test · ping",
  );
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "PermissionBar.tsx"), "utf8"), /permissionActionLabel/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /permission-detail/);
  assert.equal(prettyToolStatus("updated"), "working");
  assert.equal(describePeerTool("workhorse_workhorse_ask_chat", "Test")?.title, "Asking Test");
  assert.equal(describePeerTool("Asking Test", "")?.kind, "ask");
  assert.equal(describePeerTool("workhorse_list_chats", ""), null);
  assert.equal(describePeerTool("Listing chats", ""), null);
  assert.equal(describePeerTool("workhorse_list_bots", ""), null);
  assert.equal(describePeerTool("workhorse_list_tools", ""), null);
  const talking = talkingToSummary([
    { id: "t", role: "system", kind: "tool", text: "Asking Test · working — Test", createdAt: 1 },
  ]);
  assert.equal(talking, "Talking to Test");
  assert.equal(
    talkingToSummary([
      { id: "l", role: "system", kind: "tool", text: "List chats · completed", createdAt: 1 },
      { id: "b", role: "system", kind: "tool", text: "List bots · completed", createdAt: 2 },
    ]),
    "",
  );
  const source: Session = {
    id: "sess_a",
    projectId: null,
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "Main",
    mode: "ask",
    sandbox: "off",
    status: "running",
    contextUsed: 0,
    messages: [
      { id: "u", role: "user", text: "ask test", createdAt: 1 },
      { id: "t", role: "system", kind: "tool", text: "Reading Test · working — Test", toolStatus: "updated", createdAt: 2 },
    ],
  };
  const target: Session = {
    ...source,
    id: "sess_b",
    title: "Test",
    status: "idle",
    messages: [{ id: "u2", role: "user", text: "hi", createdAt: 1 }],
  };
  const links = chatLinksFromSessions([source, target]);
  assert.equal(links.some((item) => item.sessionId === "sess_b" && item.kind === "reading"), true);

  const wassup: Session = {
    ...source,
    id: "wassup",
    title: "Wassup minimax",
    provider: "custom",
    model: "MiniMax-M3",
    messages: [
      { id: "u", role: "user", text: "call grok", createdAt: 1 },
      {
        id: "call",
        role: "system",
        kind: "tool",
        text: "Calling grok · working — grok",
        toolStatus: "running",
        createdAt: 2,
      },
    ],
  };
  const contact: Session = {
    ...source,
    id: "contact",
    title: "Contact the grok bot please just...",
    provider: "custom",
    model: "MiniMax-M3",
    status: "running",
    messages: [{ id: "u", role: "user", text: "Contact the grok bot please just say hi", createdAt: 1 }],
  };
  const falseCall = chatLinksFromSessions([wassup, contact]);
  assert.equal(
    falseCall.some((item) => item.sessionId === "contact"),
    false,
    "calling a vendor named grok must not label a chat whose title merely mentions grok",
  );
  assert.equal(findSessionForLink(
    [
      {
        id: "contact",
        title: "Contact the grok bot please just...",
        projectId: null,
        projectName: null,
        provider: "custom",
        model: "MiniMax-M3",
        status: "running",
        archived: false,
        preview: "",
        sidebar: "",
        messageCount: 1,
      },
    ],
    "grok",
  ), null);
  const asked: Session = {
    ...contact,
    messages: [{ id: "p", role: "user", kind: "peer", fromTitle: "Wassup minimax", text: "say hi", createdAt: 1 }],
  };
  const answering = chatLinksFromSessions([wassup, asked]);
  assert.equal(answering.some((item) => item.sessionId === asked.id && item.kind === "answering"), true);
});

const MODES: PermissionMode[] = ["ask", "accept-edits", "always-approve"];

for (const model of GROK_MODELS) {
  for (const effort of GROK_EFFORT_GATES) {
    for (const mode of MODES) {
      test(`grok launch ${model} ${effort} ${mode} uses grok agent stdio`, () => {
        const spec = buildGrokLaunchSpec({
          model,
          effort,
          cwd: ROOT,
          mode,
        });
        const spawned = grokSpawnArgs(spec);
        assert.equal(spec.command, "grok");
        assert.equal(spawned.command, "grok");
        assert.deepEqual(spawned.args, spec.argv);
        assert.equal(spawned.cwd, ROOT);
        assert.ok(spec.argv.includes("agent"));
        assert.equal(spec.argv.at(-1), "stdio");
        assert.equal(spec.argv[spec.argv.indexOf("--model") + 1], model);
        assert.equal(spec.argv[spec.argv.indexOf("--reasoning-effort") + 1], effort);
        assert.equal(spec.model, model);
        assert.equal(spec.effort, effort);
        assert.equal(spec.sessionParams.cwd, ROOT);
        assert.deepEqual(spec.sessionParams.mcpServers, []);
        assert.equal(spec.sessionParams._meta?.rules, WORKHORSE_SESSION_RULES);
        assert.equal(spec.sessionParams._meta?.goalMode, true);
        assert.ok(!/claude|codex|custom/i.test([spec.command, ...spec.argv].join(" ")));
        if (mode === "always-approve") {
          assert.equal(spec.alwaysApprove, true);
          assert.ok(spec.argv.includes("--always-approve"));
          assert.equal(spec.sessionParams._meta?.yoloMode, true);
        } else {
          assert.equal(spec.alwaysApprove, false);
          assert.ok(!spec.argv.includes("--always-approve"));
          assert.ok(!spec.sessionParams._meta?.yoloMode);
        }
        assert.equal(spec.argv[spec.argv.indexOf("--permission-mode") + 1], mode === "always-approve" ? "bypassPermissions" : mode === "accept-edits" ? "acceptEdits" : "default");
        if (mode === "accept-edits") {
          assert.ok(!spec.sessionParams._meta?.autoMode);
        }
      });
    }
  }
}

test("GrokSessionHost is the Electron spawn owner and does not call other vendors", () => {
  const host = new GrokSessionHost();
  assert.equal(typeof host.prompt, "function");
  assert.equal(typeof host.compact, "function");
  assert.equal(typeof host.answerPermission, "function");
  host.disposeAll();
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const agent = readFileSync(path.join(ROOT, "electron", "grok-agent.ts"), "utf8");
  assert.match(main, /new GrokSessionHost/);
  assert.match(main, /ipcMain\.handle\("grok:prompt"/);
  assert.match(main, /ipcMain\.handle\("grok:compact"/);
  assert.match(main, /startWorkhorseBridge/);
  assert.match(main, /grok:peer-ask/);
  assert.match(main, /spawnGrok|GrokSessionHost|grokHost\.prompt/);
  assert.doesNotMatch(main, /spawn\(["']claude|spawn\(["']codex/);
  assert.match(preload, /ipcRenderer\.invoke\("grok:prompt"/);
  assert.match(preload, /ipcRenderer\.invoke\("grok:compact"/);
  assert.doesNotMatch(preload, /spawn\(/);
  assert.match(store, /vendorSendTarget\(session\.provider\)/);
  assert.match(store, /grokPrompt/);
  assert.match(store, /Preview only/);
  const grokBranch = store.slice(store.indexOf("window.workhorse.grokPrompt"));
  assert.doesNotMatch(grokBranch.slice(0, grokBranch.indexOf("Preview only")), /Preview only/);
  assert.ok(store.indexOf('status: "running"') < store.lastIndexOf("grokPrompt"));
  assert.match(store, /Grok finished without a visible reply/);
  assert.match(agent, /spawnGrokProcess/);
  assert.match(agent, /buildGrokLaunchSpec/);
  assert.match(agent, /classifyAcpUpdate/);
  assert.match(agent, /withDeskToolEnv/);
});

test("vendor children get ripgrep on PATH and rg is not a write", () => {
  const userBin = path.join(os.tmpdir(), "workhorse-user-path", "tools");
  const fakeRg = path.join(userBin, "rg.exe");
  const fakeGit = path.join(userBin, "git.exe");
  const electronPath = "C:\\Windows\\system32";
  // A Windows machine: the .exe name resolves and Path mirrors PATH.
  const found = resolveRipgrep({ PATH: electronPath }, (file) => file === fakeRg, [userBin], userBin, "win32");
  assert.equal(found, fakeRg);
  assert.equal(
    resolveDeskBinary(["git.exe"], { PATH: electronPath }, (file) => file === fakeGit, [userBin], userBin),
    fakeGit,
  );
  const merged = deskPath(electronPath, { PATH: electronPath }, [userBin], userBin, "win32");
  assert.ok(merged.toLowerCase().includes(userBin.toLowerCase()));
  assert.ok(merged.toLowerCase().includes("windows\\system32"));
  assert.ok(merged.toLowerCase().indexOf(userBin.toLowerCase()) < merged.toLowerCase().indexOf("windows\\system32"));
  const env = withDeskToolEnv(
    { PATH: electronPath },
    { extra: [userBin], persistedPath: userBin, existsSync: (file) => file === fakeRg || file === fakeGit, platform: "win32" },
  );
  assert.ok((env.PATH ?? "").toLowerCase().includes(userBin.toLowerCase()));
  assert.equal(env.Path, env.PATH);
  assert.equal(env.RIPGREP, fakeRg);
  assert.equal(env.GIT, fakeGit);

  // A Mac machine: the same lookups take the bare name and never mirror Path.
  const macToolsDir = path.join(os.tmpdir(), "workhorse-user-path", "mac-tools");
  const macRg = path.join(macToolsDir, "rg");
  const macGit = path.join(macToolsDir, "git");
  assert.equal(
    resolveRipgrep({ PATH: "/usr/bin" }, (file) => file === macRg, [macToolsDir], macToolsDir, "darwin"),
    macRg,
  );
  assert.equal(
    resolveRipgrep(
      { PATH: "/usr/bin" },
      (file) => file === path.join(macToolsDir, "rg.exe"),
      [macToolsDir],
      macToolsDir,
      "darwin",
    ),
    null,
  );
  const macEnv = withDeskToolEnv(
    { PATH: "/usr/bin" },
    {
      extra: [macToolsDir],
      persistedPath: macToolsDir,
      existsSync: (file) => file === macRg || file === macGit,
      platform: "darwin",
    },
  );
  assert.equal(macEnv.RIPGREP, macRg);
  assert.equal(macEnv.GIT, macGit);
  assert.equal(macEnv.Path, undefined);

  assert.match(parseRegPathValue("    Path    REG_EXPAND_SZ    C:\\Users\\me\\bin;%USERPROFILE%\\.cargo\\bin"), /C:\\Users\\me\\bin/);
  assert.equal(readWindowsPersistedPath(() => "D:\\user-tools", "win32"), "D:\\user-tools");
  assert.equal(readWindowsPersistedPath(() => "D:\\user-tools", "darwin"), "");
  const bin = workhorseToolBin();
  assert.match(bin, /Go7 Workhorse/);
  assert.match(readFileSync(path.join(ROOT, "electron", "codex-launch.ts"), "utf8"), /withDeskToolEnv/);
  assert.match(readFileSync(path.join(ROOT, "electron", "claude-launch.ts"), "utf8"), /withDeskToolEnv/);
  assert.match(readFileSync(path.join(ROOT, "electron", "grok-agent.ts"), "utf8"), /withDeskToolEnv/);
  assert.match(readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8"), /ensureDeskRipgrep/);
  const wingetPkg = "BurntSushi.ripgrep.MSVC_winget";
  const discovered = discoverRipgrepDirs(
    "C:\\Users\\me",
    { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    (file) => file.endsWith(`${path.sep}ripgrep-15${path.sep}rg.exe`),
    (dir) => {
      if (dir.endsWith("Packages")) return [wingetPkg];
      if (dir.endsWith(wingetPkg)) return ["ripgrep-15"];
      if (dir.includes("OpenAI") && dir.endsWith("bin")) return [];
      return [];
    },
    "win32",
  );
  assert.ok(discovered.some((dir) => dir.toLowerCase().endsWith(`${wingetPkg}\\ripgrep-15`.toLowerCase()) || dir.toLowerCase().endsWith(`${wingetPkg}/ripgrep-15`.toLowerCase()) || dir.replace(/\\/g, "/").endsWith(`${wingetPkg}/ripgrep-15`)));
  const copied: string[] = [];
  const ensured = ensureDeskRipgrep({
    home: "C:\\Users\\me",
    env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", PATH: electronPath },
    platform: "win32",
    extra: [userBin],
    existsSync: (file) => file === fakeRg || file === fakeGit,
    mkdirSync: () => undefined,
    copyFileSync: (_src, dest) => {
      copied.push(dest);
    },
  });
  assert.equal(ensured?.source, fakeRg);
  assert.ok(copied.some((file) => /\\?\.grok\\bin\\rg\.exe$/i.test(file) || file.replace(/\\/g, "/").endsWith(".grok/bin/rg.exe")));
  // path.join uses the host separator, so compare on a normalised copy.
  // These must hold when the suite runs on Windows too.
  const macBin = workhorseToolBin("/Users/me", {}, "darwin");
  assert.match(macBin.replace(/\\/g, "/"), /Library\/Application Support\/Go7 Workhorse\/bin$/);
  assert.doesNotMatch(macBin, /AppData/);
  const macDirs = extraDeskDirs("/Users/me", {}, "darwin").join("\n");
  assert.match(macDirs, /\/opt\/homebrew\/bin/);
  assert.match(macDirs, /\/usr\/local\/bin/);
  assert.doesNotMatch(macDirs, /Program Files/);
  assert.doesNotMatch(macDirs, /WinGet/);
  assert.doesNotMatch(macDirs, /scoop/);
  assert.doesNotMatch(macDirs, /AppData/);
  const linuxBin = workhorseToolBin("/home/me", {}, "linux");
  assert.match(linuxBin.replace(/\\/g, "/"), /\.local\/share\/Go7 Workhorse\/bin$/);
});

test("pickPermissionOptionId maps Workhorse answers onto ACP option kinds", () => {
  const options = [
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "allow-always", kind: "allow_always" },
    { optionId: "reject-once", kind: "reject_once" },
  ];
  assert.equal(pickPermissionOptionId(options, "once"), "allow-once");
  assert.equal(pickPermissionOptionId(options, "session"), "allow-always");
  assert.equal(pickPermissionOptionId(options, "deny"), "reject-once");
});

test("ACP text extractors walk nested content and update kinds", () => {
  assert.equal(textFromContent([{ type: "text", text: "WORK" }, { text: "HORSE" }]), "WORKHORSE");
  assert.equal(extractUpdateText({ content: { type: "text", text: "OK" } }), "OK");
  assert.equal(updateKind({ sessionUpdate: "agent_message_chunk" }), "agent_message_chunk");
  assert.equal(updateKind({ kind: "agent_message" }), "agent_message");
  assert.equal(classifyAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "Hi" } }).kind, "message");
  assert.equal(classifyAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { text: "Hmm" } }).kind, "thought");
  assert.equal(
    classifyAcpUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "thinking", thinking: "Plan the reply" },
    }).kind,
    "thought",
  );
  assert.equal(extractUpdateText({ content: { type: "thinking", thinking: "Plan the reply" } }), "Plan the reply");
  assert.equal(
    classifyAcpUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "reasoning", text: "I'll list the chats" },
    }).kind,
    "thought",
  );
  assert.equal(
    classifyAcpUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "I'll scan the sidebar" },
      _meta: { codex: { phase: "commentary" } },
    }).kind,
    "thought",
  );
  assert.equal(
    classifyAcpUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "There are more chats below those." },
      _meta: { codex: { phase: "final_answer" } },
    }).kind,
    "message",
  );
  assert.equal(
    classifyAcpUpdate({ sessionUpdate: "turn_completed", usage: { inputTokens: 3, outputTokens: 2 } }).kind,
    "usage",
  );
  const titled = classifyAcpUpdate({ sessionUpdate: "session_info_update", title: "Loaded.com Darkest Dungeon" });
  assert.equal(titled.kind, "title");
  if (titled.kind !== "title") throw new Error("expected title");
  assert.equal(titled.title, "Loaded.com Darkest Dungeon");
  assert.equal(extractSessionTitle({ sessionUpdate: "session_info_update", title: "  Fix login  " }), "Fix login");
  assert.equal(isAcpSessionUpdateMethod("session/update"), true);
  assert.equal(isAcpSessionUpdateMethod("_x.ai/session/update"), true);
  assert.equal(isAcpSessionUpdateMethod("_x.ai/session_notification"), true);
  assert.equal(isAcpSessionUpdateMethod("_x.ai/queue/changed"), false);
});

test("consumeAcpMessages reads NDJSON and Content-Length frames", () => {
  const ndjson = `${JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Hi" } } },
  })}\n`;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "There" } } },
  });
  const framed = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
  const parsed = consumeAcpMessages(ndjson + framed);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.rest, "");
  assert.equal(extractUpdateText((parsed.messages[0].params as { update: Record<string, unknown> }).update), "Hi");
  assert.equal(extractUpdateText((parsed.messages[1].params as { update: Record<string, unknown> }).update), "There");
  const unicodeBody = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "I’m Grok" } } },
  });
  const unicodeFramed = `Content-Length: ${Buffer.byteLength(unicodeBody, "utf8")}\r\n\r\n${unicodeBody}`;
  const unicodeParsed = consumeAcpMessages(unicodeFramed);
  assert.equal(unicodeParsed.messages.length, 1);
  assert.equal(
    extractUpdateText((unicodeParsed.messages[0].params as { update: Record<string, unknown> }).update),
    "I’m Grok",
  );
});

test("parseGrokUsage reads ACP usage_update and token fields", () => {
  const usage = parseGrokUsage({
    input_tokens: 12,
    output_tokens: 4,
    cache_read_input_tokens: 8,
    cache_creation_input_tokens: 1,
    cost: { amount: 0.02, currency: "USD" },
  });
  assert.deepEqual(usage, {
    inputTokens: 12,
    outputTokens: 4,
    cacheReadTokens: 8,
    cacheWriteTokens: 1,
    costUsd: 0.02,
  });
  const fromUsed = parseGrokUsage({ used: 53000, cost: { amount: 0.045, currency: "USD" } });
  assert.equal(fromUsed?.inputTokens, 0);
  assert.equal(fromUsed?.outputTokens, 0);
  assert.equal(fromUsed?.contextUsed, 53000);
  assert.equal(fromUsed?.costUsd, 0.045);
  const billedWithUsed = parseGrokUsage({
    used: 512250,
    input_tokens: 17050,
    output_tokens: 2040,
    cache_read_input_tokens: 96768,
  });
  assert.equal(billedWithUsed?.inputTokens, 17050);
  assert.equal(billedWithUsed?.contextUsed, 512250);
  const contextMeter = classifyAcpUpdate({ sessionUpdate: "usage_update", used: 525000, size: 2000000 });
  assert.equal(contextMeter.kind, "usage");
  if (contextMeter.kind !== "usage") throw new Error("expected usage");
  assert.equal(contextMeter.usage.inputTokens, 0);
  assert.equal(contextMeter.usage.contextUsed, 525000);
});

test("collapseInflatedUsage drops used-as-input snapshots and duplicate finals", () => {
  const at = Date.now();
  const row = (
    id: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    when = at,
  ) => ({
    id,
    at: when,
    provider: "grok" as const,
    model: "grok-4.6",
    sessionId: "sess_search",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
  });
  const cleaned = collapseInflatedUsage([
    row("dup_used_1", 512250, 6110, 0),
    row("dup_used_2", 512250, 6110, 0),
    row("last_request", 17050, 2040, 96768),
    row("mid_request", 4573, 1590, 92288, at - 30_000),
  ]);
  assert.deepEqual(
    cleaned.map((event) => event.id),
    ["last_request", "mid_request"],
  );
  const totals = rollup(cleaned);
  assert.equal(totals.inputTokens, 21623);
  assert.equal(totals.outputTokens, 3630);

  const summed = addUsageDraft(
    {
      provider: "grok",
      model: "grok-4.6",
      inputTokens: 17050,
      outputTokens: 2040,
      cacheReadTokens: 96768,
    },
    {
      provider: "grok",
      model: "grok-4.6",
      inputTokens: 4573,
      outputTokens: 1590,
      cacheReadTokens: 92288,
    },
  );
  assert.equal(summed.inputTokens, 21623);
  assert.equal(summed.outputTokens, 3630);

  const hydrated = normalizeUsage([
    row("dup_used_1", 512250, 6110, 0),
    row("dup_used_2", 512250, 6110, 0),
    row("last_request", 17050, 2040, 96768),
  ]);
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0].inputTokens, 17050);
  assert.equal(eventTotal(hydrated[0]), 19090);
  assert.equal(contextFromEvent(hydrated[0]), 113818);

  const repaired = applyUsageContext(
    [
      {
        id: "sess_search",
        projectId: null,
        provider: "grok",
        model: "grok-4.6",
        effort: "medium",
        title: "Search",
        mode: "ask",
        sandbox: "off",
        status: "idle",
        messages: [],
        contextUsed: 512250,
      },
    ],
    hydrated,
  );
  assert.equal(repaired[0].contextUsed, 113818);

  const authoritative = applyUsageContext(
    [{ ...repaired[0], contextUsed: 4_000 }],
    [{ ...hydrated[0], contextUsed: 150_575 }],
  );
  assert.equal(authoritative[0].contextUsed, 150_575);

  const normalizedContext = normalizeUsage([{ ...hydrated[0], id: "with_context", contextUsed: 150_575 }]);
  assert.equal(normalizedContext[0].contextUsed, 150_575);

  assert.equal(occupancyFromUsage({ contextUsed: 70_000, inputTokens: 17_050, cacheReadTokens: 510_000 }, 500_000), 70_000);
  assert.equal(occupancyFromUsage({ contextUsed: 527_934, inputTokens: 17_050, cacheReadTokens: 510_000 }, 500_000), undefined);
  assert.equal(occupancyFromUsage({ inputTokens: 17_050, cacheReadTokens: 96_768 }, 500_000), 113_818);

  const over = applyUsageContext(
    [
      {
        id: "sess_over",
        projectId: null,
        provider: "grok",
        model: "grok-4.6",
        effort: "medium",
        title: "Over",
        mode: "ask",
        sandbox: "off",
        status: "idle",
        messages: [],
        contextUsed: 527_934,
      },
    ],
    [
      {
        id: "use_over",
        at: Date.now(),
        provider: "grok",
        model: "grok-4.6",
        inputTokens: 17_050,
        outputTokens: 0,
        cacheReadTokens: 510_884,
        cacheWriteTokens: 0,
      },
    ],
  );
  assert.equal(over[0].contextUsed, 0);
});

test("parseGrokUsage splits Grok turn_completed inclusive inputTokens", () => {
  const turn = parseGrokUsage({
    sessionUpdate: "turn_completed",
    usage: {
      inputTokens: 527934,
      outputTokens: 5202,
      cachedReadTokens: 461440,
      cacheCreationTokens: 0,
    },
  });
  assert.equal(turn?.inputTokens, 66494);
  assert.equal(turn?.outputTokens, 5202);
  assert.equal(turn?.cacheReadTokens, 461440);
  assert.equal(turn?.cacheWriteTokens, 0);

  const exclusive = parseGrokUsage({
    input_tokens: 17050,
    output_tokens: 2040,
    cache_read_input_tokens: 96768,
  });
  assert.equal(exclusive?.inputTokens, 17050);
  assert.equal(exclusive?.cacheReadTokens, 96768);

  const classified = classifyAcpUpdate({
    sessionUpdate: "turn_completed",
    usage: { inputTokens: 96114, outputTokens: 1660, cachedReadTokens: 67456 },
  });
  assert.equal(classified.kind, "usage");
  if (classified.kind !== "usage") throw new Error("expected usage");
  assert.equal(classified.usage.inputTokens, 28658);
  assert.equal(classified.usage.cacheReadTokens, 67456);
});

test("MiniMax usage row bills the turn total while the context ring keeps last occupancy", () => {
  const stored = {
    id: "use_minimax_harness",
    at: 1,
    provider: "custom" as const,
    model: "MiniMax-M3",
    inputTokens: 81_929,
    outputTokens: 8_196,
    cacheReadTokens: 1_089_280,
    cacheWriteTokens: 0,
    contextUsed: 24_141,
  };
  assert.equal(eventTotal(stored), stored.inputTokens + stored.outputTokens + stored.cacheWriteTokens);
  assert.equal(occupancyFromUsage(stored, 1_000_000), 24_141);
  const ring = estimateChatContext({
    contextUsed: 24_141,
    windowSize: 1_000_000,
    messages: [
      { text: "a".repeat(8_000) },
      { text: "b".repeat(8_564) },
    ],
  });
  assert.equal(ring.used, 24_141);
  assert.ok(ring.used !== eventTotal(stored));

  const firstHttp = { provider: "custom" as const, model: "MiniMax-M3", inputTokens: 2766, outputTokens: 43, cacheReadTokens: 128, cacheWriteTokens: 0 };
  const secondHttp = { provider: "custom" as const, model: "MiniMax-M3", inputTokens: 211, outputTokens: 445, cacheReadTokens: 2816, cacheWriteTokens: 0 };
  const folded = finalizeTurnUsage([firstHttp, secondHttp]);
  assert.equal(folded.inputTokens, firstHttp.inputTokens + secondHttp.inputTokens);
  assert.equal(folded.outputTokens, firstHttp.outputTokens + secondHttp.outputTokens);
  const lastOccupancy = occupancyFromUsage(secondHttp, 1_000_000);
  const billed = eventTotal({ ...folded, id: "fold", at: 1, cacheWriteTokens: folded.cacheWriteTokens ?? 0 });
  assert.ok(lastOccupancy !== undefined);
  assert.ok(billed !== lastOccupancy);
});

test("mergeUsageDraft prefers a running turn total over summing it", () => {
  const lastRequest = {
    provider: "grok" as const,
    model: "grok-4.6",
    inputTokens: 66494,
    outputTokens: 5202,
    cacheReadTokens: 461440,
  };
  const sameAgain = mergeUsageDraft(lastRequest, { ...lastRequest });
  assert.equal(sameAgain.inputTokens, 66494);
  assert.equal(sameAgain.outputTokens, 5202);
  assert.equal(sameAgain.cacheReadTokens, 461440);

  const turnTotal = mergeUsageDraft(
    { provider: "grok", model: "grok-4.6", inputTokens: 5000, outputTokens: 400, cacheReadTokens: 50_000 },
    { provider: "grok", model: "grok-4.6", inputTokens: 66494, outputTokens: 5202, cacheReadTokens: 461440 },
  );
  assert.equal(turnTotal.inputTokens, 66494);
  assert.equal(turnTotal.outputTokens, 5202);
  assert.equal(turnTotal.cacheReadTokens, 461440);

  const summed = mergeUsageDraft(
    { provider: "grok", model: "grok-4.6", inputTokens: 17050, outputTokens: 2040, cacheReadTokens: 96768 },
    { provider: "grok", model: "grok-4.6", inputTokens: 4573, outputTokens: 1590, cacheReadTokens: 92288 },
  );
  assert.equal(summed.inputTokens, 21623);
  assert.equal(summed.outputTokens, 3630);
  assert.equal(summed.cacheReadTokens, 189056);

  const folded = finalizeTurnUsage([
    { provider: "grok", model: "grok-4.6", inputTokens: 17050, outputTokens: 2040, cacheReadTokens: 96768 },
    { provider: "grok", model: "grok-4.6", inputTokens: 4573, outputTokens: 1590, cacheReadTokens: 92288 },
    { provider: "grok", model: "grok-4.6", inputTokens: 21623, outputTokens: 3630, cacheReadTokens: 189056 },
  ]);
  assert.equal(folded.inputTokens, 21623);
  assert.equal(folded.outputTokens, 3630);
  assert.equal(folded.cacheReadTokens, 189056);
});

test("repairInflatedTurn undoes inclusive+exclusive double counts", () => {
  const repaired = repairInflatedTurn({
    inputTokens: 594428,
    outputTokens: 10404,
    cacheReadTokens: 461440,
  });
  assert.equal(repaired.inputTokens, 66494);
  assert.equal(repaired.outputTokens, 5202);
  assert.equal(repaired.cacheReadTokens, 461440);

  const uncachedFirst = repairInflatedTurn({
    inputTokens: 16082,
    outputTokens: 57,
    cacheReadTokens: 1408,
  });
  assert.equal(uncachedFirst.inputTokens, 16082);
  assert.equal(uncachedFirst.outputTokens, 57);

  const alreadyExclusive = repairInflatedTurn({
    inputTokens: 17050,
    outputTokens: 2040,
    cacheReadTokens: 96768,
  });
  assert.equal(alreadyExclusive.inputTokens, 17050);

  const hydrated = normalizeUsage([
    {
      id: "use_inflated",
      at: Date.now(),
      provider: "grok",
      model: "grok-4.6",
      inputTokens: 917770,
      outputTokens: 13356,
      cacheReadTokens: 693248,
      cacheWriteTokens: 0,
    },
  ]);
  assert.equal(hydrated[0].inputTokens, 112261);
  assert.equal(hydrated[0].outputTokens, 6678);
});

const EFFORT_WIRE: Record<(typeof GROK_EFFORT_INPUTS)[number], string> = {
  low: "low",
  medium: "medium",
  high: "high",
  extra: "xhigh",
  xhigh: "xhigh",
};

for (const input of GROK_EFFORT_INPUTS) {
  test(`shipped effort resolver maps ${input} to --reasoning-effort ${EFFORT_WIRE[input]}`, () => {
    const mapped = resolveGrokEffort(input);
    assert.equal(mapped, EFFORT_WIRE[input]);
    const spec = buildGrokLaunchSpec({
      model: "grok-4.6",
      effort: input,
      cwd: ROOT,
      mode: "ask",
    });
    assert.ok(spec.argv.includes("--reasoning-effort"));
    assert.equal(spec.argv[spec.argv.indexOf("--reasoning-effort") + 1], mapped);
    assert.equal(spec.effort, mapped);
  });
}

test("parseEffort and COMMANDS ship extra as xhigh and include /compact", () => {
  assert.equal(parseEffort("extra"), "xhigh");
  assert.equal(parseEffort("xhigh"), "xhigh");
  assert.equal(parseEffort("low"), "low");
  assert.equal(parseEffort("max"), "max");
  assert.equal(parseEffort("ultra"), "ultra");
  assert.equal(effortsFor("grok", "grok-4.6").map((item) => item.id).join(","), "low,medium,high,xhigh");
  assert.deepEqual(
    effortsFor("custom", "MiniMax-M3").map((item) => item.id),
    ["off", "minimal", "low", "medium", "high"],
  );
  assert.deepEqual(
    effortsFor("custom", "MiniMax-M2.7").map((item) => item.id),
    ["off", "minimal", "low", "medium", "high"],
  );
  assert.ok(effortsFor("codex", "gpt-5.6-sol").some((item) => item.id === "ultra"));
  assert.ok(COMMANDS.some((command) => command.name === "/compact" && command.run === "compact"));
  assert.ok(COMMANDS.some((command) => command.name === "/effort" && command.run === "effort"));
  assert.ok(filterCommands("/compact").some((command) => command.run === "compact"));
});

test("classifyAcpUpdate extracts tool_call and tool_call_update title status detail", () => {
  const started = classifyAcpUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call_1",
    title: "Read",
    status: "in_progress",
    rawInput: { path: "src/main.rs" },
  });
  assert.equal(started.kind, "tool");
  if (started.kind !== "tool") throw new Error("expected tool");
  assert.equal(started.tool.toolCallId, "call_1");
  assert.equal(started.tool.title, "Read");
  assert.equal(started.tool.status, "in_progress");
  assert.match(started.tool.detail, /src\/main\.rs/);
  const absWrite = extractToolEvent({
    sessionUpdate: "tool_call",
    toolCallId: "call_abs",
    title: "Edit",
    status: "completed",
    rawInput: { path: "/Users/venomspike/workspace/Go7-Workhorse-github/electron/main.ts" },
  });
  assert.equal(absWrite?.detail, "/Users/venomspike/workspace/Go7-Workhorse-github/electron/main.ts");
  assert.equal(shortDisplayPath(absWrite?.detail ?? ""), "electron/main.ts");
  assert.match(
    collapseToolText(`Edit · completed — ${absWrite?.detail ?? ""}`, "completed"),
    /Edit · completed — electron\/main\.ts/,
  );

  const dumped = extractToolEvent({
    sessionUpdate: "tool_call_update",
    toolCallId: "call_1",
    status: "completed",
    rawOutput: { type: "ReadFile", content: "Read c:\\\\docs\\\\guide.md — completed — {\"type\":\"FileContent\"" },
  });
  assert.ok(dumped);
  assert.equal(dumped?.toolCallId, "call_1");
  assert.equal(dumped?.status, "completed");
  assert.equal(dumped?.detail, "");

  const rows = upsertToolMessage(
    upsertToolMessage([], started.tool, 1),
    { toolCallId: "call_1", title: "", status: dumped!.status, detail: dumped!.detail },
    2,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "tool");
  assert.equal(rows[0].text, "Read · completed — src/main.rs");
  assert.match(formatToolLine("Read", "in_progress", "src/main.rs"), /Read · in_progress — src\/main\.rs/);
  assert.equal(formatToolLine("Read", "completed", "a".repeat(400)), "Read · completed");
  assert.match(collapseToolText(`Read · completed — ${"x".repeat(500)}`, "completed"), /^Read · completed$/);
  assert.match(
    collapseToolText("Write `C:\\\\Users\\\\lgovo\\\\Projects\\\\Go7-Workhorse\\\\WALK-TEST-EDIT.md` · completed", "completed"),
    /WALK-TEST-EDIT\.md/,
  );
});

test("compact and auto-compact notifications update reported contextUsed", () => {
  const auto = extractCompactEvent({
    sessionUpdate: "auto_compact_completed",
    tokens_before: 40000,
    tokens_after: 12000,
  });
  assert.ok(auto);
  assert.equal(auto?.trigger, "auto");
  assert.equal(auto?.tokensBefore, 40000);
  assert.equal(auto?.tokensAfter, 12000);
  assert.equal(auto?.contextUsed, 12000);
  assert.equal(applyCompactUsage(40000, auto!), 12000);

  const classified = classifyAcpUpdate({
    sessionUpdate: "compact_boundary",
    usage: { input_tokens: 8000, cache_read_input_tokens: 100 },
  });
  assert.equal(classified.kind, "compact");
  if (classified.kind !== "compact") throw new Error("expected compact");
  assert.equal(applyCompactUsage(50000, classified.compact), 8100);

  const rows = upsertCompactMessage([], { trigger: "manual", tokensBefore: 20000, tokensAfter: 5000, contextUsed: 5000 }, 3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "compact");
  assert.match(rows[0].text, /20/);
  assert.match(rows[0].text, /5/);
});

test("chat markdown turns status dumps into facts and renders inline marks", () => {
  const inline = parseInline("I’m **Grok 4.6** on `C:\\\\Workhorse`");
  assert.deepEqual(inline.map((part) => part.type), ["text", "strong", "text", "code"]);
  assert.equal(parseFactLine("- **Model:** Grok 4.6 (Grok Build TUI)")?.label, "Model");
  assert.equal(parseFactLine("- **Workspace:** `C:\\\\Users\\\\lgovo\\\\Projects\\\\Go7-Workhorse`")?.value, "C:\\\\Users\\\\lgovo\\\\Projects\\\\Go7-Workhorse");

  const blocks = parseChatMarkdown(
    [
      "Nothing is running in the background from this session.",
      "",
      "- **Model:** Grok 4.6 (Grok Build TUI)",
      "- **Workspace:** `C:\\\\Users\\\\lgovo\\\\Projects\\\\Go7-Workhorse`",
      "- **Background commands / monitors / subagents:** none",
      "",
      "I’m idle and waiting on your next task.",
    ].join("\n"),
  );
  assert.equal(blocks[0].type, "p");
  assert.equal(blocks[1].type, "facts");
  if (blocks[1].type !== "facts") throw new Error("expected facts");
  assert.equal(blocks[1].rows.length, 3);
  assert.equal(blocks[1].rows[0].label, "Model");
  assert.equal(blocks[2].type, "p");

  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  assert.match(pane, /MessageBody/);
  assert.doesNotMatch(pane, /Grok · /);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.turn\.user \.say/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "MessageBody.tsx"), "utf8"), /part\.type === "em"/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "MessageBody.tsx"), "utf8"), /parseInline\(row\.value\)/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8"), /followBottom/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "MessageBody.tsx"), "utf8"), /CodeBlock/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "MessageBody.tsx"), "utf8"), /md-pre-copy/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "Composer.tsx"), "utf8"), /wrapMarkdown/);

  const asked = peelAskMarkup(
    [
      "Want me to spawn a custom agent?",
      "<Ask> <question>How do you want to proceed with Grok?</question> <options> <item><label>Use native Grok</label> <description>Flip Grok on in Settings.</description> </item>",
      "<item><label>Wait</label><description>Enable Grok yourself.</description></item> </options> </Ask>",
    ].join(" "),
  );
  assert.doesNotMatch(asked, /<Ask>|<question>|<options>|<item>|<label>/i);
  assert.match(asked, /How do you want to proceed with Grok\?/);
  assert.match(asked, /Use native Grok/);
  assert.match(asked, /Flip Grok on in Settings/);
  const askedBlocks = parseChatMarkdown(asked);
  assert.ok(askedBlocks.some((block) => block.type === "ol" || block.type === "p"));
  const leftover = peelAskMarkup(
    "1. label>Use native Grok (recommend) Flip Grok on. — Flip Grok on.\n1. label>Wait — I'll enable Grok manually You'll enable Grok.",
  );
  assert.doesNotMatch(leftover, /label>/i);
  assert.match(leftover, /Use native Grok/);
  assert.match(leftover, /Wait/);

  const italic = parseInline("say *hello* now");
  assert.deepEqual(italic.map((part) => part.type), ["text", "em", "text"]);
  const exactIdentifier = parseInline("MINIMAX_M3_LIVE_OK");
  assert.deepEqual(exactIdentifier, [{ type: "text", text: "MINIMAX_M3_LIVE_OK" }]);
  assert.equal(mergeStreamedText("MiniMax is ready.", "MiniMax is ready."), "MiniMax is ready.");
  assert.equal(mergeStreamedText("MiniMax is", "MiniMax is ready."), "MiniMax is ready.");
  assert.equal(mergeStreamedText("agent-to-", "to-agent"), "agent-to-agent");
  const link = parseInline("see [Workhorse](https://example.com)");
  assert.equal(link[1]?.type, "link");
  if (link[1].type !== "link") throw new Error("expected link");
  assert.equal(link[1].href, "https://example.com");
  assert.equal(safeExternalUrl("https://platform.openai.com/docs"), "https://platform.openai.com/docs");
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("file:///etc/passwd"), null);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "MessageBody.tsx"), "utf8"), /openWebUrl/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "MessageBody.tsx"), "utf8"), /md-file/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8"), /FileOpenProvider/);
  assert.match(readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8"), /setWindowOpenHandler/);
  assert.match(readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8"), /shell\.openExternal/);
  assert.match(readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8"), /shell:open/);
  const picture = parseInline("![A moonlit workhorse](https://imagine.x.ai/out.png)");
  assert.equal(picture[0]?.type, "image");
  const embed = parseChatMarkdown("[A moonlit workhorse in a foggy field](C:\\\\tmp\\\\out.png)");
  assert.equal(embed[0]?.type, "image");
  if (embed[0].type !== "image") throw new Error("expected image");
  assert.equal(embed[0].alt, "A moonlit workhorse in a foggy field");
  const relative = parseChatMarkdown("Here you go.\n\n![A wild neon jellyfish-city scene](images/1.jpg)\n");
  assert.equal(relative.some((block) => block.type === "image"), true);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "MessageBody.tsx"), "utf8"), /md-image/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "MessageBody.tsx"), "utf8"), /ImageZoom/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "ImageZoom.tsx"), "utf8"), /image-zoom/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "ImageZoom.tsx"), "utf8"), /originFromClick/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "ImageZoom.tsx"), "utf8"), /transformOrigin/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.image-zoom/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8"), /vendorSessionId/);
  assert.match(readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8"), /mediaFileCandidates/);
  const guessed = mediaFileCandidates("images/1.jpg", {
    cwd: "C:\\Users\\lgovo\\Projects\\Go7-Workhorse",
    vendorSessionId: "019ff9cd-bab5-7b22-94ee-aa6a8fbd4b3b",
    home: "C:\\Users\\lgovo",
  });
  assert.ok(
    guessed.some(
      (item) =>
        item.includes("019ff9cd-bab5-7b22-94ee-aa6a8fbd4b3b") &&
        (item.endsWith("images\\1.jpg") || item.endsWith("images/1.jpg")),
    ),
  );
  assert.match(textFromContent({ type: "image", mimeType: "image/png", data: "abc", name: "shot" }), /!\[shot\]\(data:image\/png;base64,abc\)/);

  assert.equal(
    unsquashSentences("Yes. I'll load the image skill and generate a sample so you can see the result.Yes. Here's a sample:"),
    "Yes. I'll load the image skill and generate a sample so you can see the result. Yes. Here's a sample:",
  );
  assert.equal(joinChatText("so you can see the result.", "Yes. Here's a sample:"), "so you can see the result. Yes. Here's a sample:");
  assert.equal(joinChatText("Hello ", "world"), "Hello world");

  const wrapped = wrapMarkdown("hello", 0, 5, "**");
  assert.equal(wrapped.text, "**hello**");
  assert.equal(wrapMarkdown(wrapped.text, 0, wrapped.text.length, "**").text, "hello");

  const table = parseChatMarkdown(
    [
      "### Apply these",
      "| SKU | Price |",
      "|---|---:|",
      "| Darkest Dungeon PC | $2.39 |",
      "",
      "1. Hold GG.deals #1.",
    ].join("\n"),
  );
  assert.equal(table[0].type, "h");
  assert.equal(table[1].type, "table");
  if (table[1].type !== "table") throw new Error("expected table");
  assert.equal(table[1].rows.length, 1);
  assert.equal(table[1].aligns[1], "right");
  assert.equal(table[2].type, "ol");
  const mashed = parseMarkdownTable([
    "| SKU | Action | |---|---| | Darkest Dungeon PC | Keep |",
  ]);
  assert.ok(mashed);
  assert.ok((mashed?.headers.length ?? 0) >= 2);
  assert.ok((mashed?.rows.length ?? 0) >= 1);
  const mashedText = JSON.stringify(mashed);
  assert.match(mashedText, /SKU/);
  assert.match(mashedText, /Darkest Dungeon PC/);
  const peeled = peelPlanningPreamble(
    "I'll look up Loaded.com and inspect the discount tools.\n\n### Apply these\nKeep the #1 slot.",
  );
  assert.match(peeled.thought, /I'll look up/);
  assert.match(peeled.body, /Apply these/);
  const codex = peelPlanningPreamble(
    [
      "I'll list the other sidebar chats and read their preview text. The sidebar preview is the last-message snippet on each other chat. Here are the ones at the top of the list:",
      "Create WALK-TEST-EDIT.md Walk Test File (Walk Test, Grok 4.6)   > I'll create that walk-test file",
      "This chat’s own preview is currently: I'll list the other sidebar chats and read their preview text.",
      "There are more chats below those (peer tests, startup-error threads, WORKHORSE-LIVE-OK, pong, etc.). If you meant one specific title, say which and I’ll quote only that preview.",
    ].join("\n\n"),
  );
  assert.match(codex.thought, /I'll list the other sidebar chats/);
  assert.match(codex.body, /There are more chats below those/);
  assert.doesNotMatch(codex.body, /Create WALK-TEST-EDIT/);
  const liveThink = peelPlanningPreamble("I'll inspect the workspace and then edit the file.", true);
  assert.match(liveThink.thought, /I'll inspect the workspace/);
  assert.equal(liveThink.body, "");
  const finishedThink = peelPlanningPreamble("I'll inspect the workspace and then edit the file.", false);
  assert.equal(finishedThink.thought, "");
  assert.match(finishedThink.body, /I'll inspect the workspace/);
  const leaked = peelPlanningPreamble(
    [
      "I want to be upfront with you: I'm a bot inside a Workhorse chat, so I can't drive the GUI.",
      "Let me first see what's actually here, and what you mean by a project for Workhorse.",
      "Excellent — I now know exactly what a project is. A Project is a typed object with id and name.",
    ].join("\n\n"),
  );
  assert.match(leaked.body, /I want to be upfront/);
  assert.doesNotMatch(leaked.body, /Let me first see/);
  assert.doesNotMatch(leaked.body, /Excellent —/);
  assert.match(leaked.thought, /Let me first see/);
  const tagged = peelPlanningPreamble("<think>scan the folders first</think>\n\nHere is the project shape.");
  assert.match(tagged.thought, /scan the folders first/);
  assert.match(tagged.body, /Here is the project shape/);
  assert.doesNotMatch(tagged.body, /<think/);
  const mmLeak = [
    "Sweeping the D drive for Space Battle folders now.</mm:think>Searching D:\\ for space* folders. Let me also list the root to see what's on D. Got it — found two candidate folders on D:\\. Let me peek inside both to see which is the real one.</mm:think>Both folders exist. Let me check what's inside each so I know which to allocate. Got it — D:\\Godot\\Projects\\spaceship-battle\\ is the canonical Space Battle project (full code, scenes, project.godot with the SpaceBattle autoload). The space folder is just an empty scratch directory.",
    "",
    "Allocating now.</mm:think>Done. Allocated “Space Battle” as a Workhorse project linked to D:\\Godot\\Projects\\spaceship-battle\\. This chat has been moved into it.",
  ].join("\n");
  const mm = peelThinkTags(mmLeak);
  assert.match(mm.thought, /Sweeping the D drive/);
  assert.match(mm.thought, /Searching D:\\ for space/);
  assert.doesNotMatch(mm.body, /<\/?mm:think>/i);
  assert.doesNotMatch(mm.body, /Sweeping the D drive/);
  assert.match(mm.body, /Done\. Allocated/);
  assert.match(mm.body, /D:\\Godot\\Projects\\spaceship-battle/);
  const mmShown = peelPlanningPreamble(mmLeak);
  assert.doesNotMatch(mmShown.body, /<\/?mm:think>/i);
  assert.doesNotMatch(mmShown.body, /Sweeping the D drive/);
  assert.match(mmShown.body, /Done\. Allocated/);
  const drafted = [
    "The user is asking if I can see the chats. I should call workhorse_list_chats to show the chats in the sidebar. Let me count: 29 entries total. Let me list them in a clean way, grouped by provider/model since that's what shows what bots are on the desk. Provider breakdown:",
    "- custom (MiniMax-M3): many chats",
    "- grok (grok-4.6): several chats",
    "By vendor:",
    "- Mini Max (M3, custom) — 14 chats",
    "- Grok 4.6 — 8 chats",
    "Status: 28 idle, 1 running",
    "Want me to read the full transcript of any specific chat?",
  ].join("\n");
  const reply = [
    "Yes — I can see all 29 sidebar chats in this Workhorse window. Here's the breakdown:",
    "",
    "By vendor:",
    "- Mini Max (M3, custom) — 14 chats",
    "- Grok 4.6 — 8 chats",
    "",
    "Status: 28 idle, 1 running (this chat).",
  ].join("\n");
  const split = splitThoughtFromOutput(drafted);
  assert.match(split.thought, /I should call workhorse_list_chats/);
  assert.doesNotMatch(split.thought, /Mini Max \(M3, custom\)/);
  assert.doesNotMatch(split.thought, /By vendor/);
  assert.doesNotMatch(split.thought, /Provider breakdown/);
  assert.match(split.leaked, /custom \(MiniMax-M3\)|Provider breakdown|By vendor/);
  const cleaned = stripOutputFromThought(drafted, reply);
  assert.match(cleaned, /The user is asking/);
  assert.doesNotMatch(cleaned, /14 chats/);
  assert.doesNotMatch(cleaned, /Yes — I can see/);
  assert.doesNotMatch(cleaned, /By vendor/);
  const shown = thoughtForReply({
    thoughtMessages: [{ text: drafted }],
    assistantText: reply,
  });
  assert.match(shown, /I should call workhorse_list_chats/);
  assert.doesNotMatch(shown, /14 chats/);
  assert.doesNotMatch(shown, /Yes — I can see/);
  assert.doesNotMatch(shown, /By vendor/);
  const include = parseChatMarkdown("#include <stdio.h>\n##### Deep\n#\nHello");
  assert.ok(include.length >= 3);
  assert.ok(include.some((block) => block.type === "p"));
  assert.ok(include.some((block) => block.type === "h"));
});

test("session bridge lists, finds, and reads chats for peer tools", async () => {
  const state = {
    projects: [{ id: "proj_1", name: "Alpha" }],
    sessions: [
      {
        id: "sess_aa",
        projectId: "proj_1",
        title: "Login fix",
        model: "grok-4.6",
        status: "idle",
        messages: [
          { role: "user", text: "Look at auth" },
          { role: "assistant", text: "Here is the login path" },
        ],
      },
      {
        id: "sess_bb",
        projectId: null,
        title: "Loose notes",
        model: "grok-4.6",
        messages: [{ role: "user", text: "hello" }],
      },
    ],
  };
  const listed = catalogSessions(state);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].projectName, "Alpha");
  assert.equal(listed[0].preview, "Here is the login path");
  assert.equal(findSession(listed, "sess_aa")?.title, "Login fix");
  assert.equal(findSession(listed, "login")?.id, "sess_aa");
  const withGone = catalogSessions({
    projects: state.projects,
    sessions: [
      ...state.sessions,
      {
        id: "sess_archived",
        title: "Old login notes",
        archivedAt: 99,
        messages: [
          { role: "user", text: "archive me" },
          { role: "assistant", text: "this archived preview must stay hidden" },
        ],
      },
      {
        id: "sess_hidden",
        title: "Child of deleted",
        parentId: "sess_gone",
        hidden: true,
        messages: [{ role: "user", text: "orphan" }],
      },
    ],
  });
  assert.deepEqual(withGone.map((item) => item.id), ["sess_aa", "sess_bb"]);
  assert.equal(findSession(withGone, "Old login notes"), null);
  assert.equal(findSession([{ id: "sess_archived", title: "Old login notes", projectId: null, projectName: null, provider: "grok", model: "grok-4.6", status: "idle", archived: true, preview: "hidden", sidebar: "", messageCount: 1 }], "Old login notes"), null);
  assert.equal(sessionTranscript({ sessions: [{ id: "sess_archived", title: "Old login notes", archivedAt: 99, messages: [{ role: "user", text: "archive me" }] }] }, "Old login notes"), null);
  const transcript = sessionTranscript(state, "Login fix", 10);
  assert.equal(transcript?.messages.at(-1)?.text, "Here is the login path");
  assert.match(formatPeerPrompt("Login fix", "Need the route"), /Login fix/);
  assert.deepEqual(peerPromptParts({ kind: "peer", fromTitle: "Can You See Other Chats", text: "Hello from the other chat" }), {
    fromTitle: "Can You See Other Chats",
    text: "Hello from the other chat",
  });
  assert.deepEqual(peerPromptParts({ text: formatPeerPrompt("Alpha", "Need the route") }), {
    fromTitle: "Alpha",
    text: "Need the route",
  });
  const peerSaved = normalizeSession({
    id: "sess_peer",
    provider: "grok",
    model: "grok-4.6",
    messages: [{ id: "p", role: "user", kind: "peer", fromTitle: "Other", text: "ping", createdAt: 1 }],
  });
  assert.equal(peerSaved?.messages[0].kind, "peer");
  assert.equal(peerSaved?.messages[0].fromTitle, "Other");
  assert.equal(
    existingPeerReply(
      [
        {
          id: "sess_b",
          messages: [
            { role: "user", kind: "peer", text: "ping" },
            { role: "assistant", text: "pong from B" },
          ],
        },
      ],
      "sess_b",
      "ping",
    ),
    "pong from B",
  );
  assert.equal(existingPeerReply([{ id: "sess_b", messages: [] }], "sess_b", "ping"), null);
  assert.equal(
    existingPeerReply(
      [{ id: "sess_b", messages: [{ role: "user", kind: "peer", text: "ping", peerFromSessionId: "sess_a" }, { role: "assistant", text: "pong" }] }],
      "sess_b",
      "ping",
      "sess_c",
    ),
    null,
  );
  const userTurn = readFileSync(path.join(ROOT, "src", "ui", "UserTurn.tsx"), "utf8");
  assert.match(userTurn, /peer \? " peer"/);
  assert.match(userTurn, /from \"\.\/TurnActions\"/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "src", "ui", "TurnActions.tsx"), "utf8"), /export function copyText/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "copy-text.ts"), "utf8"), /export function copyText/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.turn\.user\.peer \.say/);

  const inboxRoot = path.join(ROOT, "dist-electron", ".peer-test");
  try {
    mkdirSync(inboxRoot, { recursive: true });
    const stateFile = path.join(inboxRoot, "workhorse-state.json");
    writeFileSync(stateFile, "{}");
    const record = writeBridgeRecord(stateFile, { url: "http://127.0.0.1:9", token: "abc" });
    assert.equal(readBridgeRecord(stateFile)?.token, "abc");
    const stop = watchPeerInbox(record.inbox, async (ask) => ({ text: `got:${ask.message}` }));
    const replied = await askViaInbox(record.inbox, { fromSessionId: "a", toSessionId: "b", message: "hi" }, 4000);
    stop();
    assert.equal(replied, "got:hi");
  } finally {
    rmSync(inboxRoot, { recursive: true, force: true });
  }
  assert.match(WORKHORSE_SESSION_RULES, /workhorse_read_chat/);
  assert.equal(workhorseMcpServer(), null);
  assert.equal(workhorseMcpScript(path.join("C:", "app", "dist-electron", "main.js")), path.join("C:", "app", "dist-electron", "workhorse-mcp.js"));
  assert.match(readFileSync(path.join(ROOT, "vite.config.ts"), "utf8"), /workhorse-mcp/);
  assert.match(readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8"), /workhorse-mcp\.js/);
  assert.match(readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8"), /requestSingleInstanceLock/);
  assert.equal(isElectronAppCommand("/Applications/Workhorse.app/Contents/MacOS/Workhorse"), true);
  assert.equal(isElectronAppCommand("C:/Program Files/Workhorse/Workhorse.exe"), true);
  assert.equal(isElectronAppCommand("/path/to/Electron"), true);
  assert.equal(isElectronAppCommand(process.execPath), false);

  const previous = {
    script: process.env.WORKHORSE_MCP_SCRIPT,
    url: process.env.WORKHORSE_BRIDGE_URL,
    token: process.env.WORKHORSE_BRIDGE_TOKEN,
    state: process.env.WORKHORSE_STATE_PATH,
  };
  const tempDir = path.join(ROOT, "dist-electron", ".mcp-test");
  const helper = path.join(tempDir, "workhorse-mcp.js");
  try {
    mkdirSync(tempDir, { recursive: true });
    process.env.WORKHORSE_MCP_SCRIPT = path.join(tempDir, "main.js");
    process.env.WORKHORSE_BRIDGE_URL = "http://127.0.0.1:9";
    process.env.WORKHORSE_BRIDGE_TOKEN = "token";
    process.env.WORKHORSE_STATE_PATH = path.join(ROOT, "package.json");
    assert.equal(workhorseMcpServer(), null);
    writeFileSync(helper, "export {}\n");
    const advertised = workhorseMcpServer();
    assert.equal(advertised?.name, "workhorse");
    assert.equal(advertised?.args[0], helper);
    process.env.WORKHORSE_MCP_COMMAND = "/Applications/Workhorse.app/Contents/MacOS/Workhorse";
    const packaged = workhorseMcpServer();
    assert.equal(packaged?.command, "/Applications/Workhorse.app/Contents/MacOS/Workhorse");
    assert.ok(packaged?.env?.some((row) => row.name === "ELECTRON_RUN_AS_NODE" && row.value === "1"));
    process.env.WORKHORSE_MCP_COMMAND = process.execPath;
    const asNode = workhorseMcpServer();
    assert.equal(asNode?.command, process.execPath);
    assert.ok(!asNode?.env?.some((row) => row.name === "ELECTRON_RUN_AS_NODE"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    if (previous.script === undefined) delete process.env.WORKHORSE_MCP_SCRIPT;
    else process.env.WORKHORSE_MCP_SCRIPT = previous.script;
    if (previous.url === undefined) delete process.env.WORKHORSE_BRIDGE_URL;
    else process.env.WORKHORSE_BRIDGE_URL = previous.url;
    if (previous.token === undefined) delete process.env.WORKHORSE_BRIDGE_TOKEN;
    else process.env.WORKHORSE_BRIDGE_TOKEN = previous.token;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
  }

  const ready = await handleWorkhorseRpc({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal((ready as { result?: { serverInfo?: { name?: string } } })?.result?.serverInfo?.name, "go7-workhorse");
  const listedTools = await handleWorkhorseRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = ((listedTools as { result?: { tools?: { name: string }[] } })?.result?.tools ?? []).map((tool) => tool.name);
  assert.deepEqual(names, [
    "workhorse_list_chats",
    "workhorse_read_chat",
    "workhorse_ask_chat",
    "workhorse_spawn_agent",
    "workhorse_await_agents",
    "workhorse_list_bots",
    "workhorse_probe_runtime",
    "workhorse_plan",
    "workhorse_detect_custom",
    "workhorse_setup_custom_bot",
    "workhorse_list_projects",
    "workhorse_request_vendor",
    "workhorse_request_permission",
    "workhorse_create_project",
    "workhorse_move_chat",
    "workhorse_rename_chat",
    "workhorse_rename_project",
    "workhorse_delete_chat",
    "workhorse_delete_project",
    "workhorse_list_references",
    "workhorse_add_reference",
    "workhorse_delete_reference",
    "workhorse_list_skills",
    "workhorse_read_skill",
    "workhorse_delete_bot",
  ]);
  const rpcPlan = ((listedTools as { result?: { tools?: { name: string; inputSchema?: unknown }[] } })?.result?.tools ?? [])
    .find((tool) => tool.name === "workhorse_plan");
  assert.match(JSON.stringify(rpcPlan?.inputSchema), /revise/);
  assert.match(JSON.stringify(rpcPlan?.inputSchema), /dependsOn/);
  assert.match(WORKHORSE_SESSION_RULES, /workhorse_spawn_agent/);
  assert.match(WORKHORSE_SESSION_RULES, /workhorse_setup_custom_bot/);
  assert.doesNotMatch(WORKHORSE_SESSION_RULES, /importFrom=auto/);
  assert.doesNotMatch(WORKHORSE_SESSION_RULES, /OpenClaw/);
  assert.match(WORKHORSE_SESSION_RULES, /workhorse_add_reference/);
  assert.match(WORKHORSE_SESSION_RULES, /workhorse_create_project/);
  assert.match(WORKHORSE_SESSION_RULES, /workhorse_move_chat/);
  assert.match(WORKHORSE_SESSION_RULES, /workhorse_rename_chat/);
  assert.match(WORKHORSE_SESSION_RULES, /workhorse_rename_project/);
  assert.match(WORKHORSE_SESSION_RULES, /Do not delete and recreate/);
  assert.match(WORKHORSE_SESSION_RULES, /Visible sidebar names/);
  assert.match(WORKHORSE_SESSION_RULES, /the rename did not take/);
  assert.match(WORKHORSE_SESSION_RULES, /workhorse_delete_chat/);
  assert.match(WORKHORSE_SESSION_RULES, /workhorse_delete_project/);
  assert.match(WORKHORSE_SESSION_RULES, /puts THIS chat/);
  assert.match(WORKHORSE_SESSION_RULES, /After you ask the user to pick, stop/);
  assert.match(WORKHORSE_SESSION_RULES, /search likely folders first/i);
  assert.match(WORKHORSE_SESSION_RULES, /D:\\ and C:\\/);
  assert.match(WORKHORSE_SESSION_RULES, /If they name a drive/);
  assert.match(WORKHORSE_SESSION_RULES, /Do not ask the user for a path when a matching folder exists/);
  assert.match(WORKHORSE_SESSION_RULES, /Never delete this chat on a bulk list/);
  assert.match(WORKHORSE_SESSION_RULES, /onlyThis=true only when the user asked to delete this chat alone/);
  assert.match(WORKHORSE_SESSION_RULES, /not a file on disk/);
  assert.match(WORKHORSE_SESSION_RULES, /Only tell the user it exists if that list shows/);
  assert.doesNotMatch(WORKHORSE_SESSION_RULES, /sidebar project/);
  assert.match(WORKHORSE_SESSION_RULES, /Do not call it a sidebar anything/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "electron", "custom-tools.ts"), "utf8"), /sidebar project/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8"), /sidebar project/);
  assert.match(readFileSync(path.join(ROOT, "electron", "custom-tools.ts"), "utf8"), /workhorse_create_project/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "permissions.ts"), "utf8"), /create_project/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "permissions.ts"), "utf8"), /move_chat/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "permissions.ts"), "utf8"), /delete_project/);
  assert.match(WORKHORSE_SESSION_RULES, /desk slots/);
  assert.match(WORKHORSE_SESSION_RULES, /Do not read AGENTS\.md/);
  assert.match(WORKHORSE_SESSION_RULES, /do not fall back to reading source/);
  assert.match(WORKHORSE_SESSION_RULES, /sidebar subtitle/);
  assert.match(WORKHORSE_SESSION_RULES, /last user\/assistant snippet/);
  assert.match(WORKHORSE_SESSION_RULES, /Archived and deleted chats/);
  assert.match(WORKHORSE_SESSION_RULES, /do not try a write to see if it fails/);
  assert.match(WORKHORSE_SESSION_RULES, /USER DECLINED/);
  assert.match(WORKHORSE_SESSION_RULES, /user said no for this chat/);
  assert.match(WORKHORSE_SESSION_RULES, /Do not ask which vendor/);
  assert.match(WORKHORSE_SESSION_RULES, /that vendor is a no-go/);
  assert.match(WORKHORSE_SESSION_RULES, /Do not call workhorse_request_vendor/);
  assert.match(WORKHORSE_SESSION_RULES, /API key is already on the desk|this chat’s own slot/);
  assert.match(WORKHORSE_SESSION_RULES, /zero canCall rows/);
  assert.match(WORKHORSE_SESSION_RULES, /never say no custom bot is attached/);
  assert.match(WORKHORSE_SESSION_RULES, /Turned-off vendors are omitted/);
  assert.match(WORKHORSE_SESSION_RULES, /Talking to an existing sidebar chat is always allowed/);
  assert.doesNotMatch(WORKHORSE_SESSION_RULES, /pops a card|guess about the card/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /!item\.archivedAt/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /target\.archivedAt/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8"), /workhorse_spawn_agent/);
  const mcp = readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8");
  assert.match(mcp, /formatDeskRoster/);
  assert.doesNotMatch(
    mcp.slice(mcp.indexOf("async function askChat"), mcp.indexOf("async function spawnAgent")),
    /requestVendorAccess/,
  );
  assert.match(
    mcp.slice(mcp.indexOf("async function listBots"), mcp.indexOf("function setupInput")),
    /postBridge/,
  );
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8"), /workhorse_setup_custom_bot/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-bridge.ts"), "utf8"), /\/spawn/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-bridge.ts"), "utf8"), /\/bots/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /mode === "spawn"/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /mode === "bots"/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /action === "create-project"/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /action === "move-chat"/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /action === "rename-chat"/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /action === "rename-project"/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /action === "delete-chat"/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /action === "delete-project"/);
  assert.match(mcp, /setWorkhorseDeskAsk/);
  assert.match(readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8"), /setWorkhorseDeskAsk\(handlePeerAsk\)/);
  assert.match(mcp, /createWorkhorseProjectLocal/);
  assert.match(mcp, /timeoutMs: 12_000/);
  assert.match(mcp, /inbox: false/);
  assert.match(mcp, /action: "list-projects"/);
  assert.match(mcp, /parsed\.source \?\? "live"/);
  assert.match(mcp, /Do not tell the user a project exists unless it appears here/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /source: "live"/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /saveState/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /action === "add-reference"/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /action === "list-references"/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /action === "delete-reference"/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /action === "select-project"/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-bridge.ts"), "utf8"), /create-project/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-bridge.ts"), "utf8"), /move-chat/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-bridge.ts"), "utf8"), /delete-project/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-bridge.ts"), "utf8"), /add-reference/);

  const envRows = toAcpMcpEnv({ FOO: "bar", BAZ: "1" });
  assert.deepEqual(envRows, [
    { name: "FOO", value: "bar" },
    { name: "BAZ", value: "1" },
  ]);
  const merged = mergeMcpServers([{ name: "custom", command: "node", args: [], env: { TOKEN: "x" } }], null);
  assert.equal(merged[0].type, "stdio");
  assert.deepEqual(merged[0].env, [{ name: "TOKEN", value: "x" }]);
});

test("create-project writes the exact name locally and fails fast without a renderer", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "wh-create-"));
  const stateFile = path.join(scratch, "workhorse-state.json");
  const appFolder = path.join(ROOT);
  const previous = {
    state: process.env.WORKHORSE_STATE_PATH,
    url: process.env.WORKHORSE_BRIDGE_URL,
    token: process.env.WORKHORSE_BRIDGE_TOKEN,
  };
  writeFileSync(
    stateFile,
    JSON.stringify({
      projects: [emptyProject("Go7-Workhorse", [appFolder])],
      sessions: [{ id: "sess_mini", projectId: "proj_other" }],
    }),
    "utf8",
  );
  try {
    process.env.WORKHORSE_STATE_PATH = stateFile;
    delete process.env.WORKHORSE_BRIDGE_URL;
    delete process.env.WORKHORSE_BRIDGE_TOKEN;
    const started = Date.now();
    const created = await handleWorkhorseRpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "workhorse_create_project",
          arguments: { name: "Workhorse Dev", folder: appFolder },
        },
      },
      { fromSessionId: "sess_mini" },
    );
    const elapsed = Date.now() - started;
    const text =
      (created as { result?: { content?: Array<{ text?: string }> } })?.result?.content
        ?.map((item) => item.text ?? "")
        .join("\n") ?? "";
    const parsed = JSON.parse(text) as { ok?: boolean; name?: string; folder?: string };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.name, "Workhorse Dev");
    assert.equal(parsed.folder, appFolder);
    assert.ok(elapsed < 5_000);
    const saved = JSON.parse(readFileSync(stateFile, "utf8")) as {
      projects: Array<{ id: string; name: string; folders: Array<{ path: string }> }>;
      sessions: Array<{ id: string; projectId?: string | null }>;
    };
    const named = saved.projects.find((item) => item.name === "Workhorse Dev");
    assert.ok(named);
    assert.ok(named?.folders.some((folder) => folder.path === appFolder));
    assert.ok(saved.projects.some((item) => item.name === "Go7-Workhorse"));
    assert.equal(saved.sessions.find((item) => item.id === "sess_mini")?.projectId, named?.id);

    delete process.env.WORKHORSE_STATE_PATH;
    process.env.WORKHORSE_BRIDGE_URL = "http://127.0.0.1:9";
    process.env.WORKHORSE_BRIDGE_TOKEN = "dead";
    const failStart = Date.now();
    const failed = await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "workhorse_create_project", arguments: { name: "Workhorse Dev" } },
    });
    const failElapsed = Date.now() - failStart;
    const message = (failed as { error?: { message?: string } })?.error?.message ?? "";
    assert.match(message, /failed|bridge is not running|Do not tell the user the project exists/i);
    assert.ok(failElapsed < 8_000);
  } finally {
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    if (previous.url === undefined) delete process.env.WORKHORSE_BRIDGE_URL;
    else process.env.WORKHORSE_BRIDGE_URL = previous.url;
    if (previous.token === undefined) delete process.env.WORKHORSE_BRIDGE_TOKEN;
    else process.env.WORKHORSE_BRIDGE_TOKEN = previous.token;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("desk bridge binds a real local port instead of :0", async () => {
  const bridge = await startWorkhorseBridge(async () => ({ text: "ok" }));
  try {
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    assert.doesNotMatch(bridge.url, /:0$/);
  } finally {
    bridge.close();
  }
});

test("desk bridge preserves executable plan actions", async () => {
  let seen: import("../electron/peer-inbox").PeerAsk | undefined;
  const bridge = await startWorkhorseBridge(async (ask) => {
    seen = ask;
    return { text: "ok" };
  });
  try {
    const response = await fetch(`${bridge.url}/bots`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({
        fromSessionId: "root",
        toSessionId: "",
        message: "plan",
        mode: "bots",
        action: "plan",
        planOperation: "view",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(seen?.action, "plan");
    assert.equal(seen?.planOperation, "view");
  } finally {
    bridge.close();
  }
});

test("create-project uses the live desk hook instead of a silent disk write", async () => {
  const seen: string[] = [];
  let fromSeen = "";
  const folder = mkdtempSync(path.join(os.tmpdir(), "wh-space-"));
  setWorkhorseDeskAsk(async (ask) => {
    seen.push(ask.action ?? "");
    if (ask.action === "create-project") fromSeen = ask.fromSessionId;
    if (ask.action === "list-projects") {
      return {
        text: JSON.stringify({
          source: "live",
          projects: [{ id: "proj_live", name: "Spaceship Battle", folders: [folder], chats: 1 }],
        }),
      };
    }
    return {
      text: JSON.stringify({
        ok: true,
        source: "live",
        name: ask.name,
        folder: ask.folder,
        projectId: "proj_live",
        projects: [{ id: "proj_live", name: ask.name, folders: [ask.folder] }],
      }),
    };
  });
  try {
    const created = await handleWorkhorseRpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "workhorse_create_project",
          arguments: { name: "Spaceship Battle", folder },
        },
      },
      { fromSessionId: "sess_mini" },
    );
    const text =
      (created as { result?: { content?: Array<{ text?: string }> } })?.result?.content
        ?.map((item) => item.text ?? "")
        .join("\n") ?? "";
    assert.match(text, /proj_live/);
    assert.match(text, /Spaceship Battle/);
    assert.match(text, /"ok": true/);
    const listed = await handleWorkhorseRpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "workhorse_list_projects", arguments: {} },
    });
    const listText =
      (listed as { result?: { content?: Array<{ text?: string }> } })?.result?.content
        ?.map((item) => item.text ?? "")
        .join("\n") ?? "";
    assert.match(listText, /Spaceship Battle/);
    assert.ok(seen.includes("create-project"));
    assert.ok(seen.includes("list-projects"));
    assert.equal(fromSeen, "sess_mini");
  } finally {
    setWorkhorseDeskAsk(null);
    rmSync(folder, { recursive: true, force: true });
  }
});

test("auto titles come from the prompt and upgrade raw slices", () => {
  assert.equal(titleFromPrompt("What do you have access to?"), "What do you have access to?");
  assert.equal(titleFromPrompt("make a game for me"), "make a game for me");
  assert.equal(
    titleFromPrompt("fix the login redirect on settings extra please"),
    "fix the login redirect on settings...",
  );
  assert.equal(titleFromPrompt("one two three four five six seven"), "one two three four five six...");
  const session: Session = {
    id: "sess_url",
    projectId: null,
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "New chat",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [
      { id: "u", role: "user", text: "https://www.loaded.com/#q=Darkest%20Dungeon extra words here", createdAt: 1 },
    ],
    contextUsed: 0,
  };
  assert.equal(suggestedTitleForSession(session), "https://www.loaded.com/#q=Darkest%20Dungeon extra words here");
  assert.equal(suggestedTitleForSession({ ...session, titleLocked: true }), undefined);
  const draft: Session = { ...session, title: "New chat", messages: [] };
  assert.equal(autoTitleForSend(draft, "What do you have access to?"), "What do you have access to?");
  assert.equal(autoTitleForSend({ ...draft, titleLocked: true }, "What do you have access to?"), undefined);
  const named: Session = {
    ...session,
    title: "Workspace access",
    titleLocked: false,
    messages: [{ id: "u", role: "user", text: "Workspace access please keep this", createdAt: 1 }],
  };
  assert.equal(autoTitleForSend(named, "thanks"), undefined);
});

test("session setup is a compact right-side model and access inspector", () => {
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  const setup = readFileSync(path.join(ROOT, "src", "ui", "SessionSetup.tsx"), "utf8");
  const composer = readFileSync(path.join(ROOT, "src", "ui", "Composer.tsx"), "utf8");
  assert.match(pane, /SessionSetup/);
  assert.match(pane, /session-header slim/);
  assert.doesNotMatch(pane, /mode-seg/);
  assert.match(setup, /Chat settings/);
  assert.match(setup, /vendorTidePercent/);
  assert.doesNotMatch(setup, /tide-ink-dark/);
  assert.match(setup, /--setup-vendor/);
  assert.match(setup, /setup-tide/);
  assert.match(setup, /Ask each time/);
  assert.match(setup, /label: "Strict"/);
  assert.doesNotMatch(setup, /Security boundaries/);
  assert.doesNotMatch(setup, /Outside workspace/);
  assert.match(setup, /aria-label="Vendor"/);
  assert.match(setup, /defaultModel\(id\)/);
  assert.match(setup, /modelsFor\(session\.provider\)/);
  assert.doesNotMatch(
    readFileSync(path.join(ROOT, "src", "lib", "models.ts"), "utf8"),
    /id: "custom", name: "Custom"/,
  );
  assert.match(setup, /"codex"/);
  assert.match(setup, /Approval behavior/);
  assert.match(setup, /File access/);
  assert.match(setup, /label: "Plan mode"/);
  assert.match(setup, /label: "Full access"/);
  assert.match(setup, /type="range"/);
  assert.match(setup, /setup-slider-line/);
  assert.doesNotMatch(setup, /setup-slider-head/);
  assert.match(setup, /effortsFor\(session\.provider/);
  const storeSrc = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(storeSrc, /mode: choice\.mode/);
  assert.match(storeSrc, /applySessionPolicyChange/);
  assert.match(storeSrc, /sessionId: session\.id/);
  assert.match(
    readFileSync(path.join(ROOT, "src", "lib", "context-preface.ts"), "utf8"),
    /immutable Workhorse session ID/,
  );
  assert.match(setup, /Accept edits/);
  assert.doesNotMatch(setup, /Choose the brain|Approval behavior and file containment|When should Workhorse pause/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /setup-slider-thumb/);
  const setupCss = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  assert.match(setupCss, /container-name:\s*session/);
  assert.match(setupCss, /width:\s*min\(720px/);
  assert.match(setupCss, /setup-top-grid/);
  assert.match(setupCss, /right:\s*clamp/);
  assert.doesNotMatch(setup, /setup-resize/);
  assert.doesNotMatch(setup, /setSessionSetupHeight/);
  assert.doesNotMatch(setupCss, /setup-resize/);
  assert.equal(effortStopPos(4, 5), 1);
  assert.equal(effortStopPos(0, 5), 0);
  assert.equal(effortStopAt(1, 5), 4);
  assert.match(setup, /effortStopPos/);
  assert.match(composer, /setup-trigger/);
  assert.match(composer, /deskInk/);
  assert.match(composer, /shortModeLabel/);
});

test("parseSessionContext reads Grok /context occupancy and extras", () => {
  const stats = parseSessionContext({
    sessionId: "sess",
    turns: 1,
    context: {
      used: 5496,
      total: 500000,
      systemPromptTokens: 1516,
      toolDefinitionsCount: 25,
      toolDefinitionsTokens: 8471,
      messageCount: 2,
      messageTokens: 3980,
      freeTokens: 494504,
      usagePct: 1,
      autoCompactThresholdPercent: 80,
      usageCategories: [
        { label: "Skills", tokens: 3971, detail: "36 skills" },
        { label: "MCP servers", tokens: 81, detail: "5 servers" },
      ],
    },
  });
  assert.ok(stats);
  assert.equal(stats.source, "live");
  assert.equal(stats.used, 5496);
  assert.equal(stats.total, 500000);
  assert.equal(stats.free, 494504);
  assert.equal(stats.usagePct, 1);
  assert.equal(stats.autoCompactAt, 80);
  assert.deepEqual(
    stats.occupying.map((row) => [row.id, row.tokens, row.detail]),
    [
      ["system", 1516, undefined],
      ["messages", 3980, "2 messages"],
    ],
  );
  assert.deepEqual(
    stats.extra.map((row) => [row.id, row.tokens, row.detail]),
    [
      ["tools", 8471, "25 tools"],
      ["skills", 3971, "36 skills"],
      ["mcp-servers", 81, "5 servers"],
    ],
  );
});

test("estimateChatContext attributes visible messages and leftover occupancy", () => {
  const stats = estimateChatContext({
    contextUsed: 12000,
    windowSize: 500000,
    messages: [
      { text: "a".repeat(400), kind: undefined },
      { text: "b".repeat(400), kind: undefined },
      { text: "ignored tool dump", kind: "tool" },
    ],
  });
  assert.equal(stats.source, "estimate");
  assert.equal(stats.used, 12000);
  assert.equal(stats.total, 500000);
  assert.equal(stats.free, 488000);
  const messages = stats.occupying.find((row) => row.id === "messages");
  assert.equal(messages?.tokens, 200);
  assert.equal(messages?.detail, "2 messages");
  assert.equal(stats.occupying.find((row) => row.id === "other")?.tokens, 11800);

  const overflow = estimateChatContext({
    contextUsed: 527_934,
    windowSize: 500_000,
    messages: [{ text: "a".repeat(400), kind: undefined }],
  });
  assert.equal(overflow.used, 100);
  assert.equal(overflow.total, 500_000);
  assert.ok(overflow.used <= overflow.total);
});

test("context ring opens this-chat stats instead of the Usage page", () => {
  const meter = readFileSync(path.join(ROOT, "src", "ui", "ModelMenu.tsx"), "utf8");
  assert.doesNotMatch(meter, /openUsage\(/);
  assert.match(meter, /This chat/);
  assert.match(meter, /grokSessionInfo/);
  assert.match(meter, /estimateChatContext/);
  assert.match(meter, /shownUsed/);
  assert.match(meter, /useAnimatedNumber/);
  assert.match(meter, /strokeDashoffset/);
  assert.doesNotMatch(meter, /Estimated from this chat/);
  assert.doesNotMatch(meter, /until a Grok turn is live/);
  assert.doesNotMatch(meter, /Live breakdown from this Grok session/);
  assert.doesNotMatch(meter, /Latest request only/);
  assert.doesNotMatch(meter, /Usage counts every API/);
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /grok:session-info/);
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  assert.match(preload, /grokSessionInfo/);
});

test("parseGrokPlanUsage reads weekly SuperGrok pool remaining", () => {
  const plan = parseGrokPlanUsage({
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-11T13:53:32.726325+00:00",
        end: "2026-08-18T13:53:32.726325+00:00",
      },
      creditUsagePercent: 17,
      productUsage: [
        { product: "GrokBuild", usagePercent: 17 },
        { product: "GrokChat" },
      ],
      prepaidBalance: { val: 0 },
    },
  });
  assert.equal(plan?.usedPercent, 17);
  assert.equal(plan?.leftPercent, 83);
  assert.equal(plan?.period, "weekly");
  assert.equal(plan?.products[0]?.label, "Build");
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "UsagePane.tsx"), "utf8"), /% left/);
});

test("parseCodexPlanUsage reads weekly leftover the same way as SuperGrok", () => {
  const live = parseCodexPlanUsage({
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 17,
        limit_window_seconds: 604800,
        reset_at: 1787202379,
      },
    },
    credits: { balance: "0" },
  });
  assert.equal(live?.usedPercent, 17);
  assert.equal(live?.leftPercent, 83);
  assert.equal(live?.period, "weekly");
  assert.ok(live?.resetsAt);

  const session = parseCodexPlanUsage({
    rate_limits: { primary: { used_percent: 75, window_minutes: 10080, resets_at: 1785611895 } },
  });
  assert.equal(session?.usedPercent, 75);
  assert.equal(session?.leftPercent, 25);
  assert.equal(session?.period, "weekly");

  const chatgptWeekly = parseCodexPlanUsage({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 1, limit_window_seconds: 18_000, reset_at: 1786680000 },
      secondary_window: { used_percent: 41, limit_window_seconds: 604_800, reset_at: 1787202379 },
    },
  });
  assert.equal(chatgptWeekly?.usedPercent, 1);
  assert.equal(chatgptWeekly?.leftPercent, 99);
  assert.equal(chatgptWeekly?.period, "weekly");
  assert.ok(chatgptWeekly?.resetsAt);

  const activePlus = parseCodexPlanUsage({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 3, limit_window_seconds: 604_800, reset_at: 1787202379 },
    },
    credits: { balance: "0" },
  });
  assert.equal(activePlus?.usedPercent, 3);
  assert.equal(activePlus?.leftPercent, 97);
  assert.equal(activePlus?.period, "weekly");

  const pane = readFileSync(path.join(ROOT, "src", "ui", "UsagePane.tsx"), "utf8");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(pane, /leftoverForCard/);
  assert.match(pane, /\$\{planName\} ·/);
  assert.match(store, /codexPlanUsage/);
  assert.match(store, /refreshCodexPlan/);
  assert.match(store, /claudePlanUsage/);
  assert.match(store, /customPlanUsage/);
  assert.match(preload, /codex:plan-usage/);
  assert.match(preload, /claude:plan-usage/);
  assert.match(preload, /custom:plan-usage/);
  assert.match(main, /fetchCodexPlanUsage/);
  assert.match(main, /fetchClaudePlanUsage/);
  assert.match(main, /fetchCustomPlanUsage/);
});

test("new project can ship with dropped or picked source folders", () => {
  const named = emptyProject("Alpha");
  assert.equal(named.name, "Alpha");
  assert.deepEqual(named.folders, []);

  const fromFolders = emptyProject("", ["C:\\\\Work\\\\Go7-Workhorse", "C:\\\\Work\\\\Go7-Workhorse", "D:\\\\Refs"]);
  assert.equal(fromFolders.folders.length, 2);
  assert.equal(fromFolders.name, "Go7-Workhorse");
  assert.equal(fromFolders.folders[0].label, "Go7-Workhorse");
  assert.equal(fromFolders.folders[1].path, "D:\\\\Refs");

  const sheet = readFileSync(path.join(ROOT, "src", "ui", "NewProjectSheet.tsx"), "utf8");
  assert.match(sheet, /Source folders/);
  assert.match(sheet, /source-drop/);
  assert.match(sheet, /pickFolder/);
  assert.match(sheet, /onDrop/);
  assert.match(sheet, /createProject\(name, folders\)/);
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  assert.match(preload, /pathForFile/);
  assert.match(preload, /webUtils/);
});

test("create-project binds the exact name and does not attach the folder to another project", () => {
  const appFolder = "C:\\Users\\lgovo\\Projects\\Go7-Workhorse";
  const other = emptyProject("Go7-Workhorse", [appFolder]);
  const bound = applyCreateWorkhorseProject(
    [other],
    [{ id: "sess_mini", projectId: other.id }],
    { name: "Workhorse Dev", folder: appFolder, fromSessionId: "sess_mini" },
    1,
  );
  assert.equal(bound.result.ok, true);
  assert.equal(bound.result.name, "Workhorse Dev");
  assert.equal(bound.result.folder, appFolder);
  assert.equal(bound.result.movedThisChat, true);
  assert.ok(
    bound.projects.some((item) => item.name === "Workhorse Dev" && item.folders.some((folder) => folder.path === appFolder)),
  );
  assert.equal(bound.projects.find((item) => item.name === "Go7-Workhorse")?.folders[0]?.path, appFolder);
  assert.equal(bound.sessions.find((item) => item.id === "sess_mini")?.projectId, bound.result.projectId);
  assert.notEqual(bound.result.projectId, other.id);
  const again = applyCreateWorkhorseProject(bound.projects, bound.sessions, {
    name: "Workhorse Dev",
    folder: appFolder,
  });
  assert.equal(parseCreateProjectLive(JSON.stringify({ ok: true, notified: true })), null);
  assert.equal(parseCreateProjectLive(JSON.stringify({ ok: true, name: "Spaceship Battle", folder: "D:\\\\godot" }))?.name, "Spaceship Battle");
  assert.doesNotMatch(readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8"), /notified: true/);
  assert.equal(again.result.alreadyExists, true);
  assert.equal(again.result.name, "Workhorse Dev");
  assert.equal(again.projects.filter((item) => item.name === "Workhorse Dev").length, 1);
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /applyCreateWorkhorseProject/);
  const named = emptyProject("Spaceship Battles", ["D:\\\\godot\\\\Projects\\\\spaceship-battle"]);
  assert.equal(findProjectByQuery([named, other], "spaceship battles")?.id, named.id);
  const loose = {
    id: "sess_loose",
    projectId: null as string | null,
    provider: "custom" as const,
    model: "MiniMax-M3",
    title: "Can you create me a project…",
    mode: "ask" as const,
    sandbox: "off" as const,
    status: "idle" as const,
    messages: [],
    contextUsed: 0,
  };
  assert.equal(findListedChat([loose], "Can you create me a project…")?.id, "sess_loose");
  assert.equal(findListedChat([loose], "create me a project"), undefined);
  const moved = moveChat([loose], "sess_loose", named.id);
  assert.equal(moved?.find((item) => item.id === "sess_loose")?.projectId, named.id);
});

test("delete-chat refuses the calling chat and fails closed on ambiguous titles", () => {
  const caller: Session = {
    id: "sess_this",
    projectId: null,
    provider: "custom",
    model: "MiniMax-M3",
    title: "hwat chats can you see?",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [{ id: "u", role: "user", text: "kill these", createdAt: 1 }],
    contextUsed: 0,
  };
  const other: Session = {
    ...caller,
    id: "sess_other",
    title: "Can you see the chats?",
    provider: "custom",
  };
  const miniTest: Session = { ...caller, id: "sess_mini_test", title: "Test", provider: "custom" };
  const codexTest: Session = { ...caller, id: "sess_codex_test", title: "test", provider: "codex", model: "gpt-5.6-sol" };
  const listed = [caller, other, miniTest, codexTest];

  const omitted = applyDeleteDeskChat(listed, { fromSessionId: caller.id });
  assert.equal(omitted.ok, false);
  if (!omitted.ok) assert.match(omitted.error, /onlyThis=true|chat title or id is required/i);
  assert.equal(omitted.sessions.some((item) => item.id === caller.id), true);

  const byOwnTitle = applyDeleteDeskChat(listed, { chat: caller.title, fromSessionId: caller.id });
  assert.equal(byOwnTitle.ok, false);
  if (!byOwnTitle.ok) assert.match(byOwnTitle.error, /Refused to delete this chat/);
  assert.equal(byOwnTitle.sessions.some((item) => item.id === caller.id), true);
  assert.equal(deleteChatGuard({ targetId: caller.id, fromSessionId: caller.id }).allow, false);

  const thisOnly = applyDeleteDeskChat(listed, { chat: caller.title, fromSessionId: caller.id, onlyThis: true });
  assert.equal(thisOnly.ok, true);
  if (thisOnly.ok) {
    assert.equal(thisOnly.deleted.id, caller.id);
    assert.equal(thisOnly.sessions.some((item) => item.id === caller.id), false);
    assert.equal(thisOnly.sessions.some((item) => item.id === other.id), true);
  }

  const otherGone = applyDeleteDeskChat(listed, { chat: other.title, fromSessionId: caller.id });
  assert.equal(otherGone.ok, true);
  if (otherGone.ok) {
    assert.equal(otherGone.deleted.id, other.id);
    assert.equal(otherGone.sessions.some((item) => item.id === caller.id), true);
  }

  const ambiguous = resolveListedChat(listed, "test");
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.match(ambiguous.error, /Ambiguous chat title/);
    assert.equal(ambiguous.candidates?.length, 2);
    assert.ok(ambiguous.candidates?.some((item) => item.id === "sess_mini_test"));
    assert.ok(ambiguous.candidates?.some((item) => item.id === "sess_codex_test"));
  }
  const ambDelete = applyDeleteDeskChat(listed, { chat: "test", fromSessionId: caller.id });
  assert.equal(ambDelete.ok, false);
  if (!ambDelete.ok) assert.match(ambDelete.error, /Ambiguous/);
  assert.equal(ambDelete.sessions.some((item) => item.id === "sess_mini_test"), true);
  assert.equal(ambDelete.sessions.some((item) => item.id === "sess_codex_test"), true);

  const byId = applyDeleteDeskChat(listed, { chat: "sess_codex_test", fromSessionId: caller.id });
  assert.equal(byId.ok, true);
  if (byId.ok) assert.equal(byId.deleted.id, "sess_codex_test");
  assert.equal(findListedChat(listed, "see the chats"), undefined);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /applyDeleteDeskChat/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8"), /onlyThis/);

  const looseCaller: Session = { ...caller, id: "sess_loose_main", title: "Can you remove allt he chats...", projectId: null };
  const looseA: Session = { ...caller, id: "sess_loose_a", title: "What do you have access to", projectId: null };
  const looseB: Session = { ...caller, id: "sess_loose_b", title: "Test", projectId: null };
  const inProject: Session = { ...caller, id: "sess_proj", title: "Please summon subagents", projectId: "proj_ships" };
  const hiddenKid: Session = {
    ...caller,
    id: "sess_kid",
    title: "src tree review",
    projectId: null,
    parentId: "sess_loose_a",
    hidden: true,
  };
  const looseListed = [looseCaller, looseA, looseB, inProject, hiddenKid];
  const missingFrom = applyDeleteLooseDeskChats(looseListed, {});
  assert.equal(missingFrom.ok, false);
  const swept = applyDeleteLooseDeskChats(looseListed, { fromSessionId: looseCaller.id });
  assert.equal(swept.ok, true);
  if (swept.ok) {
    assert.deepEqual(swept.deleted.map((item) => item.id).sort(), ["sess_loose_a", "sess_loose_b"]);
    assert.equal(swept.kept?.id, looseCaller.id);
    assert.equal(swept.sessions.some((item) => item.id === looseCaller.id), true);
    assert.equal(swept.sessions.some((item) => item.id === inProject.id), true);
    assert.equal(swept.sessions.some((item) => item.id === looseA.id), false);
    assert.equal(swept.sessions.some((item) => item.id === hiddenKid.id), false);
  }
  assert.equal(isLooseDeleteScope({ scope: "loose" }), true);
  assert.equal(isLooseDeleteScope({ chat: "not in a project" }), true);
  assert.equal(isLooseDeleteScope({ chat: "What do you have access to" }), false);
  assert.equal(looksLikeLooseDeleteRequest("Can you remove allt he chats not in a project please?"), true);
  assert.equal(looksLikeLooseDeleteRequest("delete all loose chats"), true);
  assert.equal(looksLikeLooseDeleteRequest("rename the project"), false);
  assert.equal(withLooseDeleteHint("remove all the chats not in a project").startsWith(LOOSE_DELETE_HINT), true);
  const looseAsk = composeVendorPrompt("Can you remove all the chats not in a project please?", WORKHORSE_SESSION_RULES, "session/load");
  assert.match(looseAsk, /scope=loose/);
  assert.match(looseAsk, /Do not offer A\/B\/C/);
  assert.match(WORKHORSE_SESSION_RULES, /scope=loose/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /scope=loose/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /applyDeleteLooseDeskChats/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8"), /scope=loose|scope: loose/);
  assert.match(readFileSync(path.join(ROOT, "electron", "custom-host.ts"), "utf8"), /withLooseDeleteHint/);
});

test("rename chat and project in place without delete", () => {
  const chat: Session = {
    id: "sess_space",
    projectId: "proj_godot",
    provider: "custom",
    model: "MiniMax-M3",
    title: "PLease look at the D drive",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [{ id: "u", role: "user", text: "Rename to Spaceship game please", createdAt: 1 }],
    contextUsed: 0,
  };
  const renamedChat = applyRenameDeskChat([chat], { name: "Spaceship game", fromSessionId: chat.id });
  assert.equal(renamedChat.ok, true);
  if (renamedChat.ok) {
    assert.equal(renamedChat.previous, "PLease look at the D drive");
    assert.equal(renamedChat.renamed.title, "Spaceship game");
    assert.equal(renamedChat.renamed.id, chat.id);
    assert.equal(renamedChat.sessions.some((item) => item.id === chat.id && item.title === "Spaceship game"), true);
  }
  const missingName = applyRenameDeskChat([chat], { fromSessionId: chat.id, name: "  " });
  assert.equal(missingName.ok, false);

  const project = emptyProject("Godot Spaceships", ["D:\\\\Godot\\\\Projects\\\\spaceship-battle"]);
  const other = emptyProject("Workhorse Dev", ["C:\\\\Users\\\\lgovo\\\\Projects\\\\Go7-Workhorse"]);
  const renamedProject = applyRenameDeskProject([project, other], {
    name: "Spaceship game",
    fromProjectId: project.id,
  });
  assert.equal(renamedProject.ok, true);
  if (renamedProject.ok) {
    assert.equal(renamedProject.previous, "Godot Spaceships");
    assert.equal(renamedProject.renamed.name, "Spaceship game");
    assert.equal(renamedProject.renamed.id, project.id);
    assert.equal(renamedProject.projects.find((item) => item.id === other.id)?.name, "Workhorse Dev");
  }
  const byName = applyRenameDeskProject([project, other], { name: "Spaceship game", project: "Godot Spaceships" });
  assert.equal(byName.ok, true);
  if (byName.ok) assert.equal(byName.renamed.id, project.id);
  assert.equal(renameTookOnDesk([project, other], "Spaceship game"), false);
  assert.equal(renameTookOnDesk([{ name: "Spaceship game" }, other], "Spaceship game"), true);
  assert.deepEqual(visibleProjectNames([project, other]), ["Godot Spaceships", "Workhorse Dev"]);
  assert.equal(parseRenameProjectLive(JSON.stringify({ ok: true, name: "Spaceship game", notified: true })), null);
  assert.equal(
    parseRenameProjectLive(
      JSON.stringify({
        ok: true,
        name: "Spaceship game",
        requested: "Spaceship game",
        visibleOnDesk: true,
        projects: [{ name: "Godot Spaceships" }, { name: "Workhorse Dev" }],
      }),
    ),
    null,
  );
  const confirmed = parseRenameProjectLive(
    JSON.stringify({
      ok: true,
      name: "Spaceship game",
      requested: "Spaceship game",
      visibleOnDesk: true,
      projects: [{ name: "Spaceship game" }, { name: "Workhorse Dev" }],
    }),
  );
  assert.equal(confirmed?.name, "Spaceship game");
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /Visible sidebar names/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /applyRenameDeskChat/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /applyRenameDeskProject/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8"), /workhorse_rename_chat/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8"), /workhorse_rename_project/);
  assert.match(readFileSync(path.join(ROOT, "electron", "custom-tools.ts"), "utf8"), /workhorse_rename_project/);
});

test("move-chat and delete desk tools hit the live hook", async () => {
  const seen: string[] = [];
  setWorkhorseDeskAsk(async (ask) => {
    seen.push(`${ask.action}:${ask.fromSessionId}:${ask.name ?? ""}:${ask.chat ?? ""}:${ask.chats ?? ""}`);
    if (ask.action === "rename-project") {
      return {
        text: JSON.stringify({
          ok: true,
          name: ask.name,
          requested: ask.name,
          visibleOnDesk: true,
          projects: [{ name: "Godot Spaceships" }, { name: "Workhorse Dev" }],
        }),
      };
    }
    return { text: JSON.stringify({ ok: true, action: ask.action, fromSessionId: ask.fromSessionId }) };
  });
  try {
    const moved = await handleWorkhorseRpc(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "workhorse_move_chat", arguments: { project: "Spaceship Battles" } },
      },
      { fromSessionId: "sess_mini" },
    );
    const deleted = await handleWorkhorseRpc(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "workhorse_delete_project", arguments: { project: "Spaceship Battles", chats: "keep" } },
      },
      { fromSessionId: "sess_mini" },
    );
    const movedText =
      (moved as { result?: { content?: Array<{ text?: string }> } })?.result?.content
        ?.map((item) => item.text ?? "")
        .join("\n") ?? "";
    const deletedText =
      (deleted as { result?: { content?: Array<{ text?: string }> } })?.result?.content
        ?.map((item) => item.text ?? "")
        .join("\n") ?? "";
    assert.match(movedText, /sess_mini/);
    assert.match(deletedText, /sess_mini/);
    assert.ok(seen.some((row) => row.startsWith("move-chat:sess_mini:Spaceship Battles")));
    assert.ok(seen.some((row) => row.startsWith("delete-project:sess_mini:Spaceship Battles")));
    const self = await handleWorkhorseRpc(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "workhorse_delete_chat", arguments: {} },
      },
      { fromSessionId: "sess_mini" },
    );
    const selfMessage = (self as { error?: { message?: string } })?.error?.message ?? "";
    assert.match(selfMessage, /onlyThis=true|chat title or id is required/i);
    const lied = await handleWorkhorseRpc(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "workhorse_rename_project", arguments: { name: "Spaceship game" } },
      },
      { fromSessionId: "sess_mini" },
    );
    const liedMessage = (lied as { error?: { message?: string } })?.error?.message ?? "";
    assert.match(liedMessage, /did not take/i);
    assert.match(liedMessage, /Do not tell the user it is named/);
    const listedBots = await handleWorkhorseRpc(
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "workhorse_list_bots", arguments: {} } },
      { fromSessionId: "sess_mini" },
    );
    const listedText =
      (listedBots as { result?: { content?: Array<{ text?: string }> } })?.result?.content
        ?.map((item) => item.text ?? "")
        .join("\n") ?? "";
    assert.match(listedText, /ok|MiniMax|Callable|bots/i);
    assert.ok(seen.some((row) => row.startsWith("list:")));
  } finally {
    setWorkhorseDeskAsk(null);
  }
});

test("project home lists edited files from write tools, not Choose a brain", () => {
  assert.equal(isWriteToolTitle("Write"), true);
  assert.equal(isWriteToolTitle("Edit file"), true);
  assert.equal(isWriteToolTitle("Read"), false);
  assert.equal(isWriteToolTitle("Applying patch"), true);
  assert.equal(isWriteToolTitle("apply_patch · completed"), true);
  assert.equal(isWriteToolTitle("Updated workhorse.test.ts"), true);
  assert.equal(isWriteToolTitle("Reading workhorse.test.ts"), false);
  assert.equal(
    fileFolderFromPath("C:/Users/lgovo/Projects/Go7-Workhorse/src/ui/UsagePane.tsx", [
      "C:/Users/lgovo/Projects/Go7-Workhorse",
    ]),
    "src/ui",
  );

  const noon = new Date(2026, 7, 12, 16, 18, 0).getTime();
  const edits = projectEdits(
    [
      {
        id: "s1",
        projectId: "p1",
        provider: "grok",
        model: "grok-4.6",
        effort: "high",
        title: "Usage",
        mode: "ask",
        sandbox: "off",
        status: "idle",
        contextUsed: 0,
        messages: [
          { id: "t1", role: "system", kind: "tool", text: "Write · completed — src/ui/UsagePane.tsx", createdAt: noon },
          { id: "t2", role: "system", kind: "tool", text: "Write · completed — src/ui/UsagePane.tsx", createdAt: noon + 1000 },
          { id: "t3", role: "system", kind: "tool", text: "Read · completed — src/ui/UsagePane.tsx", createdAt: noon + 2000 },
          { id: "t4", role: "system", kind: "tool", text: "Edit · completed — src/lib/usage.ts", createdAt: noon - 60_000 },
          {
            id: "t6",
            role: "system",
            kind: "tool",
            text: "Write `C:\\\\Users\\\\lgovo\\\\Projects\\\\Go7-Workhorse\\\\WALK-TEST-EDIT.md` · completed",
            createdAt: noon + 3000,
          },
        ],
      },
      {
        id: "s2",
        projectId: "p1",
        provider: "claude",
        model: "claude-opus",
        effort: "medium",
        title: "Home",
        mode: "ask",
        sandbox: "off",
        status: "idle",
        contextUsed: 0,
        messages: [
          {
            id: "t5",
            role: "system",
            kind: "tool",
            text: "Write · completed — src/ui/ProjectHome.tsx",
            createdAt: noon - 86_400_000,
          },
        ],
      },
    ],
    ["C:\\\\proj"],
  );
  assert.equal(
    pathFromWriteTool("Write `C:\\\\Users\\\\lgovo\\\\Projects\\\\Go7-Workhorse\\\\WALK-TEST-EDIT.md` · completed"),
    "C:\\\\Users\\\\lgovo\\\\Projects\\\\Go7-Workhorse\\\\WALK-TEST-EDIT.md",
  );
  assert.equal(edits.length, 4);
  assert.equal(edits[0].name, "WALK-TEST-EDIT.md");
  assert.equal(edits[1].name, "UsagePane.tsx");
  assert.equal(edits[1].edits, 2);
  assert.equal(edits[1].provider, "grok");
  const patched = projectEdits(
    [
      {
        id: "s3",
        projectId: "p1",
        provider: "codex",
        model: "gpt-5.6-terra",
        effort: "medium",
        title: "Patch",
        mode: "ask",
        sandbox: "off",
        status: "idle",
        contextUsed: 0,
        messages: [
          {
            id: "t7",
            role: "system",
            kind: "tool",
            text: "Applying patch · completed — test/workhorse.test.ts",
            createdAt: noon,
          },
        ],
      },
    ],
    ["C:/proj"],
  );
  assert.equal(patched[0]?.name, "workhorse.test.ts");
  const merged = mergeEdits(patched, [
    {
      path: "C:/proj/test/workhorse.test.ts",
      name: "workhorse.test.ts",
      folder: "test",
      edits: 1,
      at: noon + 10,
      provider: "codex",
    },
  ]);
  assert.equal(merged.length, 1);
  assert.match(merged[0].path, /workhorse\.test\.ts$/);
  assert.equal(
    sameEditPath(
      "electron/app-update.ts",
      "C:\\Users\\lgovo\\Projects\\Go7-Workhorse\\electron\\app-update.ts",
    ),
    true,
  );
  const twins = projectEdits(
    [
      {
        id: "s4",
        projectId: "p1",
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "medium",
        title: "Twin",
        mode: "ask",
        sandbox: "off",
        status: "idle",
        contextUsed: 0,
        messages: [
          {
            id: "t8",
            role: "system",
            kind: "tool",
            text: "Write · completed — electron/app-update.ts",
            createdAt: noon,
          },
          {
            id: "t9",
            role: "system",
            kind: "tool",
            text: "Write · completed — C:\\Users\\lgovo\\Projects\\Go7-Workhorse\\electron\\app-update.ts",
            createdAt: noon + 1,
          },
        ],
      },
    ],
    ["C:\\Users\\lgovo\\Projects\\Go7-Workhorse"],
  );
  assert.equal(twins.length, 1);
  assert.equal(twins[0]?.name, "app-update.ts");
  assert.equal(edits[3].provider, "claude");
  assert.equal(formatEditWhen(noon - 86_400_000, noon), "yesterday");

  const home = readFileSync(path.join(ROOT, "src", "ui", "ProjectHome.tsx"), "utf8");
  assert.match(home, /Project/);
  assert.match(home, /Edited/);
  assert.match(home, /projectEdits/);
  assert.match(home, /FileReview/);
  assert.match(home, /EditedList/);
  assert.match(home, /editStats/);
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  assert.match(pane, /EditedList/);
  assert.match(pane, /FileReview/);
  assert.match(pane, /projectEdits\(\[session\]/);
  assert.match(pane, /\{project \? \(/);
  assert.match(pane, /project && terminalOpen && cwd/);
  assert.match(pane, /file-review overlay|overlay/);
  assert.doesNotMatch(pane, /if \(open\) \{\s*return \(/);
  assert.match(pane, /compact/);
  assert.match(pane, /session-edits/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "EditedList.tsx"), "utf8"), /edited-toggle/);
  const review = readFileSync(path.join(ROOT, "src", "ui", "FileReview.tsx"), "utf8");
  assert.match(review, /Source/);
  assert.match(review, /Diff/);
  assert.match(review, /Filter files/);
  assert.match(review, /file-review-code/);
  assert.match(review, /file-review-tab-row/);
  assert.match(review, /openFile/);
  assert.match(review, /closeTab/);
  assert.match(review, /preferSource \? "source" : "diff"/);
  assert.match(review, /preferSource/);
  assert.match(review, /onTracked/);
  assert.match(review, /overlay/);
  assert.match(review, /file-review-close/);
  assert.match(review, /File not found/);
  assert.match(review, /rootKey = roots\.join/);
  assert.match(review, /\.catch\(/);
  assert.match(review, /buildFileDiff/);
  assert.match(review, /sameEditPath/);
  assert.match(review, /mergeEdits\(files/);
  assert.doesNotMatch(review, /\[file\.path, roots\]/);
  assert.match(pane, /fileRoots = useMemo/);
  assert.match(pane, /mergeEdits\(open \? \[open\]/);
  assert.match(pane, /fileRootKey/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.diff-line\.add/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.file-review-code/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.file-review\.overlay/);
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  const overlayZ = Number(css.match(/\.file-review\.overlay\s*\{[^}]*z-index:\s*(\d+)/)?.[1] ?? 0);
  const headerZ = Number(css.match(/\.session-header\s*\{[^}]*z-index:\s*(\d+)/)?.[1] ?? 0);
  const composerZ = Number(css.match(/\.composer-wrap\s*\{[^}]*z-index:\s*(\d+)/)?.[1] ?? 0);
  assert.ok(overlayZ > headerZ, `overlay ${overlayZ} should beat header ${headerZ}`);
  assert.ok(overlayZ > composerZ, `overlay ${overlayZ} should beat composer ${composerZ}`);
  assert.match(readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8"), /project:file-diff/);
  assert.match(readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8"), /project:resolve-file/);
  assert.match(readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8"), /fileDiff/);
  assert.match(readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8"), /resolveFile/);
  assert.match(home, /empty="No edits\."/);
  assert.match(home, /archiveProject/);
  assert.match(home, /deleteProject/);
  assert.match(home, /Move chats to Chats/);
  assert.match(home, /Delete chats/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "Sidebar.tsx"), "utf8"), /Archived projects/);
  assert.doesNotMatch(home, /Choose a brain/);
  assert.doesNotMatch(home, /provider-grid/);
  assert.doesNotMatch(home, /PROVIDERS/);
});

test("delete project can keep chats in the loose list or remove them", () => {
  const project = emptyProject("Walk Test");
  const archived = applyArchiveProject([project], project.id, true, 10);
  assert.equal(archived?.[0]?.archivedAt, 10);
  assert.equal(applyArchiveProject([project], project.id, false)?.[0]?.archivedAt, null);
  assert.equal(applyDeleteProject([project], project.id)?.length, 0);
  const sessions = [
    { id: "in", projectId: project.id },
    { id: "kid", projectId: project.id, parentId: "in" },
    { id: "loose", projectId: undefined as string | undefined },
  ];
  const kept = applyProjectChatFate(sessions, project.id, "keep");
  assert.equal(kept.find((item) => item.id === "in")?.projectId, undefined);
  assert.equal(kept.length, 3);
  const gone = applyProjectChatFate(sessions, project.id, "remove");
  assert.deepEqual(gone.map((item) => item.id), ["loose"]);
});

test("file diffs count added and deleted lines from real before/after text", () => {
  const created = lineDiff("", "Walk Test edit landed.\n");
  assert.deepEqual(countLineChanges(created), { added: 1, deleted: 0 });
  const changed = lineDiff("keep\nold\n", "keep\nnew\n");
  assert.equal(changed.some((line) => line.kind === "same" && line.text === "keep"), true);
  assert.equal(changed.some((line) => line.kind === "del" && line.text === "old"), true);
  assert.equal(changed.some((line) => line.kind === "add" && line.text === "new"), true);
  assert.deepEqual(countLineChanges(changed), { added: 1, deleted: 1 });
  assert.equal(formatDiffStat(2, 1), "+2  −1");

  const built = buildFileDiff(path.join("proj", "WALK-TEST-EDIT.md"), "", "Walk Test edit landed.\n");
  assert.equal(built.name, "WALK-TEST-EDIT.md");
  assert.equal(built.added, 1);
  assert.equal(built.deleted, 0);

  const repoRoot = path.resolve(os.tmpdir(), "wh-diff-repo");
  const abs = path.join(repoRoot, "WALK-TEST-EDIT.md");
  assert.equal(isAbsolutePath(abs), true);
  assert.equal(isAbsolutePath("C:\\repo\\WALK-TEST-EDIT.md"), true);
  const live = readFileDiff(abs, [repoRoot], {
    existsSync: (file) => file === abs || file.endsWith(`${path.sep}.git`),
    readFile: (file) => (file === abs ? "Walk Test edit landed.\n" : ""),
    gitShow: () => null,
  });
  assert.equal(live.added, 1);
  assert.equal(live.deleted, 0);
  assert.equal(live.lines.some((line) => line.kind === "add" && line.text === "Walk Test edit landed."), true);

  assert.equal(looksLikeSourceFile("preload.ts"), true);
  assert.equal(looksLikeSourceFile("electron/preload.ts"), true);
  assert.equal(looksLikeSourceFile("https://example.com/preload.ts"), false);
  assert.equal(looksLikeSourceFile("always-approve"), false);
  const repo = path.resolve(os.tmpdir(), "wh-src-repo");
  const electronDir = path.join(repo, "electron");
  const preload = path.join(electronDir, "preload.ts");
  const found = findSourceFile("preload.ts", [repo], {
    existsSync: (file) => path.normalize(file) === path.normalize(preload),
    isDir: (file) => path.normalize(file) !== path.normalize(preload),
    readdir: (dir) => {
      const norm = path.normalize(dir);
      if (norm === path.normalize(repo)) return ["electron"];
      if (norm === path.normalize(electronDir)) return ["preload.ts"];
      return [];
    },
  });
  assert.equal(path.normalize(found ?? ""), path.normalize(preload));
  const crowdedRepo = path.join(os.tmpdir(), "wh-crowded-source-repo");
  const crowdedProject = path.join(crowdedRepo, "src", "lib", "project.ts");
  const decoys = Array.from({ length: 900 }, (_, index) => `decoy-${String(index).padStart(4, "0")}.txt`);
  const crowded = findSourceFile("project.ts", [crowdedRepo], {
    existsSync: (file) => file === crowdedRepo || file === crowdedProject || file === path.dirname(crowdedProject) || file === path.join(crowdedRepo, "src"),
    isDir: (file) => file === crowdedRepo || file === path.dirname(crowdedProject) || file === path.join(crowdedRepo, "src"),
    readdir: (dir) => {
      if (dir === crowdedRepo) return [...decoys, "src"];
      if (dir === path.join(crowdedRepo, "src")) return ["lib"];
      if (dir === path.dirname(crowdedProject)) return ["project.ts"];
      return [];
    },
  });
  assert.equal(crowded, crowdedProject);
  const realProject = findSourceFile("project.ts", [ROOT]);
  assert.match(realProject ?? "", /src[\\/]+lib[\\/]+project\.ts$/i);
  const projectDiff = readFileDiff("project.ts", [ROOT]);
  assert.match(projectDiff.after, /export function/);
  assert.ok(projectDiff.lines.length > 10);

  let gitCalls = 0;
  const lockedAbs = path.join(repoRoot, "electron", "app-update.ts");
  const locked = readFileDiff(lockedAbs, [repoRoot], {
    existsSync: (file) =>
      file === lockedAbs || file.endsWith(`${path.sep}.git`) || file.endsWith(`${path.sep}index.lock`),
    readFile: (file) => (file === lockedAbs ? "export const n = 1;\n" : ""),
    gitShow: () => {
      gitCalls += 1;
      return "old\n";
    },
  });
  assert.equal(gitCalls, 0);
  assert.match(locked.after, /export const n/);
  assert.match(readFileSync(path.join(ROOT, "electron", "project-diff.ts"), "utf8"), /no-optional-locks/);
  assert.match(readFileSync(path.join(ROOT, "electron", "project-diff.ts"), "utf8"), /index\.lock/);
  assert.match(readFileSync(path.join(ROOT, "electron", "project-diff.ts"), "utf8"), /os\.homedir/);
  const looseStats = readFileDiff("electron/main.ts", [ROOT]);
  assert.ok(looseStats.after.length > 0);

  // With no cwd worth searching, the lookup falls back to the usual project
  // homes. Stub that tree: asserting against the real one only passes on a
  // machine that happens to keep its checkouts in ~/workspace.
  const homeDir = os.homedir();
  const wsRoot = path.join(homeDir, "workspace");
  const wsRepo = path.join(wsRoot, "demo-repo");
  const wsElectron = path.join(wsRepo, "electron");
  const wsMain = path.join(wsElectron, "main.ts");
  const known = new Set([wsRoot, wsRepo, wsElectron, wsMain].map((item) => path.normalize(item)));
  const previousCwd = process.cwd();
  try {
    process.chdir(path.parse(previousCwd).root);
    const fromRoot = findSourceFile("electron/main.ts", [], {
      existsSync: (file) => known.has(path.normalize(file)),
      isDir: (file) => path.normalize(file) !== path.normalize(wsMain),
      readdir: (dir) => {
        const norm = path.normalize(dir);
        if (norm === path.normalize(wsRoot)) return ["demo-repo"];
        if (norm === path.normalize(wsRepo)) return ["electron"];
        if (norm === path.normalize(wsElectron)) return ["main.ts"];
        return [];
      },
    });
    assert.match(fromRoot ?? "", /electron[\\/]+main\.ts$/i);
    // The filesystem root itself is never a search root.
    assert.equal(findSourceFile("electron/main.ts", [], { existsSync: () => false, isDir: () => true, readdir: () => [] }), null);
  } finally {
    process.chdir(previousCwd);
  }
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8"), /editStats\([\s\S]*fileRoots/);
});

test("empty chats stay drafts until the first send names them", () => {
  const draft: Session = {
    id: "draft_1",
    projectId: null,
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "New chat",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [],
    contextUsed: 0,
  };
  const named: Session = {
    ...draft,
    id: "live_1",
    title: "Login Fix",
    messages: [{ id: "u", role: "user", text: "fix login", createdAt: 1 }],
  };
  assert.equal(isDraftChat(draft), true);
  assert.equal(isDraftChat(named), false);
  assert.deepEqual(listedChats([draft, named]).map((item) => item.id), ["live_1"]);
  const reused = openDraft([draft, named], { ...draft, id: "draft_2", model: "grok-4.5", mode: "plan", sandbox: "strict" });
  assert.equal(reused.session.id, "draft_1");
  assert.equal(reused.session.model, "grok-4.5");
  assert.equal(reused.session.mode, "plan");
  assert.equal(reused.session.sandbox, "strict");
  const queued = enqueuePrompt([named], "live_1", { text: "then add the bot" });
  assert.equal(queued?.[0].queue?.length, 1);
  assert.equal(queued?.[0].queue?.[0]?.text, "then add the bot");
  assert.ok(queued?.[0].messages.some((message) => message.role === "user" && message.text === "then add the bot"));
  assert.ok(queued?.[0].queue?.[0]?.userMessageId);
  const hiddenJoin = enqueuePrompt([named], "live_1", { text: "ORCHESTRATION CALL\n- User: hi", hideUser: true });
  assert.ok(!hiddenJoin?.[0].messages.some((message) => message.text.includes("ORCHESTRATION CALL")));
  const shifted = shiftQueuedPrompt(queued!, "live_1");
  assert.equal(shifted?.item.text, "then add the bot");
  assert.equal(shifted?.sessions[0]?.queue?.length ?? 0, 0);
  assert.equal(dropQueuedPrompt(queued!, "live_1", queued![0].queue![0].id)?.[0].queue?.length ?? 0, 0);
  assert.ok(!dropQueuedPrompt(queued!, "live_1", queued![0].queue![0].id)?.[0].messages.some((message) => message.text === "then add the bot"));
  const composer = readFileSync(path.join(ROOT, "src", "ui", "Composer.tsx"), "utf8");
  assert.match(composer, /Steer/);
  assert.match(composer, /Queue for next/);
  assert.match(composer, /if \(!value\) \{\s*el\.style\.height = ""/);
  assert.match(
    readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"),
    /textarea:placeholder-shown \{[\s\S]*text-overflow: ellipsis/,
  );
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /steer: true/);
  assert.equal(reused.sessions.filter((item) => isDraftChat(item)).length, 1);
  assert.deepEqual(dropDrafts([draft, named]).map((item) => item.id), ["live_1"]);
  const typing: Session = { ...draft, id: "draft_typed", composerDraft: "leave this here" };
  assert.equal(hasComposerDraft(typing), true);
  assert.equal(isDraftChat(typing), false);
  assert.deepEqual(listedChats([typing, named]).map((item) => item.id), ["draft_typed", "live_1"]);
  assert.deepEqual(dropDrafts([typing, named]).map((item) => item.id), ["draft_typed", "live_1"]);
  const reusedEmpty = openDraft([typing, named], { ...draft, id: "draft_3" });
  assert.equal(reusedEmpty.session.id, "draft_3");
  const catalog = catalogSessions({
    sessions: [
      { id: "draft_1", title: "New chat", messages: [] },
      { id: "live_1", title: "Login Fix", messages: [{ role: "user", text: "fix login" }] },
    ],
  });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.id, "live_1");
});

test("sidebar nests project chats in folders; top New chat stays loose", async () => {
  const sidebar = readFileSync(path.join(ROOT, "src", "ui", "Sidebar.tsx"), "utf8");
  assert.match(sidebar, /brand-mark/);
  assert.doesNotMatch(sidebar, /brand-mark-btn on/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.brand-mark-btn:active/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.brand-mark-btn\.on/);
  assert.match(sidebar, /go7-workhorse-transparent/);
  assert.match(sidebar, /APP_VERSION/);
  assert.match(sidebar, /SettingsPulse/);
  assert.match(sidebar, /deskPulseLines/);
  assert.doesNotMatch(sidebar, /profile, LLMs, watch/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /settings-pulse/);
  const pulse = deskPulseLines({
    usage: [
      {
        at: Date.now(),
        inputTokens: 1200,
        outputTokens: 300,
      },
    ],
    sessions: [
      { hidden: false },
      { hidden: true, parentId: "p" },
      { archivedAt: 1 },
    ],
  });
  assert.ok(pulse.some((line) => /today/.test(line.text)));
  assert.ok(pulse.some((line) => /tokens/.test(line.text)));
  assert.ok(pulse.some((line) => /in ·/.test(line.text)));
  assert.ok(pulse.some((line) => line.text === "1 chat"));
  assert.ok(pulse.some((line) => line.text === "1 turn"));
  const welcome = readFileSync(path.join(ROOT, "src", "ui", "Welcome.tsx"), "utf8");
  assert.match(welcome, /go7-workhorse-transparent/);
  assert.match(welcome, /APP_VERSION/);
  assert.match(welcome, /Getting started/);
  assert.match(welcome, /Recognized harnesses/);
  assert.match(welcome, /Manage harnesses/);
  assert.doesNotMatch(welcome, />\s*7\s*</);
  assert.doesNotMatch(welcome, /Type \/ for commands/);
  assert.doesNotMatch(welcome, /—/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "app-info.ts"), "utf8"), /package\.json/);
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  assert.match(sidebar, /function ProjectFolder/);
  assert.match(sidebar, /className=\{`project-folder/);
  assert.match(sidebar, /useProjectSessions\(project\.id\)/);
  assert.match(sidebar, /startSession\(project\.id\)/);
  assert.match(sidebar, /startSession\(null\)/);
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const addBot = readFileSync(path.join(ROOT, "src", "ui", "AddBot.tsx"), "utf8");
  const storeSource = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(settings, /llm-brains/);
  assert.match(settings, /llm-mark plus/);
  assert.match(settings, /Add bot/);
  assert.match(settings, /openAddBot/);
  assert.match(storeSource, /panel: "add-bot"/);
  assert.match(storeSource, /custom: structuredClone\(EMPTY_CUSTOM_DRAFT\)/);
  assert.doesNotMatch(settings, /ADD_VENDORS/);
  assert.doesNotMatch(settings, /Prefill MiniMax/);
  assert.match(settings, /DESK_STOCK/);
  assert.match(settings, /setLlmEnabled/);
  assert.match(settings, /Disable \$\{name\}/);
  assert.match(settings, /setCustomBotEnabled\(bot\.id, !live\)/);
  assert.match(settings, /llm-brain-open/);
  assert.match(settings, /setCustomBotEnabled/);
  assert.match(settings, /updateCustomBot/);
  assert.match(settings, /updateLlmLink/);
  assert.match(settings, /BotForm/);
  assert.match(settings, /identityOnly/);
  assert.match(settings, /StockBotDetail/);
  assert.match(settings, /CustomBotDetail/);
  assert.match(settings, /Disable/);
  assert.match(settings, /Delete/);
  assert.match(settings, /Test API/);
  assert.match(settings, /setLlmConnected/);
  const botForm = readFileSync(path.join(ROOT, "src", "ui", "BotForm.tsx"), "utf8");
  assert.match(botForm, /Bot name/);
  assert.match(botForm, /Color/);
  assert.match(botForm, /bot-swatch/);
  assert.match(botForm, /Base URL/);
  assert.match(botForm, /API key/);
  assert.match(botForm, /Context window/);
  assert.match(botForm, /identityOnly/);
  assert.match(botForm, /Default color/);
  assert.match(botForm, /More colors/);
  assert.match(botForm, /ColorWheel/);
  assert.match(botForm, /wheelOpen/);
  const wheel = readFileSync(path.join(ROOT, "src", "ui", "ColorWheel.tsx"), "utf8");
  assert.match(wheel, /color-wheel-disk/);
  assert.match(wheel, /Brightness/);
  assert.match(wheel, /Hex color/);
  assert.match(css, /\.color-wheel-disk/);
  assert.match(css, /\.bot-swatch\.wheel-toggle/);
  assert.match(storeSource, /applyUpdateCustomBot/);
  assert.match(storeSource, /updateCustomBot,/);
  assert.match(storeSource, /probeCustomBot/);
  assert.match(addBot, /Add a bot/);
  assert.match(addBot, /Add to desk/);
  assert.match(addBot, /Remove from desk/);
  assert.match(addBot, /Your own/);
  assert.doesNotMatch(addBot, /Prefill MiniMax/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "BotForm.tsx"), "utf8"), /Provider/);
  assert.match(addBot, /createCustomBot/);
  assert.match(addBot, /CATALOG/);
  assert.match(addBot, /addBotChoices/);
  assert.match(addBot, /choices.length === 1/);
  assert.match(addBot, /item.id === "own" \|\| !llms\[item.id\]\?\.connected/);
  const { addBotChoices } = await import("../src/ui/AddBot.tsx");
  assert.deepEqual(
    addBotChoices({
      grok: { connected: true },
      codex: { connected: true },
      claude: { connected: true },
      cursor: { connected: true },
    }).map((item) => item.id),
    ["own"],
  );
  assert.deepEqual(
    addBotChoices({
      grok: { connected: true },
      codex: { connected: false },
      claude: { connected: true },
      cursor: { connected: true },
    }).map((item) => item.id),
    ["codex", "own"],
  );
  assert.doesNotMatch(addBot, /on desk/);
  assert.doesNotMatch(settings, /chip-list/);
  assert.doesNotMatch(settings, /MCP servers/);
  assert.doesNotMatch(settings, /Workhorse does not host MCP/);
  assert.match(sidebar, /project-new/);
  assert.match(sidebar, /function LooseChats/);
  assert.match(sidebar, /section-label">Projects[\s\S]*<LooseChats/);
  assert.doesNotMatch(sidebar, /nest-new/);
  assert.match(pane, /canPlaceInProject/);
  assert.match(pane, /PlaceInProject/);
  assert.match(css, /\.project-chats/);
  assert.match(css, /\.place-project/);
  assert.match(sidebar, /Show more/);
  assert.match(sidebar, /nested\.length > PROJECT_CHAT_LIMIT && hidden > 0/);
  assert.match(sidebar, /settingsOpen/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "ChatRow.tsx"), "utf8"), /panel !== "settings"/);
  assert.equal(PROJECT_CHAT_LIMIT, 5);
  const rows = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id: String(id) }));
  assert.deepEqual(visibleProjectChats(rows, false).map((item) => item.id), ["1", "2", "3", "4", "5"]);
  assert.deepEqual(visibleProjectChats(rows, false, "7").map((item) => item.id), ["1", "2", "3", "4", "7"]);
  assert.equal(visibleProjectChats(rows, true).length, 7);
  assert.equal(hiddenProjectChatCount(7, false), 2);
});

test("color wheel maps hue and hex precisely", () => {
  assert.deepEqual(parseHex("#0a84ff"), [10, 132, 255]);
  assert.equal(hsvToHex(0, 1, 1), "#ff0000");
  assert.equal(hsvToHex(120, 1, 1), "#00ff00");
  assert.equal(colorFromWheel(80, 0, 80, 1), "#ff0000");
  assert.equal(colorFromWheel(0, 0, 80, 1), "#ffffff");
  const back = hexToHsv("#30d158");
  assert.ok(back);
  assert.equal(hsvToHex(back!.h, back!.s, back!.v), "#30d158");
});

test("desk bots keep disable and leave the desk on delete", () => {
  const settings = normalizeSettings({
    llms: {
      grok: { connected: true, enabled: false, available: true },
      codex: { connected: false, available: true },
    },
    customBots: [
      {
        id: "bot_minimax",
        name: "MiniMax M3",
        color: "#0071e3",
        baseUrl: "https://api.minimax.io/anthropic",
        model: "MiniMax-M2.5",
        apiKey: "sk-test",
        api: "anthropic-messages",
        contextWindow: 200_000,
        createdAt: 1,
        enabled: false,
      },
    ],
  });
  assert.equal(settings.llms.grok.connected, true);
  assert.equal(settings.llms.grok.enabled, false);
  assert.equal(vendorEnabled(settings.llms.grok), false);
  assert.equal(vendorEnabled(settings.llms.codex), false);
  assert.equal(settings.llms.codex.available, true);
  assert.equal(customBotEnabled(settings.customBots[0]), false);
  assert.equal(vendorEnabled({ connected: true }), true);
  assert.equal(hasAttachedLlm(normalizeSettings({})), false);
  assert.equal(firstAttachedChoice(normalizeSettings({})), null);
  assert.equal(
    vendorAttachedForSession({ provider: "grok" }, normalizeSettings({})),
    false,
  );
  const painted = normalizeSettings({
    llms: { claude: { connected: true, name: "Clay", color: "#ff9f0a" } },
  });
  assert.equal(firstAttachedChoice(painted)?.provider, "claude");
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "ModelMenu.tsx"), "utf8"), /Attach LLM/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /firstAttachedChoice/);
  assert.equal(vendorLabel("claude", painted.llms.claude), "Clay");
  assert.equal(vendorTint("claude", painted.llms.claude), "#ff9f0a");
  assert.equal(vendorLabel("grok", painted.llms.grok), "Grok");
  assert.equal(applyUpdateStockBot(painted.llms.claude, { name: "  ", color: "" }).name, undefined);
  assert.equal(applyUpdateStockBot(painted.llms.claude, { color: "#30d158" }).color, "#30d158");
  const nativeCodex = normalizeSettings({
    llms: {
      codex: {
        connected: true,
        accessDefaults: { mode: "always-approve", sandbox: "off" },
      },
    },
  });
  assert.deepEqual(firstAttachedChoice(nativeCodex), {
    provider: "codex",
    model: defaultModel("codex").id,
    effort: "medium",
    sandbox: "off",
    mode: "always-approve",
  });
  assert.equal(
    deskInk(
      { provider: "custom", customBotId: "bot_minimax" },
      { customBots: settings.customBots, llms: settings.llms },
    ),
    "#0071e3",
  );
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /available: Boolean\(grok.connected\)/);
  assert.match(store, /available: Boolean\(detected.connected\)/);
  assert.doesNotMatch(
    store.slice(store.indexOf("const refreshGrokLogin"), store.indexOf("const refreshCodexLogin")),
    /grok: \{ connected: Boolean/,
  );
});

test("weekDays is Monday-first and modelsForProvider keeps catalog rows at zero", () => {
  const monday = Date.UTC(2026, 7, 10, 12, 0, 0);
  const days = weekDays(
    [
      {
        id: "u1",
        at: monday,
        provider: "grok",
        model: "grok-4.6",
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
    monday,
  );
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((day) => day.letter), [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ]);
  assert.equal(days[0].totalTokens, 1000);
  assert.equal(days[1].totalTokens, 0);

  const rows = modelsForProvider([], "claude");
  assert.ok(rows.some((row) => row.label === "Opus 5" && row.totalTokens === 0));
  assert.ok(rows.some((row) => row.label === "Sonnet 5"));
});

test("stretchBuckets follows today week month and all", () => {
  const noon = new Date(2026, 7, 12, 12, 0, 0).getTime();
  const sample = (at: number) => ({
    id: `u_${at}`,
    at,
    provider: "grok" as const,
    model: "grok-4.6",
    inputTokens: 100,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const today = stretchBuckets([sample(noon)], "today", noon);
  assert.equal(today.length, 4);
  assert.deepEqual(today.map((item) => item.letter), ["Night", "Morning", "Afternoon", "Evening"]);
  assert.equal(today[2].totalTokens, 100);

  const month = stretchBuckets([sample(noon)], "month", noon);
  assert.ok(month.length >= 4 && month.length <= 5);
  assert.equal(month[1].letter, "8–14");
  assert.equal(month[1].totalTokens, 100);

  const all = stretchBuckets([sample(noon)], "all", noon);
  assert.equal(all.length, 12);
  assert.equal(all[11].letter, "A");
  assert.equal(all[11].totalTokens, 100);

  const mixed = [
    sample(noon),
    {
      ...sample(noon + 1),
      id: "u_claude",
      provider: "claude" as const,
      model: "opus",
      inputTokens: 40,
      outputTokens: 20,
    },
  ];
  const todayDots = stretchHeatmap(mixed, "today", noon);
  assert.equal(todayDots.rows, 1);
  assert.equal(todayDots.columns.length, 24);
  assert.equal(todayDots.columns[12][0].label, "12 PM");
  assert.equal(todayDots.columns[0][0].label, "12 AM");
  assert.deepEqual(
    todayDots.labels.map((item) => item.text),
    ["12 AM", "6 AM", "12 PM", "6 PM"],
  );
  assert.equal(todayDots.columns[12][0].tokens, 160);
  assert.equal(todayDots.columns[12][0].inputTokens, 140);
  assert.equal(todayDots.columns[12][0].outputTokens, 20);
  assert.equal(todayDots.columns[12][0].bots.length, 2);
  assert.equal(todayDots.columns[12][0].bots[0].provider, "grok");
  assert.equal(todayDots.columns[12][0].bots[0].tokens, 100);
  assert.equal(todayDots.columns[12][0].bots[1].provider, "claude");
  assert.equal(todayDots.columns[12][0].bots[1].tokens, 60);
  assert.equal(heatLevel(100, 100), 4);
  const mixedFill = cellDotBackground(todayDots.columns[12][0], 160, "today");
  assert.match(mixedFill ?? "", /conic-gradient\(from -90deg/);
  assert.match(mixedFill ?? "", /var\(--grok\)/);
  assert.match(mixedFill ?? "", /var\(--claude\)/);
  assert.match(mixedFill ?? "", /62\.5%/);
  assert.match(cellDotBackground(todayDots.columns[12][0], 160, "week") ?? "", /conic-gradient\(from -90deg/);
  assert.match(cellDotBackground(todayDots.columns[12][0], 160, "month") ?? "", /conic-gradient\(from -90deg/);
  assert.match(cellDotBackground(todayDots.columns[12][0], 160, "all") ?? "", /conic-gradient\(from -90deg/);
  const grokOnly = cellDotBackground(
    { tokens: 100, bots: [{ provider: "grok", label: "Grok", tokens: 100, inputTokens: 100, outputTokens: 0 }], pad: false },
    100,
  );
  assert.equal(grokOnly, "var(--grok)");
  assert.equal(cellDotBackground(todayDots.columns[0][0], 160), undefined);
  const mini = stretchHeatmap(
    [
      {
        id: "u_mini",
        at: noon,
        provider: "custom",
        model: "MiniMax-M3",
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
    "today",
    noon,
    [{ id: "bot_minimax", name: "MiniMax", model: "MiniMax-M3", color: "#ff375f" }],
  );
  assert.equal(mini.columns[12][0].bots[0]?.color, "#ff375f");
  assert.match(cellDotBackground(mini.columns[12][0], 100) ?? "", /#ff375f/);
  const remappedMini = stretchHeatmap(
    [
      {
        id: "u_mini_grok",
        at: noon,
        provider: "grok",
        model: "MiniMax-M3",
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        id: "u_mini_custom",
        at: noon + 3 * 60 * 60 * 1000,
        provider: "custom",
        model: "MiniMax-M3",
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
    "today",
    noon,
    [{ id: "bot_minimax", name: "MiniMax", model: "MiniMax-M3", color: "#ff375f" }],
  );
  assert.equal(remappedMini.columns[12][0].bots.length, 1);
  assert.equal(remappedMini.columns[12][0].bots[0]?.label, "MiniMax");
  assert.equal(remappedMini.columns[15][0].bots[0]?.label, "MiniMax");
  assert.equal(cellDotBackground(remappedMini.columns[12][0], 100), "#ff375f");
  assert.equal(cellDotBackground(remappedMini.columns[15][0], 100), "#ff375f");

  const weekDots = stretchHeatmap([sample(noon)], "week", noon);
  assert.deepEqual(
    weekDots.labels.map((item) => item.text),
    ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  );

  const monthDots = stretchHeatmap([sample(noon)], "month", noon);
  assert.equal(monthDots.rows, 1);
  assert.equal(monthDots.columns.length, 30);
  assert.ok(monthDots.labels.length >= 1);
  assert.ok(monthDots.columns.some((column) => column[0]?.tokens === 100));

  const year = stretchHeatmap([sample(noon)], "all", noon);
  assert.equal(year.rows, 7);
  assert.ok(year.columns.length >= 48);
  assert.ok(year.labels.length >= 11);
});

test("UsagePane ships the Figma fuel-ring overview, not the old token line", () => {
  const pane = readFileSync(path.join(ROOT, "src", "ui", "UsagePane.tsx"), "utf8");
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  assert.match(settings, /UsagePane key=\{usageTick\}/);
  assert.match(settings, /id === "usage"/);
  assert.match(settings, /section !== "usage"\) setUsageTick/);
  assert.match(settings, /setUsageHome/);
  assert.match(settings, /homeSignal=\{usageHome\}/);
  assert.match(pane, /homeSignal/);
  assert.match(pane, /if \(homeSignal > 0\) setFocus\("overview"\)/);
  assert.match(pane, /usage-brains/);
  assert.match(pane, /usage-overview/);
  assert.match(pane, /FuelRing/);
  const ring = readFileSync(path.join(ROOT, "src", "ui", "FuelRing.tsx"), "utf8");
  assert.match(ring, /easeOutCubic/);
  assert.match(ring, /strokeDashoffset/);
  assert.match(css, /@keyframes fuel-in/);
  assert.match(pane, /This stretch/);
  assert.match(pane, /usage-dots/);
  assert.match(pane, /usage-tip/);
  assert.match(pane, /cellSummary/);
  assert.match(pane, /stretchHeatmap/);
  assert.match(pane, /cellDotBackground/);
  assert.match(pane, /className=\{`usage-dot/);
  assert.match(pane, /usage-dot-fill/);
  assert.match(css, /\.usage-dot-fill/);
  assert.doesNotMatch(pane, /label="Cache"/);
  assert.doesNotMatch(pane, /label="Context"/);
  assert.match(pane, /shortModelName/);
  assert.match(pane, /totalTokens > 0 \|\| row\.events > 0/);
  assert.doesNotMatch(pane, /Quiet this window/);
  assert.match(pane, /hideBots/);
  assert.match(pane, /usage-plan/);
  assert.match(pane, /Weekly allowance/);
  assert.match(pane, /leftoverForCard/);
  assert.match(pane, /planRingView/);
  assert.match(pane, /planWindowChip/);
  assert.match(pane, /usage-limits/);
  assert.match(pane, /claudeWindowTabs/);
  assert.match(pane, /setClaudeWindow/);
  assert.match(pane, /% used/);
  assert.match(pane, /Unlimited/);
  assert.match(pane, /ContextMeter/);
  assert.match(pane, /setInterval\(pull, 180_000\)/);
  assert.match(pane, /codexPlan/);
  assert.doesNotMatch(pane, /row\.totalTokens \/ peak/);
  assert.match(pane, /function modelShare/);
  assert.match(pane, /total=\{modelsTotal\}/);
  assert.match(pane, /byModel\(events, settings.customBots\)/);
  assert.match(pane, /row.color \? \{ background: row.color \}/);
  assert.match(pane, /total=\{focusedTotal\}/);
  assert.doesNotMatch(pane, /Almost all of this window/);
  assert.doesNotMatch(pane, /tokens overall/);
  assert.equal(shortModelName("grok", "grok-4.6"), "4.6");
  assert.equal(shortModelName("grok", "Grok Build"), "Build");
  assert.equal(usageToneForModel("claude-opus", "custom"), "claude");
  assert.equal(usageToneForModel("claude-opus-4-8", "grok"), "claude");
  assert.equal(usageToneForModel("Fable 5", "claude"), "claude");
  assert.equal(usageToneForModel("grok-4.6", "custom"), "grok");
  assert.equal(usageToneForModel("GPT-5.4-Mini", "custom"), "codex");
  assert.equal(usageToneForModel("MiniMax-M3", "custom"), "custom");
  const mixed = byModel([
    { id: "a", at: 1, provider: "custom", model: "claude-opus", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { id: "b", at: 2, provider: "grok", model: "claude-opus", inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ]);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].provider, "claude");
  assert.equal(mixed[0].totalTokens, 18);
  const mini = byModel(
    [
      {
        id: "c",
        at: 1,
        provider: "custom",
        customBotId: "bot_minimax",
        model: "MiniMax-M3",
        inputTokens: 20,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
    [
      {
        id: "bot_minimax",
        name: "MiniMax",
        color: "#30d158",
        baseUrl: "https://example.com",
        model: "MiniMax-M3",
        apiKey: "k",
        api: "anthropic-messages",
        contextWindow: 200_000,
        createdAt: 1,
      },
    ],
  );
  assert.equal(mini[0].provider, "custom");
  assert.equal(mini[0].color, "#30d158");
  assert.match(css, /\.fuel-ring/);
  assert.match(css, /\.usage-brains/);
  assert.match(css, /--stretch-cols: 7/);
  assert.match(css, /repeat\(var\(--stretch-cols\), minmax\(0, 1fr\)\)/);
  assert.match(css, /aspect-ratio: 1/);
  assert.match(css, /\.usage-dots\.week \.usage-dot \{[\s\S]*aspect-ratio: auto[\s\S]*height: 36px/);
  assert.match(pane, /--stretch-cols/);
  assert.match(pane, /startViewTransition/);
  assert.match(pane, /view\.startViewTransition\(apply\)/);
  assert.doesNotMatch(pane, /const startViewTransition =/);
  assert.match(pane, /setSwap\("in"\)/);
  assert.match(css, /view-transition-name: usage-stretch/);
  assert.match(css, /@keyframes stretch-cell-in/);
  assert.doesNotMatch(css, /--stretch-dot: 12px/);
  assert.doesNotMatch(css, /\.usage-dots \{[\s\S]*width: max-content/);
  assert.match(css, /\.usage-tip \{[\s\S]*position: fixed/);
  assert.match(pane, /window\.innerWidth/);
  assert.match(pane, /deskUsageCards/);
  assert.match(pane, /dense/);
});

test("Usage rings include every desk LLM even with no spend", () => {
  const cards = deskUsageCards(
    [
      {
        id: "u1",
        at: 1,
        provider: "grok",
        model: "grok-4.6",
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
    {
      llms: {
        grok: { connected: true },
        claude: { connected: true, enabled: false },
        codex: { connected: true },
      },
      customBots: [
        {
          id: "bot_mini",
          name: "MiniMax",
          color: "#30d158",
          baseUrl: "https://api.minimax.io/anthropic",
          model: "MiniMax-M3",
          apiKey: "sk",
          api: "anthropic-messages",
          contextWindow: 1_000_000,
          createdAt: 1,
        },
      ],
    },
  );
  assert.deepEqual(
    cards.map((card) => card.label),
    ["Grok", "Codex", "Claude", "MiniMax"],
  );
  assert.equal(cards.find((card) => card.label === "Claude")?.totalTokens, 0);
  assert.equal(cards.find((card) => card.label === "MiniMax")?.color, "#30d158");
  const claude = leftoverForCard(cards.find((card) => card.label === "Claude")!, {
    claude: { usedPercent: 7, leftPercent: 93, period: "weekly", prepaidBalance: 0, products: [] },
  });
  const mini = leftoverForCard(cards.find((card) => card.label === "MiniMax")!, {
    custom: {
      bot_mini: { usedPercent: 0, leftPercent: 100, period: "weekly", prepaidBalance: 0, products: [] },
    },
  });
  assert.equal(claude?.leftPercent, 93);
  assert.equal(mini?.leftPercent, 100);
  assert.equal(
    vendorUsedPercent(cards.find((card) => card.label === "Grok")!, {
      grok: { usedPercent: 60, leftPercent: 40, period: "weekly", prepaidBalance: 0, products: [] },
    }),
    60,
  );
  assert.equal(
    vendorTidePercent(cards.find((card) => card.label === "Codex")!, {
      codex: { usedPercent: 1, leftPercent: 99, period: "weekly", prepaidBalance: 0, products: [] },
    }),
    99,
  );
  assert.equal(tideNeedsDarkInk("var(--grok)", "grok", "dark"), true);
  assert.equal(tideNeedsDarkInk("var(--grok)", "grok", "light"), false);
  assert.equal(tideNeedsDarkInk("var(--grok)", "grok", "workhorse"), true);
  assert.equal(tideNeedsDarkInk("#f5f5f7", "custom", "dark"), true);
  assert.equal(tideNeedsDarkInk("#0f9d73", "codex", "dark"), false);
  const claudePlan = {
    usedPercent: 7,
    leftPercent: 93,
    period: "weekly" as const,
    prepaidBalance: 0,
    products: [
      { product: "session", label: "Current session", usagePercent: 23 },
      { product: "weekly_all", label: "All models", usagePercent: 7 },
      { product: "weekly_scoped", label: "Fable", usagePercent: 12 },
    ],
  };
  assert.deepEqual(
    claudeWindowTabs(claudePlan).map((item) => item.label),
    ["Session", "Weekly", "Fable"],
  );
  assert.equal(pickClaudeWindow(claudePlan, "session")?.usagePercent, 23);
  assert.equal(pickClaudeWindow(claudePlan, "weekly_scoped")?.label, "Fable");
  assert.equal(
    planRingView(cards.find((card) => card.label === "Claude")!, { claude: claudePlan }, "session")?.label,
    "77%",
  );
  assert.equal(
    planRingView(cards.find((card) => card.label === "Claude")!, { claude: claudePlan })?.label,
    "93%",
  );
  assert.equal(
    planRingView(cards.find((card) => card.label === "MiniMax")!, {
      custom: {
        bot_mini: { usedPercent: 0, leftPercent: 100, period: "weekly", prepaidBalance: 0, products: [] },
      },
    })?.label,
    "100%",
  );
  const miniWindows = {
    usedPercent: 0,
    leftPercent: 100,
    period: "weekly" as const,
    prepaidBalance: 0,
    products: [
      { product: "session", label: "5h", usagePercent: 17 },
      { product: "weekly", label: "Weekly", usagePercent: 0, unlimited: true },
    ],
  };
  assert.equal(planWindowChip(miniWindows), "5h: 17% · Weekly: ∞");
  assert.equal(weeklyPlanLeftover(miniWindows), 100);
  assert.equal(pickPlanWindow(miniWindows, undefined, "custom")?.label, "5h");
  assert.equal(
    planRingView(cards.find((card) => card.label === "MiniMax")!, { custom: { bot_mini: miniWindows } })?.label,
    "83%",
  );
  assert.equal(
    planRingView(cards.find((card) => card.label === "MiniMax")!, { custom: { bot_mini: miniWindows } }, "weekly")
      ?.label,
    "∞",
  );
  assert.match(formatPlanReset("2026-08-20T05:59:59Z", Date.parse("2026-08-13T16:00:00Z")), /Resets/);
  assert.deepEqual(
    deskUsageCards([], {
      llms: {
        grok: { connected: false },
        claude: { connected: false },
        codex: { connected: true },
      },
      customBots: [],
    }).map((card) => card.label),
    ["Codex"],
  );
});

test("custom MiniMax In/Out tracks on the bot card, not Grok", () => {
  assert.equal(usageProviderForSession({ provider: "custom" }), "custom");
  assert.equal(usageProviderForSession({ provider: "claude" }), "claude");
  assert.equal(usageProviderForSession({ provider: "codex" }), "codex");
  assert.equal(usageProviderForSession({ provider: "grok" }), "grok");
  assert.equal(usageProviderForSession(undefined), "grok");

  const bot = {
    id: "bot_mini",
    name: "MiniMax",
    color: "#30d158",
    baseUrl: "https://api.minimax.io/anthropic",
    model: "MiniMax-M3",
    apiKey: "sk",
    api: "anthropic-messages" as const,
    contextWindow: 1_000_000,
    createdAt: 1,
  };
  const mistagged = {
    id: "u-mini-wrong",
    at: 2,
    provider: "grok" as const,
    model: "MiniMax-M3",
    sessionId: "sess_mini",
    inputTokens: 1252,
    outputTokens: 213,
    cacheReadTokens: 114,
    cacheWriteTokens: 0,
  };
  assert.equal(customBotUsageEvents([mistagged], bot).length, 0);

  const tagged = { ...mistagged, provider: "custom" as const, customBotId: "bot_mini" };
  const matched = customBotUsageEvents([tagged], bot);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].inputTokens, 1252);
  assert.equal(matched[0].outputTokens, 213);
  assert.equal(customBotUsageEvents([tagged], { ...bot, id: "bot_other", name: "MiniMax 2" }).length, 0);

  const repaired = rehomeCustomUsage(
    [mistagged],
    [bot],
    [{ id: "sess_mini", provider: "custom", customBotId: "bot_mini", model: "MiniMax-M3" }],
  );
  assert.equal(repaired[0].provider, "custom");
  assert.equal(repaired[0].customBotId, "bot_mini");

  const cards = deskUsageCards(repaired, {
    llms: {
      grok: { connected: true },
      claude: { connected: false },
      codex: { connected: false },
    },
    customBots: [bot],
  });
  assert.equal(cards.find((card) => card.label === "MiniMax")?.inputTokens, 1252);
  assert.equal(cards.find((card) => card.label === "MiniMax")?.outputTokens, 213);
  assert.equal(cards.find((card) => card.label === "Grok")?.inputTokens, 0);

  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /usageProviderForSession\(owner\)/);
  assert.match(store, /customBotId: owner\?\.customBotId/);
  assert.match(store, /rehomeCustomUsage/);
  assert.doesNotMatch(store, /provider: owner\?\.provider === "codex" \? "codex" : "grok"/);
});

test("transcript groups tools and thoughts above the final reply", () => {
  assert.equal(formatWorked(900), "1s");
  assert.equal(formatWorked(12_000), "12s");
  assert.equal(formatWorked(75_000), "1m 15s");
  assert.equal(resolveWorkedMs(1_000, 14_000, [2_000, 20_000]), 14_000);
  assert.equal(resolveWorkedMs(1_000, undefined, [2_000, 20_000]), 19_000);
  assert.equal(resolveWorkedMs(1_000, undefined, [1_000]), undefined);

  const messages: ChatMessage[] = [
    { id: "u", role: "user", text: "hi", createdAt: 1 },
    { id: "a", role: "assistant", text: "Done.", thought: "Checking the process tree.", createdAt: 2, workedMs: 14000 },
    { id: "t1", role: "system", kind: "tool", toolCallId: "1", text: "Read · completed — guide.md", createdAt: 3 },
    { id: "t2", role: "system", kind: "tool", toolCallId: "2", text: "List · completed", createdAt: 4 },
  ];
  const blocks = groupTranscript(messages);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "user");
  assert.equal(blocks[1].type, "reply");
  if (blocks[1].type !== "reply") throw new Error("expected reply");
  assert.equal(blocks[1].assistant.text, "Done.");
  assert.equal(blocks[1].tools.length, 2);
  assert.equal(lastReplyIndex(blocks), 1);
  assert.equal(
    lastReplyIndex(
      groupTranscript([
        ...messages,
        { id: "u2", role: "user", text: "again", createdAt: 5 },
        { id: "a2", role: "assistant", text: "", createdAt: 6 },
        { id: "t3", role: "system", kind: "tool", toolCallId: "3", text: "Read · completed", createdAt: 7 },
      ]),
    ),
    3,
  );

  const huge = extractToolEvent({
    sessionUpdate: "tool_call",
    toolCallId: "x",
    title: "Get-CimInstance Win32_Process -Filter \"Name = 'grok.exe'\" | Select-Object CommandLine",
    status: "completed",
  });
  assert.equal(huge?.title, "Get-CimInstance");

  const asked = extractToolEvent({
    sessionUpdate: "tool_call",
    toolCallId: "ask_1",
    title: "workhorse_workhorse_ask_chat",
    status: "updated",
    rawInput: { chat: "Test", message: "Can you ping Terra?" },
  });
  assert.equal(asked?.title, "Asking Test");
  assert.equal(asked?.detail, "Test");

  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  const popout = readFileSync(path.join(ROOT, "src", "ui", "WorkPopout.tsx"), "utf8");
  assert.match(pane, /WorkPopout/);
  assert.match(pane, /say final/);
  assert.match(pane, /streaming/);
  assert.doesNotMatch(pane, /stream-caret/);
  assert.doesNotMatch(pane, /draft=\{live \? body/);
  assert.match(popout, /thought-live/);
  assert.doesNotMatch(pane, /className="thinking"/);
  assert.doesNotMatch(pane, /live-pill" aria-live/);
  assert.match(popout, /working ·|Still working|subagent-preview/);
  assert.match(popout, /subagent-model/);
  assert.match(popout, /subagent-scope/);
  assert.match(popout, /planStep\.title/);
  assert.match(popout, /finished/);
  assert.match(popout, /peer-work/);
  assert.match(popout, /talkingToSummary/);
  assert.match(popout, /spawn_agent/);
  assert.match(popout, /info\?\.kind === "ask" \|\| info\?\.kind === "call"/);
  assert.match(popout, /Other chats/);
  assert.doesNotMatch(popout, /Copy work/);
  assert.match(popout, /<MessageBody text=\{unsquashSentences\(thought\)\}/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8"), /isDeskNotice/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8"), /peelPlanningPreamble\(assistantText, live\)/);
  assert.doesNotMatch(
    readFileSync(path.join(ROOT, "electron", "grok-agent.ts"), "utf8"),
    /fromResult \|\| thoughts/,
  );
  assert.match(pane, /peer-live/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "ChatRow.tsx"), "utf8"), /peer-link/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.peer-work/);
  assert.equal(toolIsFinished("completed"), true);
  assert.equal(toolIsFinished("in_progress"), false);
  assert.match(pane, /lastReplyIndex/);
  assert.doesNotMatch(pane, /startedAt=\{Date\.now\(\)\}/);

  const intro = {
    id: "intro",
    role: "system" as const,
    text: "Grok · Grok 4.6 is live via Grok Build. This chat belongs to “Go7-Workhorse” and can see:\nC:\\\\proj",
    createdAt: 0,
  };
  assert.equal(isSessionIntro(intro), true);
  const withChild = groupTranscript([
    ...messages,
    {
      id: "sub",
      role: "system",
      kind: "subagent",
      text: "Codex · terra",
      subagentSessionId: "child_1",
      toolStatus: "running",
      createdAt: 8,
    },
  ]);
  assert.equal(withChild[1].type, "reply");
  if (withChild[1].type === "reply") {
    assert.equal(withChild[1].subagents.length, 1);
    assert.equal(withChild[1].subagents[0]?.subagentSessionId, "child_1");
  }
  const split = groupTranscript([
    { id: "u", role: "user", text: "call grok", createdAt: 1 },
    { id: "tool", role: "system", kind: "tool", text: "Call agent · working — Hi", createdAt: 2 },
    { id: "a1", role: "assistant", text: "Spawning now.", createdAt: 3, workedMs: 48000 },
    { id: "ok", role: "system", text: "Allowed Grok for this chat", createdAt: 4 },
    { id: "sub2", role: "system", kind: "subagent", text: "Grok", subagentSessionId: "g1", createdAt: 5 },
    { id: "a2", role: "assistant", text: "", createdAt: 6 },
  ]);
  assert.equal(split.filter((block) => block.type === "reply").length, 1);
  const synthesis = groupTranscript([
    { id: "u", role: "user", text: "call subagents", createdAt: 1 },
    { id: "a1", role: "assistant", text: "Started three slices.", createdAt: 2 },
    { id: "note", role: "system", text: "All workers finished.", createdAt: 3 },
    { id: "a2", role: "assistant", text: "HUD is in battle_hud.gd.", createdAt: 4 },
  ]);
  assert.equal(synthesis.filter((block) => block.type === "reply").length, 2);
  assert.equal(
    synthesis.some((block) => block.type === "system" && block.message.text === "All workers finished."),
    true,
  );
  const replies = synthesis.filter((block) => block.type === "reply");
  if (replies[0]?.type === "reply") assert.equal(replies[0].assistant.text, "Started three slices.");
  if (replies[1]?.type === "reply") assert.equal(replies[1].assistant.text, "HUD is in battle_hud.gd.");
  const twoAssistants = groupTranscript([
    { id: "u", role: "user", text: "go", createdAt: 1 },
    { id: "a1", role: "assistant", text: "Workers are running.", createdAt: 2 },
    { id: "a2", role: "assistant", text: "Here is the combined review.", createdAt: 3 },
  ]);
  assert.equal(twoAssistants.filter((block) => block.type === "reply").length, 2);
  const work = split.find((block) => block.type === "reply");
  if (work?.type === "reply") {
    assert.equal(work.assistant.text, "Spawning now.");
    assert.equal(work.tools.length, 2);
    assert.equal(work.subagents.length, 1);
    assert.equal(split.some((block) => block.type === "system"), false);
  }
  const deniedSplit = groupTranscript([
    { id: "u", role: "user", text: "call grok", createdAt: 1 },
    { id: "a1", role: "assistant", text: "I'll spawn Grok.", createdAt: 2 },
    { id: "d1", role: "system", text: "Denied: workhorsespawnagent — Grok will run inside this conversation.", createdAt: 3 },
    { id: "t2", role: "system", kind: "tool", text: "Request vendor · denied", toolStatus: "failed", createdAt: 4 },
  ]);
  assert.equal(deniedSplit.filter((block) => block.type === "reply").length, 1);
  assert.equal(deniedSplit.some((block) => block.type === "system"), false);
  if (deniedSplit[1]?.type === "reply") {
    assert.equal(deniedSplit[1].assistant.text, "I'll spawn Grok.");
    assert.ok(deniedSplit[1].tools.length >= 2);
  }
  assert.match(popout, /subagent-preview/);
  assert.match(popout, /subagent-open/);
  assert.match(popout, /subagents/);
  assert.match(popout, /onOpenThread/);
  assert.match(popout, /working · \$\{formatWorked/);
  assert.match(popout, /anyChildLive/);
  assert.match(popout, /deskInk/);
  assert.doesNotMatch(popout, /subagentTurns/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.subagent-open/);
  const workCss = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  const foldAt = workCss.indexOf(".work-fold > summary::before");
  const foldBlock = foldAt >= 0 ? workCss.slice(foldAt, foldAt + 280) : "";
  assert.match(foldBlock, /border-radius:\s*50%/);
  assert.doesNotMatch(foldBlock, /rotate\(-45deg\)/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.agent-thread/);
  assert.doesNotMatch(pane, /AgentThreadPane/);
  assert.doesNotMatch(pane, /has-thread/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "AgentThreadPane.tsx"), "utf8"), /Talking now/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "AgentThreadPane.tsx"), "utf8"), /deskInk/);
  const threadPane = readFileSync(path.join(ROOT, "src", "ui", "AgentThreadPane.tsx"), "utf8");
  assert.match(threadPane, /compact-thread overlay/);
  assert.match(threadPane, /groupTranscript\(child\.messages\)/);
  assert.match(threadPane, /WorkPopout/);
  assert.match(threadPane, /ContextMeter session=\{child\}/);
  assert.match(threadPane, /compact/);
  assert.match(threadPane, /readOnly/);
  assert.match(threadPane, /id: "copy"/);
  assert.doesNotMatch(threadPane, /Composer/);
  assert.doesNotMatch(threadPane, /SessionSetup/);
  assert.doesNotMatch(threadPane, /GoalBar/);
  assert.doesNotMatch(threadPane, /WatchBanners/);
  assert.doesNotMatch(threadPane, /TerminalPane/);
  assert.doesNotMatch(threadPane, /FileReview/);
  assert.doesNotMatch(threadPane, /agent-bubble/);
  assert.doesNotMatch(threadPane, /id: "fork"/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.agent-thread\.compact-thread/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.agent-thread\.compact-thread\.overlay/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.crew-twist[\s\S]*z-index:\s*2/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "ModelMenu.tsx"), "utf8"), /session: sessionProp/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "UserTurn.tsx"), "utf8"), /readOnly/);

  const parent: Session = {
    id: "parent",
    projectId: null,
    provider: "custom",
    model: "MiniMax-M3",
    effort: "medium",
    title: "Can you contact Grok?",
    mode: "always-approve",
    sandbox: "off",
    status: "running",
    contextUsed: 0,
    messages: [
      {
        id: "mark",
        role: "system",
        kind: "subagent",
        text: "Grok",
        fromTitle: "Grok",
        subagentSessionId: "child",
        toolStatus: "running",
        createdAt: 2,
      },
    ],
  };
  const child: Session = {
    ...parent,
    id: "child",
    parentId: "parent",
    hidden: true,
    provider: "grok",
    model: "grok-4.6",
    title: "Grok",
    status: "running",
    messages: [
      { id: "u", role: "user", kind: "peer", fromTitle: "Can you contact Grok?", text: "are you there?", createdAt: 2 },
      { id: "a", role: "assistant", text: "yes", createdAt: 3 },
    ],
  };
  const found = agentThreadsForSession(parent, [parent, child]);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.title, "Grok");
  assert.equal(found[0]?.live, true);
  assert.equal(found[0]?.turns.length, 2);
  assert.equal(liveAgentThreadId(found), "child");
  const waiting = agentThreadsForSession(
    {
      ...parent,
      messages: [
        { id: "tool", role: "assistant", kind: "tool", text: "workhorse_spawn_agent · running — grok", toolStatus: "running", createdAt: 2 },
      ],
    },
    [parent],
  );
  assert.equal(waiting[0]?.live, true);
  assert.match(waiting[0]?.title ?? "", /grok|other agent/i);
  const blocked = agentThreadsForSession(
    {
      ...parent,
      status: "idle",
      messages: [
        {
          id: "fail",
          role: "system",
          kind: "subagent",
          fromTitle: "Grok",
          toolStatus: "failed",
          text: "Grok has no leftover left. Watch safety is on — this vendor has no more usability until the plan window resets.",
          createdAt: 4,
        },
      ],
    },
    [parent],
  );
  assert.equal(blocked[0]?.error?.includes("Watch safety"), true);
  assert.equal(liveAgentThreadId(blocked), blocked[0]?.id);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "AgentThreadPane.tsx"), "utf8"), /agent-thread-warn/);
  const stuckTools = [
    {
      id: "ask",
      role: "system" as const,
      kind: "tool" as const,
      text: "Asking WORKHORSE Live Health Check Reply · working — WORKHORSE Live Health Check Reply",
      toolStatus: "running",
      createdAt: 3,
    },
    {
      id: "list",
      role: "system" as const,
      kind: "tool" as const,
      text: "Listing chats · completed",
      toolStatus: "completed",
      createdAt: 2,
    },
  ];
  const failedAsk = failPeerAskMessages(stuckTools, {
    targetTitle: "WORKHORSE Live Health Check Reply",
    error: "Grok is over its day bank. Watch safety is on.",
  });
  assert.equal(failedAsk[0]?.toolStatus, "failed");
  assert.equal(failedAsk[1]?.toolStatus, "completed");
  const parentAfterFail = applyFailedPeerAsk(
    [
      {
        ...parent,
        messages: [...parent.messages, stuckTools[0]!],
      },
    ],
    {
      parentId: "parent",
      childId: "child",
      targetTitle: "Grok",
      error: "Grok agent failed: account unauthorized",
    },
  );
  assert.equal(parentAfterFail[0]?.messages.find((item) => item.kind === "subagent")?.toolStatus, "failed");
  assert.equal(parentAfterFail[0]?.messages.find((item) => item.kind === "tool")?.toolStatus, "failed");
  const closed = finishOpenToolMessages(
    [
      { id: "open", role: "system", kind: "tool", text: "Asking Grok · working — Grok", toolStatus: "running", createdAt: 1 },
      { id: "done", role: "system", kind: "tool", text: "Listing chats · completed", toolStatus: "completed", createdAt: 2 },
    ],
    "failed",
    "account failed",
  );
  assert.equal(closed[0]?.toolStatus, "failed");
  assert.match(closed[0]?.text ?? "", /failed/);
  assert.equal(closed[1]?.toolStatus, "completed");
  const stillLive = agentThreadsForSession(
    {
      ...parent,
      status: "idle",
      messages: [
        {
          id: "ask",
          role: "system",
          kind: "tool",
          text: "Asking WORKHORSE Live Health Check Reply · failed — WORKHORSE Live Health Check Reply",
          toolStatus: "failed",
          createdAt: 3,
        },
      ],
    },
    [{ ...parent, status: "idle" }],
  );
  assert.equal(stillLive.length, 0);
  const setupTimeout = agentThreadsForSession(
    {
      ...parent,
      status: "idle",
      messages: [
        {
          id: "bots",
          role: "system",
          kind: "subagent",
          fromTitle: "Workhorse did not finish setting up that bot in time",
          toolStatus: "failed",
          text: "Workhorse did not finish setting up that bot in time",
          createdAt: 5,
        },
      ],
    },
    [parent],
  );
  assert.equal(setupTimeout.length, 0);
  const otherChat = {
    ...parent,
    id: "other",
    title: "Campaign, sectors, workshop surface",
    parentId: "someone-else",
    hidden: true,
  };
  const leaked = agentThreadsForSession(
    {
      ...parent,
      messages: [
        {
          id: "mark-other",
          role: "system",
          kind: "subagent",
          fromTitle: otherChat.title,
          subagentSessionId: otherChat.id,
          toolStatus: "completed",
          text: otherChat.title,
          createdAt: 6,
        },
      ],
    },
    [parent, otherChat],
  );
  assert.equal(leaked.length, 0);
  assert.equal(interpretPeerAskHttp(400, { error: "Grok is over its day bank" }).retryable, false);
  assert.equal(interpretPeerAskHttp(200, { text: "hi" }).ok, true);
  assert.equal(interpretPeerAskHttp(500, { error: "bridge down" }).retryable, true);
  assert.equal(isRetryablePeerAskTransport(new Error("Grok is over its day bank")), false);
  assert.equal(isRetryablePeerAskTransport(new Error("fetch failed")), true);
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /applyFailedPeerAsk/);
  assert.match(store, /finishOpenToolMessages/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8"), /interpretPeerAskHttp/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8"), /isRetryablePeerAskTransport/);
  assert.equal(groupTranscript([intro, ...messages]).length, 2);
  const stripped = normalizeSession({
    id: "sess",
    provider: "grok",
    model: "grok-4.6",
    messages: [intro, messages[0]],
  });
  assert.equal(stripped?.messages.length, 1);
  assert.equal(stripped?.messages[0].id, "u");
  assert.doesNotMatch(store, /chatIntro/);
  assert.doesNotMatch(store, /is live via Grok Build/);
});

test("subagent pane groups child thought tools and usage like the usual chat", () => {
  const childMessages = [
    { id: "u1", role: "user" as const, kind: "peer" as const, fromTitle: "Orchestrator", text: "Scrape the HUD.", createdAt: 1 },
    { id: "th1", role: "assistant" as const, kind: "thought" as const, text: "I will list the scene files first.", createdAt: 2 },
    { id: "tl1", role: "system" as const, kind: "tool" as const, text: "Read · completed — scenes/ui/damagecam.tscn", toolStatus: "completed", createdAt: 3 },
    { id: "c1", role: "system" as const, kind: "compact" as const, text: "Kept HUD notes.", createdAt: 4 },
    { id: "a1", role: "assistant" as const, text: "The HUD script wires damage numbers to the bar.", createdAt: 5 },
  ];
  const blocks = groupTranscript(childMessages);
  const reply = blocks.find((block) => block.type === "reply");
  assert.ok(reply && reply.type === "reply");
  if (reply?.type !== "reply") return;
  assert.equal(reply.thoughts.length, 1);
  assert.equal(reply.tools.length, 1);
  assert.equal(reply.compacts.length, 1);
  assert.match(reply.assistant.text, /HUD script/);
  assert.equal(reply.thoughts[0]?.text.includes("scene files"), true);
  assert.match(reply.tools[0]?.text ?? "", /damagecam/);

  const parentCtx = estimateChatContext({
    contextUsed: 80_000,
    windowSize: 1_000_000,
    messages: [{ text: "parent only", kind: undefined }],
  });
  const childCtx = estimateChatContext({
    contextUsed: 22_000,
    windowSize: 1_000_000,
    messages: childMessages,
  });
  assert.equal(parentCtx.used, 80_000);
  assert.equal(childCtx.used, 22_000);
  assert.notEqual(childCtx.used, parentCtx.used);
  assert.ok((childCtx.messageCount ?? 0) > (parentCtx.messageCount ?? 0));

  const bot = {
    id: "bot_minimax",
    name: "MiniMax",
    model: "MiniMax-M3",
    color: "#3dff7a",
    enabled: true,
    baseUrl: "https://api.example",
    apiKey: "k",
    api: "openai-completions" as const,
    contextWindow: 1_000_000,
    createdAt: 1,
  };
  const who = brainCaption(
    { provider: "custom", model: "MiniMax-M3", customBotId: "bot_minimax" },
    [bot],
  );
  assert.equal(who.color, "#3dff7a");
  const ink = deskInk(
    { provider: "custom", customBotId: "bot_minimax" },
    { customBots: [bot], llms: { grok: { connected: false }, claude: { connected: false }, codex: { connected: false } } },
  );
  assert.equal(ink, "#3dff7a");
  assert.notEqual(who.color, undefined);
});

test("agent thread pane only lists this chat’s workers", () => {
  const parent: Session = {
    id: "parent",
    projectId: null,
    provider: "custom",
    model: "MiniMax-M3",
    effort: "medium",
    title: "Please summon subagents",
    mode: "always-approve",
    sandbox: "off",
    status: "idle",
    contextUsed: 0,
    messages: [
      {
        id: "mine",
        role: "system",
        kind: "subagent",
        fromTitle: "Battle HUD",
        subagentSessionId: "kid",
        toolStatus: "completed",
        text: "Battle HUD",
        createdAt: 1,
      },
      {
        id: "setup",
        role: "system",
        kind: "subagent",
        fromTitle: "Workhorse did not finish setting up that bot in time",
        toolStatus: "failed",
        text: "Workhorse did not finish setting up that bot in time",
        createdAt: 2,
      },
      {
        id: "foreign",
        role: "system",
        kind: "subagent",
        fromTitle: "Campaign, sectors, workshop surface",
        subagentSessionId: "other-kid",
        toolStatus: "completed",
        text: "Campaign, sectors, workshop surface",
        createdAt: 3,
      },
    ],
  };
  const mine: Session = {
    ...parent,
    id: "kid",
    parentId: "parent",
    hidden: true,
    title: "Battle HUD",
    messages: [{ id: "u", role: "user", kind: "peer", text: "do hud", createdAt: 1 }],
  };
  const other: Session = {
    ...parent,
    id: "other-kid",
    parentId: "other-parent",
    hidden: true,
    title: "Campaign, sectors, workshop surface",
    messages: [],
  };
  const found = agentThreadsForSession(parent, [parent, mine, other]);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.title, "Battle HUD");
  assert.equal(found[0]?.childId, "kid");
});

test("shipped launch spec maps sandbox and plan without yolo", () => {
  const base = { model: "grok-4.6", effort: "medium" as const, cwd: ROOT, mode: "ask" as const };
  const off = buildGrokLaunchSpec(base);
  assert.ok(off.argv.includes("--no-leader"));
  assert.equal(off.argv[off.argv.indexOf("--sandbox") + 1], "off");
  assert.equal(off.argv[off.argv.indexOf("--permission-mode") + 1], "default");
  assert.ok(off.argv.indexOf("--sandbox") < off.argv.indexOf("agent"));
  assert.ok(!off.argv.includes("--rules"));
  assert.equal(off.sessionParams._meta?.rules, WORKHORSE_SESSION_RULES);
  assert.equal(off.sandbox, "off");
  assert.equal(off.initializeParams.clientCapabilities.sessionLoad, true);
  assert.equal(off.initializeParams.clientCapabilities.permissionPrompts, true);
  assert.equal("fs" in off.initializeParams.clientCapabilities, false);
  assert.equal("terminal" in off.initializeParams.clientCapabilities, false);
  assert.equal("edit" in off.initializeParams.clientCapabilities, false);
  assert.deepEqual(off.initializeParams.clientCapabilities, WORKHORSE_CLIENT_CAPABILITIES);

  for (const profile of ["workspace", "read-only", "strict"] as const) {
    const spec = buildGrokLaunchSpec({ ...base, sandbox: profile });
    assert.ok(spec.argv.includes("--no-leader"));
    assert.equal(spec.argv[spec.argv.indexOf("--sandbox") + 1], profile);
    assert.ok(spec.argv.indexOf("--sandbox") < spec.argv.indexOf("agent"));
    assert.equal(spec.sandbox, profile);
    if (profile === "read-only" || profile === "strict") {
      assert.equal(spec.argv[spec.argv.indexOf("--permission-mode") + 1], "dontAsk");
    }
  }
  const boxedYolo = buildGrokLaunchSpec({ ...base, mode: "always-approve", sandbox: "read-only" });
  assert.ok(!boxedYolo.argv.includes("--always-approve"));
  assert.equal(boxedYolo.argv[boxedYolo.argv.indexOf("--permission-mode") + 1], "dontAsk");

  const yolo = buildGrokLaunchSpec({ ...base, mode: "always-approve" });
  assert.ok(yolo.argv.includes("--always-approve"));
  assert.equal(yolo.sessionParams._meta?.yoloMode, true);
  assert.ok(!yolo.sessionParams._meta?.planMode);

  const edits = buildGrokLaunchSpec({ ...base, mode: "accept-edits" });
  assert.equal(edits.argv[edits.argv.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok(edits.argv.includes("Edit"));
  assert.ok(!edits.sessionParams._meta?.autoMode);
  assert.ok(!edits.argv.includes("--always-approve"));
  assert.equal(
    permissionPolicyAnswer({ mode: "accept-edits", sandbox: "off", tool: "Edit", detail: "EDITS.txt", path: "EDITS.txt" }),
    "once",
  );
  assert.equal(
    permissionPolicyAnswer({ mode: "accept-edits", sandbox: "off", tool: "run command", detail: "powershell -c echo hi" }),
    null,
  );

  const plan = buildGrokLaunchSpec({ ...base, mode: "plan" });
  assert.equal(plan.sessionParams._meta?.planMode, true);
  assert.ok(!plan.sessionParams._meta?.yoloMode);
  assert.equal(plan.argv[plan.argv.indexOf("--permission-mode") + 1], "plan");
  assert.ok(plan.argv.indexOf("--permission-mode") < plan.argv.indexOf("agent"));
  assert.ok(!plan.argv.includes("--always-approve"));

  const mcp = buildGrokLaunchSpec({
    ...base,
    mcpServers: [{ name: "github", command: "npx", args: ["-y", "mcp-github"] }],
  });
  assert.deepEqual(mcp.sessionParams.mcpServers, [
    { type: "stdio", name: "github", command: "npx", args: ["-y", "mcp-github"] },
  ]);
  assert.deepEqual(mergeMcpServers([{ name: "a", command: "x", args: [] }], null), [
    { type: "stdio", name: "a", command: "x", args: [] },
  ]);
});

test("Grok Build slash commands merge into the palette and lose to Workhorse names", () => {
  assert.ok(GROK_SHELL_COMMANDS.some((command) => command.name === "/imagine" && command.inputHint));
  assert.ok(GROK_SHELL_COMMANDS.some((command) => command.name === "/context"));
  assert.ok(GROK_SHELL_COMMANDS.some((command) => command.name === "/skills"));
  const merged = commandsForSession({ provider: "grok", grokCommands: [] });
  assert.ok(merged.some((command) => command.name === "/imagine"));
  assert.ok(merged.some((command) => command.name === "/compact" && command.run === "compact"));
  assert.equal(merged.filter((command) => command.name === "/usage").length, 1);
  assert.equal(merged.find((command) => command.name === "/usage")?.run, "usage");
  assert.equal(matchCommand("/imagine a sunset", GROK_SHELL_COMMANDS)?.run, "grok");
  assert.equal(matchCommand("/m grok-4.6")?.run, "model");
  assert.equal(matchCommand("/clear")?.run, "new");
  assert.ok(commandNeedsInput(GROK_SHELL_COMMANDS.find((command) => command.name === "/imagine")!, "/imagine"));
  assert.ok(!commandNeedsInput(GROK_SHELL_COMMANDS.find((command) => command.name === "/imagine")!, "/imagine a cat"));
  const asked = filterCommands("/imag", GROK_SHELL_COMMANDS);
  assert.ok(asked.some((command) => command.name === "/imagine"));
  const skill = extractAvailableCommands({
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "commit", description: "Commit staged files", input: { hint: "message" } }],
  });
  assert.equal(skill?.[0]?.name, "/commit");
  assert.equal(skill?.[0]?.run, "grok");
  const classified = classifyAcpUpdate({
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "commit", description: "Commit staged files" }],
  });
  assert.equal(classified.kind, "commands");
  assert.equal(mergeCommands(COMMANDS, GROK_SHELL_COMMANDS).find((command) => command.name === "/theme")?.run, "theme");
  assert.match(
    mergeCommands(COMMANDS, GROK_SHELL_COMMANDS).find((command) => command.name === "/theme")?.hint ?? "",
    /Workhorse/,
  );
});

test("Workhorse theme cycles and horse click restores light or dark", () => {
  assert.equal(isTheme("workhorse"), true);
  assert.equal(isTheme("sepia"), false);
  assert.equal(nextTheme("system"), "light");
  assert.equal(nextTheme("light"), "dark");
  assert.equal(nextTheme("dark"), "workhorse");
  assert.equal(nextTheme("workhorse"), "system");
  assert.equal(resolvedTheme("system", true), "dark");
  assert.equal(resolvedTheme("system", false), "light");
  assert.equal(resolvedTheme("workhorse"), "workhorse");
  assert.deepEqual(applyWorkhorseToggle("light"), { theme: "workhorse", themeReturn: "light" });
  assert.deepEqual(applyWorkhorseToggle("dark"), { theme: "workhorse", themeReturn: "dark" });
  assert.deepEqual(applyWorkhorseToggle("workhorse", "dark"), { theme: "dark" });
  assert.deepEqual(applyWorkhorseToggle("workhorse"), { theme: "system" });
  assert.deepEqual(
    SETTINGS_THEME_CHOICES.map((item) => item.id),
    ["system", "light", "dark"],
  );
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8"), /SETTINGS_THEME_CHOICES/);
});

test("Workhorse /goal and pulled skills join the Codex slash palette", () => {
  assert.ok(COMMANDS.some((command) => command.name === "/goal" && command.run === "goal"));
  const palette = commandsForSession({ provider: "codex" }, [
    {
      name: "unity-ui-to-figma",
      description: "Preserve Unity UI in Figma",
      origin: "codex",
      dir: "C:\\\\codex\\\\skills\\\\unity-ui-to-figma",
      skillFile: "C:\\\\codex\\\\skills\\\\unity-ui-to-figma\\\\SKILL.md",
    },
  ]);
  assert.ok(palette.some((command) => command.name === "/goal" && command.run === "goal" && !command.source));
  assert.ok(palette.some((command) => command.name === "/unity-ui-to-figma" && command.run === "skill"));
  assert.equal(palette.find((command) => command.name === "/plan")?.run, "mode:plan");
  assert.match(invokeSkillPrompt(commandsFromSkills([{
    name: "unity-ui-to-figma",
    description: "Preserve Unity UI in Figma",
    origin: "codex",
    dir: "x",
    skillFile: "x",
  }])[0], "/unity-ui-to-figma export HUD"), /Use the installed skill "unity-ui-to-figma"/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "src", "ui", "SkillsPane.tsx"), "utf8"), />\s*Pull\s*</);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "skills-catalog.ts"), "utf8"), /\.codex., .plugins./);
  const storeSend = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(storeSend, /commandContinuesToVendor\(match\.run\)/);
  assert.match(storeSend, /prepareVendorSend\(/);
  assert.match(storeSend, /nextGoalForSend\(/);
  assert.doesNotMatch(storeSend, /vendorText = goalVendorPrompt/);
  assert.doesNotMatch(storeSend, /hideUser = true/);
  assert.match(storeSend, /goal\?\.status === "paused"/);
  const extras = (provider: "codex" | "grok") =>
    commandsForSession({ provider }).filter((command) => command.source && command.source !== "workhorse");
  for (const line of ["/goal", "/goal ship the backlog", "/goal pause", "/goal resume", "/goal clear"]) {
    const codex = matchCommand(line, commandsForSession({ provider: "codex" }));
    const grok = matchCommand(line, commandsForSession({ provider: "grok" }));
    assert.equal(codex?.run, "goal", line);
    assert.equal(grok?.run, "grok", line);
    assert.equal(commandContinuesToVendor(codex?.run), false, line);
    assert.equal(commandContinuesToVendor(grok?.run), true, line);
  }
  assert.deepEqual(splitGoalCommand("/goal"), { name: "/goal", rest: "" });
  assert.deepEqual(splitGoalCommand("/goal ship the backlog"), { name: "/goal", rest: " ship the backlog" });
  assert.equal(splitGoalCommand("/plan"), null);
  assert.equal(splitGoalCommand("please /goal later"), null);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "UserTurn.tsx"), "utf8"), /chat-command/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.chat-command/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "tokens.css"), "utf8"), /--command:/);
  assert.equal(matchCommand("/skills", extras("codex"))?.run, "vendor");
  assert.equal(matchCommand("/review", extras("codex"))?.run, "vendor");
  assert.equal(matchCommand("/skills", extras("grok"))?.run, "grok");
  assert.equal(commandContinuesToVendor("new"), false);
  assert.equal(commandContinuesToVendor("compact"), false);
});

test("Goal state set pause resume clear maps to display actions", () => {
  assert.equal(parseGoalInput("/new"), null);
  assert.equal(parseGoalInput("/goal does that goal act as a grok goal or a workhorse goal?"), null);
  assert.equal(parseGoalInput("/goal is this a grok goal"), null);
  assert.deepEqual(parseGoalInput("/goal"), { action: "view", objective: "" });
  assert.deepEqual(parseGoalInput("/goal pause"), { action: "pause", objective: "" });
  assert.deepEqual(parseGoalInput("/pause"), { action: "pause", objective: "" });
  assert.deepEqual(parseGoalInput("/goal resume"), { action: "resume", objective: "" });
  assert.deepEqual(parseGoalInput("/goal clear"), { action: "clear", objective: "" });
  assert.equal(goalHaltsVendor("/goal pause"), true);
  assert.equal(goalHaltsVendor("/pause"), true);
  assert.equal(goalHaltsVendor("/goal clear"), true);
  assert.equal(goalHaltsVendor("/goal stop"), true);
  assert.equal(goalHaltsVendor("/goal resume"), false);
  assert.equal(goalHaltsVendor("/goal ship the backlog"), false);
  const goalChat: Session = {
    id: "goal_live",
    projectId: null,
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "Goal chat",
    mode: "ask",
    sandbox: "off",
    status: "running",
    messages: [{ id: "u", role: "user", text: "start", createdAt: 1 }],
    contextUsed: 0,
  };
  const withGoalLine = appendUserMessage([goalChat], "goal_live", "/goal");
  assert.ok(withGoalLine[0]?.messages.some((message) => message.role === "user" && message.text === "/goal"));
  const queuedGoal = enqueuePrompt([goalChat], "goal_live", {
    text: "/goal ship the backlog",
    vendorText: goalVendorPrompt({ status: "active", objective: "ship the backlog" }, "set"),
  });
  assert.ok(queuedGoal?.[0].messages.some((message) => message.text === "/goal ship the backlog"));
  assert.match(queuedGoal?.[0].queue?.[0]?.vendorText ?? "", /ongoing Workhorse goal/);
  assert.notEqual(queuedGoal?.[0].queue?.[0]?.hideUser, true);
  const set = applyGoalCommand(undefined, "/goal ship the 18 features in BACKLOG.md");
  assert.deepEqual(set, { status: "active", objective: "ship the 18 features in BACKLOG.md" });
  const viewed = applyGoalCommand(set, "/goal");
  assert.deepEqual(viewed, set);
  const paused = applyGoalCommand(set, "/goal pause");
  assert.equal(paused?.status, "paused");
  assert.equal(paused?.objective, set?.objective);
  const resumed = applyGoalCommand(paused, "/goal resume");
  assert.equal(resumed?.status, "active");
  assert.equal(applyGoalCommand(resumed, "/goal clear"), undefined);
  assert.equal(applyGoalCommand(set, "/goal clear"), undefined);
  const activeView = goalDisplay(set);
  assert.equal(activeView?.title, "Goal");
  assert.deepEqual(activeView?.actions, ["pause", "clear"]);
  const pausedView = goalDisplay(paused);
  assert.equal(pausedView?.title, "Goal paused");
  assert.deepEqual(pausedView?.actions, ["resume", "clear"]);
  assert.equal(goalDisplay(undefined), null);
  assert.equal(goalCommandForAction("pause"), "/goal pause");
  assert.match(goalVendorPrompt(set!, "set"), /concrete progress/);
  assert.match(goalVendorPrompt(resumed!, "resume"), /Do not only acknowledge/);
  const persisted = normalizeSession({
    id: "goal_sess",
    projectId: null,
    provider: "codex",
    model: "gpt-5.4",
    effort: "medium",
    title: "Goal chat",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [],
    contextUsed: 0,
    goal: { status: "paused", objective: "keep going" },
  });
  assert.deepEqual(persisted?.goal, { status: "paused", objective: "keep going" });
  const bar = readFileSync(path.join(ROOT, "src", "ui", "GoalBar.tsx"), "utf8");
  assert.match(bar, /goalDisplayForSession/);
  const grokIdleActive = {
    provider: "grok" as const,
    status: "idle" as const,
    goal: { status: "active" as const, objective: "prove native /goal" },
  };
  assert.equal(goalDisplayForSession(grokIdleActive), null);
  assert.ok(goalDisplayForSession({ ...grokIdleActive, status: "running" }));
  assert.equal(goalDisplayForSession({ ...grokIdleActive, goal: { status: "paused", objective: "prove native /goal" } })?.status, "paused");
  assert.ok(goalDisplayForSession({ provider: "custom", status: "idle", goal: { status: "active", objective: "desk" } }));
  assert.equal(grokGoalAfterTurnIdle("grok", { status: "active", objective: "prove native /goal" }), undefined);
  assert.deepEqual(grokGoalAfterTurnIdle("grok", { status: "paused", objective: "prove native /goal" }), {
    status: "paused",
    objective: "prove native /goal",
  });
  assert.deepEqual(grokGoalAfterTurnIdle("custom", { status: "active", objective: "desk" }), {
    status: "active",
    objective: "desk",
  });
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /grokGoalAfterTurnIdle/);
  assert.match(bar, /Pause/);
  assert.match(bar, /Resume/);
  assert.match(bar, /Clear/);
  assert.match(bar, /goalCommandForAction/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8"), /GoalBar/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.goal-bar/);
  const haltStore = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(haltStore, /planHaltForward\(/);
  assert.match(haltStore, /prepareVendorSend\(/);
  assert.match(haltStore, /appendUserMessage\(/);
  const haltAt = haltStore.indexOf("planHaltForward(");
  const queueAt = haltStore.indexOf("!skipQueue && !options?.afterGoalHalt && !options?.steer");
  assert.ok(haltAt >= 0 && queueAt >= 0 && haltAt < queueAt, "pause must halt before a live turn can queue it");
  assert.match(haltStore, /haltPlan === "defer-until-cancelled-done"/);
  assert.match(haltStore, /afterGoalHalt: true/);
  assert.match(haltStore, /!options\?\.afterGoalHalt && !options\?\.steer/);
  assert.match(haltStore, /vendorTerminalAction\(/);
  assert.match(haltStore, /consume-halt-then-forward/);
  const consumeAt = haltStore.indexOf('terminal === "consume-halt-then-forward"');
  const consumeReturn = haltStore.indexOf("return;", consumeAt);
  const finalizeAfter = haltStore.indexOf("EMPTY_GROK_REPLY", consumeAt);
  assert.ok(consumeAt >= 0 && consumeReturn >= 0, "cancelled done must return from apply");
  assert.ok(finalizeAfter < 0 || consumeReturn < finalizeAfter, "cancelled done must return before EMPTY_GROK_REPLY can stamp the live assistant");
});

test("Grok chats send native /goal and skill slashes; desk wrap stays off Grok", () => {
  const grokPalette = commandsForSession({ provider: "grok" });
  const customPalette = commandsForSession({ provider: "custom" });
  const codexPalette = commandsForSession({ provider: "codex" });
  const grokGoal = grokPalette.find((command) => command.name === "/goal");
  assert.equal(grokGoal?.run, "grok");
  assert.equal(commandContinuesToVendor(grokGoal?.run), true);
  assert.match(grokGoal?.inputHint ?? "", /budget/);
  assert.equal(customPalette.find((command) => command.name === "/goal")?.run, "goal");
  assert.equal(codexPalette.find((command) => command.name === "/goal")?.run, "goal");
  assert.equal(commandContinuesToVendor("goal"), false);

  const grokPdfSkill = {
    name: "pdf",
    description: "Make PDFs",
    origin: "grok" as const,
    dir: "x",
    skillFile: "x",
  };
  const grokWithPdf = commandsForSession({ provider: "grok" }, [grokPdfSkill]);
  const customWithPdf = commandsForSession({ provider: "custom" }, [{ ...grokPdfSkill, origin: "workhorse" }]);
  assert.equal(grokWithPdf.find((command) => command.name === "/pdf")?.run, "grok");
  assert.equal(customWithPdf.find((command) => command.name === "/pdf")?.run, "skill");

  for (const name of ["/usage", "/theme", "/settings", "/schedule", "/watch", "/new", "/compact"]) {
    const row = grokPalette.find((command) => command.name === name);
    assert.ok(row, name);
    assert.notEqual(row?.run, "grok", name);
    assert.equal(commandContinuesToVendor(row?.run), false, name);
  }
  const acceptEdits = grokPalette.find((command) => command.name === "/accept-edits" || command.aliases?.includes("/auto"));
  assert.equal(acceptEdits?.run, "mode:accept-edits");
  assert.ok(acceptEdits?.aliases?.includes("/auto"));
  assert.equal(grokPalette.find((command) => command.name === "/skills")?.run, "grok");
  assert.equal(grokPalette.find((command) => command.name === "/workflow")?.run, "grok");
  assert.equal(grokPalette.find((command) => command.name === "/workflows")?.run, "grok");
  assert.equal(grokPalette.find((command) => command.name === "/create-workflow")?.run, "grok");

  const qualified = commandsForSession(
    { provider: "grok", grokCommands: [{ id: "local-pdf", name: "/local:pdf", hint: "Local pdf", run: "grok", source: "grok" }] },
    [grokPdfSkill],
  );
  const localHit = matchCommand("/local:pdf foo", qualified);
  assert.equal(localHit?.name, "/local:pdf");
  assert.equal(localHit?.run, "grok");
  assert.notEqual(localHit?.name, "/pdf");

  const advertised = extractAvailableCommands({
    availableCommands: [
      { name: "goal", description: "Grok goal" },
      { name: "local:commit", source: "skill", description: "Commit" },
    ],
  });
  assert.equal(advertised?.find((command) => command.name === "/goal")?.run, "grok");
  assert.equal(advertised?.find((command) => command.name === "/local:commit")?.run, "grok");
  const withAcp = commandsForSession({ provider: "grok", grokCommands: advertised });
  assert.equal(withAcp.find((command) => command.name === "/goal")?.run, "grok");
  assert.ok(withAcp.some((command) => command.name === "/local:commit"));

  const grokSet = prepareVendorSend({ provider: "grok", text: "/goal ship the backlog" });
  assert.equal(grokSet.vendorText, "/goal ship the backlog");
  assert.equal(grokSet.skipVendor, false);
  assert.doesNotMatch(grokSet.vendorText, /ongoing Workhorse goal/);
  const grokBudget = prepareVendorSend({ provider: "grok", text: "/goal --budget 80000 migrate auth" });
  assert.equal(grokBudget.vendorText, "/goal --budget 80000 migrate auth");
  assert.equal(parseGrokGoalLine("/goal --budget 80000 migrate auth")?.objective, "migrate auth");

  const deskSet = prepareVendorSend({ provider: "custom", text: "/goal ship the backlog" });
  assert.match(deskSet.vendorText, /ongoing Workhorse goal/);
  assert.equal(deskSet.skipVendor, false);
  const codexSet = prepareVendorSend({ provider: "codex", text: "/goal ship the backlog" });
  assert.match(codexSet.vendorText, /ongoing Workhorse goal/);

  const grokPause = prepareVendorSend({ provider: "grok", text: "/goal pause" });
  assert.equal(grokPause.haltVendor, true);
  assert.equal(grokPause.vendorText, "/goal pause");
  assert.equal(grokPause.skipVendor, false);
  assert.equal(
    planHaltForward({ haltVendor: grokPause.haltVendor, skipVendor: grokPause.skipVendor, sessionStatus: "running" }),
    "defer-until-cancelled-done",
  );
  assert.equal(
    planHaltForward({ haltVendor: grokPause.haltVendor, skipVendor: grokPause.skipVendor, sessionStatus: "idle" }),
    "send-now",
  );
  const grokClear = prepareVendorSend({ provider: "grok", text: "/goal clear" });
  assert.equal(grokClear.haltVendor, true);
  assert.equal(grokClear.vendorText, "/goal clear");
  assert.equal(grokClear.skipVendor, false);
  assert.equal(
    planHaltForward({ haltVendor: grokClear.haltVendor, skipVendor: grokClear.skipVendor, sessionStatus: "needs-input" }),
    "defer-until-cancelled-done",
  );

  const deskPause = prepareVendorSend({ provider: "custom", text: "/goal pause" });
  assert.equal(deskPause.haltVendor, true);
  assert.equal(deskPause.skipVendor, true);
  assert.equal(
    planHaltForward({ haltVendor: deskPause.haltVendor, skipVendor: deskPause.skipVendor, sessionStatus: "running" }),
    "desk-halt-only",
  );
  const codexPause = prepareVendorSend({ provider: "codex", text: "/goal pause" });
  assert.equal(codexPause.haltVendor, true);
  assert.equal(codexPause.skipVendor, true);

  const grokBare = prepareVendorSend({ provider: "grok", text: "/goal" });
  assert.equal(grokBare.vendorText, "/goal");
  assert.equal(grokBare.skipVendor, false);
  const grokStatus = prepareVendorSend({ provider: "grok", text: "/goal status" });
  assert.equal(grokStatus.vendorText, "/goal status");
  assert.equal(grokStatus.skipVendor, false);

  const grokBarePause = prepareVendorSend({ provider: "grok", text: "/pause" });
  assert.equal(grokBarePause.haltVendor, false);
  assert.equal(grokBarePause.vendorText, "/pause");
  assert.equal(parseGrokGoalLine("/pause"), null);

  assert.equal(goalCommandForAction("pause"), "/goal pause");
  const barPause = prepareVendorSend({ provider: "grok", text: goalCommandForAction("pause") });
  assert.equal(barPause.vendorText, "/goal pause");
  assert.equal(barPause.haltVendor, true);
  assert.equal(barPause.skipVendor, false);

  const grokPdfMatch = grokWithPdf.find((command) => command.name === "/pdf");
  const grokPdfSend = prepareVendorSend({
    provider: "grok",
    text: "/pdf make a one-pager",
    match: grokPdfMatch,
  });
  assert.equal(grokPdfSend.vendorText, "/pdf make a one-pager");
  assert.doesNotMatch(grokPdfSend.vendorText, /Use the installed skill/);
  assert.equal(grokPdfMatch?.run, "grok");

  const customPdfMatch = customWithPdf.find((command) => command.name === "/pdf");
  const customPdfSend = prepareVendorSend({
    provider: "custom",
    text: "/pdf make a one-pager",
    match: customPdfMatch,
  });
  assert.match(customPdfSend.vendorText, /Use the installed skill "pdf"/);

  const merged = mergeCommands(COMMANDS, GROK_SHELL_COMMANDS);
  assert.equal(merged.find((command) => command.name === "/theme")?.run, "theme");
  assert.equal(merged.find((command) => command.name === "/usage")?.run, "usage");
  assert.equal(merged.find((command) => command.aliases?.includes("/auto"))?.run, "mode:accept-edits");
  assert.equal(matchCommand("/skills", extrasFor("codex"))?.run, "vendor");
  assert.equal(matchCommand("/skills", extrasFor("grok"))?.run, "grok");

  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /prepareVendorSend\(/);
  assert.match(store, /vendorText = prep\.vendorText/);
  assert.doesNotMatch(store, /vendorText = goalVendorPrompt/);
  assert.match(store, /planHaltForward\(/);
  assert.match(store, /vendorTerminalAction\(/);
  assert.equal(vendorTerminalAction({ halted: true, eventType: "chunk" }), "ignore");
  assert.equal(vendorTerminalAction({ halted: true, eventType: "done" }), "consume-halt-then-forward");
  assert.equal(vendorTerminalAction({ halted: true, eventType: "error" }), "consume-halt-then-forward");
  assert.equal(
    vendorTerminalAction({ halted: false, eventType: "done", eventAssistantId: "asst_old", liveAssistantId: "asst_new" }),
    "ignore",
  );
  assert.equal(
    vendorTerminalAction({ halted: false, eventType: "done", eventAssistantId: "asst_new", liveAssistantId: "asst_new" }),
    "apply",
  );
  assert.notEqual(
    vendorTerminalAction({ halted: true, eventType: "done" }),
    vendorTerminalAction({ halted: false, eventType: "done", eventAssistantId: "asst_new", liveAssistantId: "asst_new" }),
  );
  const composer = readFileSync(path.join(ROOT, "src", "ui", "Composer.tsx"), "utf8");
  assert.match(composer, /filterPalette\(value, extras\)/);
  const bar = readFileSync(path.join(ROOT, "src", "ui", "GoalBar.tsx"), "utf8");
  assert.match(bar, /store\.send\(goalCommandForAction\(action\)\)/);

  const mirrored = nextGoalForSend("grok", undefined, "/goal migrate auth", true);
  assert.deepEqual(mirrored, { status: "active", objective: "migrate auth" });
  assert.equal(nextGoalForSend("grok", mirrored, "/goal pause", true)?.status, "paused");
  assert.equal(nextGoalForSend("grok", mirrored, "/goal clear", true), undefined);
  assert.equal(goalHaltsVendor("/goal pause"), true);

  function extrasFor(provider: "codex" | "grok") {
    return commandsForSession({ provider }).filter((command) => command.source && command.source !== "workhorse");
  }
});

test("Grok /goal is not a desk spawn and keeps the typed slash", () => {
  assert.equal(looksLikeSpawnRequest("please spawn subagents"), true);
  assert.equal(looksLikeSpawnRequest("Summon multiple subagents"), true);
  assert.equal(looksLikeSpawnRequest("/goal ship the backlog"), false);
  assert.equal(looksLikeSpawnRequest("/goal assign skeptic verifier subagents"), false);
  assert.equal(withSpawnHint("/goal assign skeptic and spawn subagents"), "/goal assign skeptic and spawn subagents");
  assert.equal(withSpawnHint("Summon multiple subagents").startsWith(SPAWN_TURN_HINT), true);

  const composed = composeVendorPrompt("/goal prove native /goal", WORKHORSE_SESSION_RULES, "session/load");
  assert.doesNotMatch(composed, new RegExp(SPAWN_TURN_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(composed, /The user asked you to spawn or summon agents/);
  assert.doesNotMatch(composed, /workhorse_spawn_agent/);
  assert.match(composed, /^\/goal prove native \/goal/m);

  assert.equal(prepareVendorSend({ provider: "grok", text: "/goal assign skeptic verifier" }).vendorText, "/goal assign skeptic verifier");
  assert.equal(prepareVendorSend({ provider: "grok", text: "/goal migrate auth" }).vendorText, "/goal migrate auth");
  assert.doesNotMatch(prepareVendorSend({ provider: "grok", text: "/goal migrate auth" }).vendorText, /ongoing Workhorse goal/);
  assert.match(prepareVendorSend({ provider: "custom", text: "/goal migrate auth" }).vendorText, /ongoing Workhorse goal/);

  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /prepareVendorSend\(/);
  assert.doesNotMatch(store, /if \(looksLikeSpawnRequest\(originalText\)\)/);
  assert.match(store, /grokGoalAfterTurnIdle/);
  assert.match(WORKHORSE_SESSION_RULES, /starts with \/goal is Grok Build/);
  assert.match(WORKHORSE_SESSION_RULES, /Do not call workhorse_spawn_agent for \/goal/);
  assert.equal(buildGrokLaunchSpec({ model: "grok-4.6", effort: "medium", cwd: ROOT, mode: "ask" }).sessionParams._meta?.goalMode, true);

  assert.equal(
    goalDisplayForSession({ provider: "grok", status: "idle", goal: { status: "active", objective: "x" } }),
    null,
  );
  assert.ok(goalDisplayForSession({ provider: "grok", status: "running", goal: { status: "active", objective: "x" } }));
  assert.equal(
    goalDisplayForSession({ provider: "grok", status: "idle", goal: { status: "paused", objective: "x" } })?.status,
    "paused",
  );
  assert.ok(goalDisplayForSession({ provider: "custom", status: "idle", goal: { status: "active", objective: "desk" } }));
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "GoalBar.tsx"), "utf8"), /goalDisplayForSession/);
});

test("COMMANDS include /plan and /sandbox; Claude is a live ACP adapter", () => {
  assert.ok(COMMANDS.some((command) => command.name === "/plan" && command.run === "mode:plan"));
  assert.ok(COMMANDS.some((command) => command.name === "/sandbox" && command.run === "sandbox"));
  assert.ok(filterCommands("/plan").some((command) => command.run === "mode:plan"));
  assert.ok(filterCommands("sandbox").some((command) => command.run === "sandbox"));
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /Preview only/);
  assert.match(store, /vendorSendTarget\(session\.provider\)/);
  assert.match(store, /session\.provider === "codex"/);
  assert.match(store, /live === "claude"/);
  const preview = store.slice(store.indexOf("Preview only"), store.indexOf("Preview only") + 400);
  assert.doesNotMatch(preview, /grokPrompt/);
  assert.doesNotMatch(preview, /codexPrompt/);
  assert.doesNotMatch(preview, /claudePrompt/);
  const docs = ["README.md", "GOAL.md", "AGENTS.md"].map((name) => readFileSync(path.join(ROOT, name), "utf8")).join("\n");
  assert.match(docs, /claude-agent-acp|Claude chats use|Claude are live ACP/i);
  assert.match(docs, /codex-acp|Codex ACP is wired|Codex chats use/i);
});

test("vendor session id and sandbox survive normalizeSession", () => {
  const saved = {
    id: "sess_9",
    projectId: "proj_1",
    provider: "grok",
    model: "grok-4.6",
    effort: "high",
    title: "Resume me",
    mode: "plan",
    sandbox: "workspace",
    vendorSessionId: "acp-abc",
    status: "idle",
    messages: [{ id: "m", role: "user", text: "hi", createdAt: 1 }],
    contextUsed: 12,
  };
  const session = normalizeSession(saved);
  assert.ok(session);
  assert.equal(session.vendorSessionId, "acp-abc");
  assert.equal(session.sandbox, "workspace");
  assert.equal(session.mode, "plan");
  const again = normalizeSession(JSON.parse(JSON.stringify(session)));
  assert.equal(again?.vendorSessionId, "acp-abc");
  assert.equal(again?.sandbox, "workspace");
  const recovered = normalizeSession({ ...saved, status: "running" });
  assert.equal(recovered?.status, "idle");
});

test("unsent composer text and images survive normalizeSession", () => {
  const saved = {
    id: "sess_draft",
    projectId: null,
    provider: "grok",
    model: "grok-4.6",
    title: "New chat",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [],
    contextUsed: 0,
    composerDraft: "still typing this",
    composerImages: [{ id: "img_1", name: "shot.png", mimeType: "image/png", data: "abcd", kind: "image" }],
  };
  const session = normalizeSession(saved);
  assert.ok(session);
  assert.equal(session.composerDraft, "still typing this");
  assert.equal(session.composerImages?.[0]?.name, "shot.png");
  const again = normalizeSession(JSON.parse(JSON.stringify(session)));
  assert.equal(again?.composerDraft, "still typing this");
  assert.equal(again?.composerImages?.[0]?.data, "abcd");
  const composer = readFileSync(path.join(ROOT, "src", "ui", "Composer.tsx"), "utf8");
  assert.match(composer, /setComposerDraft/);
  assert.match(composer, /composerDraft/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8"), /key=\{session\.id\}/);
});

test("turns keep the bot that ran them after a switch", () => {
  const grok = brainStamp({ provider: "grok", model: "grok-4.6" });
  const prior = stampUnstampedMessages(
    [{ id: "a", role: "assistant", text: "hi", createdAt: 1 }],
    grok,
  );
  assert.equal(prior[0]?.provider, "grok");
  assert.equal(prior[0]?.model, "grok-4.6");
  const kept = stampUnstampedMessages(prior, { provider: "codex", model: "gpt-5.6-sol" });
  assert.equal(kept[0]?.provider, "grok");
  const saved = normalizeMessage({
    id: "a",
    role: "assistant",
    text: "hi",
    createdAt: 1,
    provider: "custom",
    model: "MiniMax-M3",
    customBotId: "bot_1",
  });
  assert.equal(saved?.provider, "custom");
  assert.equal(saved?.customBotId, "bot_1");
  const mark = brainCaption(messageBrain(saved!, grok), [
    {
      id: "bot_1",
      name: "MiniMax",
      color: "#ff9f0a",
      baseUrl: "https://api.minimax.io/anthropic",
      model: "MiniMax-M3",
      apiKey: "k",
      api: "anthropic-messages",
      contextWindow: 200_000,
      createdAt: 1,
    },
  ]);
  assert.equal(mark.name, "MiniMax");
  assert.equal(mark.color, "#ff9f0a");
  const renamed = brainCaption(brainStamp({ provider: "claude", model: "opus" }), [], {
    grok: { connected: true },
    claude: { connected: true, name: "Clay", color: "#ff9f0a" },
    codex: { connected: false },
    custom: { connected: false, baseUrl: "", model: "", apiKey: "", contextWindow: 1 },
  });
  assert.equal(renamed.name, "Clay");
  assert.equal(renamed.color, "#ff9f0a");
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  const row = readFileSync(path.join(ROOT, "src", "ui", "ChatRow.tsx"), "utf8");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(pane, /turn-who/);
  assert.match(pane, /brainCaption/);
  assert.match(row, /ink \? \{ background: ink/);
  assert.match(store, /applySessionModelChange/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "session.ts"), "utf8"), /stampUnstampedMessages\(session\.messages, brainStamp\(session\)\)/);
});

test("shouldLoadVendorSession chooses new vs load vs reuse", () => {
  assert.equal(shouldLoadVendorSession({ nextKey: "a" }), "new");
  assert.equal(shouldLoadVendorSession({ vendorSessionId: "v1", nextKey: "a" }), "load");
  assert.equal(shouldLoadVendorSession({ vendorSessionId: "v1", existingSlotKey: "a", nextKey: "a" }), "reuse");
  assert.equal(shouldLoadVendorSession({ vendorSessionId: "v1", existingSlotKey: "old", nextKey: "new" }), "new");
});

function fakeAcp(script: {
  methods: string[];
  loadFail?: boolean;
  nextId?: string;
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill() {
      this.killed = true;
      this.emit("exit", 0, null);
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  let buffer = "";
  let created = 0;
  stdin.on("data", (chunk: Buffer | string) => {
    buffer += String(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number; method?: string; params?: { sessionId?: string } };
      if (message.id === undefined) continue;
      script.methods.push(message.method ?? "");
      if (message.method === "initialize") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
        continue;
      }
      if (message.method === "session/load") {
        if (script.loadFail) {
          stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { message: "unknown session" } })}\n`,
          );
          continue;
        }
        stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params?.sessionId } })}\n`,
        );
        continue;
      }
      if (message.method === "session/new") {
        created += 1;
        const sessionId = script.nextId ?? `new-${created}`;
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId } })}\n`);
        continue;
      }
      if (message.method === "session/prompt") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })}\n`);
        continue;
      }
      if (message.method === "_x.ai/rewind/points") {
        stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { points: [{ id: "p0", index: 0 }] },
          })}\n`,
        );
        continue;
      }
      if (message.method === "_x.ai/rewind/execute") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } })}\n`);
        continue;
      }
      if (message.method === "_x.ai/session/info") {
        stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              sessionId: message.params?.sessionId,
              turns: 1,
              context: {
                used: 5496,
                total: 500000,
                systemPromptTokens: 1516,
                toolDefinitionsCount: 25,
                toolDefinitionsTokens: 8471,
                messageCount: 2,
                messageTokens: 3980,
                freeTokens: 494504,
                usagePct: 1,
                autoCompactThresholdPercent: 80,
                usageCategories: [
                  { label: "Skills", tokens: 3971, detail: "36 skills" },
                  { label: "MCP servers", tokens: 81, detail: "5 servers" },
                ],
              },
            },
          })}\n`,
        );
        continue;
      }
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
    }
  });
  return child;
}

test("GrokSessionHost new chat uses session/new then session/prompt", async () => {
  const methods: string[] = [];
  const host = new GrokSessionHost(() => fakeAcp({ methods, nextId: "fresh-1" }));
  const opened: string[] = [];
  const result = await host.prompt(
    {
      sessionId: "work-1",
      text: "hello",
      model: "grok-4.6",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
    },
    (event) => {
      if (event.type === "vendor-session") opened.push(event.opened);
    },
  );
  host.disposeAll();
  assert.deepEqual(methods, ["initialize", "session/new", "session/prompt"]);
  assert.equal(result.vendorSessionId, "fresh-1");
  assert.equal(result.opened, "session/new");
  assert.deepEqual(opened, ["session/new"]);
});

test("GrokSessionHost sessionInfo reads live context from the existing agent", async () => {
  const methods: string[] = [];
  const host = new GrokSessionHost(() => fakeAcp({ methods, nextId: "fresh-1" }));
  assert.equal(await host.sessionInfo("work-1"), null);
  await host.prompt(
    {
      sessionId: "work-1",
      text: "hello",
      model: "grok-4.6",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
    },
    () => undefined,
  );
  const stats = await host.sessionInfo("work-1");
  host.disposeAll();
  assert.ok(stats);
  assert.equal(stats.used, 5496);
  assert.equal(stats.occupying[0]?.label, "System prompt");
  assert.ok(methods.includes("_x.ai/session/info"));
  assert.equal(methods.filter((method) => method === "session/new").length, 1);
});

test("GrokSessionHost rewind resets the first prompt and executes later points", async () => {
  const methods: string[] = [];
  const host = new GrokSessionHost(() => fakeAcp({ methods, nextId: "fresh-1" }));
  const fresh = await host.rewind(
    {
      sessionId: "work-1",
      model: "grok-4.6",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
      keepUserIndex: -1,
    },
    () => undefined,
  );
  assert.equal(fresh.reset, true);
  await host.prompt(
    {
      sessionId: "work-1",
      text: "hello",
      model: "grok-4.6",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
    },
    () => undefined,
  );
  methods.length = 0;
  const later = await host.rewind(
    {
      sessionId: "work-1",
      model: "grok-4.6",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
      keepUserIndex: 0,
    },
    () => undefined,
  );
  host.disposeAll();
  assert.equal(later.reset, false);
  assert.equal(later.rewound, true);
  assert.ok(methods.includes("_x.ai/rewind/points"));
  assert.ok(methods.includes("_x.ai/rewind/execute"));
});

test("GrokSessionHost loads a stored vendor id after dispose", async () => {
  const methods: string[] = [];
  const host = new GrokSessionHost(() => fakeAcp({ methods }));
  await host.prompt(
    {
      sessionId: "work-2",
      text: "one",
      model: "grok-4.6",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
      vendorSessionId: "keep-me",
    },
    () => undefined,
  );
  host.dispose("work-2");
  methods.length = 0;
  const result = await host.prompt(
    {
      sessionId: "work-2",
      text: "two",
      model: "grok-4.6",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
      vendorSessionId: "keep-me",
    },
    () => undefined,
  );
  host.disposeAll();
  assert.deepEqual(methods, ["initialize", "session/load", "session/prompt"]);
  assert.equal(result.vendorSessionId, "keep-me");
  assert.equal(result.opened, "session/load");
});

test("GrokSessionHost failed load falls back to session/new", async () => {
  const methods: string[] = [];
  const host = new GrokSessionHost(() => fakeAcp({ methods, loadFail: true, nextId: "recovered" }));
  const result = await host.prompt(
    {
      sessionId: "work-3",
      text: "hi",
      model: "grok-4.6",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
      vendorSessionId: "missing",
    },
    () => undefined,
  );
  host.disposeAll();
  assert.ok(methods.includes("session/load"));
  assert.ok(methods.includes("session/new"));
  assert.equal(result.vendorSessionId, "recovered");
  assert.equal(result.opened, "session/new");
});

test("launch-key change starts a new vendor session", async () => {
  const methods: string[] = [];
  const host = new GrokSessionHost(() => fakeAcp({ methods, nextId: "second" }));
  await host.prompt(
    {
      sessionId: "work-4",
      text: "a",
      model: "grok-4.6",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
      vendorSessionId: "old-id",
    },
    () => undefined,
  );
  methods.length = 0;
  const result = await host.prompt(
    {
      sessionId: "work-4",
      text: "b",
      model: "grok-4.6",
      effort: "high",
      mode: "ask",
      cwd: ROOT,
      vendorSessionId: "old-id",
    },
    () => undefined,
  );
  host.disposeAll();
  assert.deepEqual(methods, ["initialize", "session/new", "session/prompt"]);
  assert.equal(result.opened, "session/new");
});

test("Grok login detection runs in Electron main over IPC, not sandboxed preload", () => {
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  assert.match(main, /from "\.\/grok-login"/);
  assert.match(main, /ipcMain\.handle\("grok:detect-login"/);
  assert.match(main, /detectGrokLogin\(\)/);
  assert.match(preload, /ipcRenderer\.invoke\("grok:detect-login"/);
  assert.doesNotMatch(preload, /grok-login/);
  assert.doesNotMatch(preload, /detectGrokLogin\(\)/);
  assert.doesNotMatch(preload, /node:fs|node:os|node:path/);
});

test("detectGrokLogin requires binary plus login artifact", () => {
  const files = new Set<string>();
  const missing = detectGrokLogin({
    env: { PATH: "" },
    homedir: "C:\\tmp\\no-home",
    platform: "win32",
    existsSync: (filePath) => files.has(filePath),
    pathDirs: [],
  });
  assert.equal(missing.connected, false);
  assert.equal(missing.binary, null);

  files.add("C:\\tmp\\home\\.grok\\bin\\grok.exe");
  files.add("C:\\tmp\\home\\.grok\\auth.json");
  const found = detectGrokLogin({
    env: { PATH: "" },
    homedir: "C:\\tmp\\home",
    platform: "win32",
    existsSync: (filePath) => files.has(filePath),
    pathDirs: [],
  });
  assert.equal(found.connected, true);
  assert.ok(found.binary?.endsWith("grok.exe"));
});

test("thought snapshots replace instead of stacking the same draft", () => {
  const first = "The user is asking what tools I have. This is a straightforward informational question.";
  const grown = `${first} Let me also check MCP tools.`;
  assert.equal(mergeThoughtText(first, grown), grown);
  assert.equal(mergeThoughtText(grown, first), grown);
  assert.equal(mergeThoughtText("Hello", " world"), "Hello world");
  const stacked = upsertThoughtMessage(
    upsertThoughtMessage([{ id: "a", role: "assistant", text: "", createdAt: 1 }], first),
    grown,
  );
  assert.equal(stacked.at(-1)?.text, grown);
  const doubled = `${first}\n\n${grown}\n\n${grown}`;
  assert.equal(collapseThoughtDisplay(doubled), grown);
  const shownTools = thoughtForReply({
    assistantThought: grown,
    thoughtMessages: [{ text: grown }],
    assistantText: `${first}\n\n### Tools\n- github`,
  });
  assert.equal(shownTools, grown);
  assert.doesNotMatch(shownTools, /asking what tools I have[\s\S]*asking what tools I have/);
});

test("thought rows stay distinct from assistant text", () => {
  const withBoth = upsertThoughtMessage(
    [{ id: "a", role: "assistant", text: "Hello", createdAt: 1 }],
    "reasoning…",
  );
  assert.equal(withBoth.length, 2);
  assert.equal(withBoth[0].text, "Hello");
  assert.equal(withBoth[1].kind, "thought");
  assert.equal(withBoth[1].text, "reasoning…");
  const grouped = groupTranscript([
    { id: "u", role: "user", text: "q", createdAt: 1 },
    { id: "a", role: "assistant", text: "Hello", createdAt: 2 },
    { id: "th", role: "system", kind: "thought", text: "hmm", createdAt: 3 },
  ]);
  assert.equal(grouped[1].type, "reply");
  if (grouped[1].type === "reply") {
    assert.equal(grouped[1].assistant.text, "Hello");
    assert.equal(grouped[1].thoughts[0]?.text, "hmm");
  }
});

test("vendor model caches drive the picker so Sol is first and new slugs need no hand edit", () => {
  assert.equal(defaultModel("codex").id, "gpt-5.6-sol");
  assert.equal(defaultModel("codex").name, "GPT-5.6-Sol");
  assert.equal(advertisedCodexWindow("gpt-5.6-sol", 272_000), 1_050_000);
  assert.equal(contextWindowFor("codex", "gpt-5.6-sol"), 1_050_000);
  assert.equal(defaultModel("claude").id, "claude-fable-5");
  assert.equal(contextWindowFor("claude", "claude-fable-5"), 1_000_000);
  assert.equal(contextWindowFor("claude", "claude-opus-5"), 1_000_000);
  assert.equal(contextWindowFor("claude", "claude-sonnet-5"), 1_000_000);
  assert.equal(contextWindowFor("claude", "claude-haiku-4-5"), 200_000);
  assert.equal(advertisedClaudeWindow("claude-opus-5", 200_000), 1_000_000);
  assert.equal(effortsFor("claude", "claude-sonnet-5").map((item) => item.id).includes("max"), true);
  const setup = readFileSync(path.join(ROOT, "src", "ui", "SessionSetup.tsx"), "utf8");
  const menu = readFileSync(path.join(ROOT, "src", "ui", "ModelMenu.tsx"), "utf8");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const preloadSrc = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  const preloadBuiltPath = path.join(ROOT, "dist-electron", "preload.mjs");
  assert.match(setup, /modelsFor\(session\.provider\)/);
  assert.doesNotMatch(setup, /MODEL_CATALOG\[session\.provider\]/);
  assert.match(menu, /modelsFor\(provider\.id\)/);
  assert.match(store, /listVendorModels/);
  assert.match(store, /applyVendorCatalog/);
  assert.match(main, /ipcMain\.handle\("models:list"/);
  assert.match(preloadSrc, /listVendorModels/);
  if (existsSync(preloadBuiltPath)) {
    assert.match(readFileSync(preloadBuiltPath, "utf8"), /models:list/);
  }

  const codex = parseCodexModelsCache(
    JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          visibility: "list",
          context_window: 272000,
          supported_reasoning_levels: [{ effort: "low" }],
        },
        {
          slug: "gpt-5.6-sol-wm",
          display_name: "GPT-5.6-Sol-WM",
          visibility: "hide",
          context_window: 272000,
        },
        {
          slug: "gpt-5.6-terra",
          display_name: "GPT-5.6-Terra",
          visibility: "list",
          context_window: 272000,
          supported_reasoning_levels: [{ effort: "medium" }],
        },
        { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
      ],
    }),
  );
  assert.deepEqual(
    codex.map((model) => model.id),
    ["gpt-5.6-sol", "gpt-5.6-terra"],
  );
  assert.equal(codex[0]?.name, "GPT-5.6-Sol");
  assert.equal(codex[0]?.contextWindow, 1_050_000);
  assert.deepEqual(codex[0]?.reasoningLevels?.map((item) => item.id), ["low"]);

  const grok = parseGrokModelsCache(
    JSON.stringify({
      models: {
        "grok-4.6": { info: { id: "grok-4.6", name: "Grok 4.6", context_window: 500000, hidden: false, supports_reasoning_effort: true } },
        "grok-4.5": { info: { id: "grok-4.5", name: "Grok 4.5", context_window: 500000, hidden: false, supports_reasoning_effort: true } },
      },
    }),
  );
  assert.deepEqual(
    grok.map((model) => model.id),
    ["grok-4.6", "grok-4.5"],
  );

  const missing = listVendorModels({
    env: {},
    homedir: path.join(ROOT, "does-not-exist"),
    existsSync: () => false,
    readFile: () => {
      throw new Error("should not read");
    },
  });
  assert.equal(missing.codex[0]?.id, "gpt-5.6-sol");
  assert.ok(missing.grok.some((model) => model.id === "grok-build"));

  const home = "C:\\home";
  const files: Record<string, string> = {
    [path.join(home, ".codex", "models_cache.json")]: JSON.stringify({
      models: [
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", context_window: 272000 },
        { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", context_window: 272000 },
      ],
    }),
    [path.join(home, ".grok", "models_cache.json")]: JSON.stringify({
      models: {
        "grok-4.6": { info: { id: "grok-4.6", name: "Grok 4.6", context_window: 500000 } },
      },
    }),
  };
  const live = listVendorModels({
    env: {},
    homedir: home,
    existsSync: (file) => Boolean(files[file]),
    readFile: (file) => files[file] ?? "",
  });
  assert.deepEqual(
    live.codex.map((model) => model.id),
    ["gpt-5.6-sol", "gpt-5.6-luna"],
  );
  assert.deepEqual(
    live.grok.map((model) => model.id),
    ["grok-4.6", "grok-build"],
  );

  try {
    applyVendorCatalog(live);
    assert.equal(defaultModel("codex").id, "gpt-5.6-sol");
    assert.equal(defaultModel("codex").name, "GPT-5.6-Sol");
  } finally {
    resetVendorCatalog();
  }
});

test("vendor preface lists extra folders and references, not cwd", () => {
  const preface = buildVendorPreface({
    cwd: "C:\\proj\\app",
    folders: ["C:\\proj\\app", "C:\\proj\\docs"],
    references: [{ kind: "url", value: "https://example.com", label: "Spec" }],
  });
  assert.match(preface, /Working directory: C:\\proj\\app/);
  assert.match(preface, /C:\\proj\\docs/);
  assert.match(preface, /already on this project/);
  assert.doesNotMatch(preface, /^- C:\\proj\\app$/m);
  assert.match(preface, /url: https:\/\/example.com/);
  const onlyCwd = buildVendorPreface({ cwd: "C:\\proj\\app", folders: ["C:\\proj\\app"], references: [] });
  assert.match(onlyCwd, /Working directory: C:\\proj\\app/);
  assert.equal(withVendorPreface("Hi", preface).startsWith(preface), true);
  const session = buildSessionPreface({ cwd: "C:\\proj\\app", folders: ["C:\\proj\\app"], references: [] });
  assert.match(session, new RegExp(WORKHORSE_SESSION_RULES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(session, /This chat’s live desk limits/);
  assert.match(session, /Working directory: C:\\proj\\app/);
  const machine = buildSessionPreface({
    cwd: "C:\\proj\\app",
    folders: ["C:\\proj\\app"],
    references: [],
    mode: "ask",
    sandbox: "off",
    surface: "http",
  });
  assert.match(machine, /Permission: Ask/);
  assert.match(machine, /full machine access, subject to Permission/);
  assert.match(machine, /workhorse_create_project/);
  assert.match(machine, /exact name/);
  const noFolder = buildVendorPreface({ cwd: "", folders: [], references: [] });
  assert.match(noFolder, /No project folder is linked/);
  assert.match(noFolder, /Sandbox Off can take any absolute path/);
  const boxed = buildSessionPreface({
    cwd: "C:\\proj\\app",
    folders: ["C:\\proj\\app"],
    references: [],
    mode: "ask",
    sandbox: "read-only",
  });
  assert.match(boxed, /Read-only/);
  assert.match(boxed, /You cannot write files this turn/);
  assert.match(boxed, /workhorse_request_permission/);
  assert.match(boxed, /override any earlier message/);
  const asked = composeVendorPrompt("Do a code write for me please", boxed, "session/load", {
    mode: "ask",
    sandbox: "read-only",
  });
  assert.match(asked, /workhorse_request_permission/);
  assert.match(asked, /Do a code write for me please/);
  assert.match(asked, /live desk limits/);
  const opened = composeVendorPrompt("Do a code write for me please", boxed, "session/load", {
    mode: "ask",
    sandbox: "off",
  });
  assert.match(opened, /Writes are allowed this turn/);
  assert.match(opened, /Do not offer to lower Permission or Sandbox/);
  assert.doesNotMatch(opened, /You cannot write files this turn/);
  const later = composeVendorPrompt("ok continue", boxed, "session/load", { mode: "ask", sandbox: "read-only" });
  assert.match(later, /You cannot write files this turn/);
  const withDesk = buildSessionPreface({
    cwd: "C:\\proj\\app",
    folders: ["C:\\proj\\app"],
    references: [],
    desk: {
      title: "Preview Query",
      projectName: "Walk Test",
      sidebar: "Grok 4.6 · Medium · Ask",
      preview: "Hey — I'm here and ready.",
    },
  });
  assert.match(withDesk, /Title: Preview Query/);
  assert.match(withDesk, /Project: Walk Test/);
  assert.match(withDesk, /Sidebar subtitle/);
  assert.match(withDesk, /Preview \(last message snippet\): Hey — I'm here and ready\./);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /buildSessionPreface/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /applySessionModelChange/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /vendorSessionForSend/);
});

test("switching This-chat vendor drops the previous vendor session", () => {
  const base = normalizeSession({
    id: "sess_1",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    mode: "ask",
    vendorSessionId: "codex-acp-1",
    vendorProvider: "codex",
    status: "running",
    messages: [{ id: "u", role: "user", text: "test", createdAt: 1 }],
  });
  assert.ok(base);
  const grok = applySessionModelChange(base!, {
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
  });
  assert.equal(grok.provider, "grok");
  assert.equal(grok.model, "grok-4.6");
  assert.equal(grok.vendorSessionId, undefined);
  assert.equal(grok.vendorProvider, undefined);
  assert.equal(grok.status, "idle");
  assert.equal(vendorSessionForSend(grok), undefined);
  assert.equal(vendorSessionForSend(base!), "codex-acp-1");
  assert.equal(vendorSessionForSend({ provider: "grok", vendorSessionId: "codex-acp-1", vendorProvider: "codex" }), undefined);
  const same = applySessionModelChange(base!, {
    provider: "codex",
    model: "gpt-5.6-terra",
    effort: "high",
    customBotId: undefined,
  });
  assert.equal(same.vendorSessionId, "codex-acp-1");
  const planned = applySessionPolicyChange(base!, { mode: "plan" });
  assert.equal(planned.mode, "plan");
  assert.equal(planned.vendorSessionId, undefined);
  const boxed = applySessionPolicyChange(base!, { sandbox: "read-only" });
  assert.equal(boxed.sandbox, "read-only");
  assert.equal(boxed.vendorSessionId, undefined);
  assert.equal(formatChatSidebar({ provider: "grok", model: "grok-4.6", effort: "medium", mode: "ask" }), "Grok 4.6 · Medium · Ask");
  assert.equal(
    workerSidebarLabel({
      id: "worker_terra",
      parentId: "orchestrator",
      provider: "codex",
      model: "gpt-5.6-terra",
      effort: "medium",
      title: "Certify Saga candidate",
      mode: "always-approve",
      sandbox: "off",
      status: "idle",
      contextUsed: 0,
      messages: [],
      agentRun: { status: "completed", startedAt: 1, isolation: "worktree" },
    }),
    "GPT-5.6-Terra · Medium · Done",
  );
  const listed = catalogSessions({
    sessions: [
      {
        id: "sess_1",
        title: "Preview Query",
        provider: "grok",
        model: "grok-4.6",
        effort: "medium",
        mode: "ask",
        messages: [
          { role: "user", text: "test" },
          { role: "assistant", text: "Hey — I'm here and ready. What would you like to work on?" },
        ],
      },
    ],
  });
  assert.equal(listed[0]?.sidebar, "Grok 4.6 · Medium · Ask");
  assert.match(listed[0]?.preview ?? "", /Hey — I'm here and ready/);
});

test("desk-bot requests get a turn hint instead of a source dive", () => {
  assert.equal(looksLikeDeskBotRequest("Set up MiniMax"), true);
  assert.equal(looksLikeDeskBotRequest("add another llm please"), true);
  assert.equal(looksLikeDeskBotRequest("implement the MiniMax adapter"), false);
  assert.equal(looksLikeDeskBotRequest("read workhorse-mcp and fix setup"), false);
  assert.equal(withDeskBotHint("Set up MiniMax").startsWith(DESK_BOT_TURN_HINT), true);
  assert.equal(looksLikeSpawnRequest("Summon multiple subagents to scrape all these systems"), true);
  assert.equal(looksLikeSpawnRequest("please spawn subagents"), true);
  assert.equal(looksLikeSpawnRequest("rename the project"), false);
  assert.equal(looksLikeGoalCommand("/goal ship the backlog"), true);
  assert.equal(looksLikeSpawnRequest("/goal ship the backlog"), false);
  assert.equal(looksLikeSpawnRequest("/goal assign skeptic verifier subagents"), false);
  assert.equal(withSpawnHint("/goal assign skeptic and spawn subagents"), "/goal assign skeptic and spawn subagents");
  assert.equal(withSpawnHint("Summon multiple subagents").startsWith(SPAWN_TURN_HINT), true);
  const spawnAsk = composeVendorPrompt("Summon multiple subagents", WORKHORSE_SESSION_RULES, "session/load");
  assert.match(spawnAsk, /canCall/);
  assert.match(spawnAsk, /do not name it/);
  assert.match(spawnAsk, /API key is already on the desk/);
  const loaded = composeVendorPrompt("Set up MiniMax", WORKHORSE_SESSION_RULES, "session/load");
  assert.match(loaded, /workhorse_list_bots/);
  assert.match(loaded, /Set up MiniMax/);
  const fresh = composeVendorPrompt("hi", WORKHORSE_SESSION_RULES, "session/new");
  assert.equal(fresh.startsWith(WORKHORSE_SESSION_RULES), true);
  assert.doesNotMatch(fresh, new RegExp(DESK_BOT_TURN_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(looksLikePreviewQuestion("What does the preview message say?"), true);
  assert.equal(looksLikePreviewQuestion("hi"), false);
  const previewAsk = composeVendorPrompt("What does the preview message say?", WORKHORSE_SESSION_RULES, "session/load");
  assert.match(previewAsk, new RegExp(PREVIEW_TURN_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("desk-enforced orchestrator vs worker lineup", async () => {
  assert.equal(looksLikeSpawnRequest("Summon multiple subagents to scrape all these systems"), true);
  assert.equal(looksLikeSpawnRequest("PLease call subagents to strip threw the project"), true);

  const workerBrief = formatWorkerPrompt({
    fromTitle: "PLease call subagents to strip threw...",
    text: "You are a MiniMax sub-agent spawned by the Workhorse MiniMax chat.\n\nYour slice: PROJECT IDENTITY & BUILD CONFIG.\n\nRead README.md",
    folder: "D:\\Godot\\Projects\\spaceship-battle",
    project: "Spaceship battles",
    slice: "Review project identity and docs",
    vendor: "MiniMax",
    skills: [{ name: "codex:play-release", file: "/skills/play-release/SKILL.md" }],
    capabilities: ["Godot Android billing"],
  });
  assert.equal(looksLikeWorkerBrief(workerBrief), true);
  assert.match(workerBrief, /ROLE: worker/);
  assert.match(workerBrief, /D:\\Godot\\Projects\\spaceship-battle/);
  assert.match(workerBrief, /one quick-route helper/);
  assert.match(workerBrief, /SKILLS: codex:play-release @ \/skills\/play-release\/SKILL\.md/);
  assert.match(workerBrief, /CAPABILITIES: Godot Android billing/);
  assert.match(workerBrief, /Read every listed SKILL\.md fully before acting/);
  assert.match(workerBrief, /Read README\.md/);
  assert.doesNotMatch(workerBrief, /From another Workhorse agent/);
  assert.equal(looksLikeSpawnRequest(workerBrief), false);
  assert.equal(withSpawnHint(workerBrief), workerBrief);
  assert.equal(withSpawnHint(workerBrief, "worker"), workerBrief);
  assert.equal(withCustomPeerHint(workerBrief), workerBrief);
  assert.doesNotMatch(composeVendorPrompt(workerBrief, WORKHORSE_SESSION_RULES, "session/load"), new RegExp(SPAWN_TURN_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const workerTurn = composeVendorPrompt(
    "You are a MiniMax sub-agent spawned — call workhorse_spawn_agent",
    WORKER_SESSION_RULES,
    "session/load",
    { role: "worker" },
  );
  assert.doesNotMatch(workerTurn, new RegExp(SPAWN_TURN_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(workerTurn, new RegExp(CUSTOM_HTTP_PEER_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.equal(isSpawnOnlyPrompt("please spawn MiniMax"), true);
  assert.equal(isSpawnOnlyPrompt("call subagents"), true);
  assert.equal(isSpawnOnlyPrompt("PLease call subagents to strip threw the project and give an indepth review on what it is"), true);
  assert.equal(isSpawnOnlyPrompt("Read project.godot and say what this game is."), false);
  assert.equal(isSpawnOnlyPrompt(workerBrief), false);

  const catalog = [
    { name: "list_dir" },
    { name: "workhorse_spawn_agent" },
    { name: "workhorse_await_agents" },
    { name: "workhorse_request_vendor" },
    { name: "workhorse_list_bots" },
    { name: "workhorse_read_chat" },
  ];
  assert.deepEqual(
    toolsForDeskRole(catalog, "orchestrator").map((tool) => tool.name),
    catalog.map((tool) => tool.name),
  );
  assert.deepEqual(
    toolsForDeskRole(catalog, "worker").map((tool) => tool.name),
    ["list_dir", "workhorse_spawn_agent", "workhorse_await_agents", "workhorse_read_chat"],
  );

  const bound = admitSpawn({
    parent: { parentId: null },
    projectFolder: "D:\\Godot\\Projects\\spaceship-battle",
    prompt: "Read project.godot and say what this game is.",
  });
  assert.equal(bound.ok, true);
  if (bound.ok) assert.equal(bound.cwd, "D:\\Godot\\Projects\\spaceship-battle");

  const unbound = admitSpawn({
    parent: { parentId: null },
    prompt: "Read project.godot and say what this game is.",
  });
  assert.equal(unbound.ok, false);
  if (!unbound.ok) assert.equal(unbound.error, UNBOUND_SPAWN_ERROR);

  const nested = admitSpawn({
    parent: { parentId: "sess_orch", hidden: true },
    projectFolder: "D:\\Godot\\Projects\\spaceship-battle",
    prompt: "Read project.godot and say what this game is.",
  });
  assert.equal(nested.ok, false);
  if (!nested.ok) assert.equal(nested.error, WORKER_SPAWN_ERROR);
  const boundedNested = admitSpawn({
    parent: { parentId: "sess_orch", hidden: true },
    projectFolder: "D:\\Godot\\Projects\\spaceship-battle",
    prompt: "Independently verify project.godot.",
    allowNested: true,
  });
  assert.equal(boundedNested.ok, true);
  assert.doesNotMatch(WORKER_SPAWN_ERROR, /MiniMax|M3/);
  assert.equal(nestedSpawnError([
    { id: "root" },
    { id: "worker", parentId: "root" },
  ], "worker"), null);
  assert.equal(nestedSpawnError([
    { id: "root" },
    { id: "worker", parentId: "root" },
    { id: "helper", parentId: "worker" },
  ], "worker"), WORKER_SPAWN_ERROR);
  assert.equal(nestedSpawnError([
    { id: "root" },
    { id: "worker", parentId: "root" },
    { id: "helper", parentId: "worker" },
  ], "helper"), WORKER_SPAWN_ERROR);

  const spawnOnly = admitSpawn({
    parent: { parentId: null },
    projectFolder: "D:\\Godot\\Projects\\spaceship-battle",
    prompt: "please spawn MiniMax",
  });
  assert.equal(spawnOnly.ok, false);
  if (!spawnOnly.ok) assert.equal(spawnOnly.error, SPAWN_ONLY_PROMPT_ERROR);

  const explicit = admitSpawn({
    parent: { parentId: null },
    folder: "D:\\Godot\\Projects\\spaceship-battle",
    prompt: "Read project.godot and say what this game is.",
    folderExists: (value) => value === "D:\\Godot\\Projects\\spaceship-battle",
  });
  assert.equal(explicit.ok, true);
  if (explicit.ok) assert.equal(explicit.cwd, "D:\\Godot\\Projects\\spaceship-battle");

  assert.equal(deskRoleOf({ parentId: "p", hidden: true }), "worker");
  assert.equal(deskRoleOf({ parentId: null }), "orchestrator");

  const { customHttpTools } = await import("../electron/custom-tools");
  const customToolset = customHttpTools();
  const orchTools = customToolset.map((tool) => tool.name);
  const workerTools = customHttpTools([], { role: "worker" }).map((tool) => tool.name);
  assert.ok(orchTools.includes("workhorse_spawn_agent"));
  assert.ok(orchTools.includes("workhorse_plan"));
  assert.match(JSON.stringify(customToolset.find((tool) => tool.name === "workhorse_plan")?.input_schema), /revise/);
  assert.ok(orchTools.includes("workhorse_probe_runtime"));
  assert.ok(orchTools.includes("workhorse_request_vendor"));
  assert.ok(workerTools.includes("workhorse_spawn_agent"));
  assert.ok(workerTools.includes("workhorse_await_agents"));
  assert.ok(!workerTools.includes("workhorse_request_vendor"));
  assert.ok(!workerTools.includes("workhorse_list_bots"));
  assert.ok(!workerTools.includes("workhorse_plan"));
  assert.ok(workerTools.includes("list_dir"));
  assert.ok(workerTools.includes("read_file"));

  assert.equal(spawnWaitsForReply({}), true);
  assert.equal(spawnWaitsForReply({ wait: true }), true);
  assert.equal(spawnWaitsForReply({ wait: false }), false);
  assert.equal(spawnWaitsForReply({ wait: "false" }), false);
  const kidRunning: Session = {
    id: "kid_run",
    parentId: "orch",
    provider: "custom",
    model: "MiniMax-M3",
    title: "src tree",
    mode: "ask",
    sandbox: "off",
    status: "running",
    messages: [{ id: "a", role: "assistant", text: "", createdAt: 1 }],
    contextUsed: 0,
    agentRun: { status: "running", startedAt: 1, isolation: "shared" },
  };
  const kidDone: Session = {
    ...kidRunning,
    id: "kid_done",
    title: "docs",
    status: "idle",
    agentRun: { status: "completed", startedAt: 1, isolation: "shared", finishedAt: 2 },
    messages: [{ id: "a", role: "assistant", text: "It is a Godot game.", createdAt: 1 }],
  };
  assert.equal(parentHasRunningChildren([kidRunning, kidDone], "orch"), true);
  assert.equal(parentHasRunningChildren([kidDone], "orch"), false);
  assert.equal(rootSpawnError([kidRunning], "orch"), null);
  assert.match(rootSpawnError([kidRunning, { ...kidRunning, id: "kid_run_2" }], "orch") ?? "", /2 workers/);
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true }), true);
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true, provider: "custom" }), false);
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true, model: "MiniMax-M3" }), false);
  assert.equal(shouldAutoRouteSpawn({ routingEnabled: true, chat: "Kimi" }), false);
  assert.equal(collectChildAgentReports([kidDone], "orch")[0]?.text, "It is a Godot game.");
  const { groupFanOutToolUses } = await import("../electron/custom-tools");
  assert.deepEqual(
    groupFanOutToolUses([
      { name: "workhorse_list_bots" },
      { name: "workhorse_spawn_agent" },
      { name: "workhorse_spawn_agent" },
      { name: "workhorse_await_agents" },
    ]).map((group) => group.length),
    [1, 2, 1],
  );
  assert.match(WORKHORSE_SESSION_RULES, /wait=false/);
  assert.match(WORKHORSE_SESSION_RULES, /workhorse_await_agents/);
  assert.match(WORKHORSE_SESSION_RULES, /Do not sit on workhorse_await_agents|do not ask 1\/2\/3/i);
  assert.equal(looksLikeCrewImpatience("timed out twice. pick one: re-await or scrape myself"), true);
  assert.equal(withCrewStatusHint("workers are still running").startsWith(CREW_STATUS_HINT), true);
  const awaitNow = peerAskTimeoutMs({ mode: "bots", action: "await-agents", timeoutSeconds: 600 });
  assert.ok(awaitNow.timeoutMs <= 15_000);
  const awaitTimer = peerAskTimeoutMs({ mode: "bots", action: "await-agents", wait: true, timeoutSeconds: 600 });
  assert.ok(awaitTimer.timeoutMs > 45_000);
  assert.doesNotMatch(awaitTimer.timeoutError, /setting up that bot/);
  assert.equal(peerAskTimeoutMs({ mode: "bots", action: "create" }).timeoutMs, 45_000);
  const crew = addLineupRow(emptyLineup("D:\\Godot\\Projects\\spaceship-battle", 1), {
    childId: "sess_a",
    title: "HUD",
    slice: "HUD",
    folder: "D:\\Godot\\Projects\\spaceship-battle",
    vendor: "MiniMax",
    status: "running",
    startedAt: 1,
  });
  const two = addLineupRow(crew, {
    childId: "sess_b",
    title: "Ships",
    slice: "Ships",
    folder: "D:\\Godot\\Projects\\spaceship-battle",
    vendor: "MiniMax",
    status: "running",
    startedAt: 2,
  });
  assert.equal(lineupIsTerminal(two), false);
  const oneDone = setLineupRowStatus(two, "sess_a", "completed", { report: "HUD report", finishedAt: 3 });
  const done = setLineupRowStatus(oneDone, "sess_b", "completed", { report: "Ships report", finishedAt: 4 });
  assert.equal(lineupIsTerminal(done), true);
  assert.equal(lineupSnapshot(done).finished.length, 2);
  const parentSess: Session = {
    id: "orch",
    projectId: "proj",
    provider: "custom",
    model: "MiniMax-M3",
    title: "Parent",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [],
    contextUsed: 0,
    lineup: two,
  };
  const childSess: Session = {
    ...parentSess,
    id: "sess_a",
    parentId: "orch",
    hidden: true,
    title: "HUD",
    lineup: undefined,
  };
  const finished = applyLineupChildFinish([parentSess, childSess], "sess_a", "HUD done", "completed", 9);
  const parentAfter = finished.find((item) => item.id === "orch");
  assert.equal(parentAfter?.lineup?.rows.find((row) => row.childId === "sess_a")?.report, "HUD done");
  const broken = applyLineupTurnBreak(finished, "orch");
  assert.ok(broken.find((item) => item.id === "orch")?.messages.some((message) => message.text === LINEUP_FINISHED_NOTICE));
  assert.match(lineupSynthesizePrompt(done), /HUD report/);
  assert.match(lineupSynthesizePrompt(done), /own words|combined review/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /maybeEnqueueLineupJoin/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /lineupJoinPrompt|maybeEnqueueLineupJoin/);
  const nestedTree = nestProjectChats([
    { id: "orch" },
    { id: "sess_a", parentId: "orch" },
    { id: "sess_b", parentId: "orch" },
  ]);
  assert.equal(nestedTree.length, 1);
  assert.equal(nestedTree[0]?.workers.length, 2);
  const crewCatalog = catalogSessions(
    {
      projects: [{ id: "proj", name: "Ships" }],
      sessions: [
        { id: "orch", title: "Parent", provider: "custom", projectId: "proj", messages: [{ role: "user", text: "go" }] },
        {
          id: "sess_a",
          title: "HUD",
          provider: "custom",
          parentId: "orch",
          hidden: true,
          projectId: "proj",
          messages: [{ role: "user", text: "slice" }],
        },
      ],
    },
    { fromSessionId: "orch" },
  );
  assert.ok(crewCatalog.some((item) => item.id === "sess_a"));
  const nestedCrew = [
    { id: "orch" },
    { id: "sess_a", parentId: "orch" },
    { id: "helper", parentId: "sess_a" },
    { id: "other" },
  ];
  assert.equal(sameSessionCrew(nestedCrew, "orch", "helper"), true);
  assert.equal(sameSessionCrew(nestedCrew, "sess_a", "helper"), true);
  assert.equal(sameSessionCrew(nestedCrew, "other", "helper"), false);
  const nestedCatalog = catalogSessions(
    {
      projects: [],
      sessions: nestedCrew.map((session) => ({
        ...session,
        title: session.id,
        provider: "custom",
        hidden: Boolean(session.parentId),
        messages: [{ role: "user", text: "crew" }],
      })),
    },
    { fromSessionId: "helper" },
  );
  assert.deepEqual(nestedCatalog.map((item) => item.id), ["orch", "sess_a", "helper", "other"]);
  const publicCatalog = catalogSessions({
    projects: [{ id: "proj", name: "Ships" }],
    sessions: [
      { id: "orch", title: "Parent", provider: "custom", projectId: "proj", messages: [{ role: "user", text: "go" }] },
      {
        id: "sess_a",
        title: "HUD",
        provider: "custom",
        parentId: "orch",
        hidden: true,
        projectId: "proj",
        messages: [{ role: "user", text: "slice" }],
      },
    ],
  });
  assert.ok(!publicCatalog.some((item) => item.id === "sess_a"));
  const persisted = normalizeSession({
    id: "orch",
    provider: "custom",
    model: "MiniMax-M3",
    title: "Parent",
    lineup: done,
  });
  assert.equal(persisted?.lineup?.rows.length, 2);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /addLineupRow/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "Sidebar.tsx"), "utf8"), /nestProjectChats/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "Sidebar.tsx"), "utf8"), /openCrew/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "Sidebar.tsx"), "utf8"), /workersOpen=\{Boolean\(openCrew/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "Sidebar.tsx"), "utf8"), /nested\.length > PROJECT_CHAT_LIMIT && hidden > 0/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /currentColor 70%/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "ChatRow.tsx"), "utf8"), /crew-twist/);

  const stateDir = path.join(ROOT, "dist-electron", ".orch-test");
  const previousState = process.env.WORKHORSE_STATE_PATH;
  const previousFrom = process.env.WORKHORSE_FROM_SESSION;
  try {
    mkdirSync(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, "workhorse-state.json");
    writeFileSync(
      stateFile,
      JSON.stringify({
        projects: [
          {
            id: "proj_ships",
            name: "Spaceship battles",
            folders: [{ id: "f", path: "D:\\Godot\\Projects\\spaceship-battle" }],
          },
        ],
        sessions: [
          { id: "sess_orch", title: "Main", provider: "custom", projectId: "proj_ships" },
          { id: "sess_worker", title: "src tree review", provider: "custom", parentId: "sess_orch", hidden: true, projectId: "proj_ships" },
          { id: "sess_helper", title: "nested check", provider: "custom", parentId: "sess_worker", hidden: true, projectId: "proj_ships" },
          { id: "sess_loose", title: "Loose", provider: "custom", projectId: null },
        ],
      }),
    );
    process.env.WORKHORSE_STATE_PATH = stateFile;

    const workerList = await handleWorkhorseRpc(
      { jsonrpc: "2.0", id: 21, method: "tools/list" },
      { fromSessionId: "sess_worker" },
    );
    const workerNames = ((workerList as { result?: { tools?: { name: string }[] } })?.result?.tools ?? []).map((tool) => tool.name);
    assert.ok(workerNames.includes("workhorse_spawn_agent"));
    assert.ok(workerNames.includes("workhorse_await_agents"));
    assert.ok(!workerNames.includes("workhorse_request_vendor"));
    assert.ok(!workerNames.includes("workhorse_list_bots"));

    const orchList = await handleWorkhorseRpc(
      { jsonrpc: "2.0", id: 22, method: "tools/list" },
      { fromSessionId: "sess_orch" },
    );
    const orchNames = ((orchList as { result?: { tools?: { name: string }[] } })?.result?.tools ?? []).map((tool) => tool.name);
    assert.ok(orchNames.includes("workhorse_spawn_agent"));

    const leaked = await handleWorkhorseRpc(
      {
        jsonrpc: "2.0",
        id: 23,
        method: "tools/call",
        params: { name: "workhorse_spawn_agent", arguments: { prompt: "Read project.godot and say what this game is." } },
      },
      { fromSessionId: "sess_worker" },
    );
    const leakedMessage = (leaked as { error?: { message?: string } })?.error?.message ?? "";
    assert.equal(leakedMessage, WORKER_SPAWN_ERROR);

    const only = await handleWorkhorseRpc(
      {
        jsonrpc: "2.0",
        id: 24,
        method: "tools/call",
        params: { name: "workhorse_spawn_agent", arguments: { prompt: "please spawn MiniMax" } },
      },
      { fromSessionId: "sess_orch" },
    );
    assert.equal((only as { error?: { message?: string } })?.error?.message, SPAWN_ONLY_PROMPT_ERROR);

    const loose = await handleWorkhorseRpc(
      {
        jsonrpc: "2.0",
        id: 25,
        method: "tools/call",
        params: { name: "workhorse_spawn_agent", arguments: { prompt: "Read project.godot and say what this game is." } },
      },
      { fromSessionId: "sess_loose" },
    );
    assert.equal((loose as { error?: { message?: string } })?.error?.message, UNBOUND_SPAWN_ERROR);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    if (previousState === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previousState;
    if (previousFrom === undefined) delete process.env.WORKHORSE_FROM_SESSION;
    else process.env.WORKHORSE_FROM_SESSION = previousFrom;
  }

  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /admitSpawn/);
  assert.match(store, /formatWorkerPrompt/);
  assert.match(store, /spawnWaitsForReply/);
  assert.match(store, /await-agents/);
  assert.match(store, /awaitAgentsWaits/);
  assert.match(store, /applyChildIdleSync/);
  assert.match(store, /stampLineupUserText/);
  assert.match(store, /formatAwaitAgentsSnapshot/);
  assert.doesNotMatch(store, /formatSubagentPrompt\(/);
  assert.match(readFileSync(path.join(ROOT, "electron", "custom-host.ts"), "utf8"), /withSpawnHint\([\s\S]*role/);
  assert.match(readFileSync(path.join(ROOT, "skills", "desk", "SKILL.md"), "utf8"), /one quick-route helper/);
  assert.match(WORKER_SESSION_RULES, /capacity-aware quick route.*5,000 tokens/);
  assert.doesNotMatch(WORKER_SESSION_RULES, /spawn every canCall/);
  assert.doesNotMatch(CUSTOM_HTTP_WORKER_RULES, /spawn every canCall/);
  assert.match(WORKHORSE_SESSION_RULES, /one bounded quick-route helper/);
});

test("desk builds one named join prompt and syncs idle children", () => {
  const userSentence = "Please do a deep scrape of this project with subagents";
  const folder = "D:\\Godot\\Projects\\spaceship-battle";
  let wave = emptyLineup(folder, Date.parse("2026-08-14T12:00:00.000Z"), userSentence);
  wave = { ...wave, id: "lineup_join_test" };
  const slices = [
    { childId: "sess_struct", title: "Structure", status: "completed" as const, report: "project.godot is a Godot 4 game." },
    { childId: "sess_scripts", title: "Scripts scrape", status: "failed" as const, report: "" },
    { childId: "sess_scenes", title: "Scenes scrape", status: "failed" as const, report: undefined },
    { childId: "sess_assets", title: "Assets", status: "completed" as const, report: "Ships live under crafts/." },
  ];
  for (const slice of slices) {
    wave = addLineupRow(wave, {
      childId: slice.childId,
      title: slice.title,
      slice: slice.title,
      folder,
      vendor: "MiniMax",
      status: slice.status,
      startedAt: 1,
      ...(slice.report ? { report: slice.report } : {}),
    });
  }
  const joined = lineupJoinPrompt(wave);
  assert.match(joined, /ORCHESTRATION CALL/);
  assert.match(joined, /Please do a deep scrape of this project with subagents/);
  assert.match(joined, /lineup_join_test/);
  assert.match(joined, /D:\\Godot\\Projects\\spaceship-battle/);
  assert.match(joined, /sess_struct/);
  assert.match(joined, /sess_scripts/);
  assert.match(joined, /sess_scenes/);
  assert.match(joined, /sess_assets/);
  assert.match(joined, /Structure/);
  assert.match(joined, /Scripts scrape/);
  assert.match(joined, /Scenes scrape/);
  assert.match(joined, /Assets/);
  assert.match(joined, /status=completed/);
  assert.match(joined, /status=failed/);
  assert.match(joined, /\(no report\)/);
  assert.match(joined, /project\.godot is a Godot 4 game/);
  assert.equal(lineupIsTerminal(wave), true);

  const persisted = stampLineupUserText(emptyLineup(folder, 1), userSentence);
  assert.equal(persisted.userText, userSentence);
  assert.equal(stampLineupUserText(persisted, "later paraphrase").userText, userSentence);

  const workerBrief = formatWorkerPrompt({
    fromTitle: "Orchestrator",
    text: "Read project.godot. Permission / Sandbox are already enforced.",
    folder,
    project: "Spaceship battles",
    slice: "Scenes scrape",
    vendor: "MiniMax",
  });
  assert.equal(looksLikeWorkerBrief(workerBrief), true);
  assert.equal(looksLikePermissionQuestion(workerBrief), false);
  assert.match(
    readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"),
    /formatWorkerPrompt\(\{[\s\S]*?folder: childCwd,/,
  );
  assert.equal(looksLikePermissionQuestion("what sandbox do you have?"), true);
  assert.equal(
    looksLikePermissionQuestion("Permission / Sandbox are workspace facts on this turn."),
    false,
  );

  assert.equal(awaitAgentsWaits({ wait: true, parentStatus: "running" }), false);
  assert.equal(awaitAgentsWaits({ wait: true, parentStatus: "idle" }), true);
  assert.equal(awaitAgentsWaits({ wait: false }), false);
  assert.equal(awaitAgentsWaits({}), false);
  const snap = formatAwaitAgentsSnapshot({ lineup: wave, wait: false });
  assert.match(snap, /"wait": false/);
  assert.doesNotMatch(snap, /sit on this tool/);

  const parent: Session = {
    id: "orch",
    projectId: "proj",
    provider: "custom",
    model: "MiniMax-M3",
    title: "Parent",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    contextUsed: 0,
    messages: [
      {
        id: "m1",
        role: "system",
        kind: "subagent",
        text: "Scripts scrape",
        subagentSessionId: "sess_idle",
        toolStatus: "running",
        createdAt: 1,
      },
    ],
    lineup: addLineupRow(emptyLineup(folder, 1, userSentence), {
      childId: "sess_idle",
      title: "Scripts scrape",
      slice: "Scripts scrape",
      folder,
      vendor: "MiniMax",
      status: "running",
      startedAt: 1,
    }),
  };
  const idleChild: Session = {
    ...parent,
    id: "sess_idle",
    parentId: "orch",
    hidden: true,
    title: "Scripts scrape",
    status: "idle",
    lineup: undefined,
    messages: [{ id: "a", role: "assistant", text: "Stopped mid-scrape at scripts/.", createdAt: 2 }],
    agentRun: { status: "running", startedAt: 1, isolation: "shared" },
  };
  const synced = applyChildIdleSync([parent, idleChild], "sess_idle", "completed", {
    report: "Stopped mid-scrape at scripts/.",
    now: 9,
  });
  const syncedChild = synced.find((item) => item.id === "sess_idle");
  const syncedParent = synced.find((item) => item.id === "orch");
  assert.equal(syncedChild?.status, "idle");
  assert.notEqual(syncedChild?.agentRun?.status, "running");
  assert.equal(syncedChild?.agentRun?.status, "completed");
  assert.equal(syncedParent?.messages.find((message) => message.subagentSessionId === "sess_idle")?.toolStatus, "completed");
  assert.equal(syncedParent?.lineup?.rows[0]?.status, "completed");

  const stuckParent: Session = {
    ...parent,
    lineup: addLineupRow(
      addLineupRow(
        addLineupRow(
          addLineupRow(emptyLineup(folder, 1, userSentence), {
            childId: "c1",
            title: "One",
            slice: "One",
            folder,
            vendor: "MiniMax",
            status: "completed",
            startedAt: 1,
            report: "ok",
          }),
          {
            childId: "c2",
            title: "Two",
            slice: "Two",
            folder,
            vendor: "MiniMax",
            status: "running",
            startedAt: 1,
          },
        ),
        {
          childId: "c3",
          title: "Three",
          slice: "Three",
          folder,
          vendor: "MiniMax",
          status: "running",
          startedAt: 1,
        },
      ),
      {
        childId: "c4",
        title: "Four",
        slice: "Four",
        folder,
        vendor: "MiniMax",
        status: "completed",
        startedAt: 1,
        report: "ok",
      },
    ),
  };
  const stuckKids: Session[] = [
    {
      ...idleChild,
      id: "c1",
      title: "One",
      status: "idle",
      agentRun: { status: "completed", startedAt: 1, isolation: "shared", finishedAt: 2 },
      messages: [{ id: "a", role: "assistant", text: "ok", createdAt: 2 }],
    },
    {
      ...idleChild,
      id: "c2",
      title: "Two",
      status: "idle",
      agentRun: { status: "running", startedAt: 1, isolation: "shared" },
      messages: [{ id: "a", role: "assistant", text: "", createdAt: 2 }],
    },
    {
      ...idleChild,
      id: "c3",
      title: "Three",
      status: "idle",
      agentRun: { status: "running", startedAt: 1, isolation: "shared" },
      messages: [{ id: "a", role: "assistant", text: "Permission / Sandbox lecture", createdAt: 2 }],
    },
    {
      ...idleChild,
      id: "c4",
      title: "Four",
      status: "idle",
      agentRun: { status: "completed", startedAt: 1, isolation: "shared", finishedAt: 2 },
      messages: [{ id: "a", role: "assistant", text: "ok", createdAt: 2 }],
    },
  ];
  const reconciled = reconcileIdleChildren([stuckParent, ...stuckKids], "orch", 11);
  const reconParent = reconciled.find((item) => item.id === "orch");
  assert.equal(lineupIsTerminal(reconParent?.lineup), true);
  assert.ok(reconciled.every((item) => item.id === "orch" || item.agentRun?.status !== "running"));
  const mixed = reconParent?.lineup;
  assert.ok(mixed);
  const joinedAfter = maybeEnqueueLineupJoin(reconciled, "orch", 12);
  const afterParent = joinedAfter.find((item) => item.id === "orch");
  assert.ok(afterParent?.messages.some((message) => message.text === LINEUP_FINISHED_NOTICE));
  const joinItem = afterParent?.queue?.find((item) => item.hideUser && item.text.includes("ORCHESTRATION CALL"));
  assert.ok(joinItem);
  assert.match(joinItem?.text ?? "", /own words/);
  assert.match(joinItem?.text ?? "", /Do not paste/);
  assert.ok((joinItem?.notBefore ?? 0) > 12);
  assert.ok(joinDelayMs(afterParent?.lineup) >= 8_000);
  assert.ok(afterParent?.lineup?.notifiedAt);
  const again = maybeEnqueueLineupJoin(joinedAfter, "orch", 13);
  assert.equal(again.find((item) => item.id === "orch")?.queue?.length, afterParent?.queue?.length);
  const nextWave = addLineupRow(
    { ...afterParent!.lineup!, notifiedAt: 12 },
    {
      childId: "c5",
      title: "Five",
      slice: "Five",
      folder,
      vendor: "Claude",
      status: "running",
      startedAt: 20,
    },
  );
  assert.equal(nextWave.notifiedAt, undefined);
  assert.deepEqual(nextWave.rows.map((row) => row.childId), ["c5"]);
  const planJoin = lineupJoinPrompt(nextWave, { continuePlan: true });
  assert.match(planJoin, /Reconcile this wave against the running executable plan/);
  assert.match(planJoin, /Continue until the plan completes or is truthfully blocked/);
  assert.doesNotMatch(planJoin, /Write one combined review/);

  const persistedLineup = normalizeLineup({
    id: "persisted-wave",
    folder,
    startedAt: 1,
    notifiedAt: 2,
    rows: [{
      childId: "persisted-child",
      title: "Interrupted worker",
      slice: "Interrupted worker",
      folder,
      vendor: "Claude",
      status: "running",
      startedAt: 3,
    }],
  });
  assert.equal(persistedLineup?.notifiedAt, undefined);
  const persistedParent: Session = { ...parent, lineup: persistedLineup };
  const persistedChild: Session = {
    ...idleChild,
    id: "persisted-child",
    parentId: "orch",
    status: "running",
    agentRun: {
      status: "failed",
      startedAt: 3,
      finishedAt: 4,
      isolation: "worktree",
      error: "Subagent was interrupted when Workhorse exited.",
    },
    messages: [{ id: "failed", role: "assistant", text: "", createdAt: 4 }],
  };
  const repairedPersisted = reconcilePersistedLineups([persistedParent, persistedChild], 30);
  const repairedParent = repairedPersisted.find((item) => item.id === "orch");
  const repairedChild = repairedPersisted.find((item) => item.id === "persisted-child");
  assert.equal(repairedChild?.status, "idle");
  assert.equal(repairedParent?.lineup?.rows[0]?.status, "failed");
  assert.ok(repairedParent?.queue?.some((item) => item.hideUser && item.text.includes("ORCHESTRATION CALL")));
  const withFollowUp = enqueuePrompt(joinedAfter, "orch", { text: "also check the HUD scripts" });
  const followParent = withFollowUp?.find((item) => item.id === "orch");
  assert.ok(followParent?.messages.some((message) => message.role === "user" && message.text === "also check the HUD scripts"));
  assert.ok(!followParent?.messages.some((message) => message.role === "user" && message.text.includes("ORCHESTRATION CALL")));
  const followBlocks = groupTranscript(followParent?.messages ?? []);
  assert.ok(followBlocks.some((block) => block.type === "user" && block.message.text === "also check the HUD scripts"));
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "Composer.tsx"), "utf8"), /hideUser !== true/);

  const rateJson =
    'Custom model HTTP 429: {"type":"error","error":{"type":"rate_limit_error","message":"Token Plan rate limit reached"}}';
  assert.equal(isVendorRateLimitError(rateJson), true);
  assert.equal(vendorFailedMessage("custom", rateJson), "Custom hit a request rate limit — too many calls at once, not the weekly leftover.");
  assert.doesNotMatch(vendorFailedMessage("custom", rateJson), /request_id|06cf11/);
  const limitedLineup = {
    ...wave,
    rows: wave.rows.map((row, index) =>
      index === 0
        ? row
        : { ...row, status: "failed" as const, report: rateJson },
    ),
  };
  assert.ok(joinDelayMs(limitedLineup) >= 8_000);
  const fallback = lineupJoinFallback(limitedLineup);
  assert.match(fallback, /Combined scrape for/);
  assert.match(fallback, /Please do a deep scrape of this project with subagents/);
  assert.match(fallback, /rate-limited/);
  assert.doesNotMatch(fallback, /request_id/);
  const joinPrompt = lineupJoinPrompt(limitedLineup);
  assert.match(joinPrompt, /own words/);
  assert.match(joinPrompt, /Do not paste/);
  const retried = applyJoinRateLimitRetry(
    [
      {
        ...parent,
        messages: [
          { id: "note", role: "system", text: LINEUP_FINISHED_NOTICE, createdAt: 1 },
          { id: "join-asst", role: "assistant", text: "", createdAt: 2 },
        ],
      },
    ],
    "orch",
    { prompt: joinPrompt, attempt: 1, assistantId: "join-asst", now: 100 },
  );
  const retryRow = retried.find((item) => item.id === "orch");
  assert.ok(retryRow?.queue?.some((item) => item.joinAttempt === 2 && (item.notBefore ?? 0) > 100));
  assert.ok(!retryRow?.messages.some((message) => message.id === "join-asst"));
  const lastTry = applyJoinRateLimitRetry(retried, "orch", {
    prompt: joinPrompt,
    attempt: JOIN_MAX_ATTEMPTS,
    now: 200,
  });
  assert.equal(lastTry.find((item) => item.id === "orch")?.queue?.length, retryRow?.queue?.length);

  const two = groupTranscript([
    { id: "u", role: "user", text: userSentence, createdAt: 1 },
    { id: "a1", role: "assistant", text: "Four workers are out.", createdAt: 2 },
    { id: "note", role: "system", text: LINEUP_FINISHED_NOTICE, createdAt: 3 },
    { id: "a2", role: "assistant", text: "Combined scrape from the four slices.", createdAt: 4 },
  ]);
  assert.equal(two.filter((block) => block.type === "reply").length, 2);

  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /maybeEnqueueLineupJoin/);
  assert.match(store, /applyJoinRateLimitRetry/);
  assert.match(store, /reconcileIdleChildren/);
  assert.match(store, /hideUser\s*\n\s*\? item\.title/);
  assert.match(store, /userMessageId/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "lineup.ts"), "utf8"), /ORCHESTRATION CALL/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "lineup.ts"), "utf8"), /userText/);
  assert.equal(
    shouldEndDispatchTurn([
      {
        name: "workhorse_spawn_agent",
        content: JSON.stringify({ started: true, childSessionId: "sess_a" }),
      },
    ]),
    true,
  );
  assert.equal(looksLikeDispatchCheckBack("I'll check back. Status snapshot in a moment."), true);
  assert.equal(looksLikeUnfinishedCustomTurn("I'll check back. Status snapshot in a moment."), false);
  assert.match(readFileSync(path.join(ROOT, "electron", "custom-host.ts"), "utf8"), /shouldEndDispatchTurn\(results\)/);
});

test("composer edit menu matches Codex cut copy paste select all", () => {
  assert.deepEqual(
    EDIT_MENU_ITEMS.map((item) => item.label),
    ["Copy", "Cut", "Paste", "Select All"],
  );
  const empty = { value: "", selectionStart: 0, selectionEnd: 0 };
  assert.equal(canCut(empty), false);
  assert.equal(canCopy(empty), false);
  assert.equal(canPaste(empty), true);
  assert.equal(canSelectAll(empty), false);

  const selected = { value: "hello world", selectionStart: 0, selectionEnd: 5 };
  assert.equal(selectedText(selected), "hello");
  assert.equal(canCut(selected), true);
  assert.equal(canCopy(selected), true);
  assert.equal(canSelectAll(selected), true);
  assert.deepEqual(applyCut(selected), { value: " world", caret: 0, cut: "hello" });
  assert.deepEqual(applyPaste(selected, "hey"), { value: "hey world", caret: 3 });
  assert.deepEqual(applySelectAll(selected), { start: 0, end: 11 });
  assert.equal(canCut({ ...selected, readOnly: true }), false);
  assert.equal(canPaste({ ...selected, disabled: true }), false);

  const pinned = clampMenuPosition(2000, 2000, 188, 136, 1280, 840);
  assert.ok(pinned.x < 1280);
  assert.ok(pinned.y < 840);
  assert.deepEqual(clampMenuPosition(12, 20, 188, 136, 1280, 840), { x: 12, y: 20 });
});

test("side panes clamp and persist so you can drag them to size", () => {
  assert.equal(clampPaneWidth(undefined, SIDEBAR_PANE), SIDEBAR_PANE.fallback);
  assert.equal(clampPaneWidth("wide", SIDEBAR_PANE), SIDEBAR_PANE.fallback);
  assert.equal(clampPaneWidth(Number.NaN, SIDEBAR_PANE), SIDEBAR_PANE.fallback);
  assert.ok(SIDEBAR_PANE.min >= 240);
  assert.equal(clampPaneWidth(176, SIDEBAR_PANE), SIDEBAR_PANE.min);
  assert.equal(clampPaneWidth(80, SIDEBAR_PANE), SIDEBAR_PANE.min);
  assert.equal(clampPaneWidth(900, SIDEBAR_PANE), SIDEBAR_PANE.max);
  assert.equal(clampPaneWidth(300.6, SIDEBAR_PANE), 301);
  assert.equal(clampPaneWidth(400, THREAD_PANE), 400);
  assert.equal(clampPaneWidth(100, THREAD_PANE), THREAD_PANE.min);
  assert.equal(clampPaneWidth(800, THREAD_PANE), THREAD_PANE.max);

  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /sidebarWidth: clampPaneWidth/);
  assert.match(store, /threadWidth: clampPaneWidth/);
  assert.match(store, /setSidebarWidth/);
  assert.match(store, /setThreadWidth/);

  const app = readFileSync(path.join(ROOT, "src", "App.tsx"), "utf8");
  assert.match(app, /--sidebar/);
  assert.match(app, /store\.sidebarWidth/);

  const sidebar = readFileSync(path.join(ROOT, "src", "ui", "Sidebar.tsx"), "utf8");
  assert.match(sidebar, /Resize sidebar/);
  assert.match(sidebar, /setSidebarWidth/);

  const thread = readFileSync(path.join(ROOT, "src", "ui", "AgentThreadPane.tsx"), "utf8");
  assert.match(thread, /compact-thread overlay/);
  assert.doesNotMatch(thread, /Resize conversation pane/);
  assert.doesNotMatch(thread, /setThreadWidth/);

  assert.doesNotMatch(store, /sessionSetupHeight/);
  assert.doesNotMatch(store, /setSessionSetupWidth/);
  const setupPane = readFileSync(path.join(ROOT, "src", "ui", "SessionSetup.tsx"), "utf8");
  assert.doesNotMatch(setupPane, /setup-resize/);

  const handle = readFileSync(path.join(ROOT, "src", "ui", "SplitHandle.tsx"), "utf8");
  assert.match(handle, /pane-dragging/);
  assert.match(handle, /onDoubleClick/);

  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  assert.match(css, /\.split-handle/);
  assert.match(css, /cursor: col-resize/);
  assert.match(css, /html\.pane-dragging/);
});

test("normalizeSettings keeps the needs-auth flag on a vendor link", () => {
  // The flag is set by detection after load. Dropping it here is why the
  // Claude card kept reading "Not found" with the copy fix already shipped.
  const settings = normalizeSettings({
    llms: {
      claude: { connected: true, available: false, needsAuth: true },
      grok: { connected: true, available: true },
    },
  });
  assert.equal(settings.llms.claude.needsAuth, true);
  assert.equal(settings.llms.claude.available, false);
  assert.equal(settings.llms.grok.needsAuth, undefined);
});

test("packages use platform Electron and mac builds receive an ad-hoc signature", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    build?: { afterPack?: string; electronDist?: string; mac?: { extendInfo?: Record<string, string> } };
  };
  assert.equal(pkg.build?.electronDist, undefined);
  assert.equal(pkg.build?.afterPack, "scripts/after-pack.cjs");
  const hook = readFileSync(path.join(ROOT, "scripts", "after-pack.cjs"), "utf8");
  assert.match(hook, /electronPlatformName !== "darwin"/);
  assert.match(hook, /codesign/);
  assert.match(hook, /shouldAdHocSign/);
  assert.match(hook, /"--deep", "--sign", "-"/);
  assert.match(pkg.build?.mac?.extendInfo?.NSDocumentsFolderUsageDescription ?? "", /project folders you link/);
});

test("custom bot setup imports a detected MiniMax configuration without overwriting a draft", () => {
  const addBot = readFileSync(path.join(ROOT, "src", "ui", "AddBot.tsx"), "utf8");
  assert.match(addBot, /!draft\.apiKey\.trim\(\) && !draft\.baseUrl\.trim\(\)/);
  assert.match(addBot, /store\.refreshCustomLogin\(\)/);
  assert.match(addBot, /Imported MiniMax from OpenClaw/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "BotForm.tsx"), "utf8"), /Stored only on this computer/);
});

test("the repo tracks no symlinks and states its working rules", () => {
  // A build worktree with node_modules symlinked into the main checkout got
  // the link itself committed: .gitignore said "node_modules/", which matches
  // a directory, not a link of that name. Anyone cloning then had a link
  // pointing at one machine's disk where their dependencies belong.
  const tracked = execFileSync("git", ["ls-files", "-s"], { cwd: ROOT, encoding: "utf8" });
  const links = tracked
    .split("\n")
    .filter((line) => line.startsWith("120000"))
    .map((line) => line.split("\t")[1] ?? line);
  assert.deepEqual(links, [], `tracked symlinks: ${links.join(", ")}`);

  // Both spellings, so a link named node_modules is ignored as well as a folder.
  const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /^node_modules$/m);

  // The rules that keep parallel agents out of each other's way.
  const agents = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  assert.match(agents, /Never leave work uncommitted/);
  assert.match(agents, /One tree per agent/);
  assert.match(agents, /Tests must not read the machine they run on/);
});

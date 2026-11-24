import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { macDictationCommand, pauseMacDictation, startMacDictation, stopMacDictation, windowsDictationCommand } from "../electron/mac-dictation";
import type { LocalArtifact, LocalJob } from "../src/lib/local-capability-contract";
import type { LocalComputeHostSettings } from "../src/lib/types";
import {
  allowDeskClipboardPermission,
  allowDeskMediaPermission,
  composerEscapeAction,
  composerFieldPlaceholder,
  getMicrophoneAccessStatus,
  installDeskMediaPermissions,
  beginVoiceDraft,
  DICTATION_OPENED_WITHOUT_SPEECH,
  dictationHelperExit,
  dictationStartLine,
  joinVoiceDraft,
  LISTENING_PLACEHOLDER,
  listeningDeviceLabel,
  mergeVoiceHypothesis,
  listenBarScales,
  LOCAL_SPEECH_CAPABILITY,
  macDictationLaunch,
  MAC_SPEECH_PRIVACY_URL,
  MAC_MICROPHONE_PRIVACY_URL,
  MAC_SYSTEM_PREFERENCES_APP,
  MAC_SYSTEM_SETTINGS_APP,
  microphonePrivacyUrl,
  osSpeechGaveUp,
  parseDictationLine,
  pickLocalSpeechHost,
  pickSpeechEngine,
  requestMicrophoneAccess,
  speechEngineAfterOsStartFailure,
  transcribeLocalSpeech,
  WINDOWS_MICROPHONE_PRIVACY_URL,
  WINDOWS_SPEECH_PRIVACY_URL,
  WINDOWS_SPEECH_SETTINGS_URL,
  windowsDictationLaunch,
  type MediaPermissionSession,
  type MicTranscribeClient,
} from "../electron/mic-host";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function host(over: Partial<LocalComputeHostSettings> = {}): LocalComputeHostSettings {
  return {
    id: "spark",
    label: "Spark",
    baseUrl: "http://127.0.0.1:8788",
    tokenFile: "/tmp/workhorse-token",
    enabled: true,
    allowedCallerRoles: ["desk"],
    allowedCapabilities: [LOCAL_SPEECH_CAPABILITY],
    allowedContinuations: [],
    ...over,
  };
}

function probe(
  over: { hostId?: string; status?: "healthy" | "disabled" | "unavailable" | "misconfigured"; ids?: string[] } = {},
) {
  return {
    hostId: over.hostId ?? "spark",
    status: over.status ?? "healthy",
    capabilities: (over.ids ?? [LOCAL_SPEECH_CAPABILITY]).map((id) => ({
      id,
      profileId: "p",
      description: "speech",
      inputKinds: ["audio"],
      outputRoles: ["transcript"],
      estimatedMemoryGb: 1,
      asynchronous: true as const,
    })),
  };
}

function artifact(): LocalArtifact {
  return {
    id: "art_" + "a".repeat(32),
    jobId: null,
    kind: "audio",
    role: "recording",
    mediaType: "audio/webm",
    sha256: "b".repeat(64),
    sizeBytes: 12,
    metadata: {},
    validation: {},
    createdAt: "2026-08-23T12:00:00Z",
  };
}

function job(over: Partial<LocalJob> = {}): LocalJob {
  return {
    protocolVersion: "1.0",
    id: "job_1",
    requestId: "req_1",
    traceId: "trace_1",
    origin: "workhorse",
    idempotencyKey: "idem_1",
    capability: LOCAL_SPEECH_CAPABILITY,
    priority: 50,
    status: "completed",
    profileId: "p",
    cancelRequested: false,
    attempt: 1,
    createdAt: "2026-08-23T12:00:00Z",
    updatedAt: "2026-08-23T12:00:01Z",
    startedAt: "2026-08-23T12:00:00Z",
    finishedAt: "2026-08-23T12:00:01Z",
    result: {
      protocolVersion: "1.0",
      jobId: "job_1",
      traceId: "trace_1",
      route: { visitedSystems: ["workhorse"], hopCount: 1 },
      artifacts: [],
      continuations: [],
      data: { transcript: "hello desk" },
    },
    ...over,
  };
}

test("mac granted status does not open settings and does not read the real disk", async () => {
  const seen: string[] = [];
  const result = await requestMicrophoneAccess({
    platform: "darwin",
    existsSync: (file) => {
      seen.push(file);
      return false;
    },
    getMediaAccessStatus: () => "granted",
    askForMediaAccess: async () => {
      throw new Error("must not prompt when already granted");
    },
    openExternal: () => {
      throw new Error("must not open settings when granted");
    },
  });
  assert.deepEqual(result, { status: "granted", granted: true });
  assert.deepEqual(seen, []);
});

test("a grant already given in this app run does not ask again", async () => {
  const result = await requestMicrophoneAccess({
    platform: "darwin",
    existsSync: () => false,
    getMediaAccessStatus: () => "not-determined",
    askForMediaAccess: async () => {
      throw new Error("must not prompt after this run was already allowed");
    },
    openExternal: () => {
      throw new Error("must not open settings after this run was already allowed");
    },
    sessionGranted: true,
  });
  assert.deepEqual(result, { status: "granted", granted: true });
});

test("mac denied opens System Settings only when the injected existsSync says the app is there", async () => {
  const opened: string[] = [];
  const denied = await requestMicrophoneAccess({
    platform: "darwin",
    existsSync: (file) => file === MAC_SYSTEM_SETTINGS_APP,
    getMediaAccessStatus: () => "denied",
    askForMediaAccess: async () => {
      throw new Error("must not re-prompt a denied mic");
    },
    openExternal: async (url) => {
      opened.push(url);
    },
  });
  assert.equal(denied.granted, false);
  assert.equal(denied.status, "denied");
  assert.equal(denied.openedSettings, true);
  assert.deepEqual(opened, [MAC_MICROPHONE_PRIVACY_URL]);

  const missing = await requestMicrophoneAccess({
    platform: "darwin",
    existsSync: () => false,
    getMediaAccessStatus: () => "denied",
    askForMediaAccess: async () => false,
    openExternal: () => {
      throw new Error("no deep link when System Settings is absent");
    },
  });
  assert.equal(missing.granted, false);
  assert.equal(missing.openedSettings, false);
});

test("mac not-determined asks then opens privacy settings if the person denies", async () => {
  let status = "not-determined";
  const opened: string[] = [];
  const result = await requestMicrophoneAccess({
    platform: "darwin",
    existsSync: (file) => file === MAC_SYSTEM_PREFERENCES_APP,
    getMediaAccessStatus: () => status,
    askForMediaAccess: async () => {
      status = "denied";
      return false;
    },
    openExternal: async (url) => {
      opened.push(url);
    },
  });
  assert.equal(result.granted, false);
  assert.equal(result.status, "denied");
  assert.equal(result.openedSettings, true);
  assert.deepEqual(opened, [MAC_MICROPHONE_PRIVACY_URL]);
});

test("windows grants session media and never reads mac System Settings paths", async () => {
  const result = await requestMicrophoneAccess({
    platform: "win32",
    existsSync: () => {
      throw new Error("windows grant must not read the disk");
    },
    getMediaAccessStatus: () => "granted",
    askForMediaAccess: async () => {
      throw new Error("windows has no askForMediaAccess");
    },
    openExternal: () => {
      throw new Error("windows grant must not open privacy settings");
    },
  });
  assert.deepEqual(result, { status: "granted", granted: true });
  assert.equal(getMicrophoneAccessStatus({ platform: "win32", getMediaAccessStatus: () => "granted" }), "granted");
  assert.equal(
    microphonePrivacyUrl("win32", () => {
      throw new Error("windows privacy link must not read the disk");
    }),
    WINDOWS_MICROPHONE_PRIVACY_URL,
  );
});

test("windows denial opens microphone privacy settings through the injected opener", async () => {
  const opened: string[] = [];
  const denied = await requestMicrophoneAccess({
    platform: "win32",
    existsSync: () => {
      throw new Error("windows denial must not read the disk");
    },
    getMediaAccessStatus: () => "denied",
    askForMediaAccess: async () => {
      throw new Error("windows has no askForMediaAccess");
    },
    openExternal: async (url) => {
      opened.push(url);
    },
  });
  assert.equal(denied.granted, false);
  assert.equal(denied.status, "denied");
  assert.equal(denied.openedSettings, true);
  assert.deepEqual(opened, [WINDOWS_MICROPHONE_PRIVACY_URL]);
  assert.equal(getMicrophoneAccessStatus({ platform: "win32", getMediaAccessStatus: () => "denied" }), "denied");
  assert.equal(opened.some((url) => url.startsWith("x-apple.systempreferences:")), false);

  const restricted = await requestMicrophoneAccess({
    platform: "win32",
    existsSync: () => {
      throw new Error("windows restriction must not read the disk");
    },
    getMediaAccessStatus: () => "restricted",
    askForMediaAccess: async () => {
      throw new Error("windows has no askForMediaAccess");
    },
    openExternal: async (url) => {
      opened.push(url);
    },
  });
  assert.equal(restricted.granted, false);
  assert.equal(restricted.openedSettings, true);
  assert.deepEqual(opened, [WINDOWS_MICROPHONE_PRIVACY_URL, WINDOWS_MICROPHONE_PRIVACY_URL]);
});

test("desk media permission allows microphone and refuses camera or a foreign page", () => {
  assert.equal(allowDeskMediaPermission("media", { mediaTypes: ["audio"] }, true), true);
  assert.equal(allowDeskMediaPermission("media", { mediaType: "audio" }, true), true);
  assert.equal(allowDeskMediaPermission("media", { mediaTypes: ["audio", "video"] }, true), false);
  assert.equal(allowDeskMediaPermission("media", { mediaType: "video" }, true), false);
  assert.equal(allowDeskMediaPermission("display-capture", { mediaTypes: ["audio"] }, true), false);
  assert.equal(allowDeskMediaPermission("media", { mediaTypes: ["audio"] }, false), false);
  assert.equal(allowDeskClipboardPermission("clipboard-read", true), true);
  assert.equal(allowDeskClipboardPermission("clipboard-sanitized-write", true), true);
  assert.equal(allowDeskClipboardPermission("clipboard-read", false), false);
  assert.equal(allowDeskClipboardPermission("media", true), false);
});

test("the session handler answers from the injected isDesk check", () => {
  let requestAllow: boolean | undefined;
  let checkAllow: boolean | undefined;
  const ses: MediaPermissionSession = {
    setPermissionRequestHandler(handler) {
      handler(
        { getURL: () => "https://evil.example/" },
        "media",
        (allow) => {
          requestAllow = allow;
        },
        { mediaTypes: ["audio"], requestingUrl: "file:///app/dist/index.html" },
      );
    },
    setPermissionCheckHandler(handler) {
      checkAllow = handler({ getURL: () => "file:///app/dist/index.html" }, "media", "file://", { mediaType: "audio" });
    },
  };
  installDeskMediaPermissions(ses, (url) => url.startsWith("file:///app/dist/index.html"));
  assert.equal(requestAllow, true);
  assert.equal(checkAllow, true);
});

test("the session handler allows clipboard read on the desk page and nowhere else", () => {
  const requests: { permission: string; allow: boolean }[] = [];
  const checks: { permission: string; allow: boolean }[] = [];
  let onRequest: Parameters<MediaPermissionSession["setPermissionRequestHandler"]>[0] = () => undefined;
  let onCheck: Parameters<MediaPermissionSession["setPermissionCheckHandler"]>[0] = () => false;
  const ses: MediaPermissionSession = {
    setPermissionRequestHandler(handler) {
      onRequest = handler;
    },
    setPermissionCheckHandler(handler) {
      onCheck = handler;
    },
  };
  installDeskMediaPermissions(ses, (url) => url.startsWith("file:///app/dist/index.html"));
  for (const permission of ["clipboard-read", "clipboard-sanitized-write", "display-capture"]) {
    onRequest({ getURL: () => "file:///app/dist/index.html" }, permission, (allow) => requests.push({ permission, allow }), {
      requestingUrl: "file:///app/dist/index.html",
    });
    checks.push({
      permission,
      allow: onCheck({ getURL: () => "file:///app/dist/index.html" }, permission, "file://", {}),
    });
  }
  onRequest({ getURL: () => "https://evil.example/" }, "clipboard-read", (allow) => requests.push({ permission: "foreign", allow }), {
    requestingUrl: "https://evil.example/",
  });
  assert.deepEqual(requests, [
    { permission: "clipboard-read", allow: true },
    { permission: "clipboard-sanitized-write", allow: true },
    { permission: "display-capture", allow: false },
    { permission: "foreign", allow: false },
  ]);
  assert.deepEqual(checks, [
    { permission: "clipboard-read", allow: true },
    { permission: "clipboard-sanitized-write", allow: true },
    { permission: "display-capture", allow: false },
  ]);
});

test("a thrown OS speech start falls back to a granted advertised local host", async () => {
  let probes = 0;
  const started = await speechEngineAfterOsStartFailure(
    () => {
      throw new Error("SpeechRecognition.start failed");
    },
    async () => {
      probes += 1;
      return pickLocalSpeechHost([host()], [probe()]);
    },
  );
  assert.equal(started, "local-compute");
  assert.equal(probes, 1);

  const blocked = await speechEngineAfterOsStartFailure(
    () => {
      throw new Error("SpeechRecognition.start failed");
    },
    async () => pickLocalSpeechHost([host({ allowedCapabilities: [] })], [probe()]),
  );
  assert.equal(blocked, "none");

  const os = await speechEngineAfterOsStartFailure(
    () => undefined,
    async () => {
      throw new Error("must not probe after OS speech starts");
    },
  );
  assert.equal(os, "os");

  const composer = read("src/ui/Composer.tsx");
  const start = composer.slice(composer.indexOf("const startMic"));
  assert.match(start, /speechEngineAfterOsStartFailure\(\s*\(\) => rec\.start\(\)/);
  assert.match(start, /engine !== "local-compute"[\s\S]*releaseMic\(\);[\s\S]*return;[\s\S]*\}[\s\S]*new MediaRecorder\(stream/);
});

test("local speech needs a granted host that already advertises the capability", () => {
  const granted = host();
  const advertised = probe();
  assert.equal(pickLocalSpeechHost([granted], [advertised]), "spark");
  assert.equal(pickLocalSpeechHost([host({ allowedCapabilities: [] })], [advertised]), null);
  assert.equal(pickLocalSpeechHost([granted], [probe({ ids: ["text.chat.generate"] })]), null);
  assert.equal(pickLocalSpeechHost([granted], [probe({ status: "unavailable" })]), null);
  assert.equal(pickSpeechEngine(true, "spark"), "os");
  assert.equal(pickSpeechEngine(false, "spark"), "local-compute");
  assert.equal(pickSpeechEngine(false, null), "none");
});

test("transcribe refuses without a granted advertised host and does not call the client", async () => {
  let called = 0;
  const client: MicTranscribeClient = {
    async uploadBase64() {
      called += 1;
      return artifact();
    },
    async submit() {
      called += 1;
      return job();
    },
    async status() {
      called += 1;
      return job();
    },
  };
  const refused = await transcribeLocalSpeech({
    hosts: [host({ allowedCapabilities: [] })],
    probes: [probe()],
    audioBase64: Buffer.from("wav").toString("base64"),
    mimeType: "audio/webm",
    client,
    sleep: async () => undefined,
  });
  assert.deepEqual(refused, { ok: false, reason: "No granted local speech host." });
  assert.equal(called, 0);
});

test("transcribe reads transcript text from a completed local job", async () => {
  const client: MicTranscribeClient = {
    async uploadBase64() {
      return artifact();
    },
    async submit() {
      return job();
    },
    async status() {
      throw new Error("completed submit must not poll");
    },
  };
  const result = await transcribeLocalSpeech({
    hosts: [host()],
    probes: [probe()],
    audioBase64: Buffer.from("wav").toString("base64"),
    mimeType: "audio/webm",
    client,
    newId: () => "fixed",
    sleep: async () => {
      throw new Error("must not sleep when the job is already done");
    },
  });
  assert.deepEqual(result, { ok: true, text: "hello desk", hostId: "spark" });
});

test("voice draft join and Escape keep a just-recorded draft", () => {
  assert.equal(joinVoiceDraft("", "hello"), "hello");
  assert.equal(joinVoiceDraft("Hi", "there"), "Hi there");
  assert.equal(joinVoiceDraft("Hi ", "there"), "Hi there");
  assert.equal(joinVoiceDraft("Hi\n", "there"), "Hi\nthere");
  assert.equal(composerEscapeAction({ recording: true, plusOpen: false, preserveVoiceDraft: false }), "stop-recording");
  assert.equal(
    composerEscapeAction({ recording: true, plusOpen: false, micMenuOpen: true, preserveVoiceDraft: false }),
    "close-menu",
  );
  assert.equal(composerEscapeAction({ recording: false, plusOpen: true, preserveVoiceDraft: true }), "close-menu");
  assert.equal(composerEscapeAction({ recording: false, plusOpen: false, preserveVoiceDraft: true }), "keep-draft");
  assert.equal(composerEscapeAction({ recording: false, plusOpen: false, preserveVoiceDraft: false }), "clear");
});

test("an untouched draft replaces the dictated span and stays editable in the composer", () => {
  let lock = beginVoiceDraft("Hi");
  let draft = "Hi";
  let caret = draft.length;
  const speak = (hypothesis: string) => {
    const merged = mergeVoiceHypothesis(lock, { draft, caret, caretMoved: false, hypothesis });
    lock = merged.lock;
    draft = merged.draft;
    caret = merged.caret;
    return merged;
  };
  assert.equal(speak("hello").draft, "Hi hello");
  assert.equal(speak("hello world").draft, "Hi hello world");
  assert.equal(speak("hello word").draft, "Hi hello word");
  assert.equal(lock.owned, false);
  assert.equal(speak("hello word today").draft, "Hi hello word today");
  const noted = mergeVoiceHypothesis(beginVoiceDraft("Hi\n"), {
    draft: "Hi\n",
    caret: 3,
    caretMoved: false,
    hypothesis: "there",
  });
  assert.equal(noted.draft, "Hi\nthere");
  const composer = read("src/ui/Composer.tsx");
  assert.match(composer, /mergeVoiceHypothesis/);
  assert.doesNotMatch(composer, /readOnly=\{recording\}/);
  assert.doesNotMatch(composer, /baseDraftRef/);
  assert.match(read("docs/FEATURES.md"), /The draft stays editable while listening/);
});

test("a user edit wins and later speech appends without restoring deleted words", () => {
  let lock = beginVoiceDraft("Hi");
  const first = mergeVoiceHypothesis(lock, {
    draft: "Hi",
    caret: 2,
    caretMoved: false,
    hypothesis: "hello world",
  });
  assert.equal(first.draft, "Hi hello world");
  const deleted = mergeVoiceHypothesis(first.lock, {
    draft: "Hi hello",
    caret: "Hi hello".length,
    caretMoved: false,
    hypothesis: "hello world there",
  });
  assert.equal(deleted.draft, "Hi hello there");
  assert.equal(deleted.lock.owned, true);
  const again = mergeVoiceHypothesis(deleted.lock, {
    draft: deleted.draft,
    caret: deleted.caret,
    caretMoved: true,
    hypothesis: "hello world there",
  });
  assert.equal(again.draft, "Hi hello there");
  assert.equal(again.moveCaret, false);
  const rewritten = mergeVoiceHypothesis(again.lock, {
    draft: again.draft,
    caret: again.draft.length,
    caretMoved: true,
    hypothesis: "hello word",
  });
  assert.equal(rewritten.draft, "Hi hello there");
  const cleared = mergeVoiceHypothesis(first.lock, {
    draft: "",
    caret: 0,
    caretMoved: false,
    hypothesis: "hello world there",
  });
  assert.equal(cleared.draft, "there");
});

test("moving the caret keeps the draft and inserts later speech there", () => {
  const first = mergeVoiceHypothesis(beginVoiceDraft("Hi"), {
    draft: "Hi",
    caret: 2,
    caretMoved: false,
    hypothesis: "hello",
  });
  assert.equal(first.draft, "Hi hello");
  const moved = mergeVoiceHypothesis(first.lock, {
    draft: first.draft,
    caret: 2,
    caretMoved: true,
    hypothesis: "hello there",
  });
  assert.equal(moved.draft, "Hi there hello");
  assert.equal(moved.caret, "Hi there".length);
  assert.equal(moved.lock.owned, true);
  const typed = mergeVoiceHypothesis(first.lock, {
    draft: "Hi hello!",
    caret: "Hi hello!".length,
    caretMoved: false,
    hypothesis: "hello now",
  });
  assert.equal(typed.draft, "Hi hello! now");
});

test("a live mic fills the text area from on-device lines and says Listening until words arrive", () => {
  assert.equal(
    composerFieldPlaceholder({ recording: true, dropping: false, running: false }),
    LISTENING_PLACEHOLDER,
  );
  assert.equal(
    composerFieldPlaceholder({ recording: true, dropping: false, running: false, status: "Speech recognition is off." }),
    "Speech recognition is off.",
  );
  assert.equal(
    composerFieldPlaceholder({ recording: false, dropping: false, running: true }),
    "Queue for next, or Steer to redirect",
  );
  assert.equal(
    composerFieldPlaceholder({
      recording: false,
      dropping: false,
      running: false,
      status: "Online speech recognition is off. Turn it on in Windows Speech privacy, then try the mic again.",
    }),
    "Online speech recognition is off. Turn it on in Windows Speech privacy, then try the mic again.",
  );
  assert.equal(listeningDeviceLabel("Microphone (Razer Kraken Ultimate)"), "Listening · Microphone (Razer Kraken Ultimate)");
  assert.equal(listeningDeviceLabel("  "), LISTENING_PLACEHOLDER);
  assert.equal(dictationStartLine(""), "start\n");
  assert.equal(dictationStartLine(" {0.0.1.00000000}.{abc} "), "start {0.0.1.00000000}.{abc}\n");
  assert.equal(dictationStartLine("bad\nid"), "start\n");
  assert.equal(osSpeechGaveUp("network"), true);
  assert.equal(osSpeechGaveUp("no-speech"), false);
  assert.deepEqual(parseDictationLine('{"type":"ready","device":"Microphone (Razer Kraken Ultimate)","deviceId":"{0.0.1.00000000}.{90a9e327-e6a9-4f41-92d4-8e0162e9633d}"}'), {
    type: "ready",
    device: "Microphone (Razer Kraken Ultimate)",
    deviceId: "{0.0.1.00000000}.{90a9e327-e6a9-4f41-92d4-8e0162e9633d}",
  });
  assert.deepEqual(
    parseDictationLine(
      '{"type":"devices","selected":"mic-a","devices":[{"id":"mic-a","name":"Headset","default":true},{"id":"bad"}]}',
    ),
    { type: "devices", devices: [{ id: "mic-a", name: "Headset", default: true }], selected: "mic-a" },
  );
  assert.deepEqual(parseDictationLine('{"type":"partial","text":"hello desk"}'), { type: "partial", text: "hello desk" });
  assert.deepEqual(parseDictationLine('{"type":"level","value":1.4}'), { type: "level", value: 1 });
  assert.deepEqual(parseDictationLine('{"type":"error","message":"off","openSettings":true}'), {
    type: "error",
    message: "off",
    openSettings: true,
  });
  assert.deepEqual(
    parseDictationLine(
      '{"type":"error","message":"mic","openSettings":true,"settingsUrl":"ms-settings:privacy-microphone"}',
    ),
    {
      type: "error",
      message: "mic",
      openSettings: true,
      settingsUrl: WINDOWS_MICROPHONE_PRIVACY_URL,
    },
  );
  assert.deepEqual(
    parseDictationLine(
      '{"type":"error","message":"Online speech recognition is off.","openSettings":true,"settingsUrl":"ms-settings:privacy-speech"}',
    ),
    {
      type: "error",
      message: "Online speech recognition is off.",
      openSettings: true,
      settingsUrl: WINDOWS_SPEECH_PRIVACY_URL,
    },
  );
  assert.deepEqual(
    parseDictationLine('{"type":"error","message":"nope","openSettings":true,"settingsUrl":"https://evil.example"}'),
    { type: "error", message: "nope", openSettings: true },
  );
  assert.equal(parseDictationLine("not json"), null);
  const binary = path.join(ROOT, "resources", "mac-dictation");
  const script = path.join(ROOT, "electron", "mac-dictation.swift");
  const files = new Set([script, "/usr/bin/swift"]);
  assert.deepEqual(
    macDictationLaunch({
      platform: "darwin",
      binaryPath: binary,
      swiftPath: "/usr/bin/swift",
      scriptPath: script,
      existsSync: (file) => files.has(file),
    }),
    { command: "/usr/bin/swift", args: [script] },
  );
  assert.deepEqual(
    macDictationLaunch({
      platform: "darwin",
      binaryPath: binary,
      swiftPath: "/usr/bin/swift",
      scriptPath: script,
      existsSync: (file) => file === binary || files.has(file),
    }),
    { command: binary, args: [] },
  );
  assert.equal(
    macDictationLaunch({
      platform: "win32",
      binaryPath: binary,
      swiftPath: "/usr/bin/swift",
      scriptPath: script,
      existsSync: () => true,
    }),
    null,
  );
  assert.deepEqual(listenBarScales(0), [0.28, 0.28, 0.28, 0.28]);
  assert.deepEqual(listenBarScales(1), [0.68, 0.93, 1, 0.78]);
  assert.deepEqual(listenBarScales(2), listenBarScales(1));
  assert.equal(MAC_SPEECH_PRIVACY_URL.includes("Privacy_SpeechRecognition"), true);
  assert.match(read("src/ui/Composer.tsx"), /LISTENING_PLACEHOLDER|composerFieldPlaceholder/);
  const swift = read("electron/mac-dictation.swift");
  assert.match(swift, /shouldReportPartialResults = true/);
  assert.match(swift, /authorizationStatus\(\)/);
  assert.match(swift, /status == \.authorized/);
  assert.match(swift, /status != \.notDetermined/);
  assert.match(swift, /recordPermission/);
  assert.match(swift, /case \.granted/);
  assert.match(swift, /command == "stop"/);
});

test("the packaged app declares mic usage strings and the hardened-runtime audio entitlement", () => {
  const pkg = JSON.parse(read("package.json")) as {
    build?: { mac?: { extendInfo?: Record<string, string> } };
  };
  assert.match(pkg.build?.mac?.extendInfo?.NSMicrophoneUsageDescription ?? "", /microphone/);
  assert.match(pkg.build?.mac?.extendInfo?.NSSpeechRecognitionUsageDescription ?? "", /speech recognition on this Mac/);
  assert.match(read("build/entitlements.mac.plist"), /device\.audio-input/);
  assert.match(read("package.json"), /"to": "mac-dictation"/);
  assert.match(read("package.json"), /"to": "windows-dictation.exe"/);
  const windowsSource = read("electron/windows-dictation.cs");
  assert.match(windowsSource, /DictationGrammar/);
  assert.match(windowsSource, /SetInputToAudioStream/);
  assert.match(windowsSource, /16000/);
  assert.match(windowsSource, /steam streaming/);
  assert.doesNotMatch(windowsSource, /SetInputToDefaultAudioDevice/);
  assert.match(windowsSource, /command == "start"/);
  assert.match(windowsSource, /command == "stop"/);
  assert.match(windowsSource, /ms-settings:privacy-microphone/);
  assert.match(windowsSource, /ms-settings:speech/);
  assert.match(windowsSource, /ms-settings:privacy-speech/);
  assert.match(windowsSource, /SpeechRecognizer/);
  assert.match(windowsSource, /SpeechRecognitionTopicConstraint/);
  assert.match(windowsSource, /SpeechRecognitionScenario\.Dictation/);
  assert.match(windowsSource, /PumpUntilSettled/);
  assert.match(windowsSource, /privacy policy/);
  assert.doesNotMatch(windowsSource, /if \(StartWindowsSpeech\(\)\) return;/);
  assert.match(windowsSource, /RecognizeAsync\(RecognizeMode\.Multiple\)/);
  assert.match(read("src/ui/Composer.tsx"), /WINDOWS_SPEECH_PRIVACY_URL/);
  assert.match(read("src/ui/Composer.tsx"), /micEpoch/);
  assert.match(windowsSource, /RecognizeCompleted/);
  assert.match(windowsSource, /PeekMessage/);
  assert.match(windowsSource, /GetMessage/);
  assert.match(windowsSource, /OpenStandardInput/);
  assert.match(windowsSource, /RecognizeAsync\(RecognizeMode\.Single\)/);
  assert.match(windowsSource, /PostThreadMessage/);
  assert.match(read("package.json"), /build-windows-dictation\.mjs/);
  assert.match(read("scripts/build-windows-dictation.mjs"), /System\.Speech\.dll/);
  assert.match(read("package.json"), /"dev": "node scripts\/build-mac-dictation\.mjs/);
  assert.match(read("package.json"), /"pack:mac": "npm run build && node scripts\/build-mac-dictation\.mjs/);
  assert.match(read("package.json"), /"package:mac": "node scripts\/build-mac-dictation\.mjs/);
  assert.match(read("scripts/build-mac-dictation.mjs"), /__info_plist/);
  assert.match(read("scripts/build-mac-dictation.mjs"), /mac-dictation-disclaim\.c/);
  assert.match(read("electron/mac-dictation-Info.plist"), /NSSpeechRecognitionUsageDescription/);
  assert.match(read("electron/mac-dictation-Info.plist"), /NSMicrophoneUsageDescription/);
  assert.match(read("electron/mac-dictation-disclaim.c"), /responsibility_spawnattrs_setdisclaim/);
  assert.match(read("electron/mac-dictation-disclaim.c"), /WORKHORSE_DICTATION_DISCLAIMED/);
  assert.match(read("scripts/after-pack.cjs"), /windows-dictation\.exe/);
  assert.match(read("scripts/after-pack.cjs"), /copyFileSync\(built, helper\)/);
  assert.match(read(".gitignore"), /build\/windows-dictation\.exe/);
  const macSpeech = read("electron/mac-dictation.swift");
  assert.match(macSpeech, /Privacy_Microphone/);
  assert.match(macSpeech, /settingsUrl/);
  const exe = path.join(ROOT, "build", "windows-dictation.exe");
  assert.deepEqual(
    windowsDictationLaunch({
      platform: "win32",
      exePath: exe,
      existsSync: (file) => file === exe,
    }),
    { command: exe, args: [] },
  );
  assert.equal(
    windowsDictationLaunch({
      platform: "darwin",
      exePath: exe,
      existsSync: () => true,
    }),
    null,
  );
  assert.equal(
    windowsDictationCommand({
      platform: "win32",
      resourcesPath: path.join(ROOT, "missing-resources"),
      appPath: ROOT,
      existsSync: (file) => file === exe,
    })?.command,
    exe,
  );
  const builtMac = path.join(ROOT, "build", "mac-dictation");
  assert.equal(
    macDictationCommand({
      platform: "darwin",
      resourcesPath: path.join(ROOT, "missing-resources"),
      appPath: ROOT,
      existsSync: (file) => file === builtMac,
    })?.command,
    builtMac,
  );
  assert.equal(WINDOWS_SPEECH_SETTINGS_URL, "ms-settings:speech");
  assert.match(read("src/ui/Composer.tsx"), /Speech recognition is not available on this PC/);
  assert.match(read("electron/mac-dictation.ts"), /windowsDictationCommand/);
});

test("main, preload, and composer wire the mic control after the tools spacer", () => {
  const main = read("electron/main.ts");
  const preload = read("electron/preload.ts");
  const composer = read("src/ui/Composer.tsx");
  const css = read("src/styles/composer.css");
  assert.match(main, /installDeskMediaPermissions/);
  assert.match(main, /mic:request-access/);
  assert.match(main, /mic:get-status/);
  assert.match(main, /askForMediaAccess/);
  assert.match(preload, /micRequestAccess/);
  assert.match(preload, /micGetStatus/);
  assert.match(preload, /micTranscribeLocal/);
  assert.match(composer, /composer-tools-spacer[\s\S]*composer-mic[\s\S]*Steer/);
  assert.match(composer, /aria-label=\{recording \? "Stop listening" : "Listen"\}/);
  assert.match(composer, /composerFieldPlaceholder/);
  assert.match(composer, /micDictateStart/);
  assert.match(composer, /Choose microphone/);
  assert.match(read("electron/preload.ts"), /micListDevices/);
  assert.match(read("electron/main.ts"), /mic:list-devices/);
  assert.match(read("electron/preload.ts"), /micDictateStart/);
  assert.match(read("electron/main.ts"), /mic:dictate-start/);
  assert.match(main, /pauseMacDictation\(\)/);
  assert.match(main, /sessionGranted: microphoneGrantedThisRun/);
  assert.match(css, /\.composer\.listening \.composer-listen/);
  assert.match(composer, /listenBarScales/);
  assert.match(composer, /composerEscapeAction/);
  assert.match(composer, /preserveVoiceDraft/);
  assert.match(css, /\.composer-mic \{[\s\S]*?height:\s*32px/);
  assert.match(css, /\.composer-mic\.recording/);
});

test("a second mic tap reuses the helper instead of starting another one", () => {
  stopMacDictation();
  const writes: string[] = [];
  let spawns = 0;
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      writes.push(String(chunk));
      done();
    },
  });
  const spawnImpl = (() => {
    spawns += 1;
    return child;
  }) as unknown as NonNullable<Parameters<typeof startMacDictation>[0]["spawnImpl"]>;
  const input = {
    platform: "darwin" as const,
    resourcesPath: ROOT,
    appPath: ROOT,
    existsSync: (file: string) => file.endsWith(`${path.sep}mac-dictation.swift`) || file === "/usr/bin/swift",
    spawnImpl,
    onLine: () => undefined,
  };
  assert.equal(startMacDictation(input).ok, true);
  pauseMacDictation();
  assert.equal(startMacDictation(input).ok, true);
  assert.equal(spawns, 1);
  assert.deepEqual(writes, ["start\n", "stop\n", "start\n"]);
  stopMacDictation();
});

test("a chosen microphone is sent on the helper start line", () => {
  stopMacDictation();
  const writes: string[] = [];
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      writes.push(String(chunk));
      done();
    },
  });
  const spawnImpl = (() => child) as unknown as NonNullable<Parameters<typeof startMacDictation>[0]["spawnImpl"]>;
  const started = startMacDictation({
    platform: "win32",
    resourcesPath: path.join(ROOT, "resources"),
    appPath: ROOT,
    deviceId: "{0.0.1.00000000}.{90a9e327-e6a9-4f41-92d4-8e0162e9633d}",
    existsSync: (file) => file.endsWith(`${path.sep}windows-dictation.exe`),
    spawnImpl,
    onLine: () => undefined,
  });
  assert.equal(started.ok, true);
  assert.deepEqual(writes, ["start {0.0.1.00000000}.{90a9e327-e6a9-4f41-92d4-8e0162e9633d}\n"]);
  stopMacDictation();
});

test("a failed helper spawn reports an error instead of staying silent", () => {
  stopMacDictation();
  const lines: Array<{ type: string; message?: string }> = [];
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const spawnImpl = (() => child) as unknown as NonNullable<Parameters<typeof startMacDictation>[0]["spawnImpl"]>;
  const started = startMacDictation({
    platform: "win32",
    resourcesPath: path.join(ROOT, "resources"),
    appPath: ROOT,
    existsSync: (file) => file.endsWith(`${path.sep}windows-dictation.exe`),
    spawnImpl,
    onLine: (line) => lines.push(line),
  });
  assert.equal(started.ok, true);
  child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
  assert.deepEqual(lines, [{ type: "error", message: "On-device speech is not available on this PC." }]);
  stopMacDictation();
});

test("a helper aborted by the system tells the composer instead of leaving it listening", () => {
  stopMacDictation();
  const lines: Array<{ type: string; message?: string }> = [];
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const spawnImpl = (() => child) as unknown as NonNullable<Parameters<typeof startMacDictation>[0]["spawnImpl"]>;
  const started = startMacDictation({
    platform: "darwin",
    resourcesPath: path.join(ROOT, "missing-resources"),
    appPath: ROOT,
    existsSync: (file) => file.endsWith(`${path.sep}mac-dictation.swift`) || file === "/usr/bin/swift",
    spawnImpl,
    onLine: (line) => lines.push(line),
  });
  assert.equal(started.ok, true);
  child.emit("close", null, "SIGABRT");
  assert.deepEqual(lines, [{ type: "error", message: "Speech recognition stopped before it heard anything." }]);
  stopMacDictation();
});

test("a ready helper that exits with no words surfaces an error and clears listening", () => {
  assert.equal(
    dictationHelperExit({
      stopped: false,
      reported: false,
      code: 0,
      signal: null,
      sawReady: false,
      sawTranscript: false,
    }),
    null,
  );
  assert.equal(
    dictationHelperExit({
      stopped: false,
      reported: false,
      code: 0,
      signal: null,
      sawReady: true,
      sawTranscript: true,
    }),
    null,
  );
  assert.deepEqual(
    dictationHelperExit({
      stopped: false,
      reported: false,
      code: 0,
      signal: null,
      sawReady: true,
      sawTranscript: false,
    }),
    { type: "error", message: DICTATION_OPENED_WITHOUT_SPEECH },
  );
  assert.equal(DICTATION_OPENED_WITHOUT_SPEECH.includes("privacy"), false);
  stopMacDictation();
  const lines: Array<{ type: string; message?: string; openSettings?: boolean; device?: string }> = [];
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const spawnImpl = (() => child) as unknown as NonNullable<Parameters<typeof startMacDictation>[0]["spawnImpl"]>;
  const started = startMacDictation({
    platform: "win32",
    resourcesPath: path.join(ROOT, "resources"),
    appPath: ROOT,
    existsSync: (file) => file.endsWith(`${path.sep}windows-dictation.exe`),
    spawnImpl,
    onLine: (line) => lines.push(line),
  });
  assert.equal(started.ok, true);
  child.stdout.emit(
    "data",
    '{"type":"ready","device":"Microphone (Razer Kraken Ultimate)","deviceId":"{0.0.1.00000000}.{90a9e327-e6a9-4f41-92d4-8e0162e9633d}"}\n',
  );
  child.emit("close", 0, null);
  assert.equal(lines[0]?.type, "ready");
  assert.deepEqual(lines[1], { type: "error", message: DICTATION_OPENED_WITHOUT_SPEECH });
  assert.equal(lines[1]?.openSettings, undefined);
  const composer = read("src/ui/Composer.tsx");
  assert.match(composer, /event\.type === "error"[\s\S]{0,400}setRecording\(false\)/);
  assert.match(composer, /dictationRef\.current = false/);
  assert.doesNotMatch(composer, /readOnly/);
  stopMacDictation();
});

function runDictationHelper(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  const exe = path.join(ROOT, "build", "windows-dictation.exe");
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => finish(code));
  });
}

test("the pipe stays fed while a reader is blocked and direct capture uses the real block align", async () => {
  const windowsSource = read("electron/windows-dictation.cs");
  assert.match(windowsSource, /PumpPipeRead/);
  assert.match(windowsSource, /PullCaptureOffSta/);
  assert.match(windowsSource, /while \(filled < count\)/);
  assert.match(windowsSource, /position \+= filled/);
  assert.match(windowsSource, /EmitCaptureLevel/);
  assert.doesNotMatch(windowsSource, /A short read is the end/);
  assert.match(windowsSource, /\(int\)read \* blockAlign/);
  assert.doesNotMatch(windowsSource, /\(int\)read \* 2/);
  assert.match(windowsSource, /lock \(Gate\) committed = "";/);
  assert.match(windowsSource, /The microphone opened, but no speech was heard\./);
  assert.match(windowsSource, /finalResult && result\.Confidence < 0\.1f/);
  assert.doesNotMatch(windowsSource, /if \(!Heard\(e\.Result\)\) return;/);
  if (process.platform !== "win32") return;
  const exe = path.join(ROOT, "build", "windows-dictation.exe");
  assert.equal(existsSync(exe), true, "rebuild build/windows-dictation.exe before this test");
  const pipe = await runDictationHelper(["--self-test-pipe"], 8000);
  assert.match(pipe.stdout, /hello pipe/);
  assert.equal(pipe.code, 0);
  const stream = await runDictationHelper(["--self-test-stream"], 20000);
  assert.match(stream.stdout, /hello/i);
  assert.equal(stream.code, 0);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { LocalArtifact, LocalJob } from "../src/lib/local-capability-contract";
import type { LocalComputeHostSettings } from "../src/lib/types";
import {
  allowDeskMediaPermission,
  composerEscapeAction,
  composerFieldPlaceholder,
  getMicrophoneAccessStatus,
  installDeskMediaPermissions,
  joinVoiceDraft,
  LISTENING_PLACEHOLDER,
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
  assert.equal(composerEscapeAction({ recording: false, plusOpen: true, preserveVoiceDraft: true }), "close-menu");
  assert.equal(composerEscapeAction({ recording: false, plusOpen: false, preserveVoiceDraft: true }), "keep-draft");
  assert.equal(composerEscapeAction({ recording: false, plusOpen: false, preserveVoiceDraft: false }), "clear");
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
  assert.equal(osSpeechGaveUp("network"), true);
  assert.equal(osSpeechGaveUp("no-speech"), false);
  assert.deepEqual(parseDictationLine('{"type":"partial","text":"hello desk"}'), { type: "partial", text: "hello desk" });
  assert.deepEqual(parseDictationLine('{"type":"level","value":1.4}'), { type: "level", value: 1 });
  assert.deepEqual(parseDictationLine('{"type":"error","message":"off","openSettings":true}'), {
    type: "error",
    message: "off",
    openSettings: true,
  });
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
  assert.equal(MAC_SPEECH_PRIVACY_URL.includes("Privacy_SpeechRecognition"), true);
  assert.match(read("src/ui/Composer.tsx"), /LISTENING_PLACEHOLDER|composerFieldPlaceholder/);
  assert.match(read("electron/mac-dictation.swift"), /shouldReportPartialResults = true/);
});

test("the packaged app declares mic usage strings and the hardened-runtime audio entitlement", () => {
  const pkg = JSON.parse(read("package.json")) as {
    build?: { mac?: { extendInfo?: Record<string, string> } };
  };
  assert.match(pkg.build?.mac?.extendInfo?.NSMicrophoneUsageDescription ?? "", /microphone/);
  assert.match(pkg.build?.mac?.extendInfo?.NSSpeechRecognitionUsageDescription ?? "", /speech recognition on this Mac/);
  assert.match(read("build/entitlements.mac.plist"), /device\.audio-input/);
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
  assert.match(composer, /aria-label=\{recording \? "Stop recording" : "Record voice"\}/);
  assert.match(composer, /composerFieldPlaceholder/);
  assert.match(composer, /micDictateStart/);
  assert.match(read("electron/preload.ts"), /micDictateStart/);
  assert.match(read("electron/main.ts"), /mic:dictate-start/);
  assert.match(css, /\.composer\.listening textarea::placeholder/);
  assert.match(composer, /composerEscapeAction/);
  assert.match(composer, /preserveVoiceDraft/);
  assert.match(css, /\.composer-mic \{[\s\S]*?height:\s*32px/);
  assert.match(css, /\.composer-mic\.recording/);
});

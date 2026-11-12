/**
 * Microphone access lives in main. The renderer records and transcribes only
 * after this module grants media, and never invents a cloud speech vendor.
 */
import { localComputeHostCallable, type LocalComputeHostProbe, type LocalComputeHostSettings } from "../src/lib/local-compute";
import { buildLocalCapabilityRequest } from "../src/lib/local-capability-requests";
import type { LocalArtifact, LocalJob } from "../src/lib/local-capability-contract";

export const LOCAL_SPEECH_CAPABILITY = "audio.speech.transcribe";

export const MAC_SYSTEM_SETTINGS_APP = "/System/Applications/System Settings.app";
export const MAC_SYSTEM_PREFERENCES_APP = "/System/Applications/System Preferences.app";
export const MAC_MICROPHONE_PRIVACY_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
export const MAC_SPEECH_PRIVACY_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition";
export const WINDOWS_MICROPHONE_PRIVACY_URL = "ms-settings:privacy-microphone";
export const LISTENING_PLACEHOLDER = "Listening…";

const LISTEN_BAR_WEIGHTS = [0.55, 0.9, 1, 0.7] as const;

/** Four short bars beside the mic. Quiet at rest, taller as the voice gets louder. */
export function listenBarScales(level: number): number[] {
  const amount = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return LISTEN_BAR_WEIGHTS.map((weight) => Math.round((0.28 + weight * amount * 0.72) * 100) / 100);
}

export const NS_MICROPHONE_USAGE_DESCRIPTION =
  "Workhorse records from the microphone so your words can be typed into the unsent draft.";
export const NS_SPEECH_RECOGNITION_USAGE_DESCRIPTION =
  "Workhorse uses speech recognition on this Mac to type what you say into the unsent draft.";

const MAX_AUDIO_BASE64_CHARS = 8_000_000;
const TRANSCRIBE_POLLS = 20;
const TRANSCRIBE_POLL_MS = 250;

export type MicAccessStatus = "granted" | "denied" | "restricted" | "not-determined" | "unknown";

export type MicAccessResult = {
  status: MicAccessStatus;
  granted: boolean;
  openedSettings?: boolean;
};

export type MicTranscriptResult =
  | { ok: true; text: string; hostId: string }
  | { ok: false; reason: string };

export type SpeechEngine = "os" | "local-compute" | "none";

export type ComposerEscapeAction = "stop-recording" | "close-menu" | "keep-draft" | "clear";

export type MicAccessDeps = {
  platform: NodeJS.Platform;
  existsSync: (file: string) => boolean;
  getMediaAccessStatus: (mediaType: "microphone") => string;
  askForMediaAccess: (mediaType: "microphone") => Promise<boolean>;
  openExternal: (url: string) => Promise<void> | void;
};

export type MediaPermissionDetails = {
  mediaTypes?: readonly string[];
  mediaType?: string;
  requestingUrl?: string;
};

export type MediaPermissionSession = {
  setPermissionRequestHandler(
    handler: (
      contents: { getURL(): string },
      permission: string,
      callback: (allow: boolean) => void,
      details: MediaPermissionDetails,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      contents: { getURL(): string } | null,
      permission: string,
      requestingOrigin: string,
      details: MediaPermissionDetails,
    ) => boolean,
  ): void;
};

export type MicTranscribeClient = {
  uploadBase64(
    hostId: string,
    input: { kind: string; role: string; mediaType: string; base64: string; origin: string; scopeCapability?: string },
  ): Promise<LocalArtifact>;
  submit(hostId: string, request: unknown): Promise<LocalJob>;
  status(hostId: string, jobId: string): Promise<LocalJob>;
};

export function mapMediaAccessStatus(value: string): MicAccessStatus {
  if (value === "granted" || value === "denied" || value === "restricted" || value === "not-determined" || value === "unknown") {
    return value;
  }
  return "unknown";
}

export function microphonePrivacyUrl(platform: NodeJS.Platform, existsSync: (file: string) => boolean): string | null {
  if (platform === "win32") return WINDOWS_MICROPHONE_PRIVACY_URL;
  if (platform !== "darwin") return null;
  if (existsSync(MAC_SYSTEM_SETTINGS_APP) || existsSync(MAC_SYSTEM_PREFERENCES_APP)) {
    return MAC_MICROPHONE_PRIVACY_URL;
  }
  return null;
}

export function allowDeskMediaPermission(
  permission: string,
  details: MediaPermissionDetails | undefined,
  deskPage: boolean,
): boolean {
  if (!deskPage || permission !== "media") return false;
  const types = details?.mediaTypes;
  if (Array.isArray(types) && types.length > 0) {
    return types.includes("audio") && !types.includes("video");
  }
  if (details?.mediaType === "video") return false;
  return true;
}

export function installDeskMediaPermissions(ses: MediaPermissionSession, isDesk: (url: string) => boolean): void {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const url = details?.requestingUrl || contents.getURL();
    callback(allowDeskMediaPermission(permission, details, isDesk(url)));
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const url = contents?.getURL() || requestingOrigin;
    return allowDeskMediaPermission(permission, details, isDesk(url));
  });
}

export function getMicrophoneAccessStatus(deps: Pick<MicAccessDeps, "platform" | "getMediaAccessStatus">): MicAccessStatus {
  if (deps.platform !== "darwin" && deps.platform !== "win32") return "granted";
  return mapMediaAccessStatus(deps.getMediaAccessStatus("microphone"));
}

export async function requestMicrophoneAccess(deps: MicAccessDeps): Promise<MicAccessResult> {
  if (deps.platform === "win32") {
    const current = mapMediaAccessStatus(deps.getMediaAccessStatus("microphone"));
    if (current === "denied" || current === "restricted") {
      const openedSettings = await openMicPrivacy(deps);
      return { status: current, granted: false, openedSettings };
    }
    return { status: "granted", granted: true };
  }
  if (deps.platform !== "darwin") {
    return { status: "granted", granted: true };
  }
  const current = mapMediaAccessStatus(deps.getMediaAccessStatus("microphone"));
  if (current === "granted") return { status: "granted", granted: true };
  if (current === "not-determined" || current === "unknown") {
    const ok = await deps.askForMediaAccess("microphone");
    const next = mapMediaAccessStatus(deps.getMediaAccessStatus("microphone"));
    if (ok || next === "granted") return { status: "granted", granted: true };
    const denied = next === "not-determined" || next === "unknown" ? "denied" : next;
    const openedSettings = await openMicPrivacy(deps);
    return { status: denied, granted: false, openedSettings };
  }
  const openedSettings = await openMicPrivacy(deps);
  return { status: current, granted: false, openedSettings };
}

async function openMicPrivacy(deps: MicAccessDeps): Promise<boolean> {
  const url = microphonePrivacyUrl(deps.platform, deps.existsSync);
  if (!url) return false;
  try {
    await deps.openExternal(url);
    return true;
  } catch {
    return false;
  }
}

export function pickLocalSpeechHost(
  hosts: readonly LocalComputeHostSettings[],
  probes: readonly Pick<LocalComputeHostProbe, "hostId" | "status" | "capabilities">[],
): string | null {
  for (const host of hosts) {
    if (!localComputeHostCallable(host, "desk", LOCAL_SPEECH_CAPABILITY)) continue;
    const probe = probes.find((row) => row.hostId === host.id);
    if (!probe || probe.status !== "healthy") continue;
    if (!probe.capabilities.some((capability) => capability.id === LOCAL_SPEECH_CAPABILITY)) continue;
    return host.id;
  }
  return null;
}

export function pickSpeechEngine(osAvailable: boolean, localHostId: string | null): SpeechEngine {
  if (osAvailable) return "os";
  if (localHostId) return "local-compute";
  return "none";
}

/** OS speech wins until start() throws. A granted local host then records. */
export async function speechEngineAfterOsStartFailure(
  startOs: () => void,
  resolveLocalHost: () => Promise<string | null>,
): Promise<SpeechEngine> {
  try {
    startOs();
    return "os";
  } catch {
    return pickSpeechEngine(false, await resolveLocalHost());
  }
}

export function joinVoiceDraft(existing: string, spoken: string): string {
  const speech = spoken.trim();
  if (!speech) return existing;
  if (!existing.trim()) return speech;
  if (existing.endsWith("\n")) return `${existing}${speech}`;
  if (/\s$/.test(existing)) return `${existing}${speech}`;
  return `${existing} ${speech}`;
}

/** Electron's web speech engine often starts and then reports one of these. */
export function osSpeechGaveUp(error: string | undefined): boolean {
  return error === "network" || error === "not-allowed" || error === "service-not-allowed" || error === "audio-capture";
}

export function composerFieldPlaceholder(input: {
  recording: boolean;
  dropping: boolean;
  running: boolean;
  status?: string;
}): string {
  if (input.dropping) return "Drop files or folders";
  if (input.recording) {
    const status = input.status?.trim();
    return status || LISTENING_PLACEHOLDER;
  }
  if (input.running) return "Queue for next, or Steer to redirect";
  return "Message, drop a file or folder, or type /";
}

export type DictationLine =
  | { type: "ready" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "level"; value: number }
  | { type: "error"; message: string; openSettings?: boolean };

export function parseDictationLine(line: string): DictationLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { type?: unknown; text?: unknown; value?: unknown; message?: unknown; openSettings?: unknown };
  if (record.type === "ready") return { type: "ready" };
  if ((record.type === "partial" || record.type === "final") && typeof record.text === "string") {
    return { type: record.type, text: record.text };
  }
  if (record.type === "level" && typeof record.value === "number" && Number.isFinite(record.value)) {
    return { type: "level", value: Math.min(1, Math.max(0, record.value)) };
  }
  if (record.type === "error" && typeof record.message === "string" && record.message.trim()) {
    return {
      type: "error",
      message: record.message.trim(),
      ...(record.openSettings === true ? { openSettings: true } : {}),
    };
  }
  return null;
}

/** Prefer a bundled on-device helper. Otherwise the system Swift interpreter and a script the caller already resolved. */
export function macDictationLaunch(input: {
  platform: NodeJS.Platform;
  binaryPath: string;
  swiftPath: string;
  scriptPath: string | null;
  existsSync: (file: string) => boolean;
}): { command: string; args: string[] } | null {
  if (input.platform !== "darwin") return null;
  if (input.existsSync(input.binaryPath)) return { command: input.binaryPath, args: [] };
  if (!input.scriptPath || !input.existsSync(input.swiftPath) || !input.existsSync(input.scriptPath)) return null;
  return { command: input.swiftPath, args: [input.scriptPath] };
}

export function composerEscapeAction(input: {
  recording: boolean;
  plusOpen: boolean;
  preserveVoiceDraft: boolean;
}): ComposerEscapeAction {
  if (input.recording) return "stop-recording";
  if (input.plusOpen) return "close-menu";
  if (input.preserveVoiceDraft) return "keep-draft";
  return "clear";
}

export function transcriptFromLocalJob(job: Pick<LocalJob, "status" | "result" | "error">): string | null {
  if (job.status !== "completed" || !job.result) return null;
  const data = job.result.data;
  for (const key of ["transcript", "text"] as const) {
    const value = data?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export async function transcribeLocalSpeech(input: {
  hosts: readonly LocalComputeHostSettings[];
  probes: readonly Pick<LocalComputeHostProbe, "hostId" | "status" | "capabilities">[];
  audioBase64: string;
  mimeType: string;
  client: MicTranscribeClient;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<MicTranscriptResult> {
  const hostId = pickLocalSpeechHost(input.hosts, input.probes);
  if (!hostId) return { ok: false, reason: "No granted local speech host." };
  if (!input.audioBase64 || input.audioBase64.length > MAX_AUDIO_BASE64_CHARS) {
    return { ok: false, reason: "Recording is empty or too large." };
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.audioBase64)) {
    return { ok: false, reason: "Recording is empty or too large." };
  }
  const mimeType = input.mimeType.trim() || "audio/webm";
  if (!/^audio\/[a-z0-9.+\-]+(?:;[\w.=+\-]+)?$/i.test(mimeType) || mimeType.length > 80) {
    return { ok: false, reason: "Recording is empty or too large." };
  }
  const mint = input.newId ?? (() => `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    const artifact = await input.client.uploadBase64(hostId, {
      kind: "audio",
      role: "recording",
      mediaType: mimeType.split(";")[0] ?? "audio/webm",
      base64: input.audioBase64,
      origin: "workhorse",
      scopeCapability: LOCAL_SPEECH_CAPABILITY,
    });
    const request = buildLocalCapabilityRequest(
      { requestId: `req_${mint()}`, traceId: `trace_${mint()}`, idempotencyKey: `idem_${mint()}` },
      {
        capability: LOCAL_SPEECH_CAPABILITY,
        inputs: [{ artifact, role: "recording" }],
        requiredOutputs: [{ role: "transcript", kind: "text", mediaTypes: ["text/plain"], required: true }],
        metadata: { surface: "composer-mic" },
      },
    );
    let job = await input.client.submit(hostId, request);
    for (let attempt = 0; attempt < TRANSCRIBE_POLLS && job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled"; attempt += 1) {
      await sleep(TRANSCRIBE_POLL_MS);
      job = await input.client.status(hostId, job.id);
    }
    const text = transcriptFromLocalJob(job);
    if (text) return { ok: true, text, hostId };
    if (job.status === "failed") return { ok: false, reason: job.error?.message || "Local speech failed." };
    return { ok: false, reason: "Local speech did not return a transcript." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local speech failed.";
    return { ok: false, reason: message };
  }
}

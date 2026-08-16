import type { LearningEvent, SensitivityLabel } from "./learning-types";
import { LEARNING_REDACTION_VERSION } from "./learning-types";

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+=/]{8,}/gi,
  /\b(xai-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/g,
  /\b(api[_-]?key|secret|token|password|passwd|authorization)\s*[:=]\s*['"]?[^'"\s]{6,}/gi,
  /\b[A-Z][A-Z0-9_]{2,}(KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*=\s*\S+/g,
  /\b(keychain|login keychain|osxkeychain)\b[^\n]{0,80}/gi,
];

const MAX_PAYLOAD_CHARS = 4_000;
const MAX_STATEMENT_CHARS = 1_200;

export function sourceHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function localDayKey(at: number, timeZone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(at),
    );
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export function redactText(text: string): { text: string; sensitivity: SensitivityLabel } {
  let next = text;
  let sensitivity: SensitivityLabel = "normal";
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(next)) {
      sensitivity = "secret";
      next = next.replace(pattern, "[redacted]");
    }
    pattern.lastIndex = 0;
  }
  return { text: boundText(next, MAX_PAYLOAD_CHARS), sensitivity };
}

export function boundText(text: string, max = MAX_PAYLOAD_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function boundStatement(text: string): string {
  return boundText(text.trim(), MAX_STATEMENT_CHARS);
}

export function redactPayload(payload: Record<string, unknown>): {
  payload: Record<string, unknown>;
  sensitivity: SensitivityLabel;
} {
  let worst: SensitivityLabel = "normal";
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const redacted = redactText(value);
      if (redacted.sensitivity === "secret") worst = "secret";
      else if (redacted.sensitivity === "sensitive" && worst === "normal") worst = "sensitive";
      return redacted.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return { payload: walk(payload) as Record<string, unknown>, sensitivity: worst };
}

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    const hit = pattern.test(text);
    pattern.lastIndex = 0;
    return hit;
  });
}

export function prepareEvent(
  draft: Omit<LearningEvent, "sourceHash" | "redactionVersion" | "sensitivity" | "schemaVersion" | "localDay" | "payload"> & {
    payload: Record<string, unknown>;
    schemaVersion?: number;
    localDay?: string;
    timeZone?: string;
  },
): LearningEvent {
  const redacted = redactPayload(draft.payload);
  const serialized = JSON.stringify(redacted.payload);
  return {
    ...draft,
    payload: redacted.payload,
    schemaVersion: draft.schemaVersion ?? 1,
    localDay: draft.localDay ?? localDayKey(draft.createdAt, draft.timeZone),
    redactionVersion: LEARNING_REDACTION_VERSION,
    sensitivity: redacted.sensitivity,
    sourceHash: sourceHash(`${draft.id}:${draft.kind}:${serialized}`),
    tombstone: Boolean(draft.tombstone),
    purged: Boolean(draft.purged),
  };
}

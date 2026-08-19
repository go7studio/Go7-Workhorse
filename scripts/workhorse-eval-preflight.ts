import path from "node:path";
import process from "node:process";
import { detectClaudeLogin } from "../electron/claude-login";
import { detectCodexLogin } from "../electron/codex-login";
import { detectCursorLogin } from "../electron/cursor-login";
import { detectGrokLogin } from "../electron/grok-login";

function binaryEvidence(value: string | null | undefined) {
  return value ? { found: true, name: path.basename(value) } : { found: false, name: null };
}

const grok = detectGrokLogin();
const codex = detectCodexLogin();
const claude = detectClaudeLogin();
const cursor = detectCursorLogin();

const report = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  profiles: {
    "grok-acp": {
      connected: grok.connected,
      acp: binaryEvidence(grok.binary),
    },
    "codex-acp": {
      connected: codex.connected,
      acp: binaryEvidence(codex.acpBinary),
      cli: binaryEvidence(codex.cliBinary),
      accessDefaults: codex.accessDefaults ?? null,
    },
    "claude-acp": {
      connected: claude.connected,
      needsAuth: claude.needsAuth,
      acp: binaryEvidence(claude.acpBinary),
      cli: binaryEvidence(claude.cliBinary),
    },
    "cursor-acp": {
      connected: cursor.connected,
      needsAuth: cursor.needsAuth,
      acp: binaryEvidence(cursor.binary),
      prefix: cursor.prefixArgs.map((value) => path.basename(value)),
    },
  },
  redaction: {
    pathsReducedToBasenames: true,
    credentialsRead: false,
    credentialsEmitted: false,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

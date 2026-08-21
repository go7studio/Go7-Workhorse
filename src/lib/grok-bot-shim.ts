import path from "node:path";
import { GROK_BOT_SHIM_PORT } from "./custom-http-identity";

export { GROK_BOT_SHIM_PORT };
export const GROK_BOT_SHIM_HOST = "127.0.0.1";
export const GROK_BOT_SHIM_LABEL = "com.go7studio.workhorse-grok-bot-shim";
export const GROK_BOT_WAKE_FILE = "grok-bot-wake.json";
export const GROK_BOT_INBOX_DIR = "grok-bot-inbox";

export function grokBotInboxDir(userData: string): string {
  return path.join(userData, GROK_BOT_INBOX_DIR);
}

export function grokBotWakePath(userData: string): string {
  return path.join(userData, GROK_BOT_WAKE_FILE);
}

export type GrokBotWake = { url: string; key: string };

/** Steve's routine-panel copy. Never log url or sender key. */
export function parseGrokBotWake(raw: unknown): GrokBotWake | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const url = String(record.url || record.endpoint || "").trim();
  const key = String(record.senderKey || record.sender_key || record.key || "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:") return null;
  if (!key) return null;
  if (!host || host === "..." || host === "example.com" || !host.includes(".")) return null;
  if (!parsed.pathname.includes("/webhook")) return null;
  return { url, key };
}

export function grokBotShimListen(host: string, port: number, options?: { ephemeral?: boolean }): { host: string; port: number } {
  if (host !== GROK_BOT_SHIM_HOST) {
    throw new Error("Grok Bot shim binds 127.0.0.1 only.");
  }
  if (!options?.ephemeral && port !== Number(GROK_BOT_SHIM_PORT)) {
    throw new Error(`Grok Bot shim listens on port ${GROK_BOT_SHIM_PORT} only.`);
  }
  return { host, port };
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plistString(value: string): string {
  return `<string>${xmlEscape(value)}</string>`;
}

/** launchd KeepAlive + RunAtLoad. No token. Loopback bind is the shim's job. */
export function grokBotLaunchAgentPlist(input: {
  label?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  logPath: string;
}): string {
  const label = input.label ?? GROK_BOT_SHIM_LABEL;
  const args = [input.command, ...input.args].map((item) => `    ${plistString(item)}`).join("\n");
  const envEntries = Object.entries(input.env ?? {});
  const env = envEntries.length
    ? [
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        ...envEntries.flatMap(([key, value]) => [`    <key>${xmlEscape(key)}</key>`, `    ${plistString(value)}`]),
        "  </dict>",
      ].join("\n")
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${plistString(label)}
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${env ? `${env}\n` : ""}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${plistString(input.logPath)}
  <key>StandardErrorPath</key>${plistString(input.logPath)}
</dict></plist>
`;
}

export function grokBotShimEnv(input: { inbox: string; wake: string; userData: string }): Record<string, string> {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    WORKHORSE_GROK_BOT_SHIM: "1",
    WORKHORSE_GROK_BOT_INBOX: input.inbox,
    WORKHORSE_GROK_BOT_WAKE: input.wake,
    WORKHORSE_GROK_BOT_USERDATA: input.userData,
  };
}

export function grokBotLaunchctlCommands(input: { uid: number; label?: string; plistPath: string }): {
  bootout: string[];
  bootstrap: string[];
} {
  const label = input.label ?? GROK_BOT_SHIM_LABEL;
  const domain = `gui/${input.uid}`;
  return {
    bootout: ["bootout", `${domain}/${label}`],
    bootstrap: ["bootstrap", domain, input.plistPath],
  };
}

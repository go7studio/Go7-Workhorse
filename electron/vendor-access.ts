import type { BotAccessDefaults, PermissionMode, SandboxProfile } from "../src/lib/types";

/**
 * Reading a vendor app's own recorded defaults, the way Codex already does in
 * codex-login.ts. This is how "vice versa" works without a handshake: the desk
 * reads config files it can already see on this machine. No agent is asked what
 * it is allowed to do, nothing is sent, and no caller may assert a grant.
 *
 * Every reader takes its file access injected, so a test never touches the home
 * machine, and every unknown word maps to nothing rather than to a guess — an
 * unreadable config leaves the desk default standing rather than narrowing it.
 */

/** Claude Code and Grok share this vocabulary (electron/claude-launch.ts:114, electron/grok-launch.ts:203). */
function acpPermissionMode(value: unknown): PermissionMode | undefined {
  if (value === "bypassPermissions") return "always-approve";
  if (value === "acceptEdits") return "accept-edits";
  if (value === "plan") return "plan";
  // `default` is Claude's and Grok's word for prompting on each tool use.
  // `dontAsk` is what Grok uses inside a box; both land on Ask here.
  if (value === "default" || value === "dontAsk") return "ask";
  return undefined;
}

/** Cursor's three-way mode (electron/cursor-launch.ts:60). */
function cursorPermissionMode(value: unknown): PermissionMode | undefined {
  if (value === "plan") return "plan";
  if (value === "ask") return "ask";
  // Cursor folds Always and Accept edits into one word, so the narrower of the
  // two is the only honest reading back.
  if (value === "agent") return "accept-edits";
  return undefined;
}

function sandboxProfile(value: unknown): SandboxProfile | undefined {
  if (value === "off" || value === "workspace" || value === "read-only" || value === "strict") return value;
  if (value === "danger-full-access") return "off";
  if (value === "workspace-write") return "workspace";
  return undefined;
}

function access(mode: PermissionMode | undefined, sandbox: SandboxProfile | undefined): BotAccessDefaults | undefined {
  return mode || sandbox ? { ...(mode ? { mode } : {}), ...(sandbox ? { sandbox } : {}) } : undefined;
}

function readJson(filePath: string, readFile: (filePath: string) => string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFile(filePath)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A login can exist with no config file, and a half-written one is not a
    // restriction. Either way the desk default stands.
    return {};
  }
}

function nested(values: Record<string, unknown>, key: string): Record<string, unknown> {
  const row = values[key];
  return row && typeof row === "object" ? (row as Record<string, unknown>) : {};
}

/** Top-level `key = "value"` pairs, stopping at the first table header. */
export function topLevelToml(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(["'])(.*?)\2(?:\s*#.*)?$/.exec(line);
    if (match) values[match[1]] = match[3];
  }
  return values;
}

export type VendorAccessInput = {
  home: string;
  join: (...parts: string[]) => string;
  readFile: (filePath: string) => string;
  env?: NodeJS.Dict<string>;
};

/** `~/.claude/settings.json` → `permissions.defaultMode`. */
export function detectClaudeAccessDefaults(input: VendorAccessInput): BotAccessDefaults | undefined {
  const values = readJson(input.join(input.home, "settings.json"), input.readFile);
  const permissions = nested(values, "permissions");
  return access(acpPermissionMode(permissions.defaultMode ?? values.permissionMode), undefined);
}

/** `~/.grok/config.toml` → `permission_mode` and `sandbox`, with GROK_SANDBOX over the file. */
export function detectGrokAccessDefaults(input: VendorAccessInput): BotAccessDefaults | undefined {
  let values: Record<string, string> = {};
  try {
    values = topLevelToml(input.readFile(input.join(input.home, "config.toml")));
  } catch {
    // No config file. Not a restriction.
  }
  const sandbox = sandboxProfile(input.env?.GROK_SANDBOX?.trim() || values.sandbox);
  return access(acpPermissionMode(values.permission_mode), sandbox);
}

/** `~/.cursor/cli-config.json` → `permissions.defaultMode`. */
export function detectCursorAccessDefaults(input: VendorAccessInput): BotAccessDefaults | undefined {
  const values = readJson(input.join(input.home, "cli-config.json"), input.readFile);
  const permissions = nested(values, "permissions");
  return access(cursorPermissionMode(permissions.defaultMode ?? values.permissionMode), undefined);
}

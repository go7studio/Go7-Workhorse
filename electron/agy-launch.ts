import path from "node:path";
import type { EffortLevel, PermissionMode, SandboxProfile } from "../src/lib/types";

export const AGY_DEFAULT_MODEL = "gemini-3.8-flash-high";

const PINNED_EFFORT = /-(low|medium|high|xhigh|max)$/i;
const PASSABLE_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);

export type AgyLaunchInput = {
  model?: string | null;
  effort?: EffortLevel | string | null;
  cwd: string;
  mode?: PermissionMode;
  sandbox?: SandboxProfile;
  /** Resume a conversation the CLI already has. Omitted on a process that is still open. */
  conversationId?: string;
  command?: string;
  mcpOverlay?: string;
};

export type AgyLaunchSpec = {
  command: string;
  argv: string[];
  cwd: string;
  model: string;
};

/** The slug already names the thinking level, so a second `--effort` would fight it. */
export function modelPinsEffort(model: string): boolean {
  return PINNED_EFFORT.test(model.trim());
}

/**
 * Gemini's default seat. Headless `agy` never asks in the stream, so an
 * omitted mode is always-approve. Ask, plan, and accept-edits stay off the
 * flag so a later tighten is honored.
 */
export function agySkipsPermissions(mode: PermissionMode | undefined): boolean {
  return mode === undefined || mode === "always-approve";
}

function effortFlag(model: string, effort: EffortLevel | string | null | undefined): string | undefined {
  if (modelPinsEffort(model)) return undefined;
  const word = typeof effort === "string" ? effort.trim().toLowerCase() : "";
  if (word === "ultra") return "max";
  if (PASSABLE_EFFORT.has(word)) return word;
  return undefined;
}

/**
 * Headless stream for one desk chat. The binary is the official `agy`.
 * No ACP, no `-p` (it is dropped on a stream and would end the process),
 * no token path, no API key. `--add-dir` is the workspace, or writes land
 * in the CLI's scratch folder. `--print-timeout 0` waits for the turn.
 */
export function buildAgyLaunchSpec(input: AgyLaunchInput): AgyLaunchSpec {
  const cwd = input.cwd?.trim() ?? "";
  if (!cwd || !path.isAbsolute(cwd)) throw new Error("Gemini needs a workspace folder.");
  const model = input.model?.trim() || AGY_DEFAULT_MODEL;
  const argv = ["--model", model];
  const effort = effortFlag(model, input.effort);
  if (effort) argv.push("--effort", effort);
  const conversation = input.conversationId?.trim();
  if (conversation) argv.push("--conversation", conversation);
  argv.push("--add-dir", cwd);
  if (input.mcpOverlay) argv.push("--add-dir", input.mcpOverlay);
  // `--mode plan` and `--mode accept-edits` do not change permission_mode.
  // Headless agy does not ask in the stream.
  if ((input.sandbox ?? "off") !== "off") argv.push("--sandbox");
  if (agySkipsPermissions(input.mode)) argv.push("--dangerously-skip-permissions");
  argv.push("--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "0");
  return { command: input.command?.trim() || "agy", argv, cwd, model };
}

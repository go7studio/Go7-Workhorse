import { spawn } from "node:child_process";
import { parseAgyUsageCommand } from "../src/lib/agy-usage";
import { planObservedNow } from "../src/lib/usage";
import type { GrokPlanUsage } from "../src/lib/types";
import { deskToolEnv } from "./desk-path";
import { groupSpawnOptions } from "./process-registry";
import { resolveAgyBinary } from "./agy-login";

export type AgyPlanSpawn = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; code: number }>;

/**
 * One-shot official meter. `-p` is last, as the CLI requires.
 * This is not the session stream: a stream process must not take `-p`.
 */
export const AGY_USAGE_ARGS = ["--output-format", "json", "--print-timeout", "20s", "-p", "/usage"];

function defaultSpawn(command: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: deskToolEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      ...groupSpawnOptions(),
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 25_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout: "", code: 1 });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, code: code ?? 1 });
    });
  });
}

/** Raw `/usage` stdout. Empty when the CLI is missing or the call fails. */
export async function readAgyUsageStdout(input: { command?: string; spawn?: AgyPlanSpawn } = {}): Promise<string> {
  const command = input.command ?? resolveAgyBinary() ?? "";
  if (!command) return "";
  const spawnPlan = input.spawn ?? defaultSpawn;
  try {
    const result = await spawnPlan(command, AGY_USAGE_ARGS);
    if (result.code !== 0 && !result.stdout.trim()) return "";
    return result.stdout;
  } catch {
    return "";
  }
}

/** Leftover from `agy -p /usage`. A failed parse is unknown, never 0 or 100. */
export async function readAgyPlan(input: { command?: string; spawn?: AgyPlanSpawn } = {}): Promise<GrokPlanUsage | undefined> {
  const stdout = await readAgyUsageStdout(input);
  if (!stdout.trim()) return undefined;
  return planObservedNow(parseAgyUsageCommand(stdout));
}

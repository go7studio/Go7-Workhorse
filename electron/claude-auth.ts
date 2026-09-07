import { spawn } from "node:child_process";
import fs from "node:fs";
import { deskToolEnv } from "./desk-path";
import { ptyRunner, stripTerminalCodes, wantsEnter, type PtyRunnerInput } from "./claude-pty";
import { CLAUDE_OAUTH_TOKEN_PATTERN } from "../src/lib/claude-token";

/**
 * `claude auth login` writes the shared credential store, so using it here
 * signs the person out of Claude Code itself. `claude setup-token` mints a
 * long-lived token for a second client instead, which Workhorse keeps in its
 * own vault and passes as CLAUDE_CODE_OAUTH_TOKEN. The two then coexist.
 */
export { CLAUDE_OAUTH_TOKEN_PATTERN };

/**
 * Why a sign-in did not finish. `needs_terminal` is the one the card acts on:
 * this desk cannot make a terminal, so the person runs the command in their
 * own and pastes the token back.
 */
export type SetupTokenReason = "needs_terminal" | "timed_out" | "failed";

export type SetupTokenResult = { ok: boolean; token?: string; message?: string; reason?: SetupTokenReason };

export function findClaudeOauthToken(output: string): string | null {
  const match = stripTerminalCodes(output).match(CLAUDE_OAUTH_TOKEN_PATTERN);
  return match ? match[0] : null;
}

export type SetupTokenInput = {
  cli: string;
  onOutput?: (chunk: string) => void;
  spawnFn?: typeof spawn;
  /** How long the whole flow may take, browser approval included. */
  timeoutMs?: number;
  /** How long a silent start is allowed before this is called no terminal at all. */
  quietMs?: number;
  /** Injected so tests never look at this machine for a Python. */
  pty?: PtyRunnerInput;
};

/**
 * The Claude CLI minting a fresh token needs the person's PATH, and needs to
 * be told not to open a browser. It does not need a token to make one: a
 * `CLAUDE_CODE_OAUTH_TOKEN` already on the environment would be the desk's
 * vault copy, and this flow is how that copy gets replaced.
 */
export function setupTokenEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return deskToolEnv(base, { NO_BROWSER: "" });
}

export const NEEDS_TERMINAL_MESSAGE =
  "Signing in needs a terminal this desk cannot make. Run the command below in your own terminal, then paste the token here.";

/**
 * Runs the token flow under a pseudo-terminal, streaming its output so the
 * sign-in stays visible.
 *
 * Without a terminal the CLI prints nothing whatsoever and waits, so a desk
 * that cannot make one says so at once instead of holding a spinner for five
 * minutes. A start that stays silent is treated the same way: whatever the
 * reason, there is nothing for the person to act on, and the paste path is.
 */
export function runClaudeSetupToken(input: SetupTokenInput): Promise<SetupTokenResult> {
  const spawnFn = input.spawnFn ?? spawn;
  const runner = ptyRunner([input.cli, "setup-token"], {
    existsSync: (filePath: string) => fs.existsSync(filePath),
    ...input.pty,
  });
  if (!runner) {
    return Promise.resolve({ ok: false, reason: "needs_terminal", message: NEEDS_TERMINAL_MESSAGE });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(runner.command, runner.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: setupTokenEnv(),
      });
    } catch (error) {
      resolve({ ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    let seen = "";
    let settled = false;
    let answeredPrompt = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (result: SetupTokenResult) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve(result);
    };
    const stop = (result: SetupTokenResult) => {
      try {
        child.kill();
      } catch {
        /* it may already be gone */
      }
      finish(result);
    };
    const read = (chunk: Buffer | string) => {
      const text = chunk.toString();
      seen += text;
      // The prompt only appears when the CLI could not open the browser
      // itself. Answering it here keeps the flow moving without the person
      // having to reach a terminal the desk is holding.
      if (!answeredPrompt && wantsEnter(seen)) {
        answeredPrompt = true;
        try {
          child.stdin?.write("\n");
        } catch {
          /* the child may have gone */
        }
      }
      input.onOutput?.(text);
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("error", (error: Error) => finish({ ok: false, reason: "failed", message: error.message }));
    timers.push(
      setTimeout(() => {
        if (seen.trim()) return;
        stop({ ok: false, reason: "needs_terminal", message: NEEDS_TERMINAL_MESSAGE });
      }, input.quietMs ?? 25_000),
    );
    timers.push(
      setTimeout(() => {
        stop({ ok: false, reason: "timed_out", message: "Sign-in timed out." });
      }, input.timeoutMs ?? 5 * 60_000),
    );
    child.once("exit", (code: number | null) => {
      const token = findClaudeOauthToken(seen);
      if (token) finish({ ok: true, token });
      else if (!seen.trim()) finish({ ok: false, reason: "needs_terminal", message: NEEDS_TERMINAL_MESSAGE });
      else finish({ ok: false, reason: "failed", message: `Sign-in ended without a token${code ? ` (${code})` : ""}.` });
    });
  });
}

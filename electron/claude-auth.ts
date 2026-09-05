import { spawn } from "node:child_process";
import { deskToolEnv } from "./desk-path";

/**
 * `claude auth login` writes the shared credential store, so using it here
 * signs the person out of Claude Code itself. `claude setup-token` mints a
 * long-lived token for a second client instead, which Workhorse keeps in its
 * own vault and passes as CLAUDE_CODE_OAUTH_TOKEN. The two then coexist.
 */
export const CLAUDE_OAUTH_TOKEN_PATTERN = /\bsk-ant-[A-Za-z0-9_-]{20,}\b/;

export type SetupTokenResult = { ok: boolean; token?: string; message?: string };

export function findClaudeOauthToken(output: string): string | null {
  const match = output.match(CLAUDE_OAUTH_TOKEN_PATTERN);
  return match ? match[0] : null;
}

export type SetupTokenInput = {
  cli: string;
  onOutput?: (chunk: string) => void;
  spawnFn?: typeof spawn;
  timeoutMs?: number;
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

/** Runs the token flow, streaming its output so the sign-in stays visible. */
export function runClaudeSetupToken(input: SetupTokenInput): Promise<SetupTokenResult> {
  const spawnFn = input.spawnFn ?? spawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(input.cli, ["setup-token"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: setupTokenEnv(),
      });
    } catch (error) {
      resolve({ ok: false, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    let seen = "";
    let settled = false;
    const finish = (result: SetupTokenResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const read = (chunk: Buffer | string) => {
      const text = chunk.toString();
      seen += text;
      input.onOutput?.(text);
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("error", (error: Error) => finish({ ok: false, message: error.message }));
    const timer = setTimeout(
      () => {
        child.kill();
        finish({ ok: false, message: "Sign-in timed out." });
      },
      input.timeoutMs ?? 5 * 60_000,
    );
    child.once("exit", (code: number | null) => {
      clearTimeout(timer);
      const token = findClaudeOauthToken(seen);
      if (token) finish({ ok: true, token });
      else finish({ ok: false, message: `Sign-in ended without a token${code ? ` (${code})` : ""}.` });
    });
  });
}

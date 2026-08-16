import { ClaudeSessionHost } from "../electron/claude-host";
import { detectClaudeLogin } from "../electron/claude-login";
import { CodexSessionHost } from "../electron/codex-host";
import { detectCodexLogin } from "../electron/codex-login";
import { CursorSessionHost } from "../electron/cursor-host";
import { detectCursorLogin } from "../electron/cursor-login";
import { GrokSessionHost, type GrokIpcEvent } from "../electron/grok-host";
import { detectGrokLogin } from "../electron/grok-login";

type SmokeProvider = "grok" | "codex" | "claude" | "cursor";

const provider = process.argv[2] as SmokeProvider | undefined;
if (provider !== "grok" && provider !== "codex" && provider !== "claude" && provider !== "cursor") {
  throw new Error("Choose exactly one provider: grok, codex, claude, or cursor.");
}

const detection =
  provider === "grok"
    ? detectGrokLogin()
    : provider === "codex"
      ? detectCodexLogin()
      : provider === "claude"
        ? detectClaudeLogin()
        : detectCursorLogin();
if (!detection.connected) throw new Error(`${provider} is not connected; no live call was made.`);

const model =
  provider === "grok"
    ? "grok-4.6"
    : provider === "codex"
      ? "gpt-5.6-sol"
      : provider === "claude"
        ? "opus-5"
        : "composer-2.5";
const host =
  provider === "grok"
    ? new GrokSessionHost()
    : provider === "codex"
      ? new CodexSessionHost()
      : provider === "claude"
        ? new ClaudeSessionHost()
        : new CursorSessionHost();
const events: GrokIpcEvent[] = [];
const sessionId = `smoke-${provider}-${Date.now()}`;

try {
  const result = await Promise.race([
    host.prompt(
      {
        sessionId,
        model,
        effort: "low",
        mode: "ask",
        sandbox: "read-only",
        cwd: process.cwd(),
        text: "Connectivity check only. Do not use tools or inspect files. Return exactly: ADAPTER_OK",
        mcpServers: [],
        role: "orchestrator",
      },
      (event) => events.push(event),
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${provider} adapter smoke timed out after 90 seconds`)), 90_000),
    ),
  ]);
  const text = result.text.trim();
  const exactReply = text === "ADAPTER_OK";
  const vendorSession = events.find((event) => event.type === "vendor-session");
  const usage = events.filter((event) => event.type === "usage").at(-1);
  console.log(
    JSON.stringify(
      {
        provider,
        requestedModel: model,
        connected: detection.connected,
        vendorSession: vendorSession?.type === "vendor-session" ? Boolean(vendorSession.vendorSessionId) : false,
        stopReason: result.stopReason ?? null,
        exactReply,
        replyLength: text.length,
        replyPreview: exactReply ? null : text.slice(0, 240),
        usage:
          usage?.type === "usage"
            ? { model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
            : null,
      },
      null,
      2,
    ),
  );
  if (!text) throw new Error(`${provider} returned an empty smoke reply.`);
  if (!exactReply) throw new Error(`${provider} did not follow the deterministic reply contract.`);
} finally {
  host.disposeAll();
}

// ACP children can retain transport handles briefly after disposal; this
// one-call runner has already captured its evidence and must remain bounded.
process.exit(0);

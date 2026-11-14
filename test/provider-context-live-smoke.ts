/** Opt-in only: two synthetic turns through a real Workhorse ACP host. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ClaudeSessionHost, spawnClaudeProcess } from "../electron/claude-host";
import { detectClaudeLogin } from "../electron/claude-login";
import { CodexSessionHost, spawnCodexProcess } from "../electron/codex-host";
import { detectCodexLogin } from "../electron/codex-login";
import { CursorSessionHost, spawnCursorProcess } from "../electron/cursor-host";
import { detectCursorLogin } from "../electron/cursor-login";
import { GrokSessionHost, type GrokIpcEvent } from "../electron/grok-host";
import { spawnGrokProcess } from "../electron/grok-agent";
import { detectGrokLogin } from "../electron/grok-login";
import { buildSessionPreface, buildTurnContext, type PrefaceInput } from "../src/lib/context-preface";
import { withPortableHistory } from "../src/lib/portable-history";
import { finalizeTurnUsage } from "../src/lib/usage";
import { normalizeModelId } from "../src/lib/models";
import { redactText } from "../src/lib/learning-redact";
import { groupIsAlive, PROC_KILL_GRACE_MS } from "../electron/process-registry";

const provider = process.argv[2];
if (provider !== "grok" && provider !== "codex" && provider !== "claude" && provider !== "cursor") {
  throw new Error("Choose exactly one ACP provider and model: grok, codex, claude, or cursor.");
}
const model = process.argv[3]?.trim();
if (!model) throw new Error("Pass an explicitly chosen model; this live check makes two billed turns.");
// This isolated harness never attaches the provider to an ambient live desk.
for (const name of Object.keys(process.env)) if (name.startsWith("WORKHORSE_")) delete process.env[name];
const connected = (provider === "grok" ? detectGrokLogin() : provider === "codex" ? detectCodexLogin() : provider === "claude" ? detectClaudeLogin() : detectCursorLogin()).connected;
if (!connected) throw new Error(`${provider} is not connected; no live call was made.`);

const tag = randomUUID().slice(0, 12);
const fact = `cedar-${tag}`;
const delta = `amber-${tag}`;
const sessionId = `context-smoke-${tag}`;
const cwd = mkdtempSync(path.join(tmpdir(), "workhorse-context-smoke-"));
const children: ChildProcessWithoutNullStreams[] = [];
const methods: string[] = [];
const prompts: Array<{
  utf8Bytes: number;
  utf16Units: number;
  openingIdentity: boolean;
  portableReplay: boolean;
  originalFact: boolean;
  currentDelta: boolean;
  livePolicyCopies: number;
}> = [];

/** Observe the real adapter pipe; retain counts/flags, never prompt bodies or env. */
function observe<Spec>(spawn: (spec: Spec) => ChildProcessWithoutNullStreams) {
  return (spec: Spec) => {
    const child = spawn(spec);
    children.push(child);
    const write = child.stdin.write;
    let tail = "";
    child.stdin.write = function (this: typeof child.stdin, chunk: string | Uint8Array, ...args: unknown[]) {
      tail += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const lines = tail.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        let message: { method?: string; params?: { prompt?: Array<{ text?: string }> } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.method) methods.push(message.method);
        if (message.method !== "session/prompt") continue;
        const text = (message.params?.prompt ?? []).map(block => block.text ?? "").join("\n");
        prompts.push({
          utf8Bytes: Buffer.byteLength(text), utf16Units: text.length,
          openingIdentity: text.includes("immutable Workhorse session ID"),
          portableReplay: text.includes("<workhorse-portable-history"),
          originalFact: text.includes(fact), currentDelta: text.includes(delta),
          livePolicyCopies: text.split("This chat’s live desk limits").length - 1,
        });
      }
      return Reflect.apply(write, this, [chunk, ...args]);
    } as typeof child.stdin.write;
    return child;
  };
}

const host = provider === "grok" ? new GrokSessionHost(observe(spawnGrokProcess))
  : provider === "codex" ? new CodexSessionHost(observe(spawnCodexProcess))
  : provider === "claude" ? new ClaudeSessionHost(observe(spawnClaudeProcess))
  : new CursorSessionHost(observe(spawnCursorProcess));
const base: PrefaceInput = {
  sessionId, cwd, folders: [cwd], references: [], mode: "ask", sandbox: "read-only", computer: "off",
  surface: provider === "cursor" ? "cursor" : "mcp", role: "orchestrator",
  desk: { title: "Synthetic continuation check", projectName: "Synthetic fixture", sidebar: `${provider} · low · Ask`, preview: "(empty)" },
};
const common = { sessionId, cwd, model, effort: "low" as const, mode: "ask" as const, sandbox: "read-only" as const, computer: "off" as const, mcpServers: [], role: "orchestrator" as const };
const events: GrokIpcEvent[][] = [];
let nativeSessionId: string | undefined;
let nativeArchived = false;

async function bounded<T>(call: Promise<T>, ms = 90_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([call, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { host.cancel(sessionId); reject(new Error("Workhorse context smoke timed out.")); }, ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Codex session/delete archives this exact synthetic thread, as Workhorse workers do. */
async function archiveCodexThread(child: ChildProcessWithoutNullStreams, id: string): Promise<boolean> {
  if (!child.stdin.writable || child.killed) return false;
  return new Promise(resolve => {
    const requestId = "workhorse-context-smoke-archive";
    let tail = "";
    const finish = (ok: boolean) => { clearTimeout(timer); child.stdout.off("data", onData); resolve(ok); };
    const onData = (chunk: Buffer | string) => {
      tail += String(chunk);
      const lines = tail.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: string; error?: unknown };
          if (message.id === requestId) finish(!message.error);
        } catch { /* not a JSON-RPC response */ }
      }
    };
    const timer = setTimeout(() => finish(false), 5_000);
    child.stdout.on("data", onData);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "session/delete", params: { sessionId: id } })}\n`);
  });
}

async function waitForRuntimeStop(): Promise<boolean> {
  const stopped = () => children.every(child => !child.pid ||
    ((child.exitCode !== null || child.signalCode !== null) && !groupIsAlive(child.pid)));
  const deadline = Date.now() + PROC_KILL_GRACE_MS + 3_000;
  while (!stopped() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  return stopped();
}

const receipt: Record<string, unknown> = { provider, requestedModel: model, syntheticOnly: true, passed: false };
try {
  const firstText = `Synthetic continuity check only. Do not use tools or inspect files. Remember the unique fixture fact ${fact}. Reply exactly FIRST_OK.`;
  const firstEvents: GrokIpcEvent[] = [];
  events.push(firstEvents);
  const first = await bounded(host.prompt({ ...common, text: firstText, visibleText: firstText, preface: buildSessionPreface(base), turnContext: buildTurnContext(base) }, event => {
    firstEvents.push(event);
    if (event.type === "vendor-session") nativeSessionId = event.vendorSessionId;
  }));
  nativeSessionId = first.vendorSessionId ?? nativeSessionId;
  assert.equal(first.text.trim(), "FIRST_OK", "first synthetic reply must follow the exact contract");
  assert.ok(nativeSessionId, "the Workhorse host must establish a real native session");

  const updated: PrefaceInput = { ...base, references: [{ kind: "note", label: "Delta", value: delta }], desk: { ...base.desk!, preview: "FIRST_OK" } };
  const secondText = "Synthetic continuation only. Do not use tools or inspect files. Recall the unique fixture fact from the preceding turn and read this turn's linked note named Delta. Reply only with that remembered fact, a pipe character, and the current Delta value.";
  const secondEvents: GrokIpcEvent[] = [];
  events.push(secondEvents);
  const second = await bounded(host.prompt({
    ...common, text: secondText, visibleText: firstText, vendorSessionId: nativeSessionId,
    // Deliberately include canonical history in preface, as the renderer does.
    // A warm host must send turnContext, rather than replaying this block.
    preface: withPortableHistory(buildSessionPreface(updated), [
      { id: "first-user", role: "user", text: firstText, createdAt: 1 },
      { id: "first-reply", role: "assistant", text: first.text, createdAt: 2 },
    ]),
    turnContext: buildTurnContext(updated),
  }, event => secondEvents.push(event)));
  assert.equal(second.text.trim(), `${fact}|${delta}`, "the earlier fact and current project delta must both survive");
  assert.equal(second.vendorSessionId, nativeSessionId, "the continuation must use the same native session");
  assert.equal(children.length, 1, "the host must reuse its runtime");
  assert.equal(methods.filter(method => method === "session/new").length, 1);
  assert.equal(prompts.length, 2, "exactly two live prompts are permitted");
  assert.ok(prompts[0].openingIdentity && prompts[0].originalFact);
  assert.ok(!prompts[1].openingIdentity && !prompts[1].portableReplay && !prompts[1].originalFact, "old opening context and fact must not be resent");
  assert.ok(prompts[1].currentDelta, "the current linked reference must reach the adapter");
  assert.equal(prompts[1].livePolicyCopies, 1);
  assert.ok(prompts[1].utf8Bytes < prompts[0].utf8Bytes);
  assert.ok(events.every(turn => !turn.some(event => event.type === "tool" || event.type === "permission")), "the synthetic check must not use tools or request permission");

  receipt.sameNativeSession = true;
  receipt.factRememberedWithoutReplay = true;
  receipt.currentReferenceApplied = true;
  receipt.runtimeCount = children.length;
  receipt.noToolsOrPermissions = true;
  receipt.ambientDeskBridgeExcluded = true;
  receipt.localPromptEnvelope = prompts;
  receipt.envelopeUnits = "Exact Workhorse text bytes/UTF-16 units before the native runtime; not provider token counts or billing.";
  receipt.providerUsage = events.map(turn => {
    const reports = turn.filter((event): event is Extract<GrokIpcEvent, { type: "usage" }> => event.type === "usage");
    if (!reports.length) return { state: "unknown", reports: 0 };
    assert.ok(reports.every(event => normalizeModelId(provider, event.model) === normalizeModelId(provider, model)), "usage identity must match the chosen model");
    const folded = finalizeTurnUsage(reports.map(event => ({ ...event, provider: event.provider ?? provider })));
    return { state: reports.some(event => event.source === "request" || event.source === "turn") ? "provider-reported" : "gauge-only", reports: reports.length, sources: reports.map(event => event.source ?? "untagged"), inputTokens: folded.inputTokens, outputTokens: folded.outputTokens, cacheReadTokens: folded.cacheReadTokens, cacheWriteTokens: folded.cacheWriteTokens, contextUsed: folded.contextUsed ?? null, costUsd: folded.costUsd ?? null };
  });
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.failure = error instanceof assert.AssertionError ? error.message : error instanceof Error ? redactText(error.message).text.slice(0, 400) : "The Workhorse adapter did not complete the bounded live smoke.";
  process.exitCode = 1;
} finally {
  let runtimeDisposed = false;
  let syntheticCwdRemoved = false;
  const cleanupFailure = (message: string) => { receipt.passed = false; receipt.cleanupFailure = message; process.exitCode = 1; };
  try {
    if (provider === "codex" && nativeSessionId && children[0]) {
      nativeArchived = await archiveCodexThread(children[0], nativeSessionId);
      if (!nativeArchived) cleanupFailure("The synthetic Codex thread was not archived.");
    }
  } catch {
    cleanupFailure("Synthetic native-thread archival failed.");
  } finally {
    try {
      try { host.disposeAll(); } catch { cleanupFailure("Workhorse runtime disposal failed."); }
      runtimeDisposed = await waitForRuntimeStop();
      if (!runtimeDisposed) cleanupFailure("The owned adapter process group did not terminate within the cleanup bound.");
    } finally {
      try { rmSync(cwd, { recursive: true, force: true }); syntheticCwdRemoved = true; }
      catch { cleanupFailure("The synthetic workspace could not be removed."); }
    }
  }
  receipt.localPromptEnvelope = prompts;
  receipt.promptCount = prompts.length;
  receipt.cleanup = { nativeThreadArchived: provider === "codex" ? nativeArchived : "unsupported", runtimeDisposed, syntheticCwdRemoved, ownedRuntimePids: children.map(child => child.pid).filter(Boolean) };
  console.log(JSON.stringify(receipt, null, 2));
}

// Bounded disposal above lets the group's delayed SIGKILL run before exiting.
process.exit(process.exitCode ?? 0);

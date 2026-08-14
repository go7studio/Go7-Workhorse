import { runGrokOneShot } from "../electron/grok-agent";

const cwd = process.cwd();
const result = await runGrokOneShot({
  model: process.env.GROK_LIVE_MODEL || "grok-4.6",
  effort: "low",
  cwd,
  mode: "always-approve",
  prompt: "Reply with the single word pong and nothing else.",
});

const report = {
  command: result.spec.command,
  argv: result.spec.argv,
  cwd: result.spec.cwd,
  model: result.spec.model,
  effort: result.spec.effort,
  initializeOk: Boolean(result.initialize && (result.initialize.protocolVersion === 1 || result.initialize.agentCapabilities)),
  sessionNewOk: Boolean(result.sessionId),
  sessionId: result.sessionId,
  stopReason: result.stopReason ?? null,
  text: result.text,
  textLength: result.text.length,
  usage: result.usage ?? null,
};

console.log(JSON.stringify(report, null, 2));

if (!report.initializeOk) {
  throw new Error("initialize did not succeed");
}
if (!report.sessionNewOk) {
  throw new Error("session/new did not succeed");
}
if (!report.text.trim()) {
  throw new Error("one-shot prompt returned empty agent text");
}

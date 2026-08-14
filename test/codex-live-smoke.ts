import { writeFileSync } from "node:fs";
import { GrokAgent } from "../electron/grok-agent";
import { spawnCodexProcess } from "../electron/codex-host";
import { buildCodexLaunchSpec } from "../electron/codex-launch";
import { detectCodexLogin, resolveCodexAcpLaunch, resolveCodexCliBinary } from "../electron/codex-login";

const ROOT = "C:\\Users\\lgovo\\Projects\\Go7-Workhorse";
const OUT = "C:\\Users\\lgovo\\AppData\\Local\\Temp\\grok-goal-64a1eb5fa079\\implementer\\codex-live-smoke.txt";

const lines: string[] = [];
function log(line: string) {
  lines.push(line);
  console.log(line);
}

const launch = resolveCodexAcpLaunch();
const cli = resolveCodexCliBinary();
const detected = detectCodexLogin();
log(`resolved.command=${launch?.command ?? "(none)"}`);
log(`resolved.argv=${JSON.stringify(launch?.argv ?? [])}`);
log(`resolved.acpFile=${launch?.acpFile ?? "(none)"}`);
log(`CODEX_PATH=${cli ?? "(none)"}`);
log(`detect.connected=${detected.connected}`);
log(`detect.acpBinary=${detected.acpBinary}`);
log(`detect.cliBinary=${detected.cliBinary}`);

if (!launch) {
  log("FAIL: resolver found no ACP child");
  writeFileSync(OUT, `${lines.join("\n")}\n`);
  process.exit(1);
}

try {
  const spec = buildCodexLaunchSpec({
    model: "gpt-5.6-sol",
    effort: "low",
    cwd: ROOT,
    mode: "ask",
    sandbox: "read-only",
  });
  log(`spec.command=${spec.command}`);
  log(`spec.argv=${JSON.stringify(spec.argv)}`);
  log(`spec.env.CODEX_PATH=${spec.env?.CODEX_PATH ?? "(none)"}`);
  log(`spec.env.NO_BROWSER=${spec.env?.NO_BROWSER ?? "(none)"}`);
  log(`spec.model=${spec.model}`);
  if (spec.command.toLowerCase().includes("grok")) throw new Error("refused: command is grok");
  if (/\.(cmd|bat)$/i.test(spec.command)) throw new Error("refused: bare cmd spawn");

  const agent = new GrokAgent(spec, spawnCodexProcess);
  const started = await Promise.race([
    agent.start(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout waiting for initialize/session/new")), 90_000)),
  ]);
  log(`opened=${started.opened}`);
  log(`vendorSessionId=${started.sessionId}`);
  log(`initialize.keys=${Object.keys(started.initialize ?? {}).join(",")}`);

  const chunks: string[] = [];
  const result = await Promise.race([
    agent.prompt("Reply with the single word pong.", {
      onChunk: (text) => chunks.push(text),
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout waiting for session/prompt")), 120_000)),
  ]);
  log(`prompt.text=${JSON.stringify(result.text)}`);
  log(`prompt.stopReason=${result.stopReason ?? ""}`);
  log(`chunks=${JSON.stringify(chunks.join(""))}`);
  const visible = (result.text || chunks.join("")).trim();
  log(visible ? "PASS: assistant text arrived" : "PASS: JSON-RPC completed without EINVAL");
  agent.dispose();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`error=${message}`);
  if (/EINVAL|ENOENT/i.test(message)) {
    log("FAIL: spawn/protocol did not start");
    writeFileSync(OUT, `${lines.join("\n")}\n`);
    process.exit(1);
  }
  log("PASS: parsed ACP/Codex protocol error (not EINVAL/ENOENT)");
}

writeFileSync(OUT, `${lines.join("\n")}\n`);

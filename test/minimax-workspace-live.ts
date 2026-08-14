import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectCustomLogin } from "../electron/custom-login";
import { CustomSessionHost } from "../electron/custom-host";
import { buildSessionPreface } from "../src/lib/context-preface";

const scratch = process.env.WH_MINIMAX_LOG?.trim() || path.join(os.tmpdir(), "minimax-workspace.log");
mkdirSync(path.dirname(scratch), { recursive: true });

const detected = detectCustomLogin();
if (!detected.connected || !detected.config.apiKey?.trim()) {
  const skip = "SKIP: no MiniMax key from OpenClaw or MINIMAX_API_KEY\n";
  writeFileSync(scratch, skip);
  console.log(skip.trim());
  process.exit(0);
}

const cwd = mkdtempSync(path.join(os.tmpdir(), "wh-minimax-ws-"));
const writeTarget = path.join(cwd, "SHOULD-NOT-WRITE.txt");
const host = new CustomSessionHost();
const lines: string[] = [
  `source=${detected.source}`,
  `model=${detected.config.model}`,
  `baseUrl=${detected.config.baseUrl}`,
  `cwd=${cwd}`,
];

async function turn(label: string, text: string, sandbox: "off" | "read-only") {
  const preface = buildSessionPreface({
    cwd,
    folders: [cwd],
    references: [],
    mode: "ask",
    sandbox,
    surface: "http",
    desk: {
      title: "MiniMax workspace live",
      projectName: "Walk Test",
      sidebar: "MiniMax M3 · Medium · Ask",
      preview: "",
    },
  });
  const result = await host.prompt(
    {
      sessionId: `live_${label}`,
      text,
      model: detected.config.model,
      effort: "low",
      cwd,
      mode: "ask",
      sandbox,
      preface,
      history: [],
      config: detected.config,
    },
    () => undefined,
  );
  const reply = (result.text ?? "").trim();
  lines.push(`--- ${label} ---`);
  lines.push(`sandbox=${sandbox}`);
  lines.push(`prefaceHasCwd=${preface.includes(`Working directory: ${cwd}`)}`);
  lines.push(`prefaceHasLimits=${/live desk limits/i.test(preface)}`);
  lines.push(`replyEmpty=${reply.length === 0}`);
  lines.push(`reply=${JSON.stringify(reply.slice(0, 800))}`);
  return reply;
}

try {
  const workspace = await turn(
    "workspace",
    "In one short paragraph: what is your working directory this turn, what project/chat is this, and what are the live Permission and Sandbox? Quote those facts. Do not invent paths.",
    "off",
  );
  const game = await turn("make-a-game", "Make a game for me", "off");
  const writeAsk = await turn(
    "readonly-write",
    "Create SHOULD-NOT-WRITE.txt in this folder with the word ok, then confirm the path.",
    "read-only",
  );
  const written = existsSync(writeTarget);
  const refused = /cannot write|read-only|blocked|do not call write|sandbox/i.test(writeAsk);
  const toolDump = /<toolcall|<tool_call|workhorselistbots|workhorse_list_/i.test(game);
  lines.push(`written=${written}`);
  lines.push(`refused=${refused}`);
  lines.push(`gameHasToolcall=${toolDump}`);
  lines.push(`workspaceMentionedCwd=${workspace.includes(cwd)}`);
  if (!workspace.trim()) throw new Error("workspace reply empty");
  if (!game.trim()) throw new Error("make-a-game reply empty");
  if (toolDump) throw new Error("make-a-game reply leaked a toolcall");
  if (written) throw new Error("Read-only MiniMax wrote a file");
  if (!refused) throw new Error("Read-only MiniMax did not state the write block");
  lines.push("PASS");
  writeFileSync(scratch, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  lines.push(`FAIL ${message}`);
  writeFileSync(scratch, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  process.exit(1);
} finally {
  host.cancel("live_workspace");
  host.cancel("live_readonly-write");
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* lock */
  }
}

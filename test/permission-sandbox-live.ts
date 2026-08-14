import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GrokSessionHost, type GrokIpcEvent } from "../electron/grok-host";
import type { PermissionMode, SandboxProfile } from "../src/lib/types";
import { permissionPolicyAnswer } from "../src/lib/permissions";

type Case = {
  name: string;
  mode: PermissionMode;
  sandbox: SandboxProfile;
  file: string;
  expectFile: boolean;
  expectPermission: boolean;
};

const only = (process.env.WH_PERM_ONLY ?? "").trim().toLowerCase();
const cases: Case[] = [
  { name: "always-approve writes", mode: "always-approve", sandbox: "off", file: "ALWAYS.txt", expectFile: true, expectPermission: false },
  { name: "ask pauses for write", mode: "ask", sandbox: "off", file: "ASK.txt", expectFile: false, expectPermission: true },
  { name: "accept-edits writes without ask", mode: "accept-edits", sandbox: "off", file: "EDITS.txt", expectFile: true, expectPermission: false },
  { name: "plan blocks project writes", mode: "plan", sandbox: "off", file: "PLAN.txt", expectFile: false, expectPermission: false },
  { name: "read-only blocks writes", mode: "always-approve", sandbox: "read-only", file: "READONLY.txt", expectFile: false, expectPermission: false },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCase(item: Case): Promise<string> {
  const cwd = mkdtempSync(path.join(os.tmpdir(), `wh-perm-${item.name.replace(/\s+/g, "-")}-`));
  const host = new GrokSessionHost();
  const events: GrokIpcEvent[] = [];
  const target = path.join(cwd, item.file);
  if (item.mode === "accept-edits") writeFileSync(target, "old\n");
  let asked = false;
  const asks: string[] = [];
  try {
    const work = host.prompt(
      {
        sessionId: `live_${item.file}`,
        model: process.env.GROK_LIVE_MODEL || "grok-4.6",
        effort: "low",
        mode: item.mode,
        sandbox: item.sandbox,
        cwd,
        text:
          item.mode === "accept-edits"
            ? `Replace the contents of ${item.file} with the single word ok using a file edit tool. Do not run a shell. Then stop.`
            : `Create ${item.file} in this folder with the single word ok. Do not run a shell. Use a file write tool. Then stop.`,
      },
      (event) => {
        events.push(event);
        if (event.type !== "permission") return;
        const title = `${event.tool} ${event.detail}`.toLowerCase();
        if (item.mode === "plan" && /exit_plan|enter_plan/.test(title)) {
          host.answerPermission(event.requestId, "once");
          return;
        }
        const forced = permissionPolicyAnswer({
          mode: item.mode,
          sandbox: item.sandbox,
          tool: event.tool,
          detail: event.detail,
          path: event.path,
        });
        if (forced) {
          host.answerPermission(event.requestId, forced);
          if (forced === "deny" && !item.expectFile) host.cancel(`live_${item.file}`);
          return;
        }
        asked = true;
        asks.push(`${event.tool} — ${event.detail}`);
        const answer = item.expectFile ? "once" : "deny";
        host.answerPermission(event.requestId, answer);
        if (!item.expectFile) host.cancel(`live_${item.file}`);
      },
    );
    await Promise.race([work.catch(() => undefined), sleep(item.expectFile ? 90_000 : 35_000)]);
    host.cancel(`live_${item.file}`);
    await sleep(300);
    const written = existsSync(target);
    const body = written ? readFileSync(target, "utf8").trim() : "";
    if (item.expectPermission && !asked) throw new Error("expected a permission prompt");
    if (!item.expectPermission && asked && item.expectFile) {
      throw new Error(`unexpected permission prompt (${asks.join("; ")})`);
    }
    if (item.expectFile && !written) throw new Error(`expected ${item.file} (${events.find((event) => event.type === "error") && "error" || "no file"})`);
    if (!item.expectFile && written) throw new Error(`${item.file} was written (${body})`);
    return `${item.name}: ok asked=${asked} written=${written}`;
  } finally {
    host.disposeAll();
    await sleep(400);
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // grok may still hold the sandbox cwd on Windows
    }
  }
}

const reports: string[] = [];
const failures: string[] = [];
const selected = only ? cases.filter((item) => item.name.toLowerCase().includes(only)) : cases;
for (const item of selected) {
  try {
    reports.push(await runCase(item));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reports.push(`${item.name}: FAIL ${message}`);
    failures.push(`${item.name}: ${message}`);
  }
}
console.log(reports.join("\n"));
if (failures.length) throw new Error(failures.join("\n"));

/**
 * Opt-in Workhorse-shaped Cursor discussion. Not part of `npm test`.
 *
 *   npm run eval:skill-radar
 *
 * Skips (`not_run`) when Cursor ACP is disconnected. Scores radar plus
 * list/read skill tools against eval/fixtures/skills.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CursorSessionHost } from "../electron/cursor-host";
import { detectCursorLogin } from "../electron/cursor-login";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import {
  catalogLeakySkills,
  loadSkillDiscussionSuite,
  prepareSkillDiscussionTurn,
  scoreSkillDiscussionTurn,
  type SkillDiscussionBeat,
} from "../src/lib/skill-discussion";
import { skillsForAutoLoad } from "../src/lib/skills-catalog";
import { publicSkillCard } from "../src/lib/skills-catalog";
import { readFileSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.includes("--fixture-mcp")) {
  await runFixtureMcp();
} else {
  await runDiscussion();
}

async function runDiscussion(): Promise<void> {
  const detection = detectCursorLogin();
  if (!detection.connected) {
    console.log(JSON.stringify({ status: "not_run", reason: "Cursor ACP is not connected" }, null, 2));
    return;
  }

  const suite = loadSkillDiscussionSuite(ROOT);
  const skills = catalogLeakySkills(ROOT);
  const policy = DEFAULT_SETTINGS.skills;
  const auto = skillsForAutoLoad(skills, policy);
  const cardsDir = mkdtempSync(path.join(os.tmpdir(), "workhorse-skill-cards-"));
  const cardsPath = path.join(cardsDir, "cards.json");
  const filesPath = path.join(cardsDir, "files.json");
  const files: Record<string, string> = {};
  for (const skill of auto) {
    try {
      files[skill.name] = readFileSync(skill.skillFile, "utf8");
    } catch {
      files[skill.name] = "";
    }
  }
  writeFileSync(cardsPath, JSON.stringify(auto.map(publicSkillCard)), "utf8");
  writeFileSync(filesPath, JSON.stringify(files), "utf8");

  const cwd = mkdtempSync(path.join(os.tmpdir(), "workhorse-skill-discussion-"));
  const host = new CursorSessionHost();
  const results: unknown[] = [];
  let failed = 0;
  try {
    for (const beat of suite.beats) {
      const turn = prepareSkillDiscussionTurn(beat.prompt, skills, policy);
      const live = await promptCursor(host, beat, turn.vendorText, cwd, cardsPath, filesPath);
      const score = scoreSkillDiscussionTurn({
        beat,
        radarNames: turn.radarNames,
        tools: live.tools,
        reply: live.reply,
      });
      if (!score.ok) failed += 1;
      results.push({
        id: beat.id,
        kind: beat.kind,
        radarNames: turn.radarNames,
        tools: live.tools,
        reply: live.reply.slice(0, 1200),
        score,
        error: live.error,
      });
      host.dispose(live.sessionId);
    }
  } finally {
    host.disposeAll();
    rmSync(cardsDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }

  const report = { status: failed === 0 ? "pass" : "fail", failed, results };
  console.log(JSON.stringify(report, null, 2));
  if (failed > 0) process.exitCode = 1;
}

async function promptCursor(
  host: CursorSessionHost,
  beat: SkillDiscussionBeat,
  text: string,
  cwd: string,
  cardsPath: string,
  filesPath: string,
): Promise<{ sessionId: string; reply: string; tools: Array<{ title: string; detail: string }>; error?: string }> {
  const sessionId = `skill-discussion-${beat.id}-${Date.now()}`;
  const tools: Array<{ title: string; detail: string }> = [];
  let reply = "";
  try {
    const result = await Promise.race([
      host.prompt(
        {
          sessionId,
          model: "composer-2.5",
          effort: "low",
          mode: "always-approve",
          sandbox: "read-only",
          cwd,
          role: "orchestrator",
          text: [
            "Skill-routing check only. Do not search, grep, or edit files.",
            "You may call workhorse_list_skills or workhorse_read_skill only if this request is that installed workflow.",
            "Then answer in at most three sentences and stop.",
            "",
            text,
          ].join("\n"),
          mcpServers: [
            {
              name: "workhorse",
              command: process.execPath,
              args: [...process.execArgv, fileURLToPath(import.meta.url), "--fixture-mcp"],
              env: {
                WORKHORSE_SKILL_CARDS: cardsPath,
                WORKHORSE_SKILL_FILES: filesPath,
              },
            },
          ],
        },
        (event) => {
          if (event.type === "chunk" && event.text) reply += event.text;
          if (event.type === "tool") tools.push({ title: event.title ?? "", detail: event.detail ?? "" });
        },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${beat.id} timed out after 45 seconds`)), 45_000),
      ),
    ]);
    if (result.text.trim()) reply = result.text;
    return { sessionId, reply, tools };
  } catch (error) {
    host.cancel(sessionId);
    return { sessionId, reply, tools, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runFixtureMcp(): Promise<void> {
  const { consumeMcpBuffers, encodeMcpFrame } = await import("../electron/workhorse-mcp.ts");
  const cards = JSON.parse(readFileSync(process.env.WORKHORSE_SKILL_CARDS ?? "", "utf8")) as Array<{
    name: string;
    origin: string;
    description: string;
  }>;
  const files = JSON.parse(readFileSync(process.env.WORKHORSE_SKILL_FILES ?? "", "utf8")) as Record<string, string>;
  const tools = [
    {
      name: "workhorse_list_skills",
      description: "List desk skills. Call when the request is an installed workflow. Do not list skills for generic chat.",
      inputSchema: { type: "object", properties: { origin: { type: "string" } } },
    },
    {
      name: "workhorse_read_skill",
      description: "Read one SKILL.md by name when the request is that workflow.",
      inputSchema: { type: "object", properties: { skill: { type: "string" } }, required: ["skill"] },
    },
  ];

  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")]);
    const parsed = consumeMcpBuffers(buffer);
    buffer = parsed.rest;
    for (const frame of parsed.frames) {
      const message = frame.message;
      if (message.id === undefined) continue;
      if (message.method === "initialize") {
        process.stdout.write(
          encodeMcpFrame(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "workhorse-skill-fixture", version: "1" },
              },
            },
            frame.framing,
          ),
        );
        continue;
      }
      if (message.method === "tools/list") {
        process.stdout.write(encodeMcpFrame({ jsonrpc: "2.0", id: message.id, result: { tools } }, frame.framing));
        continue;
      }
      if (message.method === "tools/call") {
        const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, string> };
        const name = params.name ?? "";
        const origin = params.arguments?.origin?.trim().toLowerCase() ?? "";
        let text = "";
        if (name === "workhorse_list_skills") {
          const rows = origin ? cards.filter((row) => row.origin === origin) : cards;
          text = JSON.stringify(rows, null, 2);
        } else if (name === "workhorse_read_skill") {
          const query = params.arguments?.skill ?? "";
          const key = query.includes(":") ? query.slice(query.indexOf(":") + 1) : query;
          const body = files[key] ?? files[query] ?? "";
          text = JSON.stringify({ skill: query, text: body }, null, 2);
        } else {
          text = JSON.stringify({ error: `unknown tool ${name}` });
        }
        process.stdout.write(
          encodeMcpFrame(
            { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } },
            frame.framing,
          ),
        );
      }
    }
  });
  process.stdin.resume();
}

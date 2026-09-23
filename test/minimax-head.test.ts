import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { CustomSessionHost } from "../electron/custom-host";
import { buildOpenAiBody } from "../electron/custom-http";
import type { CustomToolUse } from "../electron/custom-tools";

/**
 * MiniMax M3 as the head of an Orchestrate chat, through the MiniMax preset
 * (OpenAI-compatible). The model is a script: it searches the desk with
 * workhorse_find_bots, then starts one worker per squad row in a single wave.
 * The request bodies are the ones the preset would send.
 */
test("a MiniMax head searches the desk, then staffs a squad from its picks in one wave", async () => {
  const sentTools: string[][] = [];
  const ran: CustomToolUse[] = [];
  const squad = [
    { provider: "codex", model: "gpt-5.6-sol" },
    { provider: "claude", model: "claude-opus-5" },
  ];
  let turns = 0;
  const host = new CustomSessionHost(
    async (config, input) => {
      turns += 1;
      const body = buildOpenAiBody({
        model: config.model,
        messages: input.messages,
        preface: input.preface,
        effort: input.effort,
        tools: input.tools,
        role: input.role,
      });
      sentTools.push((body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name));
      if (turns === 1) {
        return {
          text: "",
          toolUses: [{ id: "find-1", name: "workhorse_find_bots", input: { task: "Build the bot scores pane", squad: 2 } }],
        };
      }
      if (turns === 2) {
        return {
          text: "Two workers are on it.",
          toolUses: squad.map((row, index) => ({
            id: `spawn-${index + 1}`,
            name: "workhorse_spawn_agent",
            input: { prompt: `Slice ${index + 1}`, provider: row.provider, model: row.model, wait: false },
          })),
        };
      }
      return { text: "a third turn means the wave did not end the turn" };
    },
    {
      executeTool: async (use) => {
        ran.push(use);
        if (use.name === "workhorse_find_bots") {
          return { id: use.id, name: use.name, content: JSON.stringify({ domain: "coding", squad }) };
        }
        return { id: use.id, name: use.name, content: JSON.stringify({ started: true, childSessionId: `sess_${use.id}` }) };
      },
    },
  );
  const reply = await host.prompt(
    {
      sessionId: "s-head",
      text: "Build the bot scores pane. Staff it with a squad.",
      model: "MiniMax-M3",
      effort: "medium",
      cwd: os.tmpdir(),
      mode: "always-approve",
      sandbox: "off",
      history: [],
      role: "orchestrator",
      crewModes: ["orchestrate"],
      config: { baseUrl: "https://api.minimax.io/v1", apiKey: "sk-cp-test", model: "MiniMax-M3", api: "openai-completions" },
    },
    () => undefined,
  );
  assert.equal(turns, 2, "search, then one wave; the wave ends the turn");
  assert.ok(sentTools[0]!.includes("workhorse_find_bots"), "the head is offered the desk search");
  assert.ok(sentTools[0]!.includes("workhorse_spawn_agent"));
  assert.ok(sentTools[0]!.includes("workhorse_continue_mission"));
  assert.deepEqual(
    ran.map((use) => use.name),
    ["workhorse_find_bots", "workhorse_spawn_agent", "workhorse_spawn_agent"],
  );
  assert.deepEqual(
    ran.slice(1).map((use) => `${use.input.provider}/${use.input.model}`),
    ["codex/gpt-5.6-sol", "claude/claude-opus-5"],
  );
  assert.equal(reply.stopReason, "end_turn");
  assert.match(reply.text ?? "", /Two workers are on it/);
});

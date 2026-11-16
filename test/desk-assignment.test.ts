import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assignmentTurnIsWork,
  deskAssignRequest,
  deskLeadPrompt,
  deskStartedNote,
  fillSpawnAssignment,
  planDeskAssignment,
  withLoadedSkills,
} from "../src/lib/desk-assignment";
import { restrictMcpServersToTools } from "../src/lib/mcp-servers";
import type { DeskSkill, McpServerConfig } from "../src/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");

const PLAYTEST: DeskSkill = {
  name: "roblox-playtest",
  description: "Walk a Roblox place in Studio and run the smoke test.",
  origin: "grok",
  dir: "C:\\skills\\roblox-playtest",
  skillFile: "C:\\skills\\roblox-playtest\\SKILL.md",
  managed: false,
  source: "home",
};

const PDF: DeskSkill = {
  name: "pdf",
  description: "Read and write PDF files.",
  origin: "grok",
  dir: "C:\\skills\\pdf",
  skillFile: "C:\\skills\\pdf\\SKILL.md",
  managed: false,
  source: "home",
};

const PICK = { provider: "grok", model: "grok-4.7", label: "Grok 4.7" };

test("an Orchestrate turn staffs the ranked worker and the matched skill", () => {
  const task = "Playtest the Roblox place and run the smoke test before we ship.";
  const plan = planDeskAssignment({
    task,
    crewModes: ["orchestrate"],
    role: "orchestrator",
    skills: [PLAYTEST, PDF],
    picks: [PICK],
    servers: [{ name: "lovart", tools: ["lovart_query_mode", "lovart_generate"] }, { name: "github", tools: ["create_issue"] }],
  });
  assert.equal(plan?.mustStaff, true);
  assert.equal(plan?.worker?.model, "grok-4.7");
  assert.deepEqual(plan?.skills.map((skill) => skill.name), ["roblox-playtest"]);
  assert.equal(plan?.tools.includes("lovart_generate"), false);
  const request = deskAssignRequest(plan!, "sess_parent", task);
  assert.equal(request?.provider, "grok");
  assert.equal(request?.model, "grok-4.7");
  assert.deepEqual(request?.skills, ["grok:roblox-playtest"]);
  assert.match(deskStartedNote(plan!), /Grok 4\.7/);
  assert.match(deskStartedNote(plan!), /roblox-playtest/);
});

test("Mission, a short thanks, and a worker chat do not take the slice away", () => {
  const task = "Playtest the Roblox place and run the smoke test.";
  assert.equal(planDeskAssignment({
    task,
    crewModes: ["mission"],
    skills: [PLAYTEST],
    picks: [PICK],
  })?.mustStaff, false);
  assert.equal(planDeskAssignment({
    task: "thanks",
    crewModes: ["orchestrate"],
    skills: [PLAYTEST],
    picks: [PICK],
  }), null);
  assert.equal(assignmentTurnIsWork("what does the preview say?"), false);
  assert.equal(planDeskAssignment({
    task,
    crewModes: ["orchestrate"],
    role: "worker",
    skills: [PLAYTEST],
    picks: [PICK],
  }), null);
});

test("a spawn that omits the skill and the tools receives the desk's choice", () => {
  const plan = planDeskAssignment({
    task: "Use lovart_query_mode and playtest the Roblox place thoroughly.",
    crewModes: ["orchestrate"],
    skills: [PLAYTEST],
    picks: [PICK],
    servers: [{ name: "lovart", tools: ["lovart_query_mode", "lovart_generate"] }],
  });
  const filled = fillSpawnAssignment({ skills: [], tools: [] }, plan);
  assert.deepEqual(filled.skills, ["grok:roblox-playtest"]);
  assert.deepEqual(filled.skillFiles, [PLAYTEST.skillFile]);
  assert.ok(filled.tools.includes("lovart"));
  assert.ok(filled.tools.includes("lovart_query_mode"));
  const kept = fillSpawnAssignment({ skills: ["grok:pdf"], tools: ["create_issue"] }, plan);
  assert.deepEqual(kept.skills, ["grok:pdf"]);
  assert.deepEqual(kept.tools, ["create_issue"]);
  assert.match(deskLeadPrompt(plan!), /provider grok/);
  assert.match(deskLeadPrompt(plan!), /model grok-4\.7/);
  assert.match(deskLeadPrompt(plan!), /Do not do the slice yourself/);
});

test("the worker prompt contains the skill text", () => {
  const brief = withLoadedSkills("ROLE: worker\nTASK:\nPlaytest.", [
    { name: "grok:roblox-playtest", body: "---\nname: roblox-playtest\n---\nWalk the place before you change it.\n" },
  ]);
  assert.match(brief, /The desk loaded these skills/);
  assert.match(brief, /Walk the place before you change it/);
  assert.doesNotMatch(brief, /name: roblox-playtest/);
  const strict = "Return only TASK's exact structured output.";
  assert.equal(withLoadedSkills(strict, [{ name: "pdf", body: "Do not add this." }]), strict);
});

test("custom HTTP workers keep only the named tools", () => {
  const servers: McpServerConfig[] = [
    { name: "lovart", command: "py", args: [], includeTools: ["lovart_query_mode", "lovart_generate"] },
    { name: "github", command: "gh", args: [] },
  ];
  const narrowed = restrictMcpServersToTools(servers, ["lovart_query_mode"], "custom");
  assert.deepEqual(narrowed.map((server) => server.name), ["lovart"]);
  assert.deepEqual(narrowed[0]?.includeTools, ["lovart_query_mode"]);
  assert.equal(restrictMcpServersToTools(servers, ["lovart_query_mode"], "grok").length, 2);
  assert.equal(restrictMcpServersToTools(servers, [], "custom").length, 2);
  assert.equal(restrictMcpServersToTools(servers, ["missing_tool"], "custom").length, 2);
});

test("the send path starts the desk assignment instead of leaving it to the model", () => {
  const store = fs.readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /planDeskAssignment\(/);
  assert.match(store, /deskAssignRequest\(/);
  assert.match(store, /window\.workhorse\?\.deskAssign/);
  assert.match(store, /fillSpawnAssignment\(/);
  assert.match(store, /withLoadedSkills\(/);
  const main = fs.readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /ipcMain\.handle\("desk:assign"/);
  assert.match(main, /mode: "spawn"/);
  assert.match(main, /wait: false/);
});

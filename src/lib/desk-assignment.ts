import type { CrewMode, DeskSkill } from "./types";
import { suggestDeskSkills } from "./skill-suggestions";
import { skillBodyFromMarkdown } from "./skills-catalog";
import {
  looksLikeGoalCommand,
  looksLikePermissionQuestion,
  looksLikePreviewQuestion,
  looksLikeWorkerBrief,
  normalizeCrewModes,
  type DeskRole,
} from "./workhorse-rules";

/**
 * The desk's assignment for one turn.
 *
 * Orchestrate used to hand the model a hint and hope it spawned. This record
 * is the decision: who works, which installed skill applies, and which tools
 * the slice named. The send path starts that worker. A later spawn that omits
 * the skill or the tool list is filled from the same record.
 */
export type DeskAssignmentPick = {
  provider: string;
  model: string;
  label: string;
  bot?: string;
};

export type DeskToolServer = {
  name: string;
  tools?: readonly string[];
};

export type AssignedSkill = {
  origin: DeskSkill["origin"];
  name: string;
  file: string;
};

export type DeskAssignment = {
  /** Orchestrate already chose a worker. The head must not do the slice. */
  mustStaff: boolean;
  worker?: DeskAssignmentPick;
  skills: AssignedSkill[];
  /** Tool names the slice named. Empty means the desk did not narrow tools. */
  tools: string[];
  /** Server names the slice named. */
  servers: string[];
};

export type DeskAssignRequest = {
  fromSessionId: string;
  message: string;
  provider: string;
  model: string;
  description: string;
  skills: string[];
  tools: string[];
};

const SKILL_BODY_CAP = 6_000;

export function assignmentTurnIsWork(text: string): boolean {
  const value = text.trim();
  if (value.length < 12 || value.startsWith("/")) return false;
  if (looksLikeWorkerBrief(value) || looksLikeGoalCommand(value)) return false;
  const question = /\?/.test(value) || /^(what|which|who)\b/i.test(value);
  if (question && (looksLikePreviewQuestion(value) || looksLikePermissionQuestion(value))) return false;
  if (/^(thanks|thank you|ok|okay|yes|no|stop|cancel|hello|hi)\b/i.test(value) && value.length < 48) return false;
  return true;
}

export function toolsForSlice(
  task: string,
  skills: readonly Pick<DeskSkill, "name" | "description">[],
  servers: readonly DeskToolServer[] = [],
): { tools: string[]; servers: string[] } {
  const hay = `${task}\n${skills.map((skill) => `${skill.name} ${skill.description}`).join("\n")}`.toLowerCase();
  const tools: string[] = [];
  const named: string[] = [];
  for (const server of servers) {
    const name = server.name.trim();
    if (!name) continue;
    if (hay.includes(name.toLowerCase())) named.push(name);
    for (const tool of server.tools ?? []) {
      const trimmed = tool.trim();
      if (trimmed && hay.includes(trimmed.toLowerCase())) tools.push(trimmed);
    }
  }
  return { tools: [...new Set(tools)], servers: [...new Set(named)] };
}

export function planDeskAssignment(input: {
  task: string;
  crewModes?: CrewMode | CrewMode[] | readonly string[] | null;
  role?: DeskRole;
  skills?: readonly DeskSkill[];
  picks?: readonly DeskAssignmentPick[];
  servers?: readonly DeskToolServer[];
  suggestFromWording?: boolean;
}): DeskAssignment | null {
  const task = input.task.trim();
  if (!task) return null;
  const role = input.role ?? "orchestrator";
  const blocked = role === "worker" || role === "auditor" || role === "helper";
  const catalog = input.suggestFromWording === false ? [] : [...(input.skills ?? [])];
  const matched = blocked ? [] : suggestDeskSkills(catalog, task, 2);
  const slice = toolsForSlice(task, matched, input.servers ?? []);
  const worker = input.picks?.find((pick) => pick.provider.trim() && pick.model.trim());
  const orchestrate = normalizeCrewModes(input.crewModes).includes("orchestrate");
  const mustStaff = orchestrate && !blocked && assignmentTurnIsWork(task) && Boolean(worker);
  if (!mustStaff && matched.length === 0 && slice.tools.length === 0 && slice.servers.length === 0) return null;
  return {
    mustStaff,
    ...(worker ? { worker } : {}),
    skills: matched.map((skill) => ({ origin: skill.origin, name: skill.name, file: skill.skillFile })),
    tools: slice.tools,
    servers: slice.servers,
  };
}

/** A spawn that forgot the skill or the tool list still receives the desk's choice. */
export function fillSpawnAssignment(
  current: { skills: readonly string[]; tools: readonly string[] },
  plan: Pick<DeskAssignment, "skills" | "tools" | "servers"> | null,
): { skills: string[]; skillFiles: string[]; tools: string[] } {
  const namedSkills = current.skills.map((skill) => skill.trim()).filter(Boolean);
  const namedTools = current.tools.map((tool) => tool.trim()).filter(Boolean);
  if (!plan) return { skills: namedSkills, skillFiles: [], tools: namedTools };
  const skills = namedSkills.length > 0 ? namedSkills : plan.skills.map((skill) => `${skill.origin}:${skill.name}`);
  const skillFiles = namedSkills.length > 0 ? [] : plan.skills.map((skill) => skill.file);
  const tools = namedTools.length > 0 ? namedTools : [...new Set([...plan.servers, ...plan.tools])];
  return { skills, skillFiles, tools };
}

export function deskAssignRequest(
  assignment: DeskAssignment,
  fromSessionId: string,
  message: string,
): DeskAssignRequest | null {
  const from = fromSessionId.trim();
  const task = message.trim();
  if (!assignment.mustStaff || !assignment.worker || !from || !task) return null;
  return {
    fromSessionId: from,
    message: task,
    provider: assignment.worker.provider,
    model: assignment.worker.model,
    description: task.slice(0, 80),
    skills: assignment.skills.map((skill) => `${skill.origin}:${skill.name}`),
    tools: [...new Set([...assignment.servers, ...assignment.tools])],
  };
}

/** What the head is told when the desk could not start the worker itself. */
export function deskLeadPrompt(assignment: DeskAssignment, task = ""): string {
  const worker = assignment.worker;
  const who = worker ? `${worker.label} (${worker.provider} / ${worker.model})` : "the ranked worker";
  const skills = assignment.skills.length
    ? assignment.skills.map((skill) => `${skill.origin}:${skill.name}`).join(", ")
    : "none matched";
  const tools = [...assignment.servers, ...assignment.tools];
  const toolLine = tools.length > 0 ? [...new Set(tools)].join(", ") : "the tools already on that worker";
  return [
    "Desk assignment. The desk already chose the worker. Do not do the slice yourself. Do not pick a different worker.",
    `Worker: ${who}.`,
    worker ? `Call workhorse_spawn_agent once with provider ${worker.provider} and model ${worker.model}.` : "Call workhorse_spawn_agent once and leave provider and model unset.",
    `Skills: ${skills}.`,
    `Tools: ${toolLine}.`,
    "Pass this request as the prompt:",
    task.trim(),
  ].filter((line) => line.trim()).join("\n");
}

export function deskStartedNote(assignment: DeskAssignment): string {
  const who = assignment.worker?.label ?? "a worker";
  const skills = assignment.skills.length
    ? ` Skills: ${assignment.skills.map((skill) => `${skill.origin}:${skill.name}`).join(", ")}.`
    : "";
  return `Desk started ${who} on this slice.${skills}`;
}

/** Put the skill text on the worker prompt so the worker does not have to go fetch it. */
export function withLoadedSkills(
  text: string,
  skills: readonly { name: string; body: string }[],
): string {
  if (/Return only (?:TASK's|the handoff's) exact structured output/.test(text)) return text;
  const blocks = skills
    .map((skill) => {
      const body = skillBodyFromMarkdown(skill.body).trim();
      if (!body) return "";
      const clipped = body.length > SKILL_BODY_CAP ? `${body.slice(0, SKILL_BODY_CAP)}\n…` : body;
      return `## ${skill.name}\n${clipped}`;
    })
    .filter(Boolean);
  if (blocks.length === 0) return text;
  return `${text}\n\nThe desk loaded these skills before this turn. Follow them. Do not skip this step.\n\n${blocks.join("\n\n")}`;
}

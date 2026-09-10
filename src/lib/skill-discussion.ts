import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "./settings";
import { catalogSkills, skillsForAutoLoad } from "./skills-catalog";
import { suggestDeskSkills, withSkillDiscoveryHint } from "./skill-suggestions";
import type { DeskSkill, SkillDiscoverySettings } from "./types";

export type SkillDiscussionBeat = {
  id: string;
  kind: "leak" | "hit";
  prompt: string;
  expect: string[];
  forbid: string[];
};

export type SkillDiscussionSuite = {
  schemaVersion: number;
  forbidden: string[];
  beats: SkillDiscussionBeat[];
};

export type SkillDiscussionTurn = {
  vendorText: string;
  radarNames: string[];
  hinted: boolean;
};

export type SkillDiscussionScore = {
  ok: boolean;
  reasons: string[];
  cursorNative: boolean;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function leakySkillsHomedir(root = ROOT): string {
  return path.join(root, "eval", "fixtures", "skills", "leaky-home");
}

export function loadSkillDiscussionSuite(root = ROOT): SkillDiscussionSuite {
  const raw = JSON.parse(readFileSync(path.join(root, "eval", "fixtures", "skills", "scenarios.json"), "utf8")) as SkillDiscussionSuite;
  if (!Array.isArray(raw.beats)) throw new Error("skill discussion scenarios need beats");
  return raw;
}

export function catalogLeakySkills(root = ROOT): DeskSkill[] {
  return catalogSkills({ homedir: leakySkillsHomedir(root) });
}

export function prepareSkillDiscussionTurn(
  prompt: string,
  skills: DeskSkill[],
  policy: SkillDiscoverySettings = DEFAULT_SETTINGS.skills,
): SkillDiscussionTurn {
  const auto = policy.suggestFromWording === false ? [] : skillsForAutoLoad(skills, policy);
  const radarNames = suggestDeskSkills(auto, prompt).map((skill) => skill.name);
  const vendorText = withSkillDiscoveryHint(prompt, prompt, auto);
  return { vendorText, radarNames, hinted: vendorText !== prompt };
}

export function scoreSkillDiscussionTurn(input: {
  beat: SkillDiscussionBeat;
  radarNames: string[];
  tools?: Array<{ title?: string; detail?: string }>;
  reply?: string;
}): SkillDiscussionScore {
  const reasons: string[] = [];
  const hay = `${input.radarNames.join(" ")}\n${toolHay(input.tools)}\n${input.reply ?? ""}`.toLowerCase();
  for (const name of input.beat.forbid) {
    if (input.radarNames.includes(name)) reasons.push(`radar named ${name}`);
    if (toolMentions(input.tools, name)) reasons.push(`skill tool named ${name}`);
  }
  if (input.beat.kind === "leak") {
    const spoken = spokenPluginLoad(input.reply);
    if (spoken) reasons.push(`reply loaded ${spoken}`);
  }
  for (const name of input.beat.expect) {
    const present = input.radarNames.includes(name) || toolMentions(input.tools, name) || hay.includes(name.toLowerCase());
    if (!present) reasons.push(`missing ${name}`);
  }
  const cursorNative = Boolean(
    input.beat.kind === "leak" &&
      spokenPluginLoad(input.reply) &&
      !input.radarNames.some((name) => input.beat.forbid.includes(name)) &&
      !input.tools?.some((tool) => input.beat.forbid.some((name) => mentions(tool, name))),
  );
  return { ok: reasons.length === 0, reasons, cursorNative };
}

function toolHay(tools: Array<{ title?: string; detail?: string }> | undefined): string {
  return (tools ?? []).map((tool) => `${tool.title ?? ""} ${tool.detail ?? ""}`).join("\n");
}

function mentions(tool: { title?: string; detail?: string }, name: string): boolean {
  const hay = `${tool.title ?? ""} ${tool.detail ?? ""}`.toLowerCase();
  return hay.includes(name.toLowerCase()) || hay.includes(name.replace(/-/g, " ").toLowerCase());
}

function toolMentions(tools: Array<{ title?: string; detail?: string }> | undefined, name: string): boolean {
  return (tools ?? []).some((tool) => /skill/i.test(`${tool.title ?? ""} ${tool.detail ?? ""}`) && mentions(tool, name));
}

function spokenPluginLoad(reply: string | undefined): string | undefined {
  if (!reply) return undefined;
  const match = reply.match(
    /(?:load(?:ing)?|follow(?:ing)?|us(?:e|ing)|read(?:ing)?)\s+(?:the\s+)?(?:installed\s+)?(?:skill\s+)?["']?(figma-use|artifact-template-business-review|artifact-template-analytics-dashboard|business review|presentation skill)["']?/i,
  );
  return match?.[1];
}

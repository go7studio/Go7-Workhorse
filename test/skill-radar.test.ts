import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/lib/settings";
import {
  catalogSkills,
  skillSource,
  skillsForAutoLoad,
} from "../src/lib/skills-catalog";
import { suggestDeskSkills } from "../src/lib/skill-suggestions";
import {
  catalogLeakySkills,
  leakySkillsHomedir,
  loadSkillDiscussionSuite,
  prepareSkillDiscussionTurn,
  scoreSkillDiscussionTurn,
} from "../src/lib/skill-discussion";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("normalizeSettings defaults plugin packs off auto-load", () => {
  const empty = normalizeSettings({});
  assert.equal(empty.skills.suggestFromWording, true);
  assert.equal(empty.skills.includePluginPacks, false);
  const on = normalizeSettings({ skills: { includePluginPacks: true, suggestFromWording: false } });
  assert.equal(on.skills.includePluginPacks, true);
  assert.equal(on.skills.suggestFromWording, false);
});

test("plugin trees are marked and omitted from auto-load", () => {
  const skills = catalogSkills({ homedir: leakySkillsHomedir(ROOT) });
  const plugins = skills.filter((skill) => skillSource(skill) === "plugin").map((skill) => skill.name).sort();
  const homes = skills.filter((skill) => skillSource(skill) === "home").map((skill) => skill.name).sort();
  assert.deepEqual(plugins, ["artifact-template-analytics-dashboard", "artifact-template-business-review", "figma-use"]);
  assert.deepEqual(homes, ["desk", "send-taildrop", "unity-ui-to-figma"]);
  assert.deepEqual(
    skillsForAutoLoad(skills, DEFAULT_SETTINGS.skills).map((skill) => skill.name).sort(),
    homes,
  );
  assert.equal(skillsForAutoLoad(skills, { includePluginPacks: true }).length, skills.length);
});

test("skill discussion beats stay quiet on leaks and keep genuine home hits", () => {
  const suite = loadSkillDiscussionSuite(ROOT);
  const skills = catalogLeakySkills(ROOT);
  const policy = DEFAULT_SETTINGS.skills;
  for (const beat of suite.beats) {
    const turn = prepareSkillDiscussionTurn(beat.prompt, skills, policy);
    const score = scoreSkillDiscussionTurn({ beat, radarNames: turn.radarNames });
    assert.equal(score.ok, true, `${beat.id}: ${score.reasons.join("; ") || "ok"} (radar ${turn.radarNames.join(",") || "none"})`);
  }
});

test("existing radar true positives still fire", () => {
  const catalog = [
    {
      name: "unity-ui-to-figma",
      description: "Extract and reconstruct Unity game UI in Figma while preserving layout fidelity",
      origin: "workhorse" as const,
      dir: "/skills/unity-ui-to-figma",
      skillFile: "/skills/unity-ui-to-figma/SKILL.md",
    },
    {
      name: "send-taildrop",
      description: "Transfer local files to another Tailscale device with Taildrop",
      origin: "codex" as const,
      dir: "/skills/send-taildrop",
      skillFile: "/skills/send-taildrop/SKILL.md",
    },
    {
      name: "imagegen",
      description: "Generate or edit raster images and illustrations",
      origin: "codex" as const,
      dir: "/skills/imagegen",
      skillFile: "/skills/imagegen/SKILL.md",
    },
  ];
  assert.deepEqual(
    suggestDeskSkills(catalog, "Please reconstruct this Unity HUD in Figma and preserve its layout").map((skill) => skill.name),
    ["unity-ui-to-figma"],
  );
  assert.deepEqual(
    suggestDeskSkills(catalog, "Send this APK to my Tailscale phone using Taildrop").map((skill) => skill.name),
    ["send-taildrop"],
  );
  assert.deepEqual(
    suggestDeskSkills(catalog, "Create an image of a horse").map((skill) => skill.name),
    ["imagegen"],
  );
  assert.deepEqual(
    suggestDeskSkills(catalog, "The mock is in Figma; just implement the login form").map((skill) => skill.name),
    [],
  );
});

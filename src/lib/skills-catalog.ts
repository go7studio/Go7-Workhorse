import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DeskSkill, SkillOrigin } from "./types";

const SKIP = new Set([
  "node_modules",
  ".git",
  ".hg",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "__pycache__",
  ".cache",
  ".next",
  ".venv",
  "venv",
  ".turbo",
  ".pnpm-store",
  ".yarn",
  ".idea",
  ".vscode",
]);
const CODEY = new Set(["src", "lib", "bin", "obj", "vendor"]);
const MAX_DEPTH = 8;

export type SkillFs = {
  existsSync: (filePath: string) => boolean;
  readFile: (filePath: string) => string;
  listDir: (dirPath: string) => string[];
  isDir: (filePath: string) => boolean;
};

export type SkillHome = { origin: SkillOrigin; root: string; managed?: boolean };

export function workhorseSkillsHome(homedir = os.homedir()): string {
  return path.join(homedir, ".workhorse", "skills");
}

export function skillHomes(
  input: { homedir?: string; projectFolders?: string[]; bundled?: string[] } = {},
): SkillHome[] {
  const home = input.homedir ?? os.homedir();
  const homes: SkillHome[] = [
    { origin: "grok", root: path.join(home, ".grok", "skills") },
    { origin: "grok", root: path.join(home, ".grok", "bundled", "skills") },
    { origin: "codex", root: path.join(home, ".codex", "skills") },
    { origin: "claude", root: path.join(home, ".claude", "skills") },
    { origin: "cursor", root: path.join(home, ".cursor", "skills") },
    { origin: "workhorse", root: workhorseSkillsHome(home), managed: true },
    { origin: "codex", root: path.join(home, ".codex", "plugins") },
    { origin: "grok", root: path.join(home, ".grok", "plugins") },
    { origin: "claude", root: path.join(home, ".claude", "plugins") },
    { origin: "cursor", root: path.join(home, ".cursor", "plugins") },
    { origin: "workhorse", root: path.join(home, ".agents", "skills") },
  ];
  for (const root of input.bundled ?? []) {
    if (root.trim()) homes.push({ origin: "workhorse", root: root.trim() });
  }
  for (const folder of input.projectFolders ?? []) {
    const root = folder.trim();
    if (!root) continue;
    homes.push(
      { origin: "grok", root: path.join(root, ".grok", "skills") },
      { origin: "codex", root: path.join(root, ".codex", "skills") },
      { origin: "claude", root: path.join(root, ".claude", "skills") },
      { origin: "cursor", root: path.join(root, ".cursor", "skills") },
      { origin: "workhorse", root: path.join(root, ".workhorse", "skills") },
      { origin: "cursor", root: path.join(root, ".agents", "skills") },
    );
  }
  return homes;
}

export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const description = block
    .match(/^description:\s*[>|]?\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

export function catalogSkills(
  input: {
    homes?: SkillHome[];
    homedir?: string;
    projectFolders?: string[];
    fs?: SkillFs;
  } = {},
): DeskSkill[] {
  const io = input.fs ?? nodeSkillFs();
  const homes = input.homes ?? skillHomes({ homedir: input.homedir, projectFolders: input.projectFolders });
  const seen = new Set<string>();
  const skills: DeskSkill[] = [];
  for (const home of homes) {
    walk(home.root, home.origin, home.managed === true, 0, io, seen, skills);
  }
  const unique = new Map<string, DeskSkill>();
  for (const skill of skills) {
    const key = `${skill.origin}:${skill.name.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, skill);
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name) || left.origin.localeCompare(right.origin));
}

function walk(
  dir: string,
  origin: SkillOrigin,
  managed: boolean,
  depth: number,
  io: SkillFs,
  seen: Set<string>,
  skills: DeskSkill[],
): void {
  if (depth > MAX_DEPTH || !io.existsSync(dir) || !io.isDir(dir)) return;
  const skillFile = path.join(dir, "SKILL.md");
  if (io.existsSync(skillFile) && !io.isDir(skillFile)) {
    const key = skillFile.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      const raw = safeRead(io, skillFile);
      const meta = parseSkillFrontmatter(raw);
      const folder = path.basename(dir);
      skills.push({
        name: meta.name?.trim() || folder,
        description: meta.description?.trim() || "",
        origin,
        dir,
        skillFile,
        managed,
      });
    }
    return;
  }
  let names: string[] = [];
  try {
    names = io.listDir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP.has(name) || name === "SKILL.md") continue;
    const next = path.join(dir, name);
    if (CODEY.has(name) && !io.existsSync(path.join(next, "SKILL.md"))) continue;
    walk(next, origin, managed, depth + 1, io, seen, skills);
  }
}

function safeRead(io: SkillFs, filePath: string): string {
  try {
    return io.readFile(filePath);
  } catch {
    return "";
  }
}

export function sameDeskSkills(left: DeskSkill[], right: DeskSkill[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((skill, index) => {
    const other = right[index];
    return (
      skill.dir === other.dir &&
      skill.skillFile === other.skillFile &&
      skill.name === other.name &&
      skill.description === other.description &&
      skill.origin === other.origin &&
      skill.managed === other.managed
    );
  });
}

export function filterDeskSkills(skills: DeskSkill[], query: string): DeskSkill[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return skills;
  const words = needle.split(/\s+/).filter(Boolean);
  return skills.filter((skill) => {
    const hay = `${skill.name} ${skill.description} ${skill.origin} ${skill.dir}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

export function skillBodyFromMarkdown(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

export function findDeskSkill(skills: DeskSkill[], query: string): DeskSkill | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  const byDir = skills.find((skill) => skill.dir.toLowerCase() === needle || skill.skillFile.toLowerCase() === needle);
  if (byDir) return byDir;
  const exact = skills.filter(
    (skill) => skill.name.toLowerCase() === needle || `${skill.origin}:${skill.name}`.toLowerCase() === needle,
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    return (
      exact.find((skill) => skill.origin === "workhorse") ??
      exact.find((skill) => skill.origin === "grok") ??
      exact.find((skill) => skill.origin === "cursor") ??
      exact[0]
    );
  }
  return skills.find(
    (skill) => skill.dir.toLowerCase() === needle || skill.dir.toLowerCase().replace(/\\/g, "/").endsWith(`/${needle}`),
  );
}

export type ResolvedSkillRequest = {
  resolved: DeskSkill[];
  unresolved: string[];
};

/** Resolve only installed skills. Free-form expertise belongs in assignment capabilities. */
export function resolveRequestedSkills(skills: DeskSkill[], queries: string[] = []): ResolvedSkillRequest {
  const resolved = new Map<string, DeskSkill>();
  const unresolved: string[] = [];
  for (const raw of queries) {
    const query = raw.trim();
    if (!query) continue;
    const skill = findDeskSkill(skills, query);
    if (!skill) {
      if (!unresolved.includes(query)) unresolved.push(query);
      continue;
    }
    resolved.set(`${skill.origin}:${skill.name.toLowerCase()}`, skill);
  }
  return { resolved: [...resolved.values()], unresolved };
}

export function publicSkillCard(skill: DeskSkill): { name: string; origin: SkillOrigin; description: string } {
  return { name: skill.name, origin: skill.origin, description: skill.description };
}

export function nodeSkillFs(): SkillFs {
  return {
    existsSync: (filePath) => fs.existsSync(filePath),
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
    listDir: (dirPath) => fs.readdirSync(dirPath),
    isDir: (filePath) => {
      try {
        return fs.statSync(filePath).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

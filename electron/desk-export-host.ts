import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  catalogSkills,
  findDeskSkill,
  parseSkillFrontmatter,
  publicSkillCard,
  skillHomes,
  workhorseSkillsHome,
} from "../src/lib/skills-catalog";
import { chatExportFiles, defaultExportRoot, sessionToMarkdown, slugTitle, vendorExportDirName } from "../src/lib/desk-export";
import type {
  DeskExportKind,
  DeskExportResult,
  DeskSkill,
  Project,
  ProviderId,
  Session,
  SkillOrigin,
} from "../src/lib/types";

export function resolveShippedWorkhorseSkills(): string | undefined {
  const env = process.env.WORKHORSE_SKILLS?.trim();
  if (env && fs.existsSync(path.join(env, "desk", "SKILL.md"))) return env;
  if (env && fs.existsSync(env)) return env;
  const fromHere = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
  if (fs.existsSync(path.join(fromHere, "desk", "SKILL.md"))) return fromHere;
  const fromCwd = path.join(process.cwd(), "skills");
  if (fs.existsSync(path.join(fromCwd, "desk", "SKILL.md"))) return fromCwd;
  return undefined;
}

export function seedWorkhorseSkills(homedir = os.homedir(), shipped = resolveShippedWorkhorseSkills()): number {
  const destRoot = ensureWorkhorseSkillsHome(homedir);
  if (!shipped || !fs.existsSync(shipped)) return 0;
  let seeded = 0;
  for (const name of fs.readdirSync(shipped)) {
    const from = path.join(shipped, name);
    const skill = path.join(from, "SKILL.md");
    if (!fs.existsSync(skill) || !fs.statSync(from).isDirectory()) continue;
    const dest = path.join(destRoot, name);
    if (fs.existsSync(dest) || removedSkillNames(homedir).has(name)) continue;
    copyDir(from, dest);
    seeded += 1;
  }
  return seeded;
}

export function ensureWorkhorseSkillsHome(homedir = os.homedir()): string {
  const dir = workhorseSkillsHome(homedir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listDeskSkills(projectFolders: string[] = [], homedir = os.homedir()): DeskSkill[] {
  seedWorkhorseSkills(homedir);
  return catalogSkills({ homedir, projectFolders });
}

export function publicDeskSkills(projectFolders: string[] = [], homedir = os.homedir()) {
  return listDeskSkills(projectFolders, homedir).map(publicSkillCard);
}

export function readDeskSkill(
  query: string,
  projectFolders: string[] = [],
  homedir = os.homedir(),
): { name: string; origin: SkillOrigin; dir: string; text: string } {
  const direct = resolveSkillDir(query);
  if (direct) {
    const skillFile = path.join(direct, "SKILL.md");
    const text = fs.readFileSync(skillFile, "utf8");
    const clipped = text.length > 80_000 ? `${text.slice(0, 80_000)}\n…` : text;
    const meta = parseSkillFrontmatter(text);
    return {
      name: meta.name?.trim() || path.basename(direct),
      origin: "workhorse",
      dir: direct,
      text: clipped,
    };
  }
  const skill = findDeskSkill(listDeskSkills(projectFolders, homedir), query);
  if (!skill) throw new Error(`No desk skill matches “${query}”`);
  const text = fs.readFileSync(skill.skillFile, "utf8");
  const clipped = text.length > 80_000 ? `${text.slice(0, 80_000)}\n…` : text;
  return { name: skill.name, origin: skill.origin, dir: skill.dir, text: clipped };
}

export function exportVendorBundle(input: {
  provider: string;
  dest?: string;
  kind: DeskExportKind;
  sessions?: Session[];
  projects?: Project[];
  projectFolders?: string[];
  homedir?: string;
  customBotId?: string;
  botName?: string;
}): DeskExportResult {
  const provider = input.provider as ProviderId;
  if (provider !== "grok" && provider !== "codex" && provider !== "claude" && provider !== "custom") {
    return { ok: false, message: "Mass send is only for Grok, Codex, Claude, or a desk bot." };
  }
  const destRoot = resolveExportRoot(input.dest, input.homedir);
  if (!destRoot) return { ok: false, message: "Could not create the export folder." };
  const bundle = path.join(destRoot, vendorExportDirName(provider, input.botName));
  fs.mkdirSync(bundle, { recursive: true });
  let skills = 0;
  let chats = 0;
  if (input.kind === "skills") {
    const homes = skillHomes({ homedir: input.homedir, projectFolders: input.projectFolders }).filter((home) =>
      provider === "custom" ? true : home.origin === provider,
    );
    const catalog = catalogSkills({
      homedir: input.homedir,
      projectFolders: input.projectFolders,
      homes,
    });
    const names = new Map<string, number>();
    for (const skill of catalog) {
      const used = names.get(`${skill.origin}:${skill.name}`) ?? 0;
      names.set(`${skill.origin}:${skill.name}`, used + 1);
      const folder = used === 0 ? skill.name : `${skill.name}-${used + 1}`;
      const dest = provider === "custom" ? path.join(bundle, "skills", skill.origin, folder) : path.join(bundle, "skills", folder);
      copyDir(skill.dir, dest);
      skills += 1;
    }
  }
  if (input.kind === "chats") {
    const files = chatExportFiles(provider, input.sessions ?? [], input.projects ?? [], input.customBotId);
    for (const file of files) {
      const full = path.join(bundle, file.relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, file.body, "utf8");
      chats += 1;
    }
  }
  return { ok: true, dest: bundle, skills, chats };
}

export function exportChatToFolder(input: {
  dest?: string;
  session: Session;
  projectName?: string;
}): DeskExportResult {
  const destRoot = resolveExportRoot(input.dest);
  if (!destRoot) return { ok: false, message: "Could not create the export folder." };
  const file = path.join(destRoot, `${slugTitle(input.session.title, input.session.id.slice(-8))}.md`);
  fs.writeFileSync(file, sessionToMarkdown(input.session, input.projectName), "utf8");
  return { ok: true, dest: file, chats: 1 };
}

export function importSkillFromPath(from: string, homedir = os.homedir()): DeskExportResult {
  const source = resolveSkillDir(from);
  if (!source) return { ok: false, message: "That folder does not contain a SKILL.md." };
  const home = ensureWorkhorseSkillsHome(homedir);
  const name = skillNameFromDir(source);
  const dest = uniqueDir(path.join(home, name));
  copyDir(source, dest);
  forgetRemovedSkill(name, homedir);
  return { ok: true, dest, skills: 1, message: `Imported ${path.basename(dest)} into Workhorse skills.` };
}

export function deleteDeskSkill(dir: string, homedir = os.homedir()): DeskExportResult {
  const source = resolveSkillDir(dir);
  if (!source) return { ok: false, message: "That skill folder is missing SKILL.md." };
  const realHome = fs.realpathSync(ensureWorkhorseSkillsHome(homedir));
  const realSource = fs.realpathSync(source);
  const relative = path.relative(realHome, realSource);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, message: "This skill is managed outside Workhorse. Remove it from its owning app." };
  }
  const name = skillNameFromDir(realSource);
  fs.rmSync(realSource, { recursive: true, force: true });
  rememberRemovedSkill(name, homedir);
  return { ok: true, dest: realSource, skills: 1, message: `Deleted ${name} from Workhorse.` };
}

export function pushSkillToVendor(input: {
  dir: string;
  name?: string;
  target: Exclude<SkillOrigin, "workhorse">;
  homedir?: string;
}): DeskExportResult {
  const source = resolveSkillDir(input.dir);
  if (!source) return { ok: false, message: "That skill folder is missing SKILL.md." };
  const home = vendorSkillHome(input.target, input.homedir);
  fs.mkdirSync(home, { recursive: true });
  const dest = path.join(home, skillNameFromDir(source, input.name));
  copyDir(source, dest);
  return { ok: true, dest, skills: 1, message: `Added to ${input.target}.` };
}

function vendorSkillHome(target: Exclude<SkillOrigin, "workhorse">, homedir = os.homedir()): string {
  if (target === "codex") return path.join(homedir, ".codex", "skills");
  if (target === "claude") return path.join(homedir, ".claude", "skills");
  return path.join(homedir, ".grok", "skills");
}

function resolveSkillDir(from: string): string | null {
  const raw = from.trim();
  if (!raw || !fs.existsSync(raw)) return null;
  const stat = fs.statSync(raw);
  const dir = stat.isDirectory() ? raw : path.dirname(raw);
  const skill = path.join(dir, "SKILL.md");
  if (fs.existsSync(skill) && fs.statSync(skill).isFile()) return dir;
  return null;
}

function skillNameFromDir(dir: string, fallback?: string): string {
  try {
    const meta = parseSkillFrontmatter(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
    if (meta.name?.trim()) return safeFolder(meta.name);
  } catch {
    /* folder name */
  }
  return safeFolder(fallback || path.basename(dir));
}

function safeFolder(name: string): string {
  return name.replace(/[<>:"/\\|?*]+/g, "-").replace(/^\.+/, "").trim() || "skill";
}

function removedListPath(homedir: string): string {
  return path.join(homedir, ".workhorse", "removed-skills.json");
}

function removedSkillNames(homedir: string): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(removedListPath(homedir), "utf8")) as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function rememberRemovedSkill(name: string, homedir: string): void {
  const next = removedSkillNames(homedir);
  next.add(name);
  fs.mkdirSync(path.dirname(removedListPath(homedir)), { recursive: true });
  fs.writeFileSync(removedListPath(homedir), JSON.stringify([...next], null, 2), "utf8");
}

function forgetRemovedSkill(name: string, homedir: string): void {
  const next = removedSkillNames(homedir);
  if (!next.delete(name)) return;
  fs.writeFileSync(removedListPath(homedir), JSON.stringify([...next], null, 2), "utf8");
}

function uniqueDir(dest: string): string {
  if (!fs.existsSync(dest)) return dest;
  let n = 2;
  while (fs.existsSync(`${dest}-${n}`)) n += 1;
  return `${dest}-${n}`;
}

export function resolveExportRoot(dest?: string, homedir = os.homedir()): string | null {
  const explicit = dest?.trim();
  const root = explicit || defaultExportRoot(homedir, fs.existsSync(path.join(homedir, "Desktop")));
  try {
    fs.mkdirSync(root, { recursive: true });
    return root;
  } catch {
    return null;
  }
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

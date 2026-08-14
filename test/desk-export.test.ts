import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { exportVendorBundle, importSkillFromPath, listDeskSkills, pushSkillToVendor, readDeskSkill, seedWorkhorseSkills } from "../electron/desk-export-host";
import { chatExportFiles, defaultExportRoot, sessionToMarkdown, slugTitle } from "../src/lib/desk-export";
import { catalogSkills, filterDeskSkills, findDeskSkill, parseSkillFrontmatter, sameDeskSkills, skillBodyFromMarkdown, skillHomes } from "../src/lib/skills-catalog";
import { deleteDeskSkill } from "../electron/desk-export-host";
import { isSettingsSection } from "../src/lib/settings";
import type { Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}

function sampleSession(partial: Partial<Session> = {}): Session {
  return {
    id: "sess_1",
    projectId: "proj_1",
    provider: "grok",
    model: "grok-4.6",
    effort: "medium",
    title: "What do you have access to?",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    contextUsed: 0,
    messages: [
      { id: "u", role: "user", text: "What do you have access to?", createdAt: 1 },
      { id: "a", role: "assistant", text: "The linked folder.", createdAt: 2 },
    ],
    ...partial,
  };
}

test("Settings Skills tab and Mass send are wired", () => {
  assert.equal(isSettingsSection("skills"), true);
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SkillsPane.tsx"), "utf8");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(settings, /id: "skills", label: "Skills"/);
  assert.match(settings, /Mass send/);
  assert.match(settings, /Projects \/ chats/);
  assert.match(settings, /<SkillsPane/);
  assert.match(settings, /customBotId=\{bot\.id\}/);
  assert.match(pane, /Workhorse/);
  assert.match(pane, /Import/);
  assert.doesNotMatch(pane, />\s*Pull\s*</);
  assert.match(pane, /Search/);
  assert.match(pane, /Delete/);
  assert.match(pane, /skill-detail/);
  assert.match(pane, /filterDeskSkills/);
  assert.match(pane, /store.deskSkills/);
  assert.match(pane, /\[listDeskSkills\]/);
  assert.doesNotMatch(pane, /\[store\]/);
  assert.match(store, /sameDeskSkills/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "ChatRow.tsx"), "utf8"), /Export chat/);
  assert.match(store, /massSendVendor/);
  assert.match(store, /listDeskSkills/);
  assert.doesNotMatch(store.slice(store.indexOf("const massSendVendor"), store.indexOf("const exportSession")), /pickExportFolder/);
  assert.equal(defaultExportRoot("C:\\\\Users\\\\lgovo", true).replace(/\\/g, "/"), "C:/Users/lgovo/Desktop/Workhorse exports");
  assert.match(defaultExportRoot("/home/me", false), /Workhorse exports/);
  assert.match(preload, /desk:export-vendor/);
  assert.match(main, /desk:list-skills/);
});

test("skill catalog labels Grok Codex Claude and Workhorse", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wh-skills-"));
  writeSkill(path.join(home, ".grok", "skills", "pdf"), "pdf", "Make PDFs");
  writeSkill(path.join(home, ".codex", "skills", ".system", "plan"), "plan", "Plan files");
  writeSkill(path.join(home, ".claude", "skills", "review"), "review", "Review code");
  writeSkill(path.join(home, ".workhorse", "skills", "desk"), "desk", "Desk notes");
  const meta = parseSkillFrontmatter("---\nname: pdf\ndescription: Make PDFs\n---\nbody");
  assert.equal(meta.name, "pdf");
  assert.equal(meta.description, "Make PDFs");
  const rows = catalogSkills({ homedir: home });
  assert.deepEqual(
    rows.map((row) => `${row.origin}:${row.name}`),
    ["workhorse:desk", "grok:pdf", "codex:plan", "claude:review"],
  );
  assert.equal(skillHomes({ homedir: home }).some((item) => item.origin === "workhorse"), true);
});

test("skill catalog does not walk extras inside a skill folder", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wh-skills-leaf-"));
  const pdf = path.join(home, ".grok", "skills", "pdf");
  writeSkill(pdf, "pdf", "Make PDFs");
  writeSkill(path.join(pdf, "scripts", "nested"), "nested", "Should stay hidden");
  mkdirSync(path.join(pdf, "src", "huge"), { recursive: true });
  writeFileSync(path.join(pdf, "src", "huge", "blob.bin"), "x".repeat(1000));
  const rows = catalogSkills({ homedir: home });
  assert.deepEqual(
    rows.filter((row) => row.origin === "grok").map((row) => row.name),
    ["pdf"],
  );
  assert.equal(sameDeskSkills(rows, catalogSkills({ homedir: home })), true);
  assert.equal(sameDeskSkills(rows, []), false);
});

test("chat markdown export skips archived and hidden chats", () => {
  assert.equal(slugTitle("What do you have access to?"), "what-do-you-have-access-to");
  const md = sessionToMarkdown(sampleSession(), "Walk Test");
  assert.match(md, /^# What do you have access to\?/m);
  assert.match(md, /## User/);
  assert.match(md, /## Assistant/);
  assert.match(md, /The linked folder/);
  const files = chatExportFiles(
    "grok",
    [
      sampleSession(),
      sampleSession({ id: "hid", hidden: true, title: "Hidden" }),
      sampleSession({ id: "arch", archivedAt: 9, title: "Archived" }),
      sampleSession({ id: "kid", parentId: "sess_1", title: "Child" }),
      sampleSession({ id: "cx", provider: "codex", title: "Codex only" }),
    ],
    [{ id: "proj_1", name: "Walk Test", createdAt: 1, openedAt: 1, folders: [], references: [] }],
  );
  assert.equal(files.length, 1);
  assert.match(files[0].relPath, /projects\/walk-test\/what-do-you-have-access-to\.md/);
});

test("mass send writes vendor skills and chats without auth files", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wh-home-"));
  const dest = mkdtempSync(path.join(os.tmpdir(), "wh-dest-"));
  writeSkill(path.join(home, ".grok", "skills", "pdf"), "pdf", "Make PDFs");
  writeFileSync(path.join(home, ".grok", "auth.json"), "{\"token\":\"secret\"}", "utf8");
  const listed = listDeskSkills([], home);
  assert.ok(listed.some((row) => row.name === "pdf" && row.origin === "grok"));
  const skills = exportVendorBundle({ provider: "grok", dest, kind: "skills", homedir: home });
  assert.equal(skills.ok, true);
  assert.equal(skills.skills, 1);
  const skillOut = path.join(dest, "workhorse-grok", "skills", "pdf", "SKILL.md");
  assert.match(readFileSync(skillOut, "utf8"), /Make PDFs/);
  assert.equal(
    readFileSync(path.join(home, ".grok", "auth.json"), "utf8").includes("secret"),
    true,
  );
  const chats = exportVendorBundle({
    provider: "grok",
    dest,
    kind: "chats",
    homedir: home,
    sessions: [sampleSession()],
    projects: [{ id: "proj_1", name: "Walk Test", createdAt: 1, openedAt: 1, folders: [], references: [] }],
  });
  assert.equal(chats.ok, true);
  assert.equal(chats.chats, 1);
  const chatOut = path.join(dest, "workhorse-grok", "projects", "walk-test", "what-do-you-have-access-to.md");
  assert.match(readFileSync(chatOut, "utf8"), /The linked folder/);
});

test("import copies a skill into Workhorse and push copies it to Grok", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wh-imp-"));
  const source = path.join(home, "incoming", "review");
  writeSkill(source, "review", "Review diffs");
  const imported = importSkillFromPath(source, home);
  assert.equal(imported.ok, true);
  const listed = catalogSkills({ homedir: home });
  assert.ok(listed.some((row) => row.origin === "workhorse" && row.name === "review"));
  const pushed = pushSkillToVendor({ dir: imported.dest!, target: "grok", homedir: home });
  assert.equal(pushed.ok, true);
  assert.ok(catalogSkills({ homedir: home }).some((row) => row.origin === "grok" && row.name === "review"));
  const read = readDeskSkill("review", [], home);
  assert.equal(read.origin, "workhorse");
  assert.match(read.text, /Review diffs/);
  assert.equal(findDeskSkill(listed, "grok:pdf"), undefined);
});

test("Workhorse seeds desk and setup skills into the Workhorse home", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wh-seed-"));
  const shipped = path.join(ROOT, "skills");
  assert.equal(existsSync(path.join(shipped, "desk", "SKILL.md")), true);
  const seeded = seedWorkhorseSkills(home, shipped);
  assert.ok(seeded >= 2);
  const again = seedWorkhorseSkills(home, shipped);
  assert.equal(again, 0);
  const rows = listDeskSkills([], home);
  assert.ok(rows.some((row) => row.origin === "workhorse" && row.name === "desk"));
  assert.ok(rows.some((row) => row.origin === "workhorse" && row.name === "setup"));
  assert.match(readFileSync(path.join(home, ".workhorse", "skills", "desk", "SKILL.md"), "utf8"), /workhorse_ask_chat/);
  assert.match(readFileSync(path.join(home, ".workhorse", "skills", "setup", "SKILL.md"), "utf8"), /workhorse_setup_custom_bot/);
  const deskDir = path.join(home, ".workhorse", "skills", "desk");
  assert.equal(deleteDeskSkill(deskDir, home).ok, true);
  assert.equal(existsSync(deskDir), false);
  assert.equal(seedWorkhorseSkills(home, shipped), 0);
  assert.equal(filterDeskSkills(rows, "ask chat").some((row) => row.name === "desk"), true);
  assert.equal(skillBodyFromMarkdown("---\nname: desk\n---\n\n# Workhorse desk\n").startsWith("# Workhorse desk"), true);
});

test("custom bot mass send writes that bot’s chats", () => {
  const dest = mkdtempSync(path.join(os.tmpdir(), "wh-custom-"));
  const result = exportVendorBundle({
    provider: "custom",
    dest,
    kind: "chats",
    customBotId: "bot_mini",
    botName: "MiniMax",
    sessions: [
      sampleSession({ provider: "custom", customBotId: "bot_mini", projectId: null, title: "Make a game for me" }),
      sampleSession({ id: "other", provider: "custom", customBotId: "bot_other", title: "Other bot" }),
    ],
    projects: [],
  });
  assert.equal(result.ok, true);
  assert.equal(result.chats, 1);
  assert.match(
    readFileSync(path.join(dest, "workhorse-minimax", "projects", "_chats", "make-a-game-for-me.md"), "utf8"),
    /What do you have access to/,
  );
});

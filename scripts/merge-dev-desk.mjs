#!/usr/bin/env node
/**
 * Merge a prior Dev desk snapshot into the current Dev userData.
 * Usage: node scripts/merge-dev-desk.mjs <sourceUserDataDir> <destUserDataDir>
 */
import fs from "node:fs";
import path from "node:path";

const [sourceRoot, destRoot] = process.argv.slice(2);
if (!sourceRoot || !destRoot) {
  process.stderr.write("usage: node scripts/merge-dev-desk.mjs <source> <dest>\n");
  process.exit(1);
}

const prodRoot = path.join(process.env.APPDATA ?? "", "Go7 Workhorse");

function readState(root) {
  const file = path.join(root, "workhorse-state.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sidecarRows(session, roots) {
  const sidecar = session.transcriptSidecar;
  if (typeof sidecar !== "string" || !sidecar.trim()) return 0;
  let file = sidecar;
  for (const root of roots) {
    if (file.startsWith(root)) break;
  }
  if (file.includes("Go7 Workhorse\\transcripts\\") || file.includes("Go7 Workhorse/transcripts/")) {
    const base = path.basename(file);
    file = path.join(destRoot, "transcripts", base);
  }
  if (!fs.existsSync(file)) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(raw.rows) ? raw.rows.length : Array.isArray(raw.messages) ? raw.messages.length : 0;
  } catch {
    return 0;
  }
}

function sessionScore(session, roots) {
  const inline = Array.isArray(session.messages) ? session.messages.length : 0;
  return inline + sidecarRows(session, roots);
}

function retargetSidecar(session) {
  if (typeof session.transcriptSidecar !== "string" || !session.transcriptSidecar.trim()) return session;
  const base = path.basename(session.transcriptSidecar);
  return {
    ...session,
    transcriptSidecar: path.join(destRoot, "transcripts", base),
  };
}

function stripSidecar(session) {
  const next = { ...session };
  delete next.transcriptSidecar;
  delete next.transcriptOffloaded;
  return next;
}

function mergeProjects(current, source) {
  const byId = new Map();
  for (const project of current.projects ?? []) byId.set(project.id, project);
  let added = 0;
  for (const project of source.projects ?? []) {
    if (!byId.has(project.id)) {
      byId.set(project.id, project);
      added += 1;
    }
  }
  return { projects: [...byId.values()], added };
}

function mergeSessions(current, source) {
  const roots = [prodRoot, sourceRoot, destRoot];
  const byId = new Map();
  for (const session of current.sessions ?? []) byId.set(session.id, session);

  let added = 0;
  let replaced = 0;
  let retargeted = 0;

  for (const oldSession of source.sessions ?? []) {
    const id = oldSession.id;
    const currentSession = byId.get(id);
    if (!currentSession) {
      byId.set(id, stripSidecar(oldSession));
      added += 1;
      continue;
    }
    const oldInline = Array.isArray(oldSession.messages) ? oldSession.messages.length : 0;
    const curInline = Array.isArray(currentSession.messages) ? currentSession.messages.length : 0;
    const oldScore = sessionScore(oldSession, roots);
    const curScore = sessionScore(currentSession, roots);
    // Prefer the prior Dev inline transcript when it is visibly richer in the desk.
    if (oldInline > curInline || oldScore > curScore) {
      byId.set(id, stripSidecar(oldSession));
      replaced += 1;
      continue;
    }
    const next = retargetSidecar(currentSession);
    if (next.transcriptSidecar !== currentSession.transcriptSidecar) retargeted += 1;
    byId.set(id, next);
  }

  // Retarget any remaining sessions that still point at production.
  for (const [id, session] of byId.entries()) {
    if (typeof session.transcriptSidecar === "string" && session.transcriptSidecar.includes("Go7 Workhorse\\transcripts")) {
      const next = retargetSidecar(session);
      if (next.transcriptSidecar !== session.transcriptSidecar) {
        byId.set(id, next);
        retargeted += 1;
      }
    }
  }

  return { sessions: [...byId.values()], added, replaced, retargeted };
}

function copyTree(srcRel, destRel) {
  const src = path.join(sourceRoot, srcRel);
  const dest = path.join(destRoot, destRel);
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) continue;
    if (fs.existsSync(to)) continue;
    fs.copyFileSync(from, to);
    copied += 1;
  }
  return copied;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(destRoot, `_backup-before-merge-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });
for (const name of ["workhorse-state.json", "workhorse-jobs.json", "composer-drafts.json", "file-instances.json"]) {
  const src = path.join(destRoot, name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, name));
}

const current = readState(destRoot);
const source = readState(sourceRoot);
const { projects, added: projectsAdded } = mergeProjects(current, source);
const { sessions, added, replaced, retargeted } = mergeSessions(current, source);

const merged = {
  ...current,
  projects,
  sessions,
  stateVersion: current.stateVersion ?? 2,
};

const outFile = path.join(destRoot, "workhorse-state.json");
fs.writeFileSync(outFile, JSON.stringify(merged));

const attachmentsCopied = copyTree("attachments", "attachments");
const peerCopied = copyTree("peer-inbox", "peer-inbox");

process.stdout.write(
  [
    `merged into ${destRoot}`,
    `projects added=${projectsAdded} total=${projects.length}`,
    `sessions added=${added} replaced=${replaced} retargeted=${retargeted} total=${sessions.length}`,
    `attachments copied=${attachmentsCopied}`,
    `peer-inbox copied=${peerCopied}`,
    `backup=${backupDir}`,
  ].join("\n") + "\n",
);

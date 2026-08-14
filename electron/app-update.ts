import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { APP_VERSION } from "../src/lib/app-info";
import {
  offerFromRelease,
  parseVersion,
  pickLatestTagOffer,
  releaseTag,
  UPDATE_REPO,
  versionFromRef,
  type AppUpdateApplyResult,
  type AppUpdateOffer,
} from "../src/lib/app-update";

const execFileAsync = promisify(execFile);

const HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Go7-Workhorse",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function githubJson(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}${path}`, {
    headers: HEADERS,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${response.status}`);
  return response.json();
}

export async function checkAppUpdate(current = APP_VERSION): Promise<AppUpdateOffer | null> {
  try {
    const latest = await githubJson("/releases/latest");
    const fromRelease = offerFromRelease(latest, current);
    if (fromRelease) return fromRelease;
    const tags = await githubJson("/tags?per_page=20");
    return pickLatestTagOffer(tags, current);
  } catch {
    return null;
  }
}

function deskRoot(): string | null {
  const starts = [app.getAppPath(), process.cwd()];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 6; i += 1) {
      if (fs.existsSync(path.join(dir, ".git")) && fs.existsSync(path.join(dir, "package.json"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

async function run(cmd: string, args: string[], cwd: string, timeout = 120_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd,
    timeout,
    windowsHide: true,
    encoding: "utf8",
  });
  return `${stdout}\n${stderr}`.trim();
}

export async function applyAppUpdate(version: string): Promise<AppUpdateApplyResult> {
  const wanted = versionFromRef(version);
  if (!parseVersion(wanted)) return { ok: false, message: "That version is not a Workhorse build." };
  const offer = await checkAppUpdate();
  if (!offer || offer.version !== wanted) return { ok: false, message: "No newer GitHub build to install." };
  const root = deskRoot();
  if (!root) return { ok: false, message: "This Workhorse build is not a git checkout, so it cannot install in place." };
  const tag = releaseTag(wanted);
  try {
    try {
      await run("git", ["fetch", "origin", "tag", tag, "--force"], root);
    } catch {
      await run("git", ["fetch", "origin", "--tags", "--force"], root);
    }
    try {
      await run("git", ["merge", "--ff-only", tag], root);
    } catch {
      await run("git", ["checkout", tag], root);
    }
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    await run(npm, ["install"], root, 300_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Install failed.";
    return { ok: false, message: message.slice(0, 280) };
  }
  setImmediate(() => {
    app.relaunch();
    app.quit();
  });
  return { ok: true };
}

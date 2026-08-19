import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { APP_VERSION } from "../src/lib/app-info";
import {
  MAC_APP_NAME,
  macBundleFromExecPath,
  macInstallerArch,
  macReplaceScript,
  offerFromRelease,
  packagedUpdateMissingMessage,
  parseHdiutilAttach,
  parseVersion,
  pickLatestTagOffer,
  pickMacDmgAsset,
  pickWinSetupAsset,
  releaseTag,
  UPDATE_REPO,
  updateInstallKind,
  versionFromRef,
  winSchtasksCreate,
  winSchtasksRun,
  winUpdateTaskXml,
  winUpdateTaskXmlBytes,
  winWmiCreate,
  type AppUpdateApplyResult,
  type AppUpdateCheckResult,
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
  if (response.status === 403) throw new Error("GitHub rate limit. Try again later.");
  if (!response.ok) throw new Error(`Could not reach GitHub (${response.status}).`);
  return response.json();
}

export async function checkAppUpdate(current = APP_VERSION): Promise<AppUpdateCheckResult> {
  try {
    const latest = await githubJson("/releases/latest");
    const fromRelease = offerFromRelease(latest, current);
    if (fromRelease) return { offer: fromRelease };
    const tags = await githubJson("/tags?per_page=20");
    return { offer: pickLatestTagOffer(tags, current) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reach GitHub.";
    return { offer: null, error: message.slice(0, 180) };
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

async function installMacDmg(version: string): Promise<AppUpdateApplyResult> {
  const arch = macInstallerArch(process.arch);
  if (!arch) return { ok: false, message: "This Mac architecture has no installer." };
  let release: unknown;
  try {
    release = await githubJson(`/releases/tags/${releaseTag(version)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reach GitHub.";
    return { ok: false, message: message.slice(0, 180) };
  }
  const asset = pickMacDmgAsset(release, arch);
  if (!asset) return { ok: false, message: `No ${arch} macOS installer on ${releaseTag(version)}.` };

  const destApp = macBundleFromExecPath(process.execPath) ?? path.join("/Applications", MAC_APP_NAME);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-update-"));
  const dmg = path.join(tmp, "workhorse.dmg");
  let device = "";
  try {
    const response = await fetch(asset.url, {
      headers: { "User-Agent": "Go7-Workhorse", Accept: "application/octet-stream" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`Download failed (${response.status}).`);
    fs.writeFileSync(dmg, Buffer.from(await response.arrayBuffer()));

    // Not -quiet: it silences the table the mount point is read from.
    const attached = await run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountrandom", tmp], tmp);
    const mounted = parseHdiutilAttach(attached, tmp);
    if (!mounted) throw new Error("Could not mount the disk image.");
    device = mounted.device;
    const srcApp = path.join(mounted.mount, MAC_APP_NAME);
    if (!fs.existsSync(srcApp)) throw new Error("The disk image did not contain Go7 Workhorse.");

    const helper = path.join(tmp, "replace.sh");
    fs.writeFileSync(
      helper,
      macReplaceScript({
        pid: process.pid,
        srcApp,
        destApp,
        device,
        tmp,
      }),
      { mode: 0o755 },
    );
    const child = spawn("/bin/bash", [helper], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (error) {
    if (device) {
      try {
        await run("hdiutil", ["detach", device, "-force"], tmp, 30_000);
      } catch {
        /* the image may already be gone */
      }
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* mount point may still sit inside tmp */
    }
    const message = error instanceof Error ? error.message : "Install failed.";
    return { ok: false, message: message.slice(0, 280) };
  }
  setImmediate(() => app.quit());
  return { ok: true };
}

async function installWinNsis(version: string): Promise<AppUpdateApplyResult> {
  let release: unknown;
  try {
    release = await githubJson(`/releases/tags/${releaseTag(version)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reach GitHub.";
    return { ok: false, message: message.slice(0, 180) };
  }
  const asset = pickWinSetupAsset(release);
  if (!asset) return { ok: false, message: `No Windows installer on ${releaseTag(version)}.` };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-update-"));
  const setup = path.join(tmp, "workhorse-setup.exe");
  try {
    const response = await fetch(asset.url, {
      headers: { "User-Agent": "Go7-Workhorse", Accept: "application/octet-stream" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`Download failed (${response.status}).`);
    fs.writeFileSync(setup, Buffer.from(await response.arrayBuffer()));

    const xmlPath = path.join(tmp, "update-task.xml");
    fs.writeFileSync(xmlPath, winUpdateTaskXmlBytes(winUpdateTaskXml({ command: setup })));
    const create = winSchtasksCreate({ xmlPath });
    const runTask = winSchtasksRun();
    try {
      await run(create.command, create.args, tmp, 30_000);
      await run(runTask.command, runTask.args, tmp, 30_000);
    } catch {
      const wmi = winWmiCreate(setup);
      await run(wmi.command, wmi.args, tmp, 30_000);
    }
  } catch (error) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* helper may already be running */
    }
    const message = error instanceof Error ? error.message : "Install failed.";
    return { ok: false, message: message.slice(0, 280) };
  }
  setImmediate(() => app.quit());
  return { ok: true };
}

export async function applyAppUpdate(version: string): Promise<AppUpdateApplyResult> {
  const wanted = versionFromRef(version);
  if (!parseVersion(wanted)) return { ok: false, message: "That version is not a Workhorse build." };
  const { offer, error } = await checkAppUpdate();
  if (error) return { ok: false, message: error };
  if (!offer || offer.version !== wanted) return { ok: false, message: "No newer GitHub build to install." };
  const kind = updateInstallKind({
    platform: process.platform,
    packaged: app.isPackaged,
    hasGitCheckout: Boolean(deskRoot()),
  });
  if (kind === "mac-dmg") return installMacDmg(wanted);
  if (kind === "win-nsis") return installWinNsis(wanted);
  if (kind === "none") return { ok: false, message: packagedUpdateMissingMessage(process.platform) };
  const root = deskRoot();
  if (!root) return { ok: false, message: packagedUpdateMissingMessage(process.platform) };
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

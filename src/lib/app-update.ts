export const UPDATE_REPO = {
  owner: "go7studio",
  repo: "Go7-Workhorse",
} as const;

export type AppUpdateOffer = {
  version: string;
  name?: string;
  notes?: string;
  url: string;
};

export function versionFromRef(raw: string): string {
  return raw.trim().replace(/^v/i, "");
}

export function parseVersion(raw: string): [number, number, number] | null {
  const match = versionFromRef(raw).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

export function releaseTag(version: string): string {
  return `v${versionFromRef(version)}`;
}

export function releaseUrl(version: string): string {
  return `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/tag/${releaseTag(version)}`;
}

export type AppUpdateApplyResult = { ok: true } | { ok: false; message: string };

export type AppUpdateCheckResult = {
  offer: AppUpdateOffer | null;
  error?: string;
};

export const MAC_APP_NAME = "Go7 Workhorse.app";

export function macInstallerArch(raw: string): "arm64" | "x64" | null {
  if (raw === "arm64") return "arm64";
  if (raw === "x64" || raw === "x86_64") return "x64";
  return null;
}

export type MacDmgAsset = { url: string; name: string };

export function pickMacDmgAsset(release: unknown, arch: "arm64" | "x64"): MacDmgAsset | null {
  if (!release || typeof release !== "object") return null;
  const assets = (release as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return null;
  const named: MacDmgAsset[] = [];
  for (const item of assets) {
    if (!item || typeof item !== "object") continue;
    const record = item as { name?: unknown; browser_download_url?: unknown };
    if (typeof record.name !== "string" || typeof record.browser_download_url !== "string") continue;
    if (!record.browser_download_url.startsWith("https://")) continue;
    named.push({ name: record.name, url: record.browser_download_url });
  }
  const exact = named.find((asset) => asset.name.endsWith(`-mac-${arch}.dmg`));
  if (exact) return exact;
  // Releases up to 0.1.9 shipped one unlabelled dmg, and it was arm64 only.
  if (arch === "arm64") {
    const legacy = named.find((asset) => /-mac\.dmg$/.test(asset.name) && !/-mac-(arm64|x64)\.dmg$/.test(asset.name));
    if (legacy) return legacy;
  }
  return null;
}

export function macBundleFromExecPath(execPath: string): string | null {
  const normalized = execPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  for (let i = parts.length; i > 0; i -= 1) {
    const candidate = parts.slice(0, i).join("/");
    if (candidate.endsWith(".app")) return candidate;
  }
  return null;
}

export function parseHdiutilAttach(output: string, tmpDir: string): { device: string; mount: string } | null {
  const device = output
    .split(/\r?\n/)
    .map((line) => line.match(/^(\/dev\/\S+)/)?.[1])
    .find(Boolean);
  if (!device) return null;
  const comparableMacPath = (value: string) =>
    value.replace(/\\/g, "/").replace(/^\/private(?=\/(?:var|tmp)\/)/, "");
  const prefix = comparableMacPath(tmpDir);
  const mount = output
    .replace(/\\/g, "/")
    .split(/\s+/)
    .find((token) => comparableMacPath(token).startsWith(`${prefix}/`));
  if (!mount) return null;
  return { device, mount };
}

export type WinSetupAsset = { url: string; name: string };

export function pickWinSetupAsset(release: unknown): WinSetupAsset | null {
  if (!release || typeof release !== "object") return null;
  const assets = (release as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return null;
  const named: WinSetupAsset[] = [];
  for (const item of assets) {
    if (!item || typeof item !== "object") continue;
    const record = item as { name?: unknown; browser_download_url?: unknown };
    if (typeof record.name !== "string" || typeof record.browser_download_url !== "string") continue;
    if (!record.browser_download_url.startsWith("https://")) continue;
    named.push({ name: record.name, url: record.browser_download_url });
  }
  const exact = named.find((asset) => /^Go7-Workhorse-Setup-.+\.exe$/i.test(asset.name));
  if (exact) return exact;
  // Releases before the Go7- prefix shipped Workhorse-Setup-<ver>.exe.
  return named.find((asset) => /Setup-.+\.exe$/i.test(asset.name)) ?? null;
}

export type UpdateInstallKind = "mac-dmg" | "win-nsis" | "git-checkout" | "none";

export function updateInstallKind(input: {
  platform: string;
  packaged: boolean;
  hasGitCheckout: boolean;
}): UpdateInstallKind {
  if (input.platform === "darwin" && input.packaged) return "mac-dmg";
  if (input.platform === "win32" && input.packaged) return "win-nsis";
  if (input.hasGitCheckout) return "git-checkout";
  return "none";
}

export function packagedUpdateMissingMessage(platform: string): string {
  if (platform === "linux") return "This Linux build cannot install in place.";
  return "This Workhorse build cannot install in place.";
}

export const WIN_UPDATE_TASK_NAME = "Go7WorkhorseUpdate";

/** The Grok Bot shim is a second Go7 Workhorse.exe that keeps app.asar locked. */
export function isWindowsGrokBotShimProcess(input: {
  pid: number;
  selfPid: number;
  name: string;
  commandLine?: string;
}): boolean {
  if (input.pid === input.selfPid) return false;
  if (!/Go7 Workhorse\.exe$/i.test(input.name.trim())) return false;
  return /grok-bot-shim-host/i.test(input.commandLine ?? "");
}

export function windowsGrokBotShimPids(
  selfPid: number,
  processes: Array<{ pid: number; name: string; commandLine?: string }>,
): number[] {
  return processes.filter((process) => isWindowsGrokBotShimProcess({ ...process, selfPid })).map((process) => process.pid);
}


export function winInstallerArgs(): string[] {
  // /S is NSIS silent. --force-run is electron-builder's assisted-installer
  // switch that starts the new exe after a silent install (the finish page
  // never runs under /S). Do not pass --updated: that is electron-updater's
  // contract, and it is not a relaunch.
  return ["/S", "--force-run"];
}

export function winInstallerCommandLine(setup: string): string {
  return `"${setup}" ${winInstallerArgs().join(" ")}`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One-shot Task Scheduler XML: silent Setup only.
 * Do not Exec cmd.exe or schtasks.exe here — those are console apps and would
 * flash a prompt in the user session. Setup /S has no wizard; --force-run
 * opens Workhorse when the copy is done.
 */
export function winUpdateTaskXml(input: { command: string; args?: string }): string {
  const command = xmlEscape(input.command);
  const args = xmlEscape(input.args ?? winInstallerArgs().join(" "));
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>Go7 Workhorse in-app update</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <TimeTrigger>",
    "      <StartBoundary>2020-01-01T00:00:00</StartBoundary>",
    "      <Enabled>true</Enabled>",
    "    </TimeTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>true</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${command}</Command>`,
    `      <Arguments>${args}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

export function winUpdateTaskXmlBytes(xml: string): Buffer {
  return Buffer.from(`\uFEFF${xml}`, "utf16le");
}

export function winSchtasksCreate(input: { xmlPath: string; taskName?: string }): { command: string; args: string[] } {
  return {
    command: "schtasks.exe",
    args: ["/Create", "/TN", input.taskName ?? WIN_UPDATE_TASK_NAME, "/XML", input.xmlPath, "/F"],
  };
}

export function winSchtasksRun(input: { taskName?: string } = {}): { command: string; args: string[] } {
  return {
    command: "schtasks.exe",
    args: ["/Run", "/TN", input.taskName ?? WIN_UPDATE_TASK_NAME],
  };
}

export function winSchtasksDelete(input: { taskName?: string } = {}): { command: string; args: string[] } {
  return {
    command: "schtasks.exe",
    args: ["/Delete", "/TN", input.taskName ?? WIN_UPDATE_TASK_NAME, "/F"],
  };
}

/** WMI Win32_Process.Create. Born under WmiPrvSE, not Electron's job. */
export function winWmiCreateCommand(commandLine: string): { command: string; args: string[] } {
  const escaped = commandLine.replace(/'/g, "''");
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${escaped}'}`,
    ],
  };
}

export function winWmiCreate(setup: string): { command: string; args: string[] } {
  return winWmiCreateCommand(winInstallerCommandLine(setup));
}

/** Re-register the live bundle and drop a stale Dock bookmark after an in-place replace. */
export function macRefreshRegistrationScript(destExpr = '"$dest"'): string {
  return `# WORKHORSE_MAC_DOCK_REFRESH
# Replacing the .app changes its inode. Dock keeps a bookmark to the old one
# and shows a blank tile. Re-register the live bundle and drop that bookmark.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ] && [ -d ${destExpr} ]; then
  "$LSREGISTER" -f ${destExpr} >/dev/null 2>&1 || true
  for stale in /private/tmp/go7-workhorse-install.*/*backup.app /tmp/go7-workhorse-install.*/*backup.app; do
    [ -e "$stale" ] || continue
    "$LSREGISTER" -u "$stale" >/dev/null 2>&1 || true
  done
fi
/usr/bin/touch ${destExpr} 2>/dev/null || true
if [ -x /usr/bin/python3 ] && [ -d ${destExpr} ]; then
  /usr/bin/python3 - ${destExpr} <<'PY'
import plistlib, subprocess, sys, time
from pathlib import Path
dest = Path(sys.argv[1]).resolve()
plist_path = Path.home() / "Library/Preferences/com.apple.dock.plist"
if not dest.is_dir() or not plist_path.is_file():
    raise SystemExit(0)
try:
    info = plistlib.loads((dest / "Contents/Info.plist").read_bytes())
except Exception:
    info = {}
bundle_id = info.get("CFBundleIdentifier") or "com.go7studio.workhorse"
label = info.get("CFBundleDisplayName") or info.get("CFBundleName") or dest.stem
url = dest.as_uri()
if not url.endswith("/"):
    url += "/"
data = plistlib.loads(plist_path.read_bytes())
changed = False
for item in data.get("persistent-apps") or []:
    tile = item.get("tile-data")
    if not isinstance(tile, dict):
        continue
    file_url = str((tile.get("file-data") or {}).get("_CFURLString") or "")
    bid = str(tile.get("bundle-identifier") or "")
    if bid != bundle_id and file_url.rstrip("/") != url.rstrip("/"):
        continue
    tile.pop("book", None)
    tile["file-data"] = {"_CFURLString": url, "_CFURLStringType": 15}
    tile["bundle-identifier"] = bundle_id
    tile["file-label"] = label
    item["tile-data"] = tile
    changed = True
if not changed:
    raise SystemExit(0)
subprocess.run(["killall", "-STOP", "Dock"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.2)
plist_path.write_bytes(plistlib.dumps(data, fmt=plistlib.FMT_BINARY))
subprocess.run(["killall", "-9", "Dock"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
PY
fi
`;
}

export function macReplaceScript(input: {
  pid: number;
  srcApp: string;
  destApp: string;
  device: string;
  tmp: string;
}): string {
  const quote = (value: string) => JSON.stringify(value);
  return `#!/bin/bash
set -euo pipefail
pid=${input.pid}
src=${quote(input.srcApp)}
dest=${quote(input.destApp)}
device=${quote(input.device)}
tmp=${quote(input.tmp)}
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
sleep 0.4
# WORKHORSE_MAC_GROK_BOT_SHIM_STOP
# The shim is a keepalive child, not the app process above. Stop both its
# LaunchAgent and an exact orphan from the replaced bundle before copying.
launchctl bootout "gui/$(id -u)/com.go7studio.workhorse-grok-bot-shim" >/dev/null 2>&1 || true
expected_shim="$dest/Contents/MacOS/Go7 Workhorse $dest/Contents/Resources/app.asar/dist-electron/grok-bot-shim-host.js"
while IFS= read -r shim_pid; do
  [ -n "$shim_pid" ] || continue
  shim_command=$(ps -p "$shim_pid" -o command= 2>/dev/null || true)
  [ "$shim_command" = "$expected_shim" ] || continue
  kill -TERM "$shim_pid" 2>/dev/null || true
done < <(pgrep -f 'grok-bot-shim-host\.js$' 2>/dev/null || true)
rm -rf "$dest"
cp -R "$src" "$dest"
if [ -n "$device" ]; then
  hdiutil detach "$device" -quiet 2>/dev/null || hdiutil detach "$device" -force -quiet 2>/dev/null || true
fi
rm -rf "$tmp" 2>/dev/null || true
${macRefreshRegistrationScript('"$dest"')}
open "$dest"
`;
}

export function offerFromRelease(raw: unknown, current: string): AppUpdateOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { tag_name?: unknown; name?: unknown; body?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (record.draft === true || record.prerelease === true) return null;
  const version = typeof record.tag_name === "string" ? versionFromRef(record.tag_name) : "";
  if (!version || !isNewerVersion(version, current)) return null;
  const url = typeof record.html_url === "string" && record.html_url.startsWith("https://") ? record.html_url : releaseUrl(version);
  const notes = typeof record.body === "string" ? record.body.trim() : "";
  return {
    version,
    name: typeof record.name === "string" ? record.name : undefined,
    notes: notes ? notes.slice(0, 400) : undefined,
    url,
  };
}

export function offerFromTag(raw: unknown, current: string): AppUpdateOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { name?: unknown };
  const version = typeof record.name === "string" ? versionFromRef(record.name) : "";
  if (!version || !isNewerVersion(version, current)) return null;
  return { version, url: releaseUrl(version) };
}

export function pickLatestTagOffer(tags: unknown, current: string): AppUpdateOffer | null {
  if (!Array.isArray(tags)) return null;
  let best: AppUpdateOffer | null = null;
  for (const tag of tags) {
    const offer = offerFromTag(tag, current);
    if (!offer) continue;
    if (!best || compareVersions(offer.version, best.version) > 0) best = offer;
  }
  return best;
}

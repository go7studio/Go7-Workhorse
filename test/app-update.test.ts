import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  compareVersions,
  isNewerVersion,
  macBundleFromExecPath,
  macInstallerArch,
  macRefreshRegistrationScript,
  macReplaceScript,
  offerFromRelease,
  winInstallerArgs,
  winInstallerCommandLine,
  winSchtasksCreate,
  winSchtasksDelete,
  winSchtasksRun,
  winUpdateTaskXml,
  winUpdateTaskXmlBytes,
  winWmiCreate,
  WIN_UPDATE_TASK_NAME,
  packagedUpdateMissingMessage,
  parseHdiutilAttach,
  pickLatestTagOffer,
  pickMacDmgAsset,
  pickWinSetupAsset,
  releaseTag,
  updateInstallKind,
  versionFromRef,
} from "../src/lib/app-update";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("semver compare treats a GitHub tag as newer than the running desk", () => {
  assert.equal(versionFromRef("v0.2.0"), "0.2.0");
  assert.equal(releaseTag("0.2.0"), "v0.2.0");
  assert.equal(isNewerVersion("0.2.0", "0.1.0"), true);
  assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), false);
  assert.ok(compareVersions("0.1.10", "0.1.9") > 0);
  assert.equal(
    offerFromRelease(
      { tag_name: "v0.2.0", html_url: "https://github.com/go7studio/Go7-Workhorse/releases/tag/v0.2.0", body: "Fixes." },
      "0.1.0",
    )?.version,
    "0.2.0",
  );
  assert.equal(offerFromRelease({ tag_name: "v0.1.0" }, "0.1.0"), null);
  assert.equal(offerFromRelease({ tag_name: "v0.3.0", draft: true }, "0.1.0"), null);
  assert.equal(pickLatestTagOffer([{ name: "v0.1.1" }, { name: "v0.2.0" }], "0.1.0")?.version, "0.2.0");
});

test("a packaged Mac desk installs the arch-matched dmg, not a git checkout", () => {
  assert.equal(macInstallerArch("arm64"), "arm64");
  assert.equal(macInstallerArch("x86_64"), "x64");
  assert.equal(macInstallerArch("x64"), "x64");
  assert.equal(macInstallerArch("ppc"), null);
  assert.equal(
    macBundleFromExecPath("/Applications/Go7 Workhorse.app/Contents/MacOS/Go7 Workhorse"),
    "/Applications/Go7 Workhorse.app",
  );
  assert.equal(macBundleFromExecPath("/usr/local/bin/workhorse"), null);

  const release = {
    assets: [
      {
        name: "Go7-Workhorse-0.3.2-mac-arm64.dmg",
        browser_download_url: "https://github.com/go7studio/Go7-Workhorse/releases/download/v0.3.2/Go7-Workhorse-0.3.2-mac-arm64.dmg",
      },
      {
        name: "Go7-Workhorse-0.3.2-mac-x64.dmg",
        browser_download_url: "https://github.com/go7studio/Go7-Workhorse/releases/download/v0.3.2/Go7-Workhorse-0.3.2-mac-x64.dmg",
      },
      {
        name: "Go7-Workhorse-Setup-0.3.2.exe",
        browser_download_url: "https://github.com/go7studio/Go7-Workhorse/releases/download/v0.3.2/Go7-Workhorse-Setup-0.3.2.exe",
      },
    ],
  };
  assert.equal(pickMacDmgAsset(release, "arm64")?.name, "Go7-Workhorse-0.3.2-mac-arm64.dmg");
  assert.equal(pickMacDmgAsset(release, "x64")?.name, "Go7-Workhorse-0.3.2-mac-x64.dmg");
  assert.equal(pickWinSetupAsset(release)?.name, "Go7-Workhorse-Setup-0.3.2.exe");
  assert.equal(
    pickWinSetupAsset({
      assets: [
        {
          name: "Go7-Workhorse-Setup-0.3.2.exe.blockmap",
          browser_download_url: "https://example.com/Go7-Workhorse-Setup-0.3.2.exe.blockmap",
        },
        {
          name: "Workhorse-Setup-0.1.4.exe",
          browser_download_url: "https://example.com/Workhorse-Setup-0.1.4.exe",
        },
      ],
    })?.name,
    "Workhorse-Setup-0.1.4.exe",
  );
  assert.equal(
    pickWinSetupAsset({ assets: [{ name: "notes.txt", browser_download_url: "https://example.com/notes.txt" }] }),
    null,
  );
  assert.equal(
    pickMacDmgAsset(
      { assets: [{ name: "Workhorse-0.1.9-mac.dmg", browser_download_url: "https://example.com/Workhorse-0.1.9-mac.dmg" }] },
      "arm64",
    )?.name,
    "Workhorse-0.1.9-mac.dmg",
  );
  assert.equal(
    pickMacDmgAsset(
      { assets: [{ name: "Workhorse-0.1.9-mac.dmg", browser_download_url: "https://example.com/Workhorse-0.1.9-mac.dmg" }] },
      "x64",
    ),
    null,
  );
  assert.equal(pickMacDmgAsset({ assets: [{ name: "notes.txt", browser_download_url: "https://example.com/notes.txt" }] }, "arm64"), null);

  const tmp = "/var/folders/xx/tmp/workhorse-update-1";
  const attached = [
    "/dev/disk4              GUID_partition_scheme",
    `/dev/disk4s1            Apple_HFS                       ${tmp}/dmg.1234`,
  ].join("\n");
  assert.deepEqual(parseHdiutilAttach(attached, tmp), { device: "/dev/disk4", mount: `${tmp}/dmg.1234` });
  const canonicalAttached = [
    "/dev/disk4              GUID_partition_scheme",
    `/dev/disk4s1            Apple_HFS                       /private${tmp}/dmg.5678`,
  ].join("\n");
  assert.deepEqual(parseHdiutilAttach(canonicalAttached, tmp), {
    device: "/dev/disk4",
    mount: `/private${tmp}/dmg.5678`,
  });
  assert.equal(parseHdiutilAttach("nothing useful", tmp), null);

  assert.equal(updateInstallKind({ platform: "darwin", packaged: true, hasGitCheckout: false }), "mac-dmg");
  assert.equal(updateInstallKind({ platform: "darwin", packaged: true, hasGitCheckout: true }), "mac-dmg");
  assert.equal(updateInstallKind({ platform: "darwin", packaged: false, hasGitCheckout: true }), "git-checkout");
  assert.equal(updateInstallKind({ platform: "win32", packaged: true, hasGitCheckout: false }), "win-nsis");
  assert.equal(updateInstallKind({ platform: "win32", packaged: true, hasGitCheckout: true }), "win-nsis");
  assert.equal(updateInstallKind({ platform: "win32", packaged: false, hasGitCheckout: true }), "git-checkout");
  assert.equal(updateInstallKind({ platform: "linux", packaged: true, hasGitCheckout: false }), "none");
  assert.match(packagedUpdateMissingMessage("linux"), /cannot install in place/);

  const script = macReplaceScript({
    pid: 4242,
    srcApp: "/tmp/mnt/Go7 Workhorse.app",
    destApp: "/Applications/Go7 Workhorse.app",
    device: "/dev/disk4s1",
    tmp,
  });
  assert.match(script, /kill -0 "\$pid"/);
  assert.match(script, /cp -R "\$src" "\$dest"/);
  assert.match(script, /hdiutil detach "\$device"/);
  assert.match(script, /open "\$dest"/);
  assert.match(script, /4242/);
  assert.match(script, /WORKHORSE_MAC_DOCK_REFRESH/);
  assert.match(script, /lsregister/);
  assert.match(script, /persistent-apps/);
  assert.match(script, /tile\.pop\("book"/);
  assert.match(script, /WORKHORSE_MAC_GROK_BOT_SHIM_STOP/);
  assert.match(script, /launchctl bootout/);
  assert.ok(script.includes("grok-bot-shim-host.js$"));
  assert.ok(script.indexOf("WORKHORSE_MAC_GROK_BOT_SHIM_STOP") < script.indexOf('rm -rf "$dest"'));

});

test("replacing the Mac app re-registers the live bundle and drops a stale Dock bookmark", () => {
  const refresh = macRefreshRegistrationScript();
  assert.match(refresh, /WORKHORSE_MAC_DOCK_REFRESH/);
  assert.match(refresh, /lsregister/);
  assert.match(refresh, /persistent-apps/);
  assert.match(refresh, /tile\.pop\("book"/);
  assert.match(refresh, /go7-workhorse-install\.\*\/\*backup\.app/);
  assert.doesNotMatch(refresh, /backup\.app"/);

  const installer = readFileSync(path.join(ROOT, "scripts", "install-mac.sh"), "utf8");
  assert.match(installer, /refresh_mac_app_icon "\/Applications\/\$\{APP\}"/);
  assert.match(installer, /WORKHORSE_MAC_DOCK_REFRESH/);
  assert.match(installer, /lsregister/);
  assert.match(installer, /persistent-apps/);
  assert.match(installer, /tile\.pop\("book"/);
  assert.doesNotMatch(installer, /Go7 Workhorse .*backup\.app/);
  assert.match(installer, /stop_grok_bot_shim "\/Applications\/\$\{APP\}"/);
  assert.match(installer, /WORKHORSE_MAC_GROK_BOT_SHIM_STOP/);
  assert.match(installer, /launchctl bootout/);
  assert.ok(installer.includes("grok-bot-shim-host\\.js$"));

  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /function setDockIcon\(\)/);
  assert.match(main, /nativeImage\.createFromPath\(icon\)/);
  assert.match(main, /app\.dock\.setIcon\(image\)/);
  assert.match(main, /createWindow\(\);\s*setDockIcon\(\)/);

  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    build?: {
      mac?: { icon?: string };
      extraResources?: Array<{ from?: string; to?: string }>;
    };
  };
  assert.equal(pkg.build?.mac?.icon, "assets/app-icons/go7-workhorse.icns");
  assert.ok(
    pkg.build?.extraResources?.some(
      (resource) => resource.from === "assets/app-icons" && resource.to === "assets/app-icons",
    ),
    "the runtime icon directory must be copied into packaged app resources",
  );
});

test("a packaged Windows desk service-spawns silent Setup and NSIS relaunches once", () => {
  const setup = "C:\\tmp\\workhorse-setup.exe";
  assert.deepEqual(winInstallerArgs(), ["/S", "--force-run"]);
  assert.ok(!winInstallerArgs().includes("--updated"));
  assert.equal(winInstallerCommandLine(setup), `"${setup}" /S --force-run`);
  assert.doesNotMatch(winInstallerCommandLine(setup), /--updated/);

  const xml = winUpdateTaskXml({ command: setup });
  assert.match(xml, /<Command>C:\\tmp\\workhorse-setup\.exe<\/Command>/);
  assert.match(xml, /<Arguments>\/S --force-run<\/Arguments>/);
  assert.doesNotMatch(xml, /--updated/);
  assert.doesNotMatch(xml, /explorer\.exe/);
  assert.doesNotMatch(xml, /Go7 Workhorse\.exe/);
  assert.doesNotMatch(xml, /cmd\.exe/);
  assert.doesNotMatch(xml, /<Command>schtasks/);
  assert.equal((xml.match(/<Exec>/g) ?? []).length, 1);
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /InteractiveToken/);

  const xmlPath = "C:\\tmp\\workhorse-update-1\\update-task.xml";
  const create = winSchtasksCreate({ xmlPath });
  assert.equal(create.command, "schtasks.exe");
  assert.deepEqual(create.args, ["/Create", "/TN", WIN_UPDATE_TASK_NAME, "/XML", xmlPath, "/F"]);
  const runTask = winSchtasksRun();
  assert.equal(runTask.command, "schtasks.exe");
  assert.deepEqual(runTask.args, ["/Run", "/TN", WIN_UPDATE_TASK_NAME]);
  const remove = winSchtasksDelete();
  assert.equal(remove.command, "schtasks.exe");
  assert.deepEqual(remove.args, ["/Delete", "/TN", WIN_UPDATE_TASK_NAME, "/F"]);

  const wmi = winWmiCreate(setup);
  assert.equal(wmi.command, "powershell.exe");
  const wmiCommand = wmi.args.join(" ");
  assert.match(wmiCommand, /Win32_Process/);
  assert.match(wmiCommand, /Create/);
  assert.match(wmiCommand, /workhorse-setup\.exe/);
  assert.match(wmiCommand, /\/S --force-run/);
  assert.match(wmiCommand, /WindowStyle Hidden/);
  assert.doesNotMatch(wmiCommand, /--updated/);
  assert.doesNotMatch(wmiCommand, /Start-Sleep|Wait-Process|explorer\.exe/);

  const xmlFile = winUpdateTaskXmlBytes(xml);
  assert.equal(xmlFile[0], 0xff);
  assert.equal(xmlFile[1], 0xfe);
});

test("update check is wired through main, preload, and the sidebar action", () => {
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const sidebar = readFileSync(path.join(ROOT, "src", "ui", "Sidebar.tsx"), "utf8");
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const updater = readFileSync(path.join(ROOT, "electron", "app-update.ts"), "utf8");
  const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const releaseConfig = readFileSync(path.join(ROOT, "release-please-config.json"), "utf8");
  assert.match(main, /app:check-update/);
  assert.match(main, /app:apply-update/);
  assert.match(main, /applyAppUpdate/);
  assert.match(preload, /checkAppUpdate/);
  assert.match(preload, /applyAppUpdate/);
  assert.match(store, /applyAppUpdate/);
  assert.match(sidebar, /sidebar-update/);
  assert.match(sidebar, /SidebarUpdate/);
  assert.match(sidebar, /"Update now"/);
  assert.match(sidebar, /Try update again/);
  const dock = sidebar.indexOf('<footer className="sidebar-dock">');
  const settingsAction = sidebar.indexOf(">Settings<", dock);
  const updateAction = sidebar.indexOf("<SidebarUpdate />", dock);
  assert.ok(dock >= 0 && settingsAction > dock && updateAction > settingsAction);
  assert.match(sidebar, /memo\(function SidebarUpdate\(\)/);
  assert.match(sidebar, /useStoreSelector\(selectSidebarUpdateStore, sameSidebarUpdateStore\)/);
  const sidebarStore = sidebar.slice(sidebar.indexOf("type SidebarStore"), sidebar.indexOf("type SidebarUpdateStore"));
  assert.doesNotMatch(sidebarStore, /appUpdate/);
  const styles = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.sidebar-update:hover \.sidebar-update-copy/);
  const brand = sidebar.slice(sidebar.indexOf('<div className="brand">'), dock);
  assert.doesNotMatch(brand, /<SidebarUpdate/);
  // Check now used to return null on every GitHub error and every current
  // build, so the button did nothing a person could see. A miss has to say
  // so, and a packaged Mac or Windows desk has to install the release
  // artifact, not hunt for a checkout.
  assert.match(settings, /This is the latest build/);
  assert.match(settings, /Workhorse \$\{result\.offer\.version\} is ready/);
  assert.match(settings, /Install \$\{store\.appUpdate\.version\}/);
  assert.match(updater, /updateInstallKind/);
  assert.match(updater, /installMacDmg/);
  assert.match(updater, /pickMacDmgAsset/);
  assert.match(updater, /installWinNsis/);
  assert.match(updater, /pickWinSetupAsset/);
  assert.match(updater, /winUpdateTaskXml/);
  assert.match(updater, /winSchtasksCreate/);
  assert.match(updater, /winSchtasksRun/);
  assert.match(updater, /winWmiCreate/);
  assert.doesNotMatch(updater, /winReplaceScript/);
  assert.doesNotMatch(updater, /winInstallerLaunch/);
  assert.doesNotMatch(updater, /replace\.vbs/);
  assert.doesNotMatch(updater, /explorer\.exe/);
  assert.match(updater, /hdiutil/);
  const winApply = updater.slice(updater.indexOf("async function installWinNsis"), updater.indexOf("export async function applyAppUpdate"));
  assert.match(winApply, /pickWinSetupAsset/);
  assert.match(winApply, /writeFileSync\(setup/);
  assert.match(winApply, /winSchtasksCreate/);
  assert.match(winApply, /winSchtasksRun/);
  assert.match(winApply, /winWmiCreate/);
  assert.doesNotMatch(winApply, /cleanupDir/);
  assert.match(winApply, /app\.quit/);
  assert.doesNotMatch(winApply, /spawn\(/);
  assert.doesNotMatch(winApply, /explorer/);
  const nsis = readFileSync(path.join(ROOT, "build", "installer.nsh"), "utf8");
  assert.doesNotMatch(nsis, /!macro customInstall/);
  assert.doesNotMatch(nsis, /\bExec\b/);
  assert.doesNotMatch(updater, /hdiutil attach[^\n]*-quiet/);
  assert.match(updater, /error: message\.slice/);
  assert.doesNotMatch(updater, /catch \{\s*return null;\s*\}/);
  // The desk offers an update by reading GitHub releases, so the workflow has
  // to create one with installers in it. release-please prepares the version
  // bump from package.json, which is the version the desk compares against.
  assert.match(workflow, /release-please-action/);
  assert.match(releaseConfig, /"release-type": "node"/);
  assert.match(workflow, /skip-github-release: true/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /installers\/\*/);

  // 0.1.9 signed both installers and published nothing: release-please's
  // prepare job failed in a GitHub incident, and a failed ancestor skips a
  // downstream job unless it says otherwise. Publishing must ask for the two
  // things that matter — a version was cut, and both installers built — and
  // for nothing else.
  // 0.1.9 shipped one arm64 dmg because no arch was set, so electron-builder
  // followed the runner and every Intel Mac got nothing. The pieces have to
  // agree: two arches built, the arch in the filename so they do not collide,
  // a glob that collects both, and an installer that picks by uname.
  const pkgBuild = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).build;
  const macTargets = pkgBuild.mac.target as Array<{ target: string; arch: string[] }>;
  for (const target of ["dmg", "zip"]) {
    const entry = macTargets.find((item) => item.target === target);
    assert.ok(entry, `mac target ${target} is missing`);
    assert.deepEqual([...entry.arch].sort(), ["arm64", "x64"], `${target} must build both arches`);
  }
  assert.match(pkgBuild.mac.artifactName, /\$\{arch\}/);
  // Targets named on the command line override build.mac.target, arch and all,
  // so the config alone builds whatever the runner happens to be. The scripts
  // have to say both arches out loud.
  const scripts = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  for (const name of ["package:mac", "pack:mac"]) {
    assert.match(scripts[name], /--arm64/, `${name} must ask for arm64`);
    assert.match(scripts[name], /--x64/, `${name} must ask for x64`);
  }
  assert.match(workflow, /\*Workhorse-\*-mac-\*\.dmg/);
  const installer = readFileSync(path.join(ROOT, "scripts", "install-mac.sh"), "utf8");
  assert.match(installer, /uname -m/);
  assert.match(installer, /arm64\) arch=arm64/);
  assert.match(installer, /x86_64\) arch=x64/);
  assert.match(installer, /-mac-\$\{arch\}\\\.dmg\$/);
  // `hdiutil attach -quiet` prints nothing, so the mount point parsed out of
  // it was always empty: the script decided every disk image was missing the
  // app, then its cleanup removed $tmp while the image was still mounted
  // inside it and printed 634 "Read-only file system" lines. Nothing was ever
  // installed. Attach must stay loud, and detach must happen by device first.
  assert.doesNotMatch(installer, /hdiutil attach[^\n]*-quiet/);
  assert.match(installer, /hdiutil detach "\$device"/);
  assert.match(installer, /device=\$\(printf/);

  const publish = workflow.slice(workflow.indexOf("\n  publish:"));
  // release-please aborts with "There are untagged, merged release PRs
  // outstanding" while a merged release PR still carries its pending label.
  // It relabels when it creates the release, but this workflow passes
  // skip-github-release and creates the release itself — so publishing has to
  // move the label, or the first release is the last one anybody can cut.
  // Signing material is scoped to the job that signs, on both platforms, and
  // an unsigned Windows installer is announced rather than shipped quietly:
  // a fork's exe is indistinguishable from ours until Authenticode exists.
  assert.match(workflow, /WIN_CSC_LINK: \$\{\{ runner\.os == 'Windows'/);
  assert.match(workflow, /MAC_CSC_LINK: \$\{\{ runner\.os == 'macOS'/);
  assert.match(workflow, /::warning::Windows installer is unsigned/);
  assert.match(publish, /autorelease: tagged/);
  // Moving that label is a pull-request write and labels are an issues API, so
  // the job needs both. 0.2.0 published every installer and then failed on the
  // label for want of them.
  assert.match(publish, /pull-requests: write/);
  assert.match(publish, /issues: write/);
  assert.match(publish, /--remove-label "autorelease: pending"/);
  assert.match(publish, /!cancelled\(\)/);
  assert.match(publish, /needs\.installers\.result == 'success'/);
  assert.match(publish, /needs\.detect-release\.outputs\.cut == 'true'/);
});

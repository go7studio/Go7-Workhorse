import type { LinkDeskPlatform } from "../src/lib/workhorse-link";
import { GROK_BOT_SHIM_PORT } from "../src/lib/custom-http-identity";
import { grokBotShimLaunch } from "../src/lib/grok-bot-shim";

export const GROK_BOT_SHIM_LAUNCH_AGENT = "com.go7studio.workhorse-grok-bot-shim";

export type ShimKeepaliveIo = {
  existsSync: (file: string) => boolean;
  mkdirp: (dir: string) => void;
  writeFile: (file: string, text: string) => void;
  exec?: (file: string, args: string[]) => { status: number };
};

export function grokBotShimAgentPlist(launch: { command: string; args: string[]; env: Record<string, string> }, logPath: string): string {
  const args = [launch.command, ...launch.args].map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");
  const env = Object.entries(launch.env)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${GROK_BOT_SHIM_LAUNCH_AGENT}</string>
  <key>ProgramArguments</key><array>
${args}
  </array>
  <key>EnvironmentVariables</key><dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logPath)}</string>
</dict></plist>
`;
}

export function grokBotShimWindowsCmd(launch: { command: string; args: string[]; env: Record<string, string> }): string {
  const env = Object.entries(launch.env)
    .map(([key, value]) => `set "${key}=${value.replace(/"/g, "")}"`)
    .join("\r\n");
  const args = launch.args.map((value) => qWin(value)).join(" ");
  return `@echo off\r\n${env}\r\n${qWin(launch.command)} ${args}\r\n`;
}

export function grokBotShimKeepalivePaths(platform: LinkDeskPlatform, home: string, userData: string): { dest: string; log?: string } {
  const slash = platform === "win32" ? "\\" : "/";
  const root = home.replace(/[\\/]+$/, "");
  const data = userData.replace(/[\\/]+$/, "");
  if (platform === "win32") {
    return { dest: `${root}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Go7-Workhorse-Grok-Bot-Shim.cmd` };
  }
  if (platform === "linux") {
    return { dest: `${data}${slash}bin${slash}grok-bot-shim.sh`, log: `${data}${slash}grok-bot-shim.log` };
  }
  return {
    dest: `${root}/Library/LaunchAgents/${GROK_BOT_SHIM_LAUNCH_AGENT}.plist`,
    log: `${root}/Library/Logs/${GROK_BOT_SHIM_LAUNCH_AGENT}.log`,
  };
}

export function installGrokBotShimKeepalive(input: {
  platform: LinkDeskPlatform;
  home: string;
  userData: string;
  command: string;
  script: string;
  io: ShimKeepaliveIo;
}): { ok: boolean; dest: string; message: string } {
  const launch = grokBotShimLaunch({ command: input.command, script: input.script, userData: input.userData });
  const paths = grokBotShimKeepalivePaths(input.platform, input.home, input.userData);
  const destDir = paths.dest.replace(/[\\/][^\\/]+$/, "");
  input.io.mkdirp(destDir);
  if (paths.log) input.io.mkdirp(paths.log.replace(/[\\/][^\\/]+$/, ""));
  const body =
    input.platform === "win32"
      ? grokBotShimWindowsCmd(launch)
      : input.platform === "linux"
        ? `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport WORKHORSE_USER_DATA=${qSh(input.userData)}\nexec ${qSh(input.command)} ${qSh(input.script)}\n`
        : grokBotShimAgentPlist(launch, paths.log || "");
  input.io.writeFile(paths.dest, body);
  if (input.platform === "darwin" && input.io.exec) {
    const uid = process.getuid?.() ?? 0;
    input.io.exec("launchctl", ["bootout", `gui/${uid}/${GROK_BOT_SHIM_LAUNCH_AGENT}`]);
    input.io.exec("launchctl", ["bootstrap", `gui/${uid}`, paths.dest]);
  }
  return {
    ok: true,
    dest: paths.dest,
    message: `Grok Bot shim keepalive on ${input.platform} writes ${paths.dest} and keeps 127.0.0.1:${GROK_BOT_SHIM_PORT} up. No webhook key is stored there.`,
  };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function qWin(value: string): string {
  return `"${value.replace(/"/g, "")}"`;
}

function qSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

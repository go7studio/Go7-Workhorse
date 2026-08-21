import path from "node:path";
import {
  GROK_BOT_SHIM_LABEL,
  grokBotInboxDir,
  grokBotLaunchAgentPlist,
  grokBotLaunchctlCommands,
  grokBotShimEnv,
  grokBotWakePath,
} from "../src/lib/grok-bot-shim";

export type GrokBotShimIo = {
  mkdirp: (dir: string) => void;
  writeFile: (file: string, text: string) => void;
  existsSync: (file: string) => boolean;
  exec?: (file: string, args: string[]) => { status: number; stdout?: string; stderr?: string };
};

export type GrokBotShimSuperviseInput = {
  platform: NodeJS.Platform;
  userData: string;
  home: string;
  uid: number;
  execPath: string;
  script: string;
  io: GrokBotShimIo;
};

export type GrokBotShimSuperviseReport = {
  ok: boolean;
  platform: string;
  plist?: string;
  inbox: string;
  wake: string;
  message: string;
};

export function grokBotShimPlistPath(home: string): string {
  return path.join(home, "Library", "LaunchAgents", `${GROK_BOT_SHIM_LABEL}.plist`);
}

export function grokBotShimLogPath(home: string): string {
  return path.join(home, "Library", "Logs", `${GROK_BOT_SHIM_LABEL}.log`);
}

/** Install or refresh the Mac LaunchAgent. Does not write grok-bot-wake.json. Does not invent a key. */
export function ensureGrokBotShimSupervise(input: GrokBotShimSuperviseInput): GrokBotShimSuperviseReport {
  const inbox = grokBotInboxDir(input.userData);
  const wake = grokBotWakePath(input.userData);
  input.io.mkdirp(inbox);
  if (input.platform !== "darwin") {
    return {
      ok: true,
      platform: input.platform,
      inbox,
      wake,
      message: "Grok Bot shim keepalive is Mac-only.",
    };
  }
  const plistPath = grokBotShimPlistPath(input.home);
  const logPath = grokBotShimLogPath(input.home);
  const env = grokBotShimEnv({ inbox, wake, userData: input.userData });
  const plist = grokBotLaunchAgentPlist({
    command: input.execPath,
    args: [input.script],
    env,
    logPath,
  });
  input.io.mkdirp(path.dirname(plistPath));
  input.io.mkdirp(path.dirname(logPath));
  input.io.writeFile(plistPath, plist);
  const commands = grokBotLaunchctlCommands({ uid: input.uid, plistPath });
  if (input.io.exec) {
    input.io.exec("launchctl", commands.bootout);
    const loaded = input.io.exec("launchctl", commands.bootstrap);
    if (loaded.status !== 0) {
      return {
        ok: false,
        platform: input.platform,
        plist: plistPath,
        inbox,
        wake,
        message: loaded.stderr?.trim() || loaded.stdout?.trim() || "launchctl bootstrap failed",
      };
    }
  }
  return {
    ok: true,
    platform: input.platform,
    plist: plistPath,
    inbox,
    wake,
    message: `Grok Bot shim keepalive at ${plistPath}. Loopback 127.0.0.1:8787.`,
  };
}

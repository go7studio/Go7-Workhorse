import fs from "node:fs";
import path from "node:path";
import {
  grokBotWakeConfig,
  grokBotWakeInput,
  type GrokBotWakeConfig,
  type GrokBotWakeInput,
  type GrokBotWakeStatus,
} from "../src/lib/grok-bot-wake";
import { atomicWriteJson } from "./state-persistence";

const SHIM_HEALTH_URL = "http://127.0.0.1:8787/health";

export type GrokBotWakeIo = {
  readFile(file: string): string;
  writeConfig(file: string, value: GrokBotWakeConfig): void;
  health(): Promise<{ ok: boolean }>;
};

export function grokBotWakePath(userData: string): string {
  return path.join(userData, "grok-bot-wake.json");
}

function defaultIo(): GrokBotWakeIo {
  return {
    readFile: (file) => fs.readFileSync(file, "utf8"),
    writeConfig: (file, value) => atomicWriteJson(file, value, 0o600),
    health: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      try {
        const response = await fetch(SHIM_HEALTH_URL, { signal: controller.signal });
        return { ok: response.ok };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function readConfig(file: string, io: GrokBotWakeIo): GrokBotWakeConfig | null {
  try {
    return grokBotWakeConfig(JSON.parse(io.readFile(file)));
  } catch {
    return null;
  }
}

export async function inspectGrokBotWake(
  file: string,
  io: GrokBotWakeIo = defaultIo(),
): Promise<GrokBotWakeStatus> {
  if (!readConfig(file, io)) {
    return {
      configured: false,
      shimReachable: false,
      ready: false,
      message: "Optional. Set this up later for quick Grok Bot replies.",
    };
  }
  try {
    const health = await io.health();
    if (health.ok) {
      return {
        configured: true,
        shimReachable: true,
        ready: true,
        message: "Ready for instant chats.",
      };
    }
    return {
      configured: true,
      shimReachable: false,
      ready: true,
      message: "Saved. Instant replies will be ready when Grok Bot starts.",
    };
  } catch {
    return {
      configured: true,
      shimReachable: false,
      ready: true,
      message: "Saved. Instant replies will be ready when Grok Bot starts.",
    };
  }
}

export async function saveGrokBotWake(
  file: string,
  input: GrokBotWakeInput,
  io: GrokBotWakeIo = defaultIo(),
): Promise<GrokBotWakeStatus> {
  const config = grokBotWakeInput(input);
  if (!config) {
    return {
      configured: false,
      shimReachable: false,
      ready: false,
      message: "Use the HTTPS webhook URL and its key from Grok Bot.",
    };
  }
  try {
    io.writeConfig(file, config);
  } catch {
    return {
      configured: false,
      shimReachable: false,
      ready: false,
      message: "Workhorse could not save this connection.",
    };
  }
  return inspectGrokBotWake(file, io);
}

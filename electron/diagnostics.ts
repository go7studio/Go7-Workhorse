import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDER_CAPABILITIES } from "../src/lib/provider-capabilities";

type Detection = { connected?: boolean; binary?: string | null };

export type SupportReport = {
  schemaVersion: 1;
  createdAt: string;
  app: { version: string; electron: string; node: string; platform: string; arch: string };
  providers: Record<string, unknown>;
  persistence: Record<string, boolean>;
  workload: { projects: number; chats: number; queued: number; scheduled: number; activeGoals: number; attentionFailures: number };
};

/** Builds a support-safe report: no prompts, API keys, environment variables, or file contents. */
export function buildSupportReport(input: {
  state: Record<string, unknown>;
  version: string;
  userData: string;
  detections: Record<string, Detection>;
  encryptionAvailable: boolean;
}): SupportReport {
  const sessions = Array.isArray(input.state.sessions) ? input.state.sessions as Record<string, unknown>[] : [];
  const projects = Array.isArray(input.state.projects) ? input.state.projects : [];
  const settings = input.state.settings && typeof input.state.settings === "object" ? input.state.settings as Record<string, unknown> : {};
  const bots = Array.isArray(settings.customBots) ? settings.customBots as Record<string, unknown>[] : [];
  const providers: Record<string, unknown> = {};
  for (const id of ["grok", "codex", "claude"] as const) {
    providers[id] = {
      connected: Boolean(input.detections[id]?.connected),
      binaryDetected: Boolean(input.detections[id]?.binary),
      capabilities: PROVIDER_CAPABILITIES[id],
    };
  }
  providers.custom = {
    bots: bots.map((bot) => ({
      name: typeof bot.name === "string" ? bot.name : "Custom",
      model: typeof bot.model === "string" ? bot.model : "",
      api: bot.api === "anthropic-messages" ? "anthropic-messages" : "openai-completions",
      enabled: bot.enabled !== false,
      credentialStored: typeof bot.credentialId === "string" || typeof bot.apiKey === "string",
    })),
    capabilities: PROVIDER_CAPABILITIES.custom,
  };
  const scheduled = sessions.flatMap((session) => Array.isArray(session.scheduledRuns) ? session.scheduledRuns as Record<string, unknown>[] : []);
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    app: {
      version: input.version,
      electron: process.versions.electron ?? "unknown",
      node: process.versions.node,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
    },
    providers,
    persistence: {
      state: fs.existsSync(path.join(input.userData, "workhorse-state.json")),
      backup: fs.existsSync(path.join(input.userData, "workhorse-state.json.bak")),
      credentials: fs.existsSync(path.join(input.userData, "credentials.json")),
      jobJournal: fs.existsSync(path.join(input.userData, "workhorse-jobs.json")),
      osEncryption: input.encryptionAvailable,
    },
    workload: {
      projects: projects.length,
      chats: sessions.filter((session) => !session.hidden).length,
      queued: sessions.reduce((sum, session) => sum + (Array.isArray(session.queue) ? session.queue.length : 0), 0),
      scheduled: scheduled.filter((run) => run.status === "pending" || run.status === "queued" || run.status === "running").length,
      activeGoals: sessions.filter((session) => (session.goal as Record<string, unknown> | undefined)?.status === "active").length,
      attentionFailures: scheduled.filter((run) => run.status === "failed").length + sessions.filter((session) => {
        const status = (session.agentRun as Record<string, unknown> | undefined)?.status;
        return status === "failed" || status === "timed-out" || status === "budget-exceeded";
      }).length,
    },
  };
}
